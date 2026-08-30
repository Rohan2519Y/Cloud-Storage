'use client'

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
    Upload,
    Search,
    Download,
    Trash2,
    Eye,
    Pencil,
    FileText,
    FileImage,
    FileVideo,
    FileAudio,
    FileArchive,
    File,
    X,
    Loader2,
    CheckCircle,
    AlertCircle,
    Grid3X3,
    List,
    Folder,
    FolderOpen,
    ChevronRight,
    Plus,
    RefreshCw,
} from 'lucide-react'
import apiService from '../../../../services/api'
import Tooltip from '@/components/Tooltip'

const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

const formatDate = (dateStr: string) =>
    new Date(dateStr).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    })

const getFileIcon = (mimeType: string) => {
    if (mimeType?.startsWith('image/')) return FileImage
    if (mimeType?.startsWith('video/')) return FileVideo
    if (mimeType?.startsWith('audio/')) return FileAudio
    if (mimeType?.includes('zip') || mimeType?.includes('rar') || mimeType?.includes('tar')) return FileArchive
    if (mimeType?.includes('pdf') || mimeType?.includes('doc') || mimeType?.includes('txt')) return FileText
    return File
}

interface FileItem {
    id: string
    original_name: string
    file_size: number
    mime_type: string
    telegram_message_id: string
    channel_id: string
    created_at: string
    folder_id?: string | null
}

interface Channel {
    channel_id: string
    channel_title: string
    channel_username: string
}

interface FolderItem {
    id: string
    name: string
    parent_id: string | null
    created_at: string
}

interface UploadQueueItem {
    id: string
    file: File
    status: 'queued' | 'uploading' | 'done' | 'error' | 'cancelled'
    progress: number
    error?: string
}

const MAX_CONCURRENT_UPLOADS = 3

export default function FilesPage() {
    const [files, setFiles] = useState<FileItem[]>([])
    const [channels, setChannels] = useState<Channel[]>([])
    const [folders, setFolders] = useState<FolderItem[]>([])
    const [currentFolder, setCurrentFolder] = useState<string | null>(null)
    const [folderPath, setFolderPath] = useState<FolderItem[]>([])
    const [syncing, setSyncing] = useState(false)
    const [showChannelDropdown, setShowChannelDropdown] = useState(false)
    const [showSortDropdown, setShowSortDropdown] = useState(false)
    const [loading, setLoading] = useState(true)
    const [isDragging, setIsDragging] = useState(false)
    const [uploadQueue, setUploadQueue] = useState<UploadQueueItem[]>([])
    const [queueRunning, setQueueRunning] = useState(false)
    const [searchQuery, setSearchQuery] = useState('')
    const [selectedForDownload, setSelectedForDownload] = useState<Set<string>>(new Set())
    const [downloadBatchProgress, setDownloadBatchProgress] = useState<{ done: number; total: number } | null>(null)
    const [clipboard, setClipboard] = useState<{ mode: 'copy' | 'cut'; fileIds: string[] } | null>(null)
    const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null)
    const [pasting, setPasting] = useState(false)
    const [selectedChannel, setSelectedChannel] = useState('')
    const [showUpload, setShowUpload] = useState(false)
    const [showNewFolder, setShowNewFolder] = useState(false)
    const [newFolderName, setNewFolderName] = useState('')
    const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid')
    const [sortBy, setSortBy] = useState<'name' | 'size' | 'date'>('date')
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
    const [thumbnailUrls, setThumbnailUrls] = useState<Record<string, string>>({})
    const [renaming, setRenaming] = useState<{ type: 'file' | 'folder'; id: string; name: string } | null>(null)
    const [deleteConfirm, setDeleteConfirm] = useState<{ type: 'file' | 'folder'; id: string; name: string } | null>(null)
    const [downloadingIds, setDownloadingIds] = useState<Set<string>>(new Set())

    const fileInputRef = useRef<HTMLInputElement>(null)
    const uploadConnectionsRef = useRef<Map<string, { xhr: XMLHttpRequest; evt: EventSource }>>(new Map())
    const activeUploadCountRef = useRef(0)
    const sortDropdownRef = useRef<HTMLDivElement>(null)
    const channelDropdownRef = useRef<HTMLDivElement>(null)
    const thumbnailUrlMapRef = useRef<Record<string, string>>({})

    const BASE = apiService['baseUrl'] || process.env.NEXT_PUBLIC_API_URL || ''

    const fetchFolders = useCallback(async () => {
        try {
            const r = await fetch(`${BASE}/api/folders?parent_id=${currentFolder || 'null'}`, {
                headers: { Authorization: `Bearer ${apiService.getToken()}` },
            })
            const d = await r.json()
            if (d.success) setFolders(d.folders || [])
        } catch {
            // ignore
        }
    }, [currentFolder, BASE])

    const fetchFiles = useCallback(async () => {
        try {
            const r = await fetch(`${BASE}/api/files?folder_id=${currentFolder || 'null'}`, {
                headers: { Authorization: `Bearer ${apiService.getToken()}` },
            })
            const d = await r.json()
            if (d.success) {
                setFiles(d.files || [])
                d.files?.forEach((f: FileItem) => {
                    if (f.mime_type?.startsWith('image/') && !thumbnailUrlMapRef.current[f.telegram_message_id]) {
                        loadThumbnail(f.telegram_message_id)
                    }
                })
            }
        } catch {
            // ignore
        } finally {
            setLoading(false)
        }
    }, [currentFolder, BASE])

    const fetchChannels = useCallback(async () => {
        try {
            const d = await apiService.getChannels()
            if (d.success) {
                if (d.channels?.length === 0) {
                    try {
                        await apiService.syncChannels()
                        const s = await apiService.getChannels()
                        if (s.success && s.channels?.length > 0) {
                            setChannels(s.channels)
                            setSelectedChannel(s.channels[0].channel_id)
                            return
                        }
                    } catch {
                        // ignore
                    }
                    setTimeout(() => fetchChannels(), 3000)
                } else {
                    setChannels(d.channels || [])
                    if (d.channels?.length > 0) setSelectedChannel(d.channels[0].channel_id)
                }
            }
        } catch {
            // ignore
        }
    }, [])

    const fetchFolderPath = useCallback(
        async (id: string) => {
            try {
                const r = await fetch(`${BASE}/api/folders/path/${id}`, {
                    headers: { Authorization: `Bearer ${apiService.getToken()}` },
                })
                const d = await r.json()
                if (d.success) setFolderPath(d.path || [])
            } catch {
                // ignore
            }
        },
        [BASE],
    )

    const loadThumbnail = useCallback(async (messageId: string) => {
        try {
            const blob = await apiService.viewFileAsBlob(messageId)
            const url = URL.createObjectURL(blob)
            thumbnailUrlMapRef.current[messageId] = url
            setThumbnailUrls((prev) => ({ ...prev, [messageId]: url }))
        } catch {
            // ignore
        }
    }, [])

    useEffect(() => {
        apiService.initToken()
        setTimeout(() => fetchChannels(), 100)
    }, [fetchChannels])

    useEffect(() => {
        setLoading(true)
        fetchFolders()
        fetchFiles()
        if (currentFolder) fetchFolderPath(currentFolder)
        else setFolderPath([])
    }, [currentFolder, fetchFolders, fetchFiles, fetchFolderPath])

    useEffect(() => {
        const urls = thumbnailUrlMapRef.current
        return () => {
            Object.values(urls).forEach((url) => URL.revokeObjectURL(url))
        }
    }, [])

    useEffect(() => {
        const connections = uploadConnectionsRef.current
        return () => {
            connections.forEach(({ xhr, evt }) => {
                xhr.abort()
                evt.close()
            })
        }
    }, [])

    useEffect(() => {
        const h = (e: MouseEvent) => {
            if (sortDropdownRef.current && !sortDropdownRef.current.contains(e.target as Node)) setShowSortDropdown(false)
        }
        document.addEventListener('mousedown', h)
        return () => document.removeEventListener('mousedown', h)
    }, [])

    useEffect(() => {
        const h = (e: MouseEvent) => {
            if (channelDropdownRef.current && !channelDropdownRef.current.contains(e.target as Node))
                setShowChannelDropdown(false)
        }
        document.addEventListener('mousedown', h)
        return () => document.removeEventListener('mousedown', h)
    }, [])

    const handleCreateFolder = useCallback(async () => {
        if (!newFolderName.trim()) return
        try {
            const r = await fetch(`${BASE}/api/folders`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiService.getToken()}`,
                },
                body: JSON.stringify({ name: newFolderName, parent_id: currentFolder }),
            })
            const d = await r.json()
            if (d.success) {
                setShowNewFolder(false)
                setNewFolderName('')
                fetchFolders()
                setMessage({ type: 'success', text: 'Folder created' })
            }
        } catch (err: any) {
            setMessage({ type: 'error', text: err.message })
        }
    }, [newFolderName, currentFolder, fetchFolders, BASE])

    const navigateToFolder = useCallback((id: string) => setCurrentFolder(id), [])
    const goBack = useCallback(() => setCurrentFolder(null), [])

    const handleDeleteFolder = useCallback(async () => {
        if (!deleteConfirm) return
        try {
            const r = await fetch(`${BASE}/api/folders/${deleteConfirm.id}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${apiService.getToken()}` },
            })
            const d = await r.json()
            if (d.success) {
                setFolders((prev) => prev.filter((f) => f.id !== deleteConfirm.id))
                setMessage({ type: 'success', text: 'Folder deleted' })
            }
        } catch (err: any) {
            setMessage({ type: 'error', text: err.message })
        } finally {
            setDeleteConfirm(null)
        }
    }, [deleteConfirm, BASE])

    // Mirrors uploadQueue/queueRunning for reads inside callbacks that run outside
    // React's render cycle (xhr/EventSource event handlers).
    const uploadQueueRef = useRef<UploadQueueItem[]>([])
    useEffect(() => {
        uploadQueueRef.current = uploadQueue
    }, [uploadQueue])
    const queueRunningRef = useRef(false)
    useEffect(() => {
        queueRunningRef.current = queueRunning
    }, [queueRunning])

    function updateQueueItem(id: string, patch: Partial<UploadQueueItem>) {
        setUploadQueue((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)))
    }

    // startQueueItemUpload and runUploadQueue call each other (start an item -> on
    // finish, run the queue again -> start the next item). Plain hoisted function
    // declarations let them reference one another without a ref-forwarding hack.
    function startQueueItemUpload(item: UploadQueueItem) {
        const uploadId = item.id
        const token = apiService.getToken()!
        updateQueueItem(uploadId, { status: 'uploading', progress: 0 })

        const evt = new EventSource(`${BASE}/api/upload-progress/${uploadId}?token=${token}`)
        evt.onmessage = (e) => {
            const d = JSON.parse(e.data)
            updateQueueItem(uploadId, { progress: d.progress })
        }
        evt.onerror = () => evt.close()

        const xhr = new XMLHttpRequest()
        uploadConnectionsRef.current.set(uploadId, { xhr, evt })
        const fd = new FormData()
        fd.append('file', item.file)
        const params = new URLSearchParams({
            channelId: selectedChannel,
            uploadId,
            ...(currentFolder ? { folderId: currentFolder } : {}),
        })

        const finishItem = (finalStatus: UploadQueueItem['status'], error?: string) => {
            evt.close()
            uploadConnectionsRef.current.delete(uploadId)
            activeUploadCountRef.current = Math.max(0, activeUploadCountRef.current - 1)
            updateQueueItem(uploadId, { status: finalStatus, error })
            fetchFiles()

            // Batch-completion summary lives here (not in a watcher effect) so it fires
            // exactly once, synchronously, right as the last item actually settles.
            const settledQueue = uploadQueueRef.current.map((it) =>
                it.id === uploadId ? { ...it, status: finalStatus } : it,
            )
            const stillPending = settledQueue.some((it) => it.status === 'queued' || it.status === 'uploading')
            if (!stillPending && queueRunningRef.current) {
                const done = settledQueue.filter((it) => it.status === 'done').length
                const failed = settledQueue.filter((it) => it.status === 'error').length
                setMessage(
                    failed === 0
                        ? { type: 'success', text: `${done} file${done === 1 ? '' : 's'} uploaded!` }
                        : { type: 'error', text: `${done} uploaded, ${failed} failed` },
                )
                setQueueRunning(false)
            }

            runUploadQueue()
        }

        xhr.addEventListener('load', () => {
            try {
                const d = JSON.parse(xhr.responseText)
                if (d.success) finishItem('done')
                else finishItem('error', d.error || 'Upload failed')
            } catch {
                finishItem('error', 'Upload failed')
            }
        })

        xhr.addEventListener('error', () => finishItem('error', 'Network error'))
        xhr.addEventListener('abort', () => finishItem('cancelled'))

        xhr.open('POST', `${BASE}/api/upload?${params}`)
        xhr.setRequestHeader('Authorization', `Bearer ${token}`)
        xhr.send(fd)
        activeUploadCountRef.current++
    }

    function runUploadQueue() {
        const queued = uploadQueueRef.current.filter((it) => it.status === 'queued')
        const freeSlots = MAX_CONCURRENT_UPLOADS - activeUploadCountRef.current
        queued.slice(0, Math.max(0, freeSlots)).forEach((it) => startQueueItemUpload(it))
    }

    const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files || [])
        if (files.length === 0) return
        setUploadQueue((prev) => [
            ...prev,
            ...files.map((file) => ({ id: crypto.randomUUID(), file, status: 'queued' as const, progress: 0 })),
        ])
        e.target.value = ''
        // A batch is already committed/running — pull newly added files straight in
        // instead of requiring another explicit "Start Upload" click.
        if (queueRunningRef.current) setTimeout(runUploadQueue, 0)
    }, [])

    const removeQueueItem = useCallback((id: string) => {
        const conn = uploadConnectionsRef.current.get(id)
        if (conn) {
            conn.xhr.abort() // triggers the 'abort' handler, which removes it from uploadConnectionsRef
        } else {
            setUploadQueue((prev) => prev.filter((it) => it.id !== id))
        }
    }, [])

    const handleStartUpload = useCallback(
        (e: React.FormEvent) => {
            e.preventDefault()
            if (!uploadQueue.some((it) => it.status === 'queued')) return
            setMessage(null)
            setQueueRunning(true)
            runUploadQueue()
        },
        [uploadQueue],
    )

    const cancelAllUploads = useCallback(() => {
        uploadConnectionsRef.current.forEach(({ xhr }) => xhr.abort())
        setUploadQueue((prev) => prev.filter((it) => it.status !== 'queued'))
        setQueueRunning(false)
    }, [])

    const closeUploadModal = useCallback(() => {
        cancelAllUploads()
        setUploadQueue([])
        setShowUpload(false)
    }, [cancelAllUploads])

    // Fetches a short-lived ticket and triggers a native browser download.
    // Shared by the single-file button and the bulk "download selected" action.
    const triggerFileDownload = useCallback(async (messageId: string, fileName: string) => {
        const ticket = await apiService.getDownloadTicket(messageId)
        const url = `${apiService.getFileDownloadUrl(messageId)}?dt=${encodeURIComponent(ticket)}`
        const a = document.createElement('a')
        a.href = url
        a.download = fileName
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
    }, [])

    const handleDownload = useCallback(async (messageId: string, fileName: string) => {
        setDownloadingIds((prev) => new Set(prev).add(messageId))
        try {
            await triggerFileDownload(messageId, fileName)
            setMessage({ type: 'success', text: `Download started: ${fileName}` })
        } catch (err: any) {
            setMessage({ type: 'error', text: err.message })
        } finally {
            // The browser takes over from here (native download UI); this only
            // covers the ticket request, so keep the spinner briefly visible
            // rather than have it vanish instantly.
            setTimeout(() => {
                setDownloadingIds((prev) => {
                    const next = new Set(prev)
                    next.delete(messageId)
                    return next
                })
            }, 1200)
        }
    }, [triggerFileDownload])

    const toggleFileSelection = useCallback((id: string) => {
        setSelectedForDownload((prev) => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
        })
    }, [])

    const clearFileSelection = useCallback(() => setSelectedForDownload(new Set()), [])

    // A plain <a download> click hands off to the browser with no way to know when the
    // transfer actually finishes, so it can't be used to gate "wait for this one to
    // finish before starting the next". fetch() + blob does block until the full
    // response body has arrived, which is what real one-at-a-time sequencing needs.
    const downloadFileBlocking = useCallback(async (messageId: string, fileName: string) => {
        const response = await fetch(`${BASE}/api/download/${messageId}`, {
            headers: { Authorization: `Bearer ${apiService.getToken()}` },
        })
        if (!response.ok) throw new Error(`Download failed (${response.status})`)
        const blob = await response.blob()
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = fileName
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
    }, [BASE])

    const handleDownloadSelected = useCallback(async () => {
        const targets = files.filter((f) => selectedForDownload.has(f.id))
        if (targets.length === 0) return

        // Strictly sequential: each file's request isn't even sent until the previous
        // file's full response has finished downloading — no overlapping API calls.
        let succeeded = 0
        const failed: string[] = []
        setDownloadBatchProgress({ done: 0, total: targets.length })
        for (const f of targets) {
            const messageId = f.telegram_message_id
            setDownloadingIds((prev) => new Set(prev).add(messageId))
            try {
                await downloadFileBlocking(messageId, f.original_name)
                succeeded++
            } catch {
                failed.push(f.original_name)
            }
            setDownloadingIds((prev) => {
                const next = new Set(prev)
                next.delete(messageId)
                return next
            })
            setDownloadBatchProgress((prev) => (prev ? { ...prev, done: prev.done + 1 } : prev))
        }
        setDownloadBatchProgress(null)

        if (failed.length === 0) {
            setMessage({ type: 'success', text: `Downloaded ${succeeded} file${succeeded === 1 ? '' : 's'}` })
        } else {
            setMessage({ type: 'error', text: `${succeeded} done, failed: ${failed.join(', ')}` })
        }
        clearFileSelection()
    }, [files, selectedForDownload, downloadFileBlocking, clearFileSelection])

    const handleView = useCallback(async (messageId: string) => {
        try {
            const blob = await apiService.viewFileAsBlob(messageId)
            const url = URL.createObjectURL(blob)
            window.open(url, '_blank')
            setTimeout(() => URL.revokeObjectURL(url), 5000)
        } catch (err: any) {
            setMessage({ type: 'error', text: err.message })
        }
    }, [])

    const handleDelete = useCallback(async () => {
        if (!deleteConfirm) return
        try {
            const d = await apiService.deleteFile(deleteConfirm.id)
            if (d.success) {
                setFiles((prev) => prev.filter((f) => f.id !== deleteConfirm.id))
                setMessage({ type: 'success', text: 'File deleted' })
            }
        } catch (err: any) {
            setMessage({ type: 'error', text: err.message })
        } finally {
            setDeleteConfirm(null)
        }
    }, [deleteConfirm])

    const handleRename = useCallback(async () => {
        if (!renaming || !renaming.name.trim()) return
        try {
            const ep =
                renaming.type === 'file'
                    ? `${BASE}/api/files/${renaming.id}/rename`
                    : `${BASE}/api/folders/${renaming.id}/rename`
            const r = await fetch(ep, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiService.getToken()}`,
                },
                body: JSON.stringify({ newName: renaming.name }),
            })
            const d = await r.json()
            if (d.success) {
                setRenaming(null)
                fetchFiles()
                fetchFolders()
                setMessage({ type: 'success', text: 'Renamed' })
            }
        } catch (err: any) {
            setMessage({ type: 'error', text: err.message })
        }
    }, [renaming, fetchFiles, fetchFolders, BASE])

    // ─── Drag & drop files into folders (and out, via the breadcrumb) ────────
    const FILE_DRAG_MIME = 'application/x-cloud-file-ids'
    // dragOverFolderId tracks which drop target is currently highlighted. Folders use
    // their real id; the root ("Home" in the breadcrumb) uses this sentinel since the
    // root's own folderId is `null`, which is already used to mean "nothing hovered".
    const ROOT_DROP_ID = '__root__'

    const handleFileDragStart = useCallback((e: React.DragEvent, item: FileItem) => {
        // Dragging a file that's part of the current selection drags the whole
        // selection (like Explorer); dragging an unselected file drags just that one.
        const ids = selectedForDownload.has(item.id) ? Array.from(selectedForDownload) : [item.id]
        e.dataTransfer.setData(FILE_DRAG_MIME, JSON.stringify(ids))
        e.dataTransfer.effectAllowed = 'move'
    }, [selectedForDownload])

    const handleFolderDragOver = useCallback((e: React.DragEvent, dropTargetId: string) => {
        if (!e.dataTransfer.types.includes(FILE_DRAG_MIME)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setDragOverFolderId(dropTargetId)
    }, [])

    const handleFolderDragLeave = useCallback((dropTargetId: string) => {
        setDragOverFolderId((prev) => (prev === dropTargetId ? null : prev))
    }, [])

    const handleFolderDrop = useCallback(async (e: React.DragEvent, folderId: string | null) => {
        e.preventDefault()
        setDragOverFolderId(null)
        const raw = e.dataTransfer.getData(FILE_DRAG_MIME)
        if (!raw) return
        try {
            const ids: string[] = JSON.parse(raw)
            await Promise.all(ids.map((id) => apiService.moveFile(id, folderId)))
            setMessage({ type: 'success', text: `Moved ${ids.length} file${ids.length === 1 ? '' : 's'}` })
            setSelectedForDownload(new Set())
            fetchFiles()
        } catch (err: any) {
            setMessage({ type: 'error', text: err.message })
        }
    }, [fetchFiles])

    // ─── Cut / copy / paste ──────────────────────────────────────────────────
    const handleCopySelected = useCallback(() => {
        if (selectedForDownload.size === 0) return
        setClipboard({ mode: 'copy', fileIds: Array.from(selectedForDownload) })
        setMessage({ type: 'success', text: `Copied ${selectedForDownload.size} file${selectedForDownload.size === 1 ? '' : 's'}` })
    }, [selectedForDownload])

    const handleCutSelected = useCallback(() => {
        if (selectedForDownload.size === 0) return
        setClipboard({ mode: 'cut', fileIds: Array.from(selectedForDownload) })
        setMessage({ type: 'success', text: `Cut ${selectedForDownload.size} file${selectedForDownload.size === 1 ? '' : 's'}` })
    }, [selectedForDownload])

    const handlePasteClipboard = useCallback(async () => {
        if (!clipboard || clipboard.fileIds.length === 0) return
        setPasting(true)
        try {
            if (clipboard.mode === 'copy') {
                await Promise.all(clipboard.fileIds.map((id) => apiService.copyFile(id, currentFolder)))
                setMessage({ type: 'success', text: `Pasted ${clipboard.fileIds.length} file${clipboard.fileIds.length === 1 ? '' : 's'}` })
            } else {
                await Promise.all(clipboard.fileIds.map((id) => apiService.moveFile(id, currentFolder)))
                setMessage({ type: 'success', text: `Moved ${clipboard.fileIds.length} file${clipboard.fileIds.length === 1 ? '' : 's'}` })
                setClipboard(null)
            }
            await fetchFiles()
        } catch (err: any) {
            setMessage({ type: 'error', text: err.message })
        } finally {
            setPasting(false)
        }
    }, [clipboard, currentFolder, fetchFiles])

    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement
            if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return
            if (!(e.ctrlKey || e.metaKey)) return

            const key = e.key.toLowerCase()
            if (key === 'c') {
                if (selectedForDownload.size === 0) return
                e.preventDefault()
                handleCopySelected()
            } else if (key === 'x') {
                if (selectedForDownload.size === 0) return
                e.preventDefault()
                handleCutSelected()
            } else if (key === 'v') {
                if (!clipboard) return
                e.preventDefault()
                handlePasteClipboard()
            }
        }
        window.addEventListener('keydown', handler)
        return () => window.removeEventListener('keydown', handler)
    }, [selectedForDownload, clipboard, handleCopySelected, handleCutSelected, handlePasteClipboard])

    const handleSync = useCallback(async () => {
        setSyncing(true)
        try {
            await apiService.syncChannels()
            await fetchChannels()
            setMessage({ type: 'success', text: 'Channels synced!' })
        } catch (err: any) {
            setMessage({ type: 'error', text: err.message })
        } finally {
            setSyncing(false)
        }
    }, [fetchChannels])

    const sortedItems = useMemo(
        () =>
            [
                ...folders.map((f) => ({ ...f, type: 'folder' as const })),
                ...files.map((f) => ({ ...f, type: 'file' as const })),
            ].sort((a, b) => {
                if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
                if (sortBy === 'name')
                    return (
                        (a as any).name?.localeCompare((b as any).name) ||
                        (a as FileItem).original_name?.localeCompare((b as FileItem).original_name) ||
                        0
                    )
                if (sortBy === 'size') return (b as FileItem).file_size - (a as FileItem).file_size
                return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
            }),
        [folders, files, sortBy],
    )

    const totalSize = useMemo(() => files.reduce((acc, f) => acc + f.file_size, 0), [files])

    return (
        <div className="p-6 lg:p-10">
            {/* Header */}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight text-black dark:text-white">Files</h1>
                    <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                        {folders.length} folders · {files.length} files · {formatFileSize(totalSize)} total
                    </p>
                </div>
                <div className="flex gap-2">
                    <button
                        onClick={() => setShowNewFolder(true)}
                        className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-zinc-200 dark:border-zinc-800 px-4 py-2.5 text-sm font-medium text-black dark:text-white hover:bg-zinc-100 dark:hover:bg-zinc-900"
                    >
                        <Plus size={18} /> New Folder
                    </button>
                    <button
                        onClick={() => setShowUpload(!showUpload)}
                        className="inline-flex cursor-pointer items-center gap-2 rounded-xl bg-black px-5 py-2.5 text-sm font-semibold text-white hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
                    >
                        <Upload size={18} /> Upload
                    </button>
                    <button
                        onClick={handleSync}
                        disabled={syncing}
                        className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-zinc-200 dark:border-zinc-800 px-4 py-2.5 text-sm font-medium text-black dark:text-white hover:bg-zinc-100 dark:hover:bg-zinc-900 disabled:opacity-50"
                    >
                        {syncing ? (
                            <Loader2 size={18} className="animate-spin" />
                        ) : (
                            <RefreshCw size={18} />
                        )}
                        {syncing ? 'Syncing...' : 'Sync'}
                    </button>
                </div>
            </div>

            {/* Breadcrumb — also a drop target so a file can be dragged back out of the
                current folder onto "Home" or any ancestor, not just further into folders */}
            <div className="flex items-center gap-2 mb-6 text-sm">
                <button
                    onClick={goBack}
                    onDragOver={(e) => handleFolderDragOver(e, ROOT_DROP_ID)}
                    onDragLeave={() => handleFolderDragLeave(ROOT_DROP_ID)}
                    onDrop={(e) => handleFolderDrop(e, null)}
                    className={`flex cursor-pointer items-center gap-1 rounded-lg px-3 py-1.5 font-medium transition-colors ${dragOverFolderId === ROOT_DROP_ID
                        ? 'bg-zinc-200 dark:bg-zinc-800 ring-2 ring-black dark:ring-white'
                        : !currentFolder
                            ? 'bg-black text-white dark:bg-white dark:text-black'
                            : 'text-zinc-500 hover:text-black dark:hover:text-white'
                        }`}
                >
                    <Folder size={16} /> Home
                </button>
                {folderPath.map((folder, index) => (
                    <div key={folder.id} className="flex items-center gap-2">
                        <ChevronRight size={14} className="text-zinc-400" />
                        <button
                            onClick={() => setCurrentFolder(folder.id)}
                            onDragOver={(e) => handleFolderDragOver(e, folder.id)}
                            onDragLeave={() => handleFolderDragLeave(folder.id)}
                            onDrop={(e) => handleFolderDrop(e, folder.id)}
                            className={`rounded-lg px-3 py-1.5 font-medium transition-colors ${dragOverFolderId === folder.id
                                ? 'bg-zinc-200 dark:bg-zinc-800 ring-2 ring-black dark:ring-white'
                                : index === folderPath.length - 1
                                    ? 'bg-black text-white dark:bg-white dark:text-black'
                                    : 'text-zinc-500 hover:text-black dark:hover:text-white'
                                }`}
                        >
                            {folder.name}
                        </button>
                    </div>
                ))}
            </div>

            {/* New Folder Modal */}
            {showNewFolder && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
                    <div className="w-full max-w-md rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-6">
                        <h3 className="text-lg font-semibold text-black dark:text-white mb-4">New Folder</h3>
                        <input
                            type="text"
                            placeholder="Folder name"
                            value={newFolderName}
                            onChange={(e) => setNewFolderName(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleCreateFolder()}
                            className="w-full rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-black px-4 py-2.5 text-sm text-black dark:text-white outline-none mb-4"
                            autoFocus
                        />
                        <div className="flex gap-2 justify-end">
                            <button
                                onClick={() => {
                                    setShowNewFolder(false)
                                    setNewFolderName('')
                                }}
                                className="cursor-pointer rounded-xl px-4 py-2 text-sm text-zinc-500 hover:text-black dark:hover:text-white"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleCreateFolder}
                                className="cursor-pointer rounded-xl bg-black px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-black"
                            >
                                Create
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Delete Confirmation Modal */}
            {deleteConfirm && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
                    <div className="w-full max-w-md rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-6">
                        <h3 className="text-lg font-semibold text-black dark:text-white mb-2">
                            Delete {deleteConfirm.type === 'file' ? 'File' : 'Folder'}
                        </h3>
                        <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-6">
                            Are you sure you want to delete{' '}
                            <span className="font-medium text-black dark:text-white break-all">
                                &quot;{deleteConfirm.name}&quot;
                            </span>
                            ?{deleteConfirm.type === 'folder' && ' This will delete all files inside it.'} This action
                            cannot be undone.
                        </p>
                        <div className="flex gap-2 justify-end">
                            <button
                                onClick={() => setDeleteConfirm(null)}
                                className="cursor-pointer rounded-xl px-4 py-2 text-sm font-medium text-zinc-500 hover:text-black dark:hover:text-white border border-zinc-200 dark:border-zinc-800"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={deleteConfirm.type === 'file' ? handleDelete : handleDeleteFolder}
                                className="cursor-pointer rounded-xl px-4 py-2 text-sm font-semibold bg-red-600 text-white hover:bg-red-700"
                            >
                                Delete
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Rename Modal */}
            {renaming && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
                    <div className="w-full max-w-md rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-6">
                        <h3 className="text-lg font-semibold text-black dark:text-white mb-4">Rename {renaming.type}</h3>
                        <input
                            type="text"
                            value={renaming.name}
                            onChange={(e) => setRenaming({ ...renaming, name: e.target.value })}
                            onKeyDown={(e) => e.key === 'Enter' && handleRename()}
                            className="w-full rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-black px-4 py-2.5 text-sm text-black dark:text-white outline-none mb-4"
                            autoFocus
                        />
                        <div className="flex gap-2 justify-end">
                            <button
                                onClick={() => setRenaming(null)}
                                className="cursor-pointer rounded-xl px-4 py-2 text-sm text-zinc-500 hover:text-black dark:hover:text-white"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleRename}
                                className="cursor-pointer rounded-xl bg-black px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-black"
                            >
                                Rename
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Message */}
            {message && (
                <div
                    className={`mb-6 flex items-center gap-3 rounded-xl border p-4 ${message.type === 'success'
                        ? 'border-green-200 bg-green-50 text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-400'
                        : 'border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-400'
                        }`}
                >
                    {message.type === 'success' ? <CheckCircle size={18} /> : <AlertCircle size={18} />}
                    <p className="text-sm font-medium">{message.text}</p>
                    <button onClick={() => setMessage(null)} className="ml-auto">
                        <X size={16} />
                    </button>
                </div>
            )}

            {/* Upload Section */}
            {showUpload && (
                <div className="mb-8 rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 p-6">
                    <div className="flex items-center justify-between mb-4">
                        <h2 className="text-lg font-semibold text-black dark:text-white">
                            Upload Files {currentFolder && 'to this folder'}
                        </h2>
                        <button
                            onClick={closeUploadModal}
                            className="text-zinc-400 hover:text-black dark:hover:text-white"
                        >
                            <X size={20} />
                        </button>
                    </div>
                    <form onSubmit={handleStartUpload} className="space-y-4">
                        {/* Channel Select */}
                        <div>
                            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2">
                                Select Channel
                            </label>
                            <div className="relative" ref={channelDropdownRef}>
                                <button
                                    type="button"
                                    onClick={() => setShowChannelDropdown((v) => !v)}
                                    className="cursor-pointer w-full flex items-center justify-between rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-black px-4 py-2.5 text-sm text-black dark:text-white"
                                >
                                    <span className="truncate">
                                        {channels.find((ch) => ch.channel_id === selectedChannel)?.channel_title ||
                                            channels.find((ch) => ch.channel_id === selectedChannel)?.channel_username ||
                                            selectedChannel ||
                                            'Select channel'}
                                    </span>
                                    <svg
                                        width="14"
                                        height="14"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                        className="ml-2 flex-shrink-0"
                                    >
                                        <path d="M6 9l6 6 6-6" />
                                    </svg>
                                </button>
                                {showChannelDropdown && (
                                    <div className="cursor-pointer absolute left-0 right-0 top-12 z-50 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 shadow-lg overflow-hidden max-h-48 overflow-y-auto">
                                        {channels.length === 0 ? (
                                            <div className="px-4 py-3 text-sm text-zinc-400 text-center">
                                                No channels found
                                            </div>
                                        ) : (
                                            channels.map((ch) => (
                                                <button
                                                    key={ch.channel_id}
                                                    type="button"
                                                    onClick={() => {
                                                        setSelectedChannel(ch.channel_id)
                                                        setShowChannelDropdown(false)
                                                    }}
                                                    className={`cursor-pointer flex items-center justify-between w-full px-4 py-2.5 text-sm transition-colors text-left ${selectedChannel === ch.channel_id
                                                        ? 'bg-zinc-100 dark:bg-zinc-900 text-black dark:text-white font-medium'
                                                        : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-900'
                                                        }`}
                                                >
                                                    <span className="truncate">
                                                        {ch.channel_title || ch.channel_username || ch.channel_id}
                                                    </span>
                                                    {selectedChannel === ch.channel_id && (
                                                        <svg
                                                            width="14"
                                                            height="14"
                                                            viewBox="0 0 24 24"
                                                            fill="none"
                                                            stroke="currentColor"
                                                            strokeWidth="2.5"
                                                            className="ml-2 flex-shrink-0"
                                                        >
                                                            <path d="M20 6L9 17l-5-5" />
                                                        </svg>
                                                    )}
                                                </button>
                                            ))
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* File Input */}
                        <div>
                            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2">
                                Choose Files
                            </label>
                            {/* Drag & Drop Zone */}
                            <div
                                onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
                                onDragLeave={() => setIsDragging(false)}
                                onDrop={(e) => {
                                    e.preventDefault()
                                    setIsDragging(false)
                                    const droppedFiles = Array.from(e.dataTransfer.files || [])
                                    if (droppedFiles.length === 0) return
                                    setUploadQueue((prev) => [
                                        ...prev,
                                        ...droppedFiles.map((file) => ({
                                            id: crypto.randomUUID(),
                                            file,
                                            status: 'queued' as const,
                                            progress: 0,
                                        })),
                                    ])
                                    if (queueRunningRef.current) setTimeout(runUploadQueue, 0)
                                }}
                                onClick={() => fileInputRef.current?.click()}
                                className={`w-full cursor-pointer rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors
                                    ${isDragging
                                        ? 'border-black dark:border-white bg-zinc-100 dark:bg-zinc-900'
                                        : 'border-zinc-300 dark:border-zinc-700 hover:border-zinc-400 dark:hover:border-zinc-600'
                                    }`}
                            >
                                <Upload size={24} className="mx-auto mb-2 text-zinc-400" />
                                <p className="text-sm text-zinc-500 dark:text-zinc-400">
                                    Drag & drop files here, or <span className="font-medium text-black dark:text-white">browse</span>
                                </p>
                                <p className="text-xs text-zinc-400 mt-1">Max 2GB per file</p>
                            </div>
                            <input
                                ref={fileInputRef}
                                type="file"
                                multiple
                                onChange={handleFileSelect}
                                className="hidden"
                            />
                        </div>

                        {/* Queue Preview */}
                        {uploadQueue.length > 0 && (
                            <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 divide-y divide-zinc-200 dark:divide-zinc-800 max-h-64 overflow-y-auto">
                                {uploadQueue.map((item) => (
                                    <div key={item.id} className="flex items-center gap-3 p-3">
                                        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-black/10 dark:bg-white/10">
                                            <File size={18} className="text-black dark:text-white" />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className="text-sm font-medium text-black dark:text-white truncate">
                                                {item.file.name}
                                            </p>
                                            {item.status === 'uploading' ? (
                                                <div className="mt-1 h-1.5 w-full rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden">
                                                    <div
                                                        className="h-full rounded-full bg-black dark:bg-white transition-all duration-300 ease-out"
                                                        style={{ width: `${item.progress}%` }}
                                                    />
                                                </div>
                                            ) : item.status === 'error' ? (
                                                <p className="text-xs text-red-500 truncate">{item.error || 'Upload failed'}</p>
                                            ) : (
                                                <p className="text-xs text-zinc-400">
                                                    {formatFileSize(item.file.size)}
                                                    {item.status === 'cancelled' && ' · Cancelled'}
                                                </p>
                                            )}
                                        </div>
                                        <div className="flex-shrink-0">
                                            {item.status === 'uploading' ? (
                                                <span className="text-xs text-zinc-500">{item.progress}%</span>
                                            ) : item.status === 'done' ? (
                                                <CheckCircle size={18} className="text-green-500" />
                                            ) : item.status === 'error' ? (
                                                <AlertCircle size={18} className="text-red-500" />
                                            ) : (
                                                <button
                                                    type="button"
                                                    onClick={() => removeQueueItem(item.id)}
                                                    className="text-zinc-400 hover:text-red-500"
                                                >
                                                    <X size={16} />
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Upload Buttons */}
                        <div className="flex gap-2">
                            <button
                                type="submit"
                                disabled={queueRunning || !uploadQueue.some((it) => it.status === 'queued')}
                                className="cursor-pointer flex-1 rounded-xl bg-black px-5 py-3 text-sm font-semibold text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
                            >
                                {queueRunning ? (
                                    <span className="flex items-center justify-center gap-2">
                                        <Loader2 size={18} className="animate-spin" />
                                        Uploading {uploadQueue.filter((it) => it.status === 'done' || it.status === 'error').length}/{uploadQueue.length}
                                    </span>
                                ) : (
                                    <span className="flex items-center justify-center gap-2">
                                        <Upload size={18} />
                                        {uploadQueue.length > 0 ? `Upload ${uploadQueue.length} file${uploadQueue.length === 1 ? '' : 's'}` : 'Upload'}
                                    </span>
                                )}
                            </button>
                            {queueRunning && (
                                <button
                                    type="button"
                                    onClick={cancelAllUploads}
                                    className="rounded-xl border border-red-200 px-4 py-3 text-sm font-semibold text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
                                >
                                    Cancel All
                                </button>
                            )}
                        </div>
                    </form>
                </div>
            )}

            {/* Toolbar */}
            <div className="mb-6 flex flex-col sm:flex-row gap-4">
                <div className="flex flex-1 items-center gap-2">
                    <div className="flex flex-1 items-center gap-3 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 px-4 py-2.5">
                        <Search size={18} className="text-zinc-400" />
                        <input
                            type="text"
                            placeholder="Search files..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="flex-1 bg-transparent text-sm text-black dark:text-white placeholder-zinc-400 outline-none"
                        />
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    {/* Sort Dropdown */}
                    <div className="relative" ref={sortDropdownRef}>
                        <button
                            onClick={() => setShowSortDropdown((v) => !v)}
                            className="cursor-pointer flex items-center gap-2 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-black px-3 py-2.5 text-sm text-black dark:text-white"
                        >
                            <span>
                                {sortBy === 'date' ? 'Newest' : sortBy === 'name' ? 'Name' : 'Size'}
                            </span>
                            <svg
                                width="14"
                                height="14"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                            >
                                <path d="M6 9l6 6 6-6" />
                            </svg>
                        </button>
                        {showSortDropdown && (
                            <div className="cursor-pointer absolute right-0 top-11 z-50 w-36 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 shadow-lg overflow-hidden">
                                {[
                                    { value: 'date', label: 'Newest' },
                                    { value: 'name', label: 'Name' },
                                    { value: 'size', label: 'Size' },
                                ].map((opt) => (
                                    <button
                                        key={opt.value}
                                        onClick={() => {
                                            setSortBy(opt.value as any)
                                            setShowSortDropdown(false)
                                        }}
                                        className={`cursor-pointer flex items-center justify-between w-full px-4 py-2.5 text-sm transition-colors ${sortBy === opt.value
                                            ? 'bg-zinc-100 dark:bg-zinc-900 text-black dark:text-white font-medium'
                                            : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-900'
                                            }`}
                                    >
                                        {opt.label}
                                        {sortBy === opt.value && (
                                            <svg
                                                width="14"
                                                height="14"
                                                viewBox="0 0 24 24"
                                                fill="none"
                                                stroke="currentColor"
                                                strokeWidth="2.5"
                                            >
                                                <path d="M20 6L9 17l-5-5" />
                                            </svg>
                                        )}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* View Mode Toggles */}
                    <button
                        onClick={() => setViewMode('grid')}
                        className={`cursor-pointer rounded-xl p-2.5 ${viewMode === 'grid'
                            ? 'bg-black text-white dark:bg-white dark:text-black'
                            : 'text-zinc-400 hover:text-black dark:hover:text-white'
                            }`}
                    >
                        <Grid3X3 size={18} />
                    </button>
                    <button
                        onClick={() => setViewMode('list')}
                        className={`cursor-pointer rounded-xl p-2.5 ${viewMode === 'list'
                            ? 'bg-black text-white dark:bg-white dark:text-black'
                            : 'text-zinc-400 hover:text-black dark:hover:text-white'
                            }`}
                    >
                        <List size={18} />
                    </button>
                </div>
            </div>

            {/* Bulk Selection Bar */}
            {selectedForDownload.size > 0 && (
                <div className="mb-4 flex items-center gap-3 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 px-4 py-3">
                    <span className="text-sm font-medium text-black dark:text-white">
                        {selectedForDownload.size} selected
                    </span>
                    <button
                        onClick={handleDownloadSelected}
                        disabled={!!downloadBatchProgress}
                        className="cursor-pointer inline-flex items-center gap-2 rounded-lg bg-black px-3 py-1.5 text-sm font-semibold text-white hover:bg-zinc-800 disabled:opacity-60 disabled:cursor-not-allowed dark:bg-white dark:text-black dark:hover:bg-zinc-200"
                    >
                        {downloadBatchProgress ? (
                            <>
                                <Loader2 size={14} className="animate-spin" />
                                Downloading {Math.min(downloadBatchProgress.done + 1, downloadBatchProgress.total)}/{downloadBatchProgress.total}
                            </>
                        ) : (
                            <>
                                <Download size={14} /> Download Selected
                            </>
                        )}
                    </button>
                    <button
                        onClick={handleCopySelected}
                        disabled={!!downloadBatchProgress}
                        className="cursor-pointer rounded-lg border border-zinc-200 dark:border-zinc-800 px-3 py-1.5 text-sm font-medium text-black dark:text-white hover:bg-zinc-100 dark:hover:bg-zinc-900 disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                        Copy
                    </button>
                    <button
                        onClick={handleCutSelected}
                        disabled={!!downloadBatchProgress}
                        className="cursor-pointer rounded-lg border border-zinc-200 dark:border-zinc-800 px-3 py-1.5 text-sm font-medium text-black dark:text-white hover:bg-zinc-100 dark:hover:bg-zinc-900 disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                        Cut
                    </button>
                    <button
                        onClick={clearFileSelection}
                        disabled={!!downloadBatchProgress}
                        className="cursor-pointer text-sm text-zinc-500 hover:text-black dark:hover:text-white ml-auto disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                        Clear
                    </button>
                </div>
            )}

            {/* Clipboard Bar — persists independent of selection so you can navigate to
                another folder (or clear the selection) and still paste what you cut/copied */}
            {clipboard && (
                <div className="mb-6 flex items-center gap-3 rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-950 px-4 py-3">
                    <span className="text-sm font-medium text-black dark:text-white">
                        {clipboard.fileIds.length} file{clipboard.fileIds.length === 1 ? '' : 's'} {clipboard.mode === 'cut' ? 'cut' : 'copied'}
                    </span>
                    <button
                        onClick={handlePasteClipboard}
                        disabled={pasting}
                        className="cursor-pointer inline-flex items-center gap-2 rounded-lg bg-black px-3 py-1.5 text-sm font-semibold text-white hover:bg-zinc-800 disabled:opacity-60 disabled:cursor-not-allowed dark:bg-white dark:text-black dark:hover:bg-zinc-200"
                    >
                        {pasting ? <Loader2 size={14} className="animate-spin" /> : null}
                        Paste Here
                    </button>
                    <button
                        onClick={() => setClipboard(null)}
                        disabled={pasting}
                        className="cursor-pointer text-sm text-zinc-500 hover:text-black dark:hover:text-white ml-auto disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                        Clear
                    </button>
                </div>
            )}

            {/* Content */}
            {loading ? (
                <div className="flex items-center justify-center py-20">
                    <Loader2 size={32} className="animate-spin text-zinc-400" />
                </div>
            ) : sortedItems.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-20">
                    <Folder size={48} className="text-zinc-300 dark:text-zinc-700 mb-4" />
                    <p className="text-lg font-medium text-zinc-500 dark:text-zinc-400">This folder is empty</p>
                </div>
            ) : viewMode === 'grid' ? (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {sortedItems.map((item) =>
                        item.type === 'folder' ? (
                            <div
                                key={item.id}
                                onClick={() => navigateToFolder(item.id)}
                                onDragOver={(e) => handleFolderDragOver(e, item.id)}
                                onDragLeave={() => handleFolderDragLeave(item.id)}
                                onDrop={(e) => handleFolderDrop(e, item.id)}
                                className={`relative rounded-2xl border p-5 transition-all cursor-pointer ${dragOverFolderId === item.id
                                    ? 'border-black dark:border-white bg-zinc-100 dark:bg-zinc-900 ring-2 ring-black dark:ring-white'
                                    : 'border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 hover:border-zinc-400 dark:hover:border-zinc-600'
                                    }`}
                            >
                                <div className="flex items-start justify-between mb-4">
                                    <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-black/10 dark:bg-white/10">
                                        <FolderOpen size={24} className="text-black dark:text-white" />
                                    </div>
                                    <div className="flex gap-1">
                                        <Tooltip text="Rename">
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation()
                                                    setRenaming({ type: 'folder', id: item.id, name: item.name })
                                                }}
                                                className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-800 hover:text-black dark:hover:text-white"
                                            >
                                                <Pencil size={16} />
                                            </button>
                                        </Tooltip>
                                        <Tooltip text="Delete" color="red">
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation()
                                                    setDeleteConfirm({ type: 'folder', id: item.id, name: item.name })
                                                }}
                                                className="rounded-lg p-1.5 text-zinc-400 hover:bg-red-100 dark:hover:bg-red-950 hover:text-red-600"
                                            >
                                                <Trash2 size={16} />
                                            </button>
                                        </Tooltip>
                                    </div>
                                </div>
                                <p className="text-sm font-medium text-black dark:text-white truncate">{item.name}</p>
                                <span className="text-xs text-zinc-400">Folder</span>
                            </div>
                        ) : (
                            <div
                                key={item.id}
                                draggable
                                onDragStart={(e) => handleFileDragStart(e, item)}
                                className={`relative rounded-2xl border overflow-hidden transition-all cursor-grab active:cursor-grabbing ${selectedForDownload.has(item.id)
                                    ? 'border-black dark:border-white bg-zinc-100 dark:bg-zinc-900'
                                    : 'border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 hover:border-zinc-400 dark:hover:border-zinc-600'
                                    } ${clipboard?.mode === 'cut' && clipboard.fileIds.includes(item.id) ? 'opacity-50' : ''}`}
                            >
                                <input
                                    type="checkbox"
                                    checked={selectedForDownload.has(item.id)}
                                    onChange={() => toggleFileSelection(item.id)}
                                    onClick={(e) => e.stopPropagation()}
                                    className="absolute left-3 top-3 z-10 h-4 w-4 cursor-pointer accent-black dark:accent-white"
                                />
                                {item.mime_type?.startsWith('image/') && thumbnailUrls[item.telegram_message_id] ? (
                                    <div className="h-40 w-full overflow-hidden bg-zinc-100 dark:bg-zinc-900">
                                        <img
                                            src={thumbnailUrls[item.telegram_message_id]}
                                            alt={item.original_name}
                                            className="h-full w-full object-cover"
                                        />
                                    </div>
                                ) : (
                                    <div className="flex h-40 w-full items-center justify-center bg-zinc-100 dark:bg-zinc-900">
                                        {React.createElement(getFileIcon(item.mime_type), {
                                            size: 48,
                                            className: 'text-zinc-400',
                                        })}
                                    </div>
                                )}
                                <div className="p-4">
                                    <div className="flex items-start justify-between mb-2">
                                        <p className="text-sm font-medium text-black dark:text-white truncate flex-1 min-w-0 mr-2">
                                            {item.original_name}
                                        </p>
                                        <div className="flex gap-1">
                                            <Tooltip text="View">
                                                <button
                                                    onClick={() => handleView(item.telegram_message_id)}
                                                    className="cursor-pointer rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-800 hover:text-black dark:hover:text-white"
                                                >
                                                    <Eye size={16} />
                                                </button>
                                            </Tooltip>
                                            <Tooltip text="Download">
                                                <button
                                                    onClick={() =>
                                                        handleDownload(item.telegram_message_id, item.original_name)
                                                    }
                                                    disabled={downloadingIds.has(item.telegram_message_id)}
                                                    className="cursor-pointer rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-800 hover:text-black dark:hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
                                                >
                                                    {downloadingIds.has(item.telegram_message_id) ? (
                                                        <Loader2 size={16} className="animate-spin" />
                                                    ) : (
                                                        <Download size={16} />
                                                    )}
                                                </button>
                                            </Tooltip>
                                            <Tooltip text="Rename">
                                                <button
                                                    onClick={() =>
                                                        setRenaming({
                                                            type: 'file',
                                                            id: item.id,
                                                            name: item.original_name,
                                                        })
                                                    }
                                                    className="cursor-pointer rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-800 hover:text-black dark:hover:text-white"
                                                >
                                                    <Pencil size={16} />
                                                </button>
                                            </Tooltip>
                                            <Tooltip text="Delete" color="red">
                                                <button
                                                    onClick={() =>
                                                        setDeleteConfirm({
                                                            type: 'file',
                                                            id: item.id,
                                                            name: item.original_name,
                                                        })
                                                    }
                                                    className="cursor-pointer rounded-lg p-1.5 text-zinc-400 hover:bg-red-100 dark:hover:bg-red-950 hover:text-red-600 dark:hover:text-red-400"
                                                >
                                                    <Trash2 size={16} />
                                                </button>
                                            </Tooltip>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-3 text-xs text-zinc-400">
                                        <span>{formatFileSize(item.file_size)}</span>
                                        <span>·</span>
                                        <span>{formatDate(item.created_at)}</span>
                                    </div>
                                </div>
                            </div>
                        ),
                    )}
                </div>
            ) : (
                <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
                    {/* List Header */}
                    <div className="grid grid-cols-12 gap-4 px-6 py-3 bg-zinc-50 dark:bg-zinc-950 text-xs font-medium text-zinc-500 uppercase">
                        <div className="col-span-4">Name</div>
                        <div className="col-span-2">Size</div>
                        <div className="col-span-3">Date</div>
                        <div className="col-span-3">Actions</div>
                    </div>
                    {/* List Rows */}
                    {sortedItems.map((item) =>
                        item.type === 'folder' ? (
                            <div
                                key={item.id}
                                onClick={() => navigateToFolder(item.id)}
                                onDragOver={(e) => handleFolderDragOver(e, item.id)}
                                onDragLeave={() => handleFolderDragLeave(item.id)}
                                onDrop={(e) => handleFolderDrop(e, item.id)}
                                className={`grid grid-cols-12 gap-4 px-6 py-4 border-t border-zinc-100 dark:border-zinc-800 transition-colors items-center cursor-pointer ${dragOverFolderId === item.id
                                    ? 'bg-zinc-100 dark:bg-zinc-900 ring-2 ring-inset ring-black dark:ring-white'
                                    : 'hover:bg-zinc-50 dark:hover:bg-zinc-950'
                                    }`}
                            >
                                <div className="col-span-4 flex items-center gap-3">
                                    <Folder size={20} className="text-zinc-400" />
                                    <span className="text-sm font-medium text-black dark:text-white truncate min-w-0">
                                        {item.name}
                                    </span>
                                </div>
                                <div className="col-span-2 text-sm text-zinc-500">—</div>
                                <div className="col-span-3 text-sm text-zinc-500">{formatDate(item.created_at)}</div>
                                <div className="col-span-3 flex items-center gap-2">
                                    <Tooltip text="Rename">
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation()
                                                setRenaming({ type: 'folder', id: item.id, name: item.name })
                                            }}
                                            className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-800 hover:text-black dark:hover:text-white"
                                        >
                                            <Pencil size={16} />
                                        </button>
                                    </Tooltip>
                                    <Tooltip text="Delete" color="red">
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation()
                                                setDeleteConfirm({ type: 'folder', id: item.id, name: item.name })
                                            }}
                                            className="rounded-lg p-1.5 text-zinc-400 hover:bg-red-100 dark:hover:bg-red-950 hover:text-red-600"
                                        >
                                            <Trash2 size={16} />
                                        </button>
                                    </Tooltip>
                                </div>
                            </div>
                        ) : (
                            <div
                                key={item.id}
                                draggable
                                onDragStart={(e) => handleFileDragStart(e, item)}
                                className={`grid grid-cols-12 gap-4 px-6 py-4 border-t border-zinc-100 dark:border-zinc-800 transition-colors items-center cursor-grab active:cursor-grabbing ${selectedForDownload.has(item.id)
                                    ? 'bg-zinc-100 dark:bg-zinc-900'
                                    : 'hover:bg-zinc-50 dark:hover:bg-zinc-950'
                                    } ${clipboard?.mode === 'cut' && clipboard.fileIds.includes(item.id) ? 'opacity-50' : ''}`}
                            >
                                <div className="col-span-4 flex items-center gap-3">
                                    <input
                                        type="checkbox"
                                        checked={selectedForDownload.has(item.id)}
                                        onChange={() => toggleFileSelection(item.id)}
                                        className="h-4 w-4 cursor-pointer accent-black dark:accent-white flex-shrink-0"
                                    />
                                    {item.mime_type?.startsWith('image/') &&
                                        thumbnailUrls[item.telegram_message_id] ? (
                                        <img
                                            src={thumbnailUrls[item.telegram_message_id]}
                                            alt=""
                                            className="h-8 w-8 rounded object-cover"
                                        />
                                    ) : (
                                        React.createElement(getFileIcon(item.mime_type), {
                                            size: 20,
                                            className: 'text-zinc-400',
                                        })
                                    )}
                                    <span className="text-sm font-medium text-black dark:text-white truncate min-w-0">
                                        {item.original_name}
                                    </span>
                                </div>
                                <div className="col-span-2 text-sm text-zinc-500">
                                    {formatFileSize(item.file_size)}
                                </div>
                                <div className="col-span-3 text-sm text-zinc-500">{formatDate(item.created_at)}</div>
                                <div className="col-span-3 flex items-center gap-2">
                                    <Tooltip text="View">
                                        <button
                                            onClick={() => handleView(item.telegram_message_id)}
                                            className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-800 hover:text-black dark:hover:text-white"
                                        >
                                            <Eye size={16} />
                                        </button>
                                    </Tooltip>
                                    <Tooltip text="Download">
                                        <button
                                            onClick={() =>
                                                handleDownload(item.telegram_message_id, item.original_name)
                                            }
                                            disabled={downloadingIds.has(item.telegram_message_id)}
                                            className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-800 hover:text-black dark:hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
                                        >
                                            {downloadingIds.has(item.telegram_message_id) ? (
                                                <Loader2 size={16} className="animate-spin" />
                                            ) : (
                                                <Download size={16} />
                                            )}
                                        </button>
                                    </Tooltip>
                                    <Tooltip text="Rename">
                                        <button
                                            onClick={() =>
                                                setRenaming({
                                                    type: 'file',
                                                    id: item.id,
                                                    name: item.original_name,
                                                })
                                            }
                                            className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-800 hover:text-black dark:hover:text-white"
                                        >
                                            <Pencil size={16} />
                                        </button>
                                    </Tooltip>
                                    <Tooltip text="Delete" color="red">
                                        <button
                                            onClick={() =>
                                                setDeleteConfirm({
                                                    type: 'file',
                                                    id: item.id,
                                                    name: item.original_name,
                                                })
                                            }
                                            className="rounded-lg p-1.5 text-zinc-400 hover:bg-red-100 dark:hover:bg-red-950 hover:text-red-600 dark:hover:text-red-400"
                                        >
                                            <Trash2 size={16} />
                                        </button>
                                    </Tooltip>
                                </div>
                            </div>
                        ),
                    )}
                </div>
            )}
        </div>
    )
}