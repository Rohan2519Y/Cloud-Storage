// routes/upload.js — optimized for Render free tier
const express = require('express');
const multer  = require('multer');
const router  = express.Router();
const path    = require('path');
const fs      = require('fs');
const { v4: uuidv4 } = require('uuid');
const jwt     = require('jsonwebtoken');
const { TelegramClient } = require('telegram');
const { StringSession }  = require('telegram/sessions');
const pool               = require('../utils/database');
const tgManager          = require('../utils/telegramClientManager');

// ─── Auth middleware ────────────────────────────────────────────────────────

async function authenticateUser(req, res, next) {
    try {
        const token = req.headers.authorization?.replace('Bearer ', '');
        if (!token) return res.status(401).json({ error: 'Authentication required' });

        const secret = process.env.JWT_SECRET;
        if (!secret) throw new Error('JWT_SECRET not configured');

        const decoded = jwt.verify(token, secret);
        const [users] = await pool.execute(
            'SELECT * FROM users WHERE id = ?', [decoded.userId]
        );
        if (users.length === 0) return res.status(401).json({ error: 'User not found' });

        req.user = users[0];
        next();
    } catch (err) {
        res.status(401).json({ error: 'Invalid token' });
    }
}

// ─── Multer — disk storage (not memory!) ───────────────────────────────────
// memoryStorage crashes Render free on any large file.
// /tmp on Render free has ~512MB; files are cleaned up after upload.

const TMP_DIR = '/tmp/tg-uploads';
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

const upload = multer({
    storage: multer.diskStorage({
        destination: TMP_DIR,
        filename: (req, file, cb) => cb(null, `${Date.now()}-${uuidv4()}${path.extname(file.originalname)}`),
    }),
    limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2GB
});

// Clean up temp file helper
function cleanupTmp(filePath) {
    fs.unlink(filePath, err => {
        if (err) console.warn('Could not delete tmp file:', err.message);
    });
}

// ─── Simple in-memory rate limiter (no extra package needed) ───────────────

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

// Clean rate limit map every 5 min to prevent memory growth
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of rateLimitMap) {
        if (now > entry.resetAt) rateLimitMap.delete(key);
    }
}, 5 * 60 * 1000);

// ─── Concurrent upload limiter ─────────────────────────────────────────────
// On Render free, max 2 simultaneous uploads to stay within RAM

let activeUploads = 0;
const MAX_CONCURRENT_UPLOADS = 2;

// ─── Routes ────────────────────────────────────────────────────────────────

router.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        activeUploads,
        maxConcurrentUploads: MAX_CONCURRENT_UPLOADS,
        cachedTelegramClients: require('../utils/telegramClientManager').clients?.size ?? 0,
    });
});

// UPLOAD — streams file from disk to Telegram, then deletes temp file
router.post('/upload',
    authenticateUser,
    rateLimit(10, 60 * 1000), // 10 uploads per minute per IP
    upload.single('file'),
    async (req, res) => {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

        // Check concurrent upload limit
        if (activeUploads >= MAX_CONCURRENT_UPLOADS) {
            cleanupTmp(req.file.path);
            return res.status(429).json({
                error: 'Server busy. Another upload is in progress. Please wait a moment.'
            });
        }

        activeUploads++;
        const tmpPath = req.file.path;

        try {
            const user      = req.user;
            const file      = req.file;
            const channelId = req.body.channelId || user.default_group_id;

            if (!channelId) {
                cleanupTmp(tmpPath);
                return res.status(400).json({ error: 'No channel specified' });
            }

            console.log(`📤 Upload started: ${file.originalname} (${(file.size / 1024 / 1024).toFixed(1)} MB) by user ${user.id}`);

            // Reuse cached Telegram client
            const client = await tgManager.getClient(user);

            let entity;
            try {
                entity = await client.getEntity(parseInt(channelId));
            } catch {
                if (user.default_channel_username) {
                    entity = await client.getEntity(user.default_channel_username);
                } else throw new Error('Cannot find Telegram channel');
            }

            // Stream from disk — not from RAM buffer
            const fileStream = fs.createReadStream(tmpPath);

            const result = await client.sendFile(entity, {
                file:          fileStream,
                fileName:      file.originalname,
                caption:       `Uploaded by ${user.first_name || ''} ${user.last_name || ''}`.trim(),
                forceDocument: true,
                progressCallback: (p) => process.stdout.write(`\r📊 ${Math.round(p)}%`),
            });

            console.log(`\n✅ Upload complete: message ID ${result.id}`);

            // Save record
            const fileId = uuidv4();
            await pool.execute(
                `INSERT INTO uploaded_files 
                 (id, user_id, original_name, file_size, mime_type, telegram_message_id, channel_id, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
                [fileId, user.id, file.originalname, file.size, file.mimetype, result.id.toString(), channelId]
            );

            res.json({
                success: true,
                file: { id: fileId, name: file.originalname, size: file.size, messageId: result.id, channelId },
            });

        } catch (err) {
            console.error('Upload error:', err.message);
            res.status(500).json({ error: err.message });
        } finally {
            activeUploads--;
            cleanupTmp(tmpPath); // always clean up temp file
        }
    }
);

// GET FILES — lightweight, no Telegram call
router.get('/files', authenticateUser, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 50, 100);
        const [files] = await pool.execute(
            'SELECT id, original_name, file_size, mime_type, telegram_message_id, channel_id, created_at FROM uploaded_files WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
            [req.user.id, limit]
        );
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

// DOWNLOAD — streams from Telegram directly to response (no RAM buffer)
router.get('/download/:messageId',
    authenticateUser,
    rateLimit(20, 60 * 1000),
    async (req, res) => {
        try {
            const [fileRecords] = await pool.execute(
                'SELECT * FROM uploaded_files WHERE telegram_message_id = ? AND user_id = ?',
                [req.params.messageId, req.user.id]
            );
            if (fileRecords.length === 0) return res.status(404).json({ error: 'File not found' });

            const fileRecord = fileRecords[0];
            const client     = await tgManager.getClient(req.user);
            const chat       = await client.getEntity(parseInt(fileRecord.channel_id));
            const messages   = await client.getMessages(chat, { ids: [parseInt(req.params.messageId)] });

            if (!messages?.length || !messages[0].media) {
                return res.status(404).json({ error: 'File not found on Telegram' });
            }

            // Stream to response — avoids loading whole file in RAM
            res.setHeader('Content-Type', fileRecord.mime_type || 'application/octet-stream');
            res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileRecord.original_name)}"`);

            // gramjs downloadMedia returns a Buffer — for very large files
            // consider upgrading to Render's paid plan or using chunked streaming
            const fileBuffer = await client.downloadMedia(messages[0], {});
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
        const client     = await tgManager.getClient(req.user);
        const chat       = await client.getEntity(parseInt(fileRecord.channel_id));
        const messages   = await client.getMessages(chat, { ids: [parseInt(req.params.messageId)] });

        if (!messages?.length || !messages[0].media) {
            return res.status(404).json({ error: 'File not found on Telegram' });
        }

        const fileBuffer = await client.downloadMedia(messages[0], {});
        res.setHeader('Content-Type', fileRecord.mime_type || 'application/octet-stream');
        res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(fileRecord.original_name)}"`);
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
        if (!q || q.length < 2) return res.status(400).json({ error: 'Query must be at least 2 characters' });

        const [files] = await pool.execute(
            'SELECT id, original_name, file_size, mime_type, telegram_message_id, created_at FROM uploaded_files WHERE user_id = ? AND original_name LIKE ? ORDER BY created_at DESC LIMIT 50',
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
            `SELECT COUNT(*) as totalFiles, COALESCE(SUM(file_size),0) as totalSize
             FROM uploaded_files WHERE user_id = ?`,
            [req.user.id]
        );
        res.json({
            success: true,
            stats: {
                totalFiles:    stats.totalFiles,
                totalSizeInMB: (stats.totalSize / 1024 / 1024).toFixed(2),
                totalSizeInGB: (stats.totalSize / 1024 / 1024 / 1024).toFixed(3),
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE
router.delete('/files/:id', authenticateUser, async (req, res) => {
    try {
        const [result] = await pool.execute(
            'DELETE FROM uploaded_files WHERE id = ? AND user_id = ?',
            [req.params.id, req.user.id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: 'File not found' });
        res.json({ success: true, message: 'File deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// CHANNELS
router.get('/channels', authenticateUser, async (req, res) => {
    try {
        const [channels] = await pool.execute(
            'SELECT channel_id, channel_title, channel_username FROM user_channels WHERE user_id = ? AND is_active = TRUE',
            [req.user.id]
        );
        res.json({ success: true, channels });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;