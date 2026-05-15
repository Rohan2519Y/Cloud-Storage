'use client'

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
    Upload, Search, Download, Trash2, Eye, Pencil,
    FileText, FileImage, FileVideo, FileAudio, FileArchive, File,
    X, Loader2, CheckCircle, AlertCircle, Grid3X3, List,
    Folder, FolderOpen, ChevronRight, Plus,
} from 'lucide-react'
import apiService from '../../../../services/api'

// ---------- static helpers (outside component) ----------
const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

const formatDate = (dateStr: string) => {
    const date = new Date(dateStr)
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const getFileIcon = (mimeType: string) => {
    if (mimeType?.startsWith('image/')) return FileImage
    if (mimeType?.startsWith('video/')) return FileVideo
    if (mimeType?.startsWith('audio/')) return FileAudio
    if (mimeType?.includes('zip') || mimeType?.includes('rar') || mimeType?.includes('tar')) return FileArchive
    if (mimeType?.includes('pdf') || mimeType?.includes('doc') || mimeType?.includes('txt')) return FileText
    return File
}

// ---------- types ----------
interface FileItem {
    id: string; original_name: string; file_size: number; mime_type: string
    telegram_message_id: string; channel_id: string; created_at: string; folder_id?: string | null
}
interface Channel {
    channel_id: string; channel_title: string; channel_username: string
}
interface FolderItem {
    id: string; name: string; parent_id: string | null; created_at: string
}

export default function FilesPage() {
    const [files, setFiles] = useState<FileItem[]>([])
    const [channels, setChannels] = useState<Channel[]>([])
    const [folders, setFolders] = useState<FolderItem[]>([])
    const [currentFolder, setCurrentFolder] = useState<string | null>(null)
    const [folderPath, setFolderPath] = useState<FolderItem[]>([])
    const [loading, setLoading] = useState(true)
    const [uploading, setUploading] = useState(false)
    const [uploadProgress, setUploadProgress] = useState(0)
    const [searchQuery, setSearchQuery] = useState('')
    const [selectedChannel, setSelectedChannel] = useState('')
    const [showUpload, setShowUpload] = useState(false)
    const [showNewFolder, setShowNewFolder] = useState(false)
    const [newFolderName, setNewFolderName] = useState('')
    const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid')
    const [sortBy, setSortBy] = useState<'name' | 'size' | 'date'>('date')
    const [message, setMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null)
    const [selectedFile, setSelectedFile] = useState<File | null>(null)
    const [thumbnailUrls, setThumbnailUrls] = useState<Record<string, string>>({})
    const [renaming, setRenaming] = useState<{ type: 'file' | 'folder', id: string, name: string } | null>(null)

    const fileInputRef = useRef<HTMLInputElement>(null)
    const xhrRef = useRef<XMLHttpRequest | null>(null)
    const evtSourceRef = useRef<EventSource | null>(null)
    const uploadIdRef = useRef<string>('')
    const uploadActiveRef = useRef(false)
    const thumbnailUrlMapRef = useRef<Record<string, string>>({})

    // ---------- data fetching (useCallback) ----------
    const fetchFolders = useCallback(async () => {
        try {
            const res = await fetch(`${apiService['baseUrl'] || process.env.NEXT_PUBLIC_API_URL}/api/folders?parent_id=${currentFolder || 'null'}`, {
                headers: { Authorization: `Bearer ${apiService.getToken()}` }
            })
            const data = await res.json()
            if (data.success) setFolders(data.folders || [])
        } catch (err) { console.error('Failed to fetch folders:', err) }
    }, [currentFolder])

    const fetchFiles = useCallback(async () => {
        try {
            const res = await fetch(`${apiService['baseUrl'] || process.env.NEXT_PUBLIC_API_URL}/api/files?folder_id=${currentFolder || 'null'}`, {
                headers: { Authorization: `Bearer ${apiService.getToken()}` }
            })
            const data = await res.json()
            if (data.success) {
                setFiles(data.files || [])
                data.files?.forEach((file: FileItem) => {
                    if (file.mime_type?.startsWith('image/') && !thumbnailUrlMapRef.current[file.telegram_message_id]) {
                        loadThumbnail(file.telegram_message_id)
                    }
                })
            }
        } catch (err) { console.error('Failed to fetch files:', err) } finally { setLoading(false) }
    }, [currentFolder])

    const fetchChannels = useCallback(async () => {
        try {
            const data = await apiService.getChannels()
            if (data.success) {
                if (data.channels?.length === 0) {
                    // No channels in DB — sync from Telegram first
                    await apiService.syncChannels()
                    const synced = await apiService.getChannels()
                    if (synced.success) {
                        setChannels(synced.channels || [])
                        if (synced.channels?.length > 0) setSelectedChannel(synced.channels[0].channel_id)
                    }
                } else {
                    setChannels(data.channels || [])
                    if (data.channels?.length > 0) setSelectedChannel(data.channels[0].channel_id)
                }
            }
        } catch (err) { console.error('Failed to fetch channels:', err) }
    }, [])

    const fetchFolderPath = useCallback(async (folderId: string) => {
        try {
            const res = await fetch(`${apiService['baseUrl'] || process.env.NEXT_PUBLIC_API_URL}/api/folders/path/${folderId}`, {
                headers: { Authorization: `Bearer ${apiService.getToken()}` }
            })
            const data = await res.json()
            if (data.success) setFolderPath(data.path || [])
        } catch (err) { }
    }, [])

    const loadThumbnail = useCallback(async (messageId: string) => {
        try {
            const blob = await apiService.downloadFileAsBlob(messageId)
            const url = URL.createObjectURL(blob)
            thumbnailUrlMapRef.current[messageId] = url
            setThumbnailUrls(prev => ({ ...prev, [messageId]: url }))
        } catch (err) { }
    }, [])

    // ---------- effects ----------
    useEffect(() => { apiService.initToken(); fetchChannels() }, [fetchChannels])

    useEffect(() => {
        setLoading(true)
        fetchFolders()
        fetchFiles()
        if (currentFolder) fetchFolderPath(currentFolder)
        else setFolderPath([])
    }, [currentFolder, fetchFolders, fetchFiles, fetchFolderPath])

    useEffect(() => {
        const urls = thumbnailUrlMapRef.current
        return () => { Object.values(urls).forEach(url => URL.revokeObjectURL(url)) }
    }, [])

    useEffect(() => {
        return () => {
            if (uploadActiveRef.current) {
                xhrRef.current?.abort()
                evtSourceRef.current?.close()
            }
        }
    }, [])

    // ---------- folder operations ----------
    const handleCreateFolder = useCallback(async () => {
        if (!newFolderName.trim()) return
        try {
            const res = await fetch(`${apiService['baseUrl'] || process.env.NEXT_PUBLIC_API_URL}/api/folders`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiService.getToken()}` },
                body: JSON.stringify({ name: newFolderName, parent_id: currentFolder })
            })
            const data = await res.json()
            if (data.success) {
                setShowNewFolder(false); setNewFolderName(''); fetchFolders()
                setMessage({ type: 'success', text: 'Folder created' })
            }
        } catch (err: any) { setMessage({ type: 'error', text: err.message }) }
    }, [newFolderName, currentFolder, fetchFolders])

    const navigateToFolder = useCallback((folderId: string) => setCurrentFolder(folderId), [])
    const goBack = useCallback(() => setCurrentFolder(null), [])

    const handleDeleteFolder = useCallback(async (folderId: string) => {
        if (!confirm('Delete this folder and all its contents?')) return
        try {
            const res = await fetch(`${apiService['baseUrl'] || process.env.NEXT_PUBLIC_API_URL}/api/folders/${folderId}`, {
                method: 'DELETE', headers: { Authorization: `Bearer ${apiService.getToken()}` }
            })
            const data = await res.json()
            if (data.success) { setFolders(prev => prev.filter(f => f.id !== folderId)); setMessage({ type: 'success', text: 'Folder deleted' }) }
        } catch (err: any) { setMessage({ type: 'error', text: err.message }) }
    }, [])

    // ---------- file operations ----------
    const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]; if (file) setSelectedFile(file)
    }, [])

    const handleUpload = useCallback(async (e: React.FormEvent) => {
        e.preventDefault()
        const fileInput = fileInputRef.current
        if (!fileInput?.files?.length) return
        const file = fileInput.files[0]
        const uploadId = crypto.randomUUID()
        uploadIdRef.current = uploadId
        const token = apiService.getToken()!
        uploadActiveRef.current = true
        setUploading(true); setUploadProgress(0); setMessage(null)
        const evtSource = new EventSource(`${apiService['baseUrl'] || process.env.NEXT_PUBLIC_API_URL}/api/upload-progress/${uploadId}?token=${token}`)
        evtSource.onmessage = (e) => { const d = JSON.parse(e.data); setUploadProgress(d.progress); if (d.progress >= 100) { evtSource.close(); uploadActiveRef.current = false } }
        evtSource.onerror = () => { evtSource.close(); uploadActiveRef.current = false }
        evtSourceRef.current = evtSource
        const xhr = new XMLHttpRequest(); xhrRef.current = xhr
        const formData = new FormData(); formData.append('file', file)
        const params = new URLSearchParams({ channelId: selectedChannel, uploadId, ...(currentFolder ? { folderId: currentFolder } : {}) })
        xhr.addEventListener('load', () => {
            evtSource.close(); uploadActiveRef.current = false
            try {
                const data = JSON.parse(xhr.responseText)
                if (data.success) { setUploadProgress(100); setMessage({ type: 'success', text: `${file.name} uploaded!` }); setShowUpload(false); setSelectedFile(null); if (fileInput) fileInput.value = ''; fetchFiles() }
                else setMessage({ type: 'error', text: data.error || 'Upload failed' })
            } catch { setMessage({ type: 'error', text: 'Upload failed' }) }
            setUploading(false)
        })
        xhr.addEventListener('error', () => { evtSource.close(); uploadActiveRef.current = false; setMessage({ type: 'error', text: 'Network error' }); setUploading(false) })
        xhr.addEventListener('abort', () => { evtSource.close(); uploadActiveRef.current = false; setUploading(false); setUploadProgress(0) })
        xhr.open('POST', `${apiService['baseUrl'] || process.env.NEXT_PUBLIC_API_URL}/api/upload?${params}`)
        xhr.setRequestHeader('Authorization', `Bearer ${token}`)
        xhr.send(formData)
    }, [selectedChannel, currentFolder, fetchFiles])

    const handleDownload = useCallback(async (messageId: string, fileName: string) => {
        try {
            const blob = await apiService.downloadFileAsBlob(messageId)
            const url = window.URL.createObjectURL(blob)
            const a = document.createElement('a'); a.href = url; a.download = fileName
            document.body.appendChild(a); a.click()
            window.URL.revokeObjectURL(url); document.body.removeChild(a)
        } catch (err: any) { setMessage({ type: 'error', text: err.message }) }
    }, [])

    const handleView = useCallback(async (messageId: string) => {
        try {
            const blob = await apiService.viewFileAsBlob(messageId)
            const url = window.URL.createObjectURL(blob)
            window.open(url, '_blank')
            setTimeout(() => window.URL.revokeObjectURL(url), 5000)
        } catch (err: any) { setMessage({ type: 'error', text: err.message }) }
    }, [])

    const handleDelete = useCallback(async (id: string) => {
        if (!confirm('Are you sure you want to delete this file?')) return
        try {
            const data = await apiService.deleteFile(id)
            if (data.success) { setFiles(prev => prev.filter(f => f.id !== id)); setMessage({ type: 'success', text: 'File deleted' }) }
        } catch (err: any) { setMessage({ type: 'error', text: err.message }) }
    }, [])

    const handleRename = useCallback(async () => {
        if (!renaming || !renaming.name.trim()) return
        try {
            const endpoint = renaming.type === 'file'
                ? `${apiService['baseUrl'] || process.env.NEXT_PUBLIC_API_URL}/api/files/${renaming.id}/rename`
                : `${apiService['baseUrl'] || process.env.NEXT_PUBLIC_API_URL}/api/folders/${renaming.id}/rename`
            const res = await fetch(endpoint, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiService.getToken()}` },
                body: JSON.stringify({ newName: renaming.name })
            })
            const data = await res.json()
            if (data.success) { setRenaming(null); fetchFiles(); fetchFolders(); setMessage({ type: 'success', text: 'Renamed' }) }
        } catch (err: any) { setMessage({ type: 'error', text: err.message }) }
    }, [renaming, fetchFiles, fetchFolders])

    // ---------- memoized sorted items ----------
    const sortedItems = useMemo(() => [
        ...folders.map(f => ({ ...f, type: 'folder' as const })),
        ...files.map(f => ({ ...f, type: 'file' as const })),
    ].sort((a, b) => {
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
        if (sortBy === 'name') return (a as any).name?.localeCompare((b as any).name) || (a as FileItem).original_name?.localeCompare((b as FileItem).original_name) || 0
        if (sortBy === 'size') return (b as FileItem).file_size - (a as FileItem).file_size
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    }), [folders, files, sortBy])

    const totalSize = useMemo(() => files.reduce((acc, f) => acc + f.file_size, 0), [files])

    // ---------- render ----------
    return (
        <div className="p-6 lg:p-10">
            {/* Header */}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight text-black dark:text-white">Files</h1>
                    <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{folders.length} folders · {files.length} files · {formatFileSize(totalSize)} total</p>
                </div>
                <div className="flex gap-2">
                    <button onClick={() => setShowNewFolder(true)} className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-zinc-200 dark:border-zinc-800 px-4 py-2.5 text-sm font-medium text-black dark:text-white hover:bg-zinc-100 dark:hover:bg-zinc-900"><Plus size={18} /> New Folder</button>
                    <button onClick={() => setShowUpload(!showUpload)} className="inline-flex cursor-pointer items-center gap-2 rounded-xl bg-black px-5 py-2.5 text-sm font-semibold text-white hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"><Upload size={18} /> Upload</button>
                </div>
            </div>

            {/* Breadcrumb */}
            <div className="flex items-center gap-2 mb-6 text-sm">
                <button onClick={goBack} className={`flex cursor-pointer items-center gap-1 rounded-lg px-3 py-1.5 font-medium transition-colors ${!currentFolder ? 'bg-black text-white dark:bg-white dark:text-black' : 'text-zinc-500 hover:text-black dark:hover:text-white'}`}><Folder size={16} /> Home</button>
                {folderPath.map((folder, index) => (
                    <div key={folder.id} className="flex items-center gap-2">
                        <ChevronRight size={14} className="text-zinc-400" />
                        <button onClick={() => setCurrentFolder(folder.id)} className={`rounded-lg px-3 py-1.5 font-medium transition-colors ${index === folderPath.length - 1 ? 'bg-black text-white dark:bg-white dark:text-black' : 'text-zinc-500 hover:text-black dark:hover:text-white'}`}>{folder.name}</button>
                    </div>
                ))}
            </div>

            {/* New Folder Modal */}
            {showNewFolder && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
                    <div className="w-full max-w-md rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-6">
                        <h3 className="text-lg font-semibold text-black dark:text-white mb-4">New Folder</h3>
                        <input type="text" placeholder="Folder name" value={newFolderName} onChange={(e) => setNewFolderName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleCreateFolder()} className="w-full rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-black px-4 py-2.5 text-sm text-black dark:text-white outline-none mb-4" autoFocus />
                        <div className="flex gap-2 justify-end">
                            <button onClick={() => { setShowNewFolder(false); setNewFolderName('') }} className="rounded-xl px-4 py-2 text-sm text-zinc-500 hover:text-black dark:hover:text-white">Cancel</button>
                            <button onClick={handleCreateFolder} className="rounded-xl bg-black px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-black">Create</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Rename Modal */}
            {renaming && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
                    <div className="w-full max-w-md rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-6">
                        <h3 className="text-lg font-semibold text-black dark:text-white mb-4">Rename {renaming.type}</h3>
                        <input type="text" value={renaming.name} onChange={(e) => setRenaming({ ...renaming, name: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && handleRename()} className="w-full rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-black px-4 py-2.5 text-sm text-black dark:text-white outline-none mb-4" autoFocus />
                        <div className="flex gap-2 justify-end">
                            <button onClick={() => setRenaming(null)} className="rounded-xl px-4 py-2 text-sm text-zinc-500 hover:text-black dark:hover:text-white">Cancel</button>
                            <button onClick={handleRename} className="rounded-xl bg-black px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-black">Rename</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Message Toast */}
            {message && (
                <div className={`mb-6 flex items-center gap-3 rounded-xl border p-4 ${message.type === 'success' ? 'border-green-200 bg-green-50 text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-400' : 'border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-400'}`}>
                    {message.type === 'success' ? <CheckCircle size={18} /> : <AlertCircle size={18} />}
                    <p className="text-sm font-medium">{message.text}</p>
                    <button onClick={() => setMessage(null)} className="ml-auto"><X size={16} /></button>
                </div>
            )}

            {/* Upload Panel */}
            {showUpload && (
                <div className="mb-8 rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 p-6">
                    <div className="flex items-center justify-between mb-4">
                        <h2 className="text-lg font-semibold text-black dark:text-white">Upload File {currentFolder && 'to this folder'}</h2>
                        <button onClick={() => { setShowUpload(false); setSelectedFile(null); setUploadProgress(0) }} className="text-zinc-400 hover:text-black dark:hover:text-white"><X size={20} /></button>
                    </div>
                    <form onSubmit={handleUpload} className="space-y-4">
                        <div><label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2">Select Channel</label>
                            <select value={selectedChannel} onChange={(e) => setSelectedChannel(e.target.value)} className="w-full rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-black px-4 py-2.5 text-sm text-black dark:text-white outline-none">{channels.map((ch) => (<option key={ch.channel_id} value={ch.channel_id}>{ch.channel_title || ch.channel_username || ch.channel_id}</option>))}</select>
                        </div>
                        <div><label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2">Choose File</label>
                            <input ref={fileInputRef} type="file" onChange={handleFileSelect} className="w-full cursor-pointer rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-black px-4 py-2.5 text-sm text-black dark:text-white file:mr-4 file:rounded-lg file:border-0 file:bg-black file:px-4 file:py-1.5 file:text-xs file:font-semibold file:text-white dark:file:bg-white dark:file:text-black" />
                        </div>
                        {selectedFile && (
                            <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-4">
                                <div className="flex items-center gap-3 mb-3">
                                    {selectedFile.type.startsWith('image/') ? <img src={URL.createObjectURL(selectedFile)} alt="Preview" className="h-16 w-16 rounded-lg object-cover" /> : <div className="flex h-16 w-16 items-center justify-center rounded-lg bg-black/10 dark:bg-white/10"><File size={28} className="text-black dark:text-white" /></div>}
                                    <div className="flex-1 min-w-0"><p className="text-sm font-medium text-black dark:text-white truncate">{selectedFile.name}</p><p className="text-xs text-zinc-400">{formatFileSize(selectedFile.size)}</p></div>
                                </div>
                                {uploading && (<div className="space-y-2 mt-3"><div className="flex items-center justify-between text-xs text-zinc-500"><span>Uploading...</span><span>{uploadProgress}%</span></div><div className="h-2 w-full rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden"><div className="h-full rounded-full bg-black dark:bg-white transition-all duration-300 ease-out" style={{ width: `${uploadProgress}%` }} /></div></div>)}
                            </div>
                        )}
                        <div className="flex gap-2">
                            <button type="submit" disabled={uploading || !selectedFile} className="flex-1 rounded-xl bg-black px-5 py-3 text-sm font-semibold text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-zinc-200">{uploading ? <span className="flex items-center justify-center gap-2"><Loader2 size={18} className="animate-spin" />{uploadProgress}%</span> : <span className="flex items-center justify-center gap-2"><Upload size={18} /> Upload</span>}</button>
                            {uploading && <button type="button" onClick={() => { xhrRef.current?.abort(); evtSourceRef.current?.close(); setUploading(false); setUploadProgress(0); setSelectedFile(null); if (fileInputRef.current) fileInputRef.current.value = '' }} className="rounded-xl border border-red-200 px-4 py-3 text-sm font-semibold text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950">Cancel</button>}
                        </div>
                    </form>
                </div>
            )}

            {/* Toolbar */}
            <div className="mb-6 flex flex-col sm:flex-row gap-4">
                <div className="flex flex-1 items-center gap-2">
                    <div className="flex flex-1 items-center gap-3 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 px-4 py-2.5"><Search size={18} className="text-zinc-400" /><input type="text" placeholder="Search files..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="flex-1 bg-transparent text-sm text-black dark:text-white placeholder-zinc-400 outline-none" /></div>
                </div>
                <div className="flex items-center gap-2">
                    <select value={sortBy} onChange={(e) => setSortBy(e.target.value as any)} className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-black px-3 py-2.5 text-sm text-black dark:text-white outline-none"><option value="date">Newest</option><option value="name">Name</option><option value="size">Size</option></select>
                    <button onClick={() => setViewMode('grid')} className={`rounded-xl p-2.5 ${viewMode === 'grid' ? 'bg-black text-white dark:bg-white dark:text-black' : 'text-zinc-400 hover:text-black dark:hover:text-white'}`}><Grid3X3 size={18} /></button>
                    <button onClick={() => setViewMode('list')} className={`rounded-xl p-2.5 ${viewMode === 'list' ? 'bg-black text-white dark:bg-white dark:text-black' : 'text-zinc-400 hover:text-black dark:hover:text-white'}`}><List size={18} /></button>
                </div>
            </div>

            {/* Items */}
            {loading ? <div className="flex items-center justify-center py-20"><Loader2 size={32} className="animate-spin text-zinc-400" /></div>
                : sortedItems.length === 0 ? <div className="flex flex-col items-center justify-center py-20"><Folder size={48} className="text-zinc-300 dark:text-zinc-700 mb-4" /><p className="text-lg font-medium text-zinc-500 dark:text-zinc-400">This folder is empty</p></div>
                    : viewMode === 'grid' ? (
                        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                            {sortedItems.map((item) => item.type === 'folder' ? (
                                <div key={item.id} onClick={() => navigateToFolder(item.id)} className="group relative rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 p-5 transition-all hover:border-zinc-400 dark:hover:border-zinc-600 cursor-pointer">
                                    <div className="flex items-start justify-between mb-4">
                                        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-black/10 dark:bg-white/10"><FolderOpen size={24} className="text-black dark:text-white" /></div>
                                        <div className="flex gap-1">
                                            <button onClick={(e) => { e.stopPropagation(); setRenaming({ type: 'folder', id: item.id, name: item.name }) }} className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-800 hover:text-black dark:hover:text-white"><Pencil size={16} /></button>
                                            <button onClick={(e) => { e.stopPropagation(); handleDeleteFolder(item.id) }} className="rounded-lg p-1.5 text-zinc-400 hover:bg-red-100 dark:hover:bg-red-950 hover:text-red-600"><Trash2 size={16} /></button>
                                        </div>
                                    </div>
                                    <p className="text-sm font-medium text-black dark:text-white truncate">{item.name}</p>
                                    <span className="text-xs text-zinc-400">Folder</span>
                                </div>
                            ) : (
                                <div key={item.id} className="group relative rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 overflow-hidden transition-all hover:border-zinc-400 dark:hover:border-zinc-600">
                                    {item.mime_type?.startsWith('image/') && thumbnailUrls[item.telegram_message_id] ? <div className="h-40 w-full overflow-hidden bg-zinc-100 dark:bg-zinc-900"><img src={thumbnailUrls[item.telegram_message_id]} alt={item.original_name} className="h-full w-full object-cover" /></div>
                                        : <div className="flex h-40 w-full items-center justify-center bg-zinc-100 dark:bg-zinc-900">{React.createElement(getFileIcon(item.mime_type), { size: 48, className: 'text-zinc-400' })}</div>}
                                    <div className="p-4">
                                        <div className="flex items-start justify-between mb-2">
                                            <p className="text-sm font-medium text-black dark:text-white truncate flex-1 mr-2">{item.original_name}</p>
                                            <div className="flex gap-1">
                                                <button onClick={() => handleView(item.telegram_message_id)} className="cursor-pointer rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-800 hover:text-black dark:hover:text-white"><Eye size={16} /></button>
                                                <button onClick={() => handleDownload(item.telegram_message_id, item.original_name)} className="cursor-pointer rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-800 hover:text-black dark:hover:text-white"><Download size={16} /></button>
                                                <button onClick={() => setRenaming({ type: 'file', id: item.id, name: item.original_name })} className="cursor-pointer rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-800 hover:text-black dark:hover:text-white"><Pencil size={16} /></button>
                                                <button onClick={() => handleDelete(item.id)} className="cursor-pointer rounded-lg p-1.5 text-zinc-400 hover:bg-red-100 dark:hover:bg-red-950 hover:text-red-600 dark:hover:text-red-400"><Trash2 size={16} /></button>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-3 text-xs text-zinc-400"><span>{formatFileSize(item.file_size)}</span><span>·</span><span>{formatDate(item.created_at)}</span></div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
                            <div className="grid grid-cols-12 gap-4 px-6 py-3 bg-zinc-50 dark:bg-zinc-950 text-xs font-medium text-zinc-500 uppercase"><div className="col-span-4">Name</div><div className="col-span-2">Size</div><div className="col-span-3">Date</div><div className="col-span-3">Actions</div></div>
                            {sortedItems.map((item) => item.type === 'folder' ? (
                                <div key={item.id} onClick={() => navigateToFolder(item.id)} className="grid grid-cols-12 gap-4 px-6 py-4 border-t border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-950 transition-colors items-center cursor-pointer">
                                    <div className="col-span-4 flex items-center gap-3"><Folder size={20} className="text-zinc-400" /><span className="text-sm font-medium text-black dark:text-white truncate">{item.name}</span></div>
                                    <div className="col-span-2 text-sm text-zinc-500">—</div>
                                    <div className="col-span-3 text-sm text-zinc-500">{formatDate(item.created_at)}</div>
                                    <div className="col-span-3 flex items-center gap-2">
                                        <button onClick={(e) => { e.stopPropagation(); setRenaming({ type: 'folder', id: item.id, name: item.name }) }} className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-800 hover:text-black dark:hover:text-white"><Pencil size={16} /></button>
                                        <button onClick={(e) => { e.stopPropagation(); handleDeleteFolder(item.id) }} className="rounded-lg p-1.5 text-zinc-400 hover:bg-red-100 dark:hover:bg-red-950 hover:text-red-600"><Trash2 size={16} /></button>
                                    </div>
                                </div>
                            ) : (
                                <div key={item.id} className="grid grid-cols-12 gap-4 px-6 py-4 border-t border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-950 transition-colors items-center">
                                    <div className="col-span-4 flex items-center gap-3">{item.mime_type?.startsWith('image/') && thumbnailUrls[item.telegram_message_id] ? <img src={thumbnailUrls[item.telegram_message_id]} alt="" className="h-8 w-8 rounded object-cover" /> : React.createElement(getFileIcon(item.mime_type), { size: 20, className: 'text-zinc-400' })}<span className="text-sm font-medium text-black dark:text-white truncate">{item.original_name}</span></div>
                                    <div className="col-span-2 text-sm text-zinc-500">{formatFileSize(item.file_size)}</div>
                                    <div className="col-span-3 text-sm text-zinc-500">{formatDate(item.created_at)}</div>
                                    <div className="col-span-3 flex items-center gap-2">
                                        <button onClick={() => handleView(item.telegram_message_id)} className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-800 hover:text-black dark:hover:text-white"><Eye size={16} /></button>
                                        <button onClick={() => handleDownload(item.telegram_message_id, item.original_name)} className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-800 hover:text-black dark:hover:text-white"><Download size={16} /></button>
                                        <button onClick={() => setRenaming({ type: 'file', id: item.id, name: item.original_name })} className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-800 hover:text-black dark:hover:text-white"><Pencil size={16} /></button>
                                        <button onClick={() => handleDelete(item.id)} className="rounded-lg p-1.5 text-zinc-400 hover:bg-red-100 dark:hover:bg-red-950 hover:text-red-600 dark:hover:text-red-400"><Trash2 size={16} /></button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
        </div>
    )
}