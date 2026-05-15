const express = require('express');
const router = express.Router();
const busboy = require('busboy');
const { Readable } = require('stream');
const { InputMedia } = require('@mtcute/node');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const pool = require('../utils/database');
const tgManager = require('../utils/telegramClientManager');

const uploadProgressMap = new Map();
const uploadCancelMap = new Map();

// ─── Auth middleware ─────────────────────────────────────────────────────────

async function authenticateUser(req, res, next) {
    try {
        const token = req.headers.authorization?.replace('Bearer ', '');
        if (!token) return res.status(401).json({ error: 'Authentication required' });
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const [users] = await pool.execute('SELECT * FROM users WHERE id = ?', [decoded.userId]);
        if (users.length === 0) return res.status(401).json({ error: 'User not found' });
        req.user = users[0];
        next();
    } catch (err) {
        res.status(401).json({ error: 'Invalid token' });
    }
}

// ─── Rate limiter ─────────────────────────────────────────────────────────────

const rateLimitMap = new Map();
function rateLimit(maxRequests, windowMs) {
    return (req, res, next) => {
        const key = req.ip;
        const now = Date.now();
        const entry = rateLimitMap.get(key) || { count: 0, resetAt: now + windowMs };
        if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + windowMs; }
        entry.count++;
        rateLimitMap.set(key, entry);
        if (entry.count > maxRequests) return res.status(429).json({ error: 'Too many requests. Please slow down.' });
        next();
    };
}
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of rateLimitMap) if (now > v.resetAt) rateLimitMap.delete(k);
}, 5 * 60 * 1000);

// ─── Concurrent upload limiter ───────────────────────────────────────────────
// mtcute streams in 512KB parts — RAM per upload is constant regardless of file size
// Render free (512MB) → safely handle more concurrent uploads

let activeUploads = 0;
const MAX_CONCURRENT_UPLOADS = 3;

// ─── HEALTH ──────────────────────────────────────────────────────────────────

router.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        activeUploads,
        maxConcurrentUploads: MAX_CONCURRENT_UPLOADS,
        cachedTelegramClients: tgManager.clients?.size ?? 0,
        mode: 'mtcute-streaming',
    });
});

// ─── SSE PROGRESS ────────────────────────────────────────────────────────────

router.get('/upload-progress/:uploadId', async (req, res) => {
    const token = req.query.token || req.headers.authorization?.replace('Bearer ', '');
    try { jwt.verify(token, process.env.JWT_SECRET); }
    catch { return res.status(401).end(); }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const id = req.params.uploadId;
    res.write(`data: ${JSON.stringify({ progress: 0 })}\n\n`);

    const interval = setInterval(() => {
        const progress = uploadProgressMap.get(id);
        if (progress !== undefined) {
            res.write(`data: ${JSON.stringify({ progress })}\n\n`);
            if (progress >= 100) {
                clearInterval(interval);
                uploadProgressMap.delete(id);
                res.end();
            }
        } else {
            res.write(`: heartbeat\n\n`);
        }
    }, 300);

    req.on('close', () => {
        clearInterval(interval);
        uploadProgressMap.delete(id);
    });
});

// ─── CANCEL ──────────────────────────────────────────────────────────────────

router.post('/upload-cancel/:uploadId', async (req, res) => {
    const token = req.query.token || req.headers.authorization?.replace('Bearer ', '');
    try { jwt.verify(token, process.env.JWT_SECRET); }
    catch { return res.status(401).end(); }
    const id = req.params.uploadId;
    uploadCancelMap.set(id, true);
    uploadProgressMap.delete(id);
    res.json({ success: true });
});

// ─── UPLOAD ──────────────────────────────────────────────────────────────────
// mtcute uploadFile accepts a Node.js Readable stream + fileSize.
// It reads the stream in 512KB MTProto parts — never loads the whole file into RAM.

router.post('/upload',
    authenticateUser,
    rateLimit(10, 60 * 1000),
    async (req, res) => {

        if (activeUploads >= MAX_CONCURRENT_UPLOADS) {
            return res.status(429).json({
                error: `Server busy (${activeUploads}/${MAX_CONCURRENT_UPLOADS} uploads active). Try again shortly.`
            });
        }

        activeUploads++;

        try {
            const user = req.user;
            const channelId = req.query.channelId || user.default_group_id;
            const uploadId = req.query.uploadId || null;
            const folderId = req.query.folderId || null;

            if (!channelId) {
                activeUploads--;
                return res.status(400).json({ error: 'No channel specified' });
            }

            const bb = busboy({
                headers: req.headers,
                limits: { fileSize: 2 * 1024 * 1024 * 1024 } // 2GB
            });

            let fileName = '';
            let mimeType = 'application/octet-stream';
            let fileSize = 0;

            // Content-Length header gives us total multipart size
            // Subtract ~200 bytes for multipart boundaries to estimate file size
            const contentLength = parseInt(req.headers['content-length'] || '0');
            const estimatedFileSize = contentLength > 200 ? contentLength - 200 : 0;

            const uploadPromise = new Promise((resolve, reject) => {

                bb.on('file', async (fieldname, fileStream, info) => {
                    fileName = info.filename || 'unnamed_file';
                    mimeType = info.mimeType || 'application/octet-stream';

                    console.log(`📤 mtcute stream upload: ${fileName} (uploadId: ${uploadId})`);

                    try {
                        if (uploadId) uploadProgressMap.set(uploadId, 5);

                        const client = await tgManager.getClient(user);

                        // mtcute uses chat ID directly (number or username string)
                        const chatId = parseInt(channelId);

                        // ── TRUE STREAMING ──────────────────────────────────
                        // Convert busboy fileStream to a Node.js Readable
                        // mtcute uploadFile reads it in 512KB chunks
                        // RAM usage = 512KB at a time, NOT the full file

                        let received = 0;

                        // Wrap fileStream so we can track bytes received
                        const trackingStream = new Readable({ read() { } });

                        fileStream.on('data', (chunk) => {
                            if (uploadCancelMap.get(uploadId)) {
                                fileStream.destroy();
                                trackingStream.destroy();
                                return;
                            }
                            received += chunk.length;
                            trackingStream.push(chunk);

                            // Receive progress 0–40%
                            if (estimatedFileSize > 0) {
                                const p = Math.min(Math.round((received / estimatedFileSize) * 40), 40);
                                if (uploadId) uploadProgressMap.set(uploadId, p);
                            }
                        });

                        fileStream.on('end', () => {
                            trackingStream.push(null); // signal end of stream
                            fileSize = received;
                        });

                        fileStream.on('error', (err) => trackingStream.destroy(err));
                        fileStream.on('limit', () => reject(new Error('File exceeds 2GB limit')));

                        if (uploadId) uploadProgressMap.set(uploadId, 40);

                        // mtcute uploadFile — streams in 512KB parts to Telegram
                        const uploadedFile = await client.uploadFile({
                            file: trackingStream,      // Node.js Readable stream
                            fileName: fileName,
                            fileSize: estimatedFileSize || undefined, // helps mtcute pick optimal part size
                            fileMime: mimeType,
                            progressCallback: (uploaded, total) => {
                                if (uploadCancelMap.get(uploadId)) {
                                    throw new Error('UPLOAD_CANCELLED');
                                }
                                // Telegram upload progress 40–99%
                                const p = total > 0
                                    ? Math.round(40 + (uploaded / total) * 59)
                                    : Math.min(Math.round(40 + (uploaded / (estimatedFileSize || uploaded)) * 59), 99);
                                if (uploadId) uploadProgressMap.set(uploadId, Math.min(p, 99));
                                process.stdout.write(`\r📤 Telegram: ${total > 0 ? Math.round(uploaded / total * 100) : '?'}%`);
                            },
                        });

                        console.log(`\n📦 Sending message to channel...`);

                        // mtcute sendMedia with InputMedia.document for force-document behavior
                        const result = await client.sendMedia(chatId, InputMedia.document(uploadedFile, {
                            caption: `Uploaded by ${user.first_name || ''} ${user.last_name || ''}`.trim(),
                            fileName: fileName,
                        }));

                        console.log(`✅ Done — message ID ${result.id}`);
                        if (uploadId) uploadProgressMap.set(uploadId, 100);
                        resolve(result);

                    } catch (err) { reject(err); }
                });

                bb.on('error', reject);
                bb.on('finish', () => {
                    if (!fileName) reject(new Error('No file field in request'));
                });
            });

            req.pipe(bb);

            const result = await uploadPromise;

            const fileId = uuidv4();
            await pool.execute(
                `INSERT INTO uploaded_files 
                 (id, user_id, original_name, file_size, mime_type, telegram_message_id, channel_id, folder_id, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
                [fileId, user.id, fileName, fileSize, mimeType, result.id.toString(), channelId, folderId]
            );

            res.json({
                success: true,
                file: {
                    id: fileId,
                    name: fileName,
                    size: fileSize,
                    messageId: result.id,
                    channelId,
                }
            });

        } catch (err) {
            const wasCancelled = err.message === 'UPLOAD_CANCELLED' || uploadCancelMap.get(req.query.uploadId);

            if (wasCancelled) {
                console.log(`🚫 Upload cancelled: ${req.query.uploadId}`);
                if (!res.headersSent) res.status(499).json({ error: 'Upload cancelled' });
            } else {
                console.error('Upload error:', err.message);
                if (!res.headersSent) res.status(500).json({ error: err.message });
            }

            if (req.query.uploadId) {
                uploadProgressMap.delete(req.query.uploadId);
                uploadCancelMap.delete(req.query.uploadId);
            }

        } finally {
            activeUploads--;
        }
    }
);

// ─── GET FILES ───────────────────────────────────────────────────────────────

router.get('/files', authenticateUser, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 50, 100);
        const folderId = req.query.folder_id === 'null' ? null : req.query.folder_id || null;
        let query, params;
        if (folderId) {
            query = `SELECT id, original_name, file_size, mime_type, telegram_message_id, channel_id, folder_id, created_at 
                     FROM uploaded_files WHERE user_id = ? AND folder_id = ? ORDER BY created_at DESC LIMIT ` + limit;
            params = [req.user.id, folderId];
        } else {
            query = `SELECT id, original_name, file_size, mime_type, telegram_message_id, channel_id, folder_id, created_at 
                     FROM uploaded_files WHERE user_id = ? AND folder_id IS NULL ORDER BY created_at DESC LIMIT ` + limit;
            params = [req.user.id];
        }
        const [files] = await pool.execute(query, params);
        res.json({ success: true, count: files.length, files });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── GET FILE BY ID ──────────────────────────────────────────────────────────

router.get('/files/:id', authenticateUser, async (req, res) => {
    try {
        const [files] = await pool.execute('SELECT * FROM uploaded_files WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
        if (files.length === 0) return res.status(404).json({ error: 'File not found' });
        res.json({ success: true, file: files[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── DOWNLOAD ────────────────────────────────────────────────────────────────
// mtcute downloadAsBuffer — downloads file from Telegram into memory buffer
// For large files consider streaming with downloadAsNodeStream instead

router.get('/download/:messageId', authenticateUser, rateLimit(20, 60 * 1000), async (req, res) => {
    try {
        console.log('messageId param:', req.params.messageId);
        const [fileRecords] = await pool.execute(
            'SELECT * FROM uploaded_files WHERE telegram_message_id = ? AND user_id = ?',
            [req.params.messageId, req.user.id]
        );
        if (fileRecords.length === 0) return res.status(404).json({ error: 'File not found' });

        const fileRecord = fileRecords[0];
        console.log('fileRecord:', fileRecord);
        const client = await tgManager.getClient(req.user);

        // mtcute: get message then download its media
        const messages = await client.getMessages(fileRecord.channel_id, {
            ids: [parseInt(req.params.messageId)]
        });

        if (!messages?.length || !messages[0].media) {
            return res.status(404).json({ error: 'File not found on Telegram' });
        }

        // mtcute downloadAsBuffer — returns Uint8Array
        const fileBuffer = await client.downloadAsBuffer(messages[0].media);

        res.setHeader('Content-Type', fileRecord.mime_type || 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileRecord.original_name)}"`);
        res.setHeader('Content-Length', fileBuffer.length);
        res.send(Buffer.from(fileBuffer));
    } catch (err) {
        console.error('Download error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── VIEW ─────────────────────────────────────────────────────────────────────

router.get('/view/:messageId', authenticateUser, rateLimit(20, 60 * 1000), async (req, res) => {
    try {
        const [fileRecords] = await pool.execute(
            'SELECT * FROM uploaded_files WHERE telegram_message_id = ? AND user_id = ?',
            [req.params.messageId, req.user.id]
        );
        if (fileRecords.length === 0) return res.status(404).json({ error: 'File not found' });

        const fileRecord = fileRecords[0];
        const client = await tgManager.getClient(req.user);

        // mtcute getMessages signature: (chatId, messageIds, fromReply?)
        const messages = await client.getMessages(
            parseInt(fileRecord.channel_id),
            parseInt(req.params.messageId)
        );

        const message = Array.isArray(messages) ? messages[0] : messages;
        if (!message || !message.media)
            return res.status(404).json({ error: 'File not found on Telegram' });

        const fileBuffer = await client.downloadAsBuffer(message.media);
        res.setHeader('Content-Type', fileRecord.mime_type || 'application/octet-stream');
        res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(fileRecord.original_name)}"`);
        res.setHeader('Content-Length', fileBuffer.length);
        res.send(Buffer.from(fileBuffer));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── SEARCH ──────────────────────────────────────────────────────────────────

router.get('/search', authenticateUser, rateLimit(30, 60 * 1000), async (req, res) => {
    try {
        const q = req.query.q;
        if (!q || q.length < 2) return res.status(400).json({ error: 'Query must be at least 2 characters' });
        const [files] = await pool.execute(
            `SELECT id, original_name, file_size, mime_type, telegram_message_id, created_at
             FROM uploaded_files WHERE user_id = ? AND original_name LIKE ? ORDER BY created_at DESC LIMIT 50`,
            [req.user.id, `%${q}%`]
        );
        res.json({ success: true, query: q, count: files.length, files });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── STATS ───────────────────────────────────────────────────────────────────

router.get('/stats', authenticateUser, async (req, res) => {
    try {
        const [[stats]] = await pool.execute(
            `SELECT COUNT(*) as totalFiles, COALESCE(SUM(file_size), 0) as totalSize FROM uploaded_files WHERE user_id = ?`,
            [req.user.id]
        );
        res.json({
            success: true,
            stats: {
                totalFiles: stats.totalFiles,
                totalSizeInMB: (stats.totalSize / 1024 / 1024).toFixed(2),
                totalSizeInGB: (stats.totalSize / 1024 / 1024 / 1024).toFixed(3),
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── DELETE ──────────────────────────────────────────────────────────────────

router.delete('/files/:id', authenticateUser, async (req, res) => {
    try {
        const [files] = await pool.execute('SELECT * FROM uploaded_files WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
        if (files.length === 0) return res.status(404).json({ error: 'File not found' });

        const file = files[0];
        try {
            const client = await tgManager.getClient(req.user);
            // mtcute deleteMessagesById
            await client.deleteMessagesById(parseInt(file.channel_id), [parseInt(file.telegram_message_id)], { revoke: true });
            console.log(`🗑️ Deleted message ${file.telegram_message_id} from Telegram`);
        } catch (tgErr) {
            console.error('Telegram delete error:', tgErr.message);
        }

        const [result] = await pool.execute('DELETE FROM uploaded_files WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
        if (result.affectedRows === 0) return res.status(404).json({ error: 'File not found' });
        res.json({ success: true, message: 'File deleted from Telegram and database' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── SYNC CHANNELS FROM TELEGRAM ─────────────────────────────────────────
router.post('/sync-channels', authenticateUser, async (req, res) => {
    try {
        const user = req.user;
        const client = await tgManager.getClient(user);

        const channels = [];
        for await (const dialog of client.iterDialogs({ limit: 500 })) {
            // mtcute Dialog has .peer not .chat
            const peer = dialog.peer;
            if (!peer) continue;

            // peer.type for channels/groups
            const type = peer.type;
            const isChannel = type === 'chat' && peer.title !== undefined;
            if (!isChannel) continue;

            const id = peer.id?.toString();
            const title = peer.title || peer.firstName || '';
            const username = peer.username || null;

            if (!id) continue;

            channels.push({ id, title, username });

            const [existing] = await pool.execute(
                'SELECT id FROM user_channels WHERE user_id = ? AND channel_id = ?',
                [user.id, id]
            );
            if (existing.length === 0) {
                await pool.execute(
                    `INSERT INTO user_channels (id, user_id, channel_id, channel_username, channel_title, access_hash)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                    [uuidv4(), user.id, id, username, title, null]
                );
            }
        }
        console.log('asdfghhjjjkk', channels)
        res.json({ success: true, synced: channels.length, channels });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── GET CHANNELS FROM DB ─────────────────────────────────────────────────
router.get('/channels', authenticateUser, async (req, res) => {
    try {
        const [channels] = await pool.execute(
            `SELECT channel_id, channel_title, channel_username FROM user_channels WHERE user_id = ? AND is_active = TRUE`,
            [req.user.id]
        );
        res.json({ success: true, channels });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── FOLDERS ─────────────────────────────────────────────────────────────────

router.get('/folders', authenticateUser, async (req, res) => {
    const parentId = req.query.parent_id === 'null' ? null : req.query.parent_id || null;
    const [folders] = await pool.execute(
        'SELECT * FROM folders WHERE user_id = ? AND parent_id ' + (parentId ? '= ?' : 'IS NULL') + ' ORDER BY name',
        parentId ? [req.user.id, parentId] : [req.user.id]
    );
    res.json({ success: true, folders });
});

router.post('/folders', authenticateUser, async (req, res) => {
    const { name, parent_id } = req.body;
    const id = uuidv4();
    await pool.execute('INSERT INTO folders (id, user_id, name, parent_id) VALUES (?, ?, ?, ?)', [id, req.user.id, name, parent_id || null]);
    res.json({ success: true, folder: { id, name, parent_id } });
});

router.delete('/folders/:id', authenticateUser, async (req, res) => {
    await pool.execute('DELETE FROM folders WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    res.json({ success: true });
});

router.get('/folders/path/:id', authenticateUser, async (req, res) => {
    const path = [];
    let currentId = req.params.id;
    while (currentId) {
        const [rows] = await pool.execute('SELECT * FROM folders WHERE id = ?', [currentId]);
        if (rows.length === 0) break;
        path.unshift(rows[0]);
        currentId = rows[0].parent_id;
    }
    res.json({ success: true, path });
});

// ─── RENAME FILE ─────────────────────────────────────────────────────────────

router.put('/files/:id/rename', authenticateUser, async (req, res) => {
    try {
        const { newName } = req.body;
        if (!newName?.trim()) return res.status(400).json({ error: 'New name required' });
        const [result] = await pool.execute(
            'UPDATE uploaded_files SET original_name = ? WHERE id = ? AND user_id = ?',
            [newName.trim(), req.params.id, req.user.id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: 'File not found' });
        res.json({ success: true, message: 'File renamed' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── RENAME FOLDER ───────────────────────────────────────────────────────────

router.put('/folders/:id/rename', authenticateUser, async (req, res) => {
    try {
        const { newName } = req.body;
        if (!newName?.trim()) return res.status(400).json({ error: 'New name required' });
        const [result] = await pool.execute(
            'UPDATE folders SET name = ? WHERE id = ? AND user_id = ?',
            [newName.trim(), req.params.id, req.user.id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Folder not found' });
        res.json({ success: true, message: 'Folder renamed' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;