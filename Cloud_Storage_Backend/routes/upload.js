// routes/upload.js — optimized for Render free tier
const express = require('express');
const multer = require('multer');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const pool = require('../utils/database');
const tgManager = require('../utils/telegramClientManager');

// ─── In-memory progress map ─────────────────────────────────────────────────
const uploadProgressMap = new Map();
const uploadCancelMap = new Map();

// ─── Auth middleware ────────────────────────────────────────────────────────
async function authenticateUser(req, res, next) {
    try {
        const authHeader = req.headers.authorization;
        const token = authHeader?.replace('Bearer ', '');
        if (!token) return res.status(401).json({ error: 'Authentication required' });
        const secret = process.env.JWT_SECRET;
        const decoded = jwt.verify(token, secret);
        const [users] = await pool.execute(
            'SELECT * FROM users WHERE id = ?', [decoded.userId]
        );
        if (users.length === 0) return res.status(401).json({ error: 'User not found' });

        req.user = users[0];
        next();
    } catch (err) {
        console.error('Auth error:', err.message);
        res.status(401).json({ error: 'Invalid token' });
    }
}

// ─── Temp dir ───────────────────────────────────────────────────────────────
const TMP_DIR = '/tmp/tg-uploads';
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

const upload = multer({
    storage: multer.diskStorage({
        destination: TMP_DIR,
        filename: (req, file, cb) =>
            cb(null, file.originalname),
    }),
    limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2GB
});

// ─── Cleanup helper ─────────────────────────────────────────────────────────
function cleanupTmp(filePath) {
    fs.unlink(filePath, err => {
        if (err) console.warn('Could not delete tmp file:', err.message);
    });
}

// ─── Simple in-memory rate limiter ──────────────────────────────────────────
const rateLimitMap = new Map();
function rateLimit(maxRequests, windowMs) {
    return (req, res, next) => {
        const key = req.ip;
        const now = Date.now();
        const entry = rateLimitMap.get(key) || { count: 0, resetAt: now + windowMs };

        if (now > entry.resetAt) {
            entry.count = 0;
            entry.resetAt = now + windowMs;
        }
        entry.count++;
        rateLimitMap.set(key, entry);

        if (entry.count > maxRequests) {
            return res.status(429).json({ error: 'Too many requests. Please slow down.' });
        }
        next();
    };
}

// Clean rate limit map every 5 min
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of rateLimitMap) {
        if (now > entry.resetAt) rateLimitMap.delete(key);
    }
}, 5 * 60 * 1000);

// ─── Concurrent upload limiter ──────────────────────────────────────────────
let activeUploads = 0;
const MAX_CONCURRENT_UPLOADS = 2;

// ─── Routes ─────────────────────────────────────────────────────────────────

// HEALTH
router.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        activeUploads,
        maxConcurrentUploads: MAX_CONCURRENT_UPLOADS,
        cachedTelegramClients: tgManager.clients?.size ?? 0,
    });
});

// SSE PROGRESS — called by frontend to stream Telegram upload progress
router.get('/upload-progress/:uploadId', async (req, res) => {
    // Accept token from query param since EventSource can't set headers
    const token = req.query.token || req.headers.authorization?.replace('Bearer ', '');
    try {
        jwt.verify(token, process.env.JWT_SECRET);
    } catch {
        return res.status(401).end();
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Important for Nginx/Render proxies
    res.flushHeaders();

    const id = req.params.uploadId;

    // Send initial ping so client knows connection is alive
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
            // Send heartbeat to keep connection alive
            res.write(`: heartbeat\n\n`);
        }
    }, 300);

    req.on('close', () => {
        clearInterval(interval);
        uploadProgressMap.delete(id);
    });
});

router.post('/upload-cancel/:uploadId', async (req, res) => {
    const token = req.query.token || req.headers.authorization?.replace('Bearer ', '');
    try {
        jwt.verify(token, process.env.JWT_SECRET);
    } catch {
        return res.status(401).end();
    }

    const id = req.params.uploadId;
    uploadCancelMap.set(id, true);
    uploadProgressMap.delete(id);
    res.json({ success: true });
});

// UPLOAD — streams file from disk to Telegram, then deletes temp file
router.post(
    '/upload',
    authenticateUser,
    rateLimit(10, 60 * 1000),
    upload.single('file'),
    async (req, res) => {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
        if (activeUploads >= MAX_CONCURRENT_UPLOADS) {
            cleanupTmp(req.file.path);
            return res.status(429).json({
                error: 'Server busy. Another upload is in progress. Please wait a moment.',
            });
        }

        activeUploads++;
        const filePath = req.file.path;

        try {
            const user = req.user;
            const file = req.file;
            const channelId = req.body.channelId || user.default_group_id;
            const uploadId = req.body.uploadId || null;
            const folderId = req.body.folderId || null;

            if (!channelId) {
                cleanupTmp(filePath);
                return res.status(400).json({ error: 'No channel specified' });
            }

            console.log(`📤 Upload started: ${file.originalname} (${uploadId})`);

            if (uploadId) uploadProgressMap.set(uploadId, 50);

            const client = await tgManager.getClient(user);

            let entity;
            try {
                entity = await client.getEntity(parseInt(channelId));
            } catch {
                if (user.default_channel_username) {
                    entity = await client.getEntity(user.default_channel_username);
                } else {
                    throw new Error('Cannot find Telegram channel');
                }
            }

            let pollingDone = false;

            const result = await client.sendFile(entity, {
                file: filePath,
                fileName: file.originalname,
                forceDocument: true,
                progressCallback: (progress) => {
                    if (uploadCancelMap.get(uploadId)) {
                        throw new Error('UPLOAD_CANCELLED');
                    }

                    const p = Math.round(50 + Math.min(progress, 1) * 49);
                    const display = Math.min(p, 99);
                    if (uploadId) uploadProgressMap.set(uploadId, display);

                    process.stdout.write(`\r📊 Telegram: ${Math.round(progress * 100)}%`);

                    if (progress >= 1) pollingDone = true;
                },
            });

            pollingDone = true;
            if (uploadId) uploadProgressMap.set(uploadId, 100);

            console.log(`\n✅ Upload complete: message ID ${result.id}`);

            const fileId = uuidv4();
            await pool.execute(
                `INSERT INTO uploaded_files 
                (id, user_id, original_name, file_size, mime_type, telegram_message_id, channel_id, folder_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
                [fileId, user.id, file.originalname, file.size, file.mimetype, result.id.toString(), channelId, folderId]
            );

            res.json({
                success: true,
                file: {
                    id: fileId,
                    name: file.originalname,
                    size: file.size,
                    messageId: result.id,
                    channelId,
                },
            });
        } catch (err) {
            const wasCancelled = err.message === 'UPLOAD_CANCELLED' || uploadCancelMap.get(req.body.uploadId);

            if (wasCancelled) {
                console.log(`🚫 Upload cancelled: ${req.body.uploadId}`);
                if (!res.headersSent) {
                    res.status(499).json({ error: 'Upload cancelled' });
                }
            } else {
                console.error('Upload error:', err.message);
                if (!res.headersSent) {
                    res.status(500).json({ error: err.message });
                }
            }

            if (req.body.uploadId) {
                uploadProgressMap.delete(req.body.uploadId);
                uploadCancelMap.delete(req.body.uploadId);
            }
        } finally {
            activeUploads--;
            cleanupTmp(filePath);
        }
    }
);

// GET FILES — lightweight, no Telegram call
router.get('/files', authenticateUser, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 50, 100);
        const folderId = req.query.folder_id === 'null' ? null : req.query.folder_id || null;

        let query, params;

        if (folderId) {
            query = `SELECT id, original_name, file_size, mime_type, telegram_message_id, channel_id, folder_id, created_at 
                     FROM uploaded_files 
                     WHERE user_id = ? AND folder_id = ? 
                     ORDER BY created_at DESC LIMIT ` + limit;
            params = [req.user.id, folderId];
        } else {
            query = `SELECT id, original_name, file_size, mime_type, telegram_message_id, channel_id, folder_id, created_at 
                     FROM uploaded_files 
                     WHERE user_id = ? AND folder_id IS NULL 
                     ORDER BY created_at DESC LIMIT ` + limit;
            params = [req.user.id];
        }

        const [files] = await pool.execute(query, params);
        res.json({ success: true, count: files.length, files });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET FILE BY ID
router.get('/files/:id', authenticateUser, async (req, res) => {
    try {
        const [files] = await pool.execute(
            'SELECT * FROM uploaded_files WHERE id = ? AND user_id = ?',
            [req.params.id, req.user.id]
        );
        if (files.length === 0) return res.status(404).json({ error: 'File not found' });
        res.json({ success: true, file: files[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DOWNLOAD — streams from Telegram to response
router.get(
    '/download/:messageId',
    authenticateUser,
    rateLimit(20, 60 * 1000),
    async (req, res) => {
        try {
            const [fileRecords] = await pool.execute(
                'SELECT * FROM uploaded_files WHERE telegram_message_id = ? AND user_id = ?',
                [req.params.messageId, req.user.id]
            );
            if (fileRecords.length === 0)
                return res.status(404).json({ error: 'File not found' });

            const fileRecord = fileRecords[0];
            const client = await tgManager.getClient(req.user);
            const chat = await client.getEntity(parseInt(fileRecord.channel_id));
            const messages = await client.getMessages(chat, {
                ids: [parseInt(req.params.messageId)],
            });

            if (!messages?.length || !messages[0].media)
                return res.status(404).json({ error: 'File not found on Telegram' });

            const fileBuffer = await client.downloadMedia(messages[0], {});
            res.setHeader('Content-Type', fileRecord.mime_type || 'application/octet-stream');
            res.setHeader(
                'Content-Disposition',
                `attachment; filename="${encodeURIComponent(fileRecord.original_name)}"`
            );
            res.setHeader('Content-Length', fileBuffer.length);
            res.send(fileBuffer);
        } catch (err) {
            console.error('Download error:', err.message);
            res.status(500).json({ error: err.message });
        }
    }
);

// VIEW (inline)
router.get('/view/:messageId', authenticateUser, rateLimit(20, 60 * 1000), async (req, res) => {
    try {
        const [fileRecords] = await pool.execute(
            'SELECT * FROM uploaded_files WHERE telegram_message_id = ? AND user_id = ?',
            [req.params.messageId, req.user.id]
        );
        if (fileRecords.length === 0) return res.status(404).json({ error: 'File not found' });

        const fileRecord = fileRecords[0];
        const client = await tgManager.getClient(req.user);
        const chat = await client.getEntity(parseInt(fileRecord.channel_id));
        const messages = await client.getMessages(chat, {
            ids: [parseInt(req.params.messageId)],
        });

        if (!messages?.length || !messages[0].media)
            return res.status(404).json({ error: 'File not found on Telegram' });

        const fileBuffer = await client.downloadMedia(messages[0], {});
        res.setHeader('Content-Type', fileRecord.mime_type || 'application/octet-stream');
        res.setHeader(
            'Content-Disposition',
            `inline; filename="${encodeURIComponent(fileRecord.original_name)}"`
        );
        res.setHeader('Content-Length', fileBuffer.length);
        res.send(fileBuffer);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// SEARCH
router.get('/search', authenticateUser, rateLimit(30, 60 * 1000), async (req, res) => {
    try {
        const q = req.query.q;
        if (!q || q.length < 2)
            return res.status(400).json({ error: 'Query must be at least 2 characters' });

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

// STATS
router.get('/stats', authenticateUser, async (req, res) => {
    try {
        const [[stats]] = await pool.execute(
            `SELECT COUNT(*) as totalFiles, COALESCE(SUM(file_size), 0) as totalSize
             FROM uploaded_files WHERE user_id = ?`,
            [req.user.id]
        );
        res.json({
            success: true,
            stats: {
                totalFiles: stats.totalFiles,
                totalSizeInMB: (stats.totalSize / 1024 / 1024).toFixed(2),
                totalSizeInGB: (stats.totalSize / 1024 / 1024 / 1024).toFixed(3),
            },
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE
router.delete('/files/:id', authenticateUser, async (req, res) => {
    try {
        const [files] = await pool.execute(
            'SELECT * FROM uploaded_files WHERE id = ? AND user_id = ?',
            [req.params.id, req.user.id]
        );

        if (files.length === 0) {
            return res.status(404).json({ error: 'File not found' });
        }

        const file = files[0];

        try {
            const client = await tgManager.getClient(req.user);
            const entity = await client.getEntity(parseInt(file.channel_id));
            await client.deleteMessages(entity, [parseInt(file.telegram_message_id)], { revoke: true });
            console.log(`🗑️ Deleted message ${file.telegram_message_id} from Telegram`);
        } catch (tgErr) {
            console.error('Telegram delete error:', tgErr.message);
        }

        // Delete from database
        const [result] = await pool.execute(
            'DELETE FROM uploaded_files WHERE id = ? AND user_id = ?',
            [req.params.id, req.user.id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'File not found' });
        }

        res.json({ success: true, message: 'File deleted from Telegram and database' });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// CHANNELS
router.get('/channels', authenticateUser, async (req, res) => {
    try {
        const [channels] = await pool.execute(
            `SELECT channel_id, channel_title, channel_username
             FROM user_channels WHERE user_id = ? AND is_active = TRUE`,
            [req.user.id]
        );
        res.json({ success: true, channels });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET folders
router.get('/folders', authenticateUser, async (req, res) => {
    const parentId = req.query.parent_id === 'null' ? null : req.query.parent_id || null;
    const [folders] = await pool.execute(
        'SELECT * FROM folders WHERE user_id = ? AND parent_id ' + (parentId ? '= ?' : 'IS NULL') + ' ORDER BY name',
        parentId ? [req.user.id, parentId] : [req.user.id]
    );
    res.json({ success: true, folders });
});

// CREATE folder
router.post('/folders', authenticateUser, async (req, res) => {
    const { name, parent_id } = req.body;
    const id = uuidv4();
    await pool.execute(
        'INSERT INTO folders (id, user_id, name, parent_id) VALUES (?, ?, ?, ?)',
        [id, req.user.id, name, parent_id || null]
    );
    res.json({ success: true, folder: { id, name, parent_id } });
});

// DELETE folder
router.delete('/folders/:id', authenticateUser, async (req, res) => {
    await pool.execute('DELETE FROM folders WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    res.json({ success: true });
});

// GET folder path (breadcrumb)
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

module.exports = router;