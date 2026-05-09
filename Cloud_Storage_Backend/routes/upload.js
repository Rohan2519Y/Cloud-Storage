const express = require('express');
const multer = require('multer');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const pool = require('../utils/database')

// Authentication middleware
async function authenticateUser(req, res, next) {
    try {
        const token = req.headers.authorization?.replace('Bearer ', '');
        if (!token) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');

        const [users] = await pool.execute(
            'SELECT * FROM users WHERE id = ?',
            [decoded.userId]
        );

        if (users.length === 0) {
            return res.status(401).json({ error: 'User not found' });
        }

        req.user = users[0];
        req.decodedToken = decoded;
        next();

    } catch (error) {
        res.status(401).json({ error: 'Invalid token' });
    }
}

// Configure multer for 2GB file uploads
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 2 * 1024 * 1024 * 1024 // 2GB
    }
});

// HEALTH ENDPOINT
router.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        maxFileSize: '2GB',
        database: 'MySQL'
    });
});

// UPLOAD FILE - Uses user's own credentials and channel
router.post('/upload', authenticateUser, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const user = req.user;
        const file = req.file;
        
        // Use channel from request body or user's default
        const channelId = req.body.channelId || user.default_group_id;
        
        if (!channelId) {
            return res.status(400).json({ error: 'No channel specified' });
        }

        console.log(`📤 User ${user.phone_number} uploading file: ${file.originalname}`);
        console.log(`📡 Using user's API credentials`);

        // Create Telegram client with THIS user's session and API credentials
        const client = new TelegramClient(
            new StringSession(user.telegram_session),
            parseInt(user.telegram_api_id),
            user.telegram_api_hash,
            { connectionRetries: 3 }
        );

        await client.connect();

        // Get the channel/group entity
        let entity;
        try {
            entity = await client.getEntity(parseInt(channelId));
        } catch (error) {
            // Try with username if ID fails
            if (user.default_channel_username) {
                entity = await client.getEntity(user.default_channel_username);
            } else {
                throw error;
            }
        }

        console.log(`📤 Uploading to: ${entity.title || entity.name || 'Channel'}`);
        console.log(`📁 File size: ${(file.size / 1024 / 1024).toFixed(2)} MB`);

        // Upload file using user's own account
        const result = await client.sendFile(entity, {
            file: file.buffer,
            fileName: file.originalname,
            caption: `Uploaded by ${user.first_name} ${user.last_name}`,
            forceDocument: true,
            progressCallback: (progress) => {
                console.log(`📊 Upload progress: ${Math.round(progress)}%`);
            }
        });

        await client.disconnect();
        console.log(`✅ Upload complete! Message ID: ${result.id}`);

        // Save file record
        const fileId = uuidv4();
        await pool.execute(
            `INSERT INTO uploaded_files (id, user_id, original_name, file_size, mime_type, telegram_message_id, channel_id, created_at) 
             VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
            [fileId, user.id, file.originalname, file.size, file.mimetype, result.id.toString(), channelId]
        );

        res.json({
            success: true,
            message: 'File uploaded successfully',
            file: {
                id: fileId,
                name: file.originalname,
                size: file.size,
                messageId: result.id,
                channelId: channelId
            }
        });

    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: error.message });
    }
});

// GET ALL FILES for authenticated user
router.get('/files', authenticateUser, async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const [files] = await pool.execute(
            'SELECT * FROM uploaded_files WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
            [req.user.id, limit]
        );

        res.json({
            success: true,
            count: files.length,
            files: files
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET FILE BY ID
router.get('/files/:id', authenticateUser, async (req, res) => {
    try {
        const [files] = await pool.execute(
            'SELECT * FROM uploaded_files WHERE id = ? AND user_id = ?',
            [req.params.id, req.user.id]
        );

        if (files.length === 0) {
            return res.status(404).json({ error: 'File not found' });
        }

        res.json({
            success: true,
            file: files[0]
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// VIEW FILE ONLINE
router.get('/view/:messageId', authenticateUser, async (req, res) => {
    try {
        const messageId = req.params.messageId;

        // Get file info from database
        const [fileRecords] = await pool.execute(
            'SELECT * FROM uploaded_files WHERE telegram_message_id = ? AND user_id = ?',
            [messageId, req.user.id]
        );

        if (fileRecords.length === 0) {
            return res.status(404).send('File record not found');
        }

        const fileRecord = fileRecords[0];
        const user = req.user;

        // Create client with user's credentials
        const client = new TelegramClient(
            new StringSession(user.telegram_session),
            parseInt(user.telegram_api_id),
            user.telegram_api_hash,
            { connectionRetries: 3 }
        );

        await client.connect();

        const chat = await client.getEntity(parseInt(fileRecord.channel_id));
        const messages = await client.getMessages(chat, {
            ids: [parseInt(messageId)]
        });

        if (!messages || messages.length === 0 || !messages[0].media) {
            await client.disconnect();
            return res.status(404).send('File not found');
        }

        const fileBuffer = await client.downloadMedia(messages[0], {
            outputFile: undefined
        });

        await client.disconnect();

        res.setHeader('Content-Type', fileRecord.mime_type);
        res.setHeader('Content-Disposition', `inline; filename="${fileRecord.original_name}"`);
        res.setHeader('Content-Length', fileBuffer.length);
        res.send(fileBuffer);

    } catch (error) {
        console.error('View error:', error);
        res.status(500).send(`Error viewing file: ${error.message}`);
    }
});

// DOWNLOAD FILE
router.get('/download/:messageId', authenticateUser, async (req, res) => {
    try {
        const messageId = req.params.messageId;

        const [fileRecords] = await pool.execute(
            'SELECT * FROM uploaded_files WHERE telegram_message_id = ? AND user_id = ?',
            [messageId, req.user.id]
        );

        if (fileRecords.length === 0) {
            return res.status(404).send('File record not found');
        }

        const fileRecord = fileRecords[0];
        const user = req.user;

        const client = new TelegramClient(
            new StringSession(user.telegram_session),
            parseInt(user.telegram_api_id),
            user.telegram_api_hash,
            { connectionRetries: 3 }
        );

        await client.connect();

        const chat = await client.getEntity(parseInt(fileRecord.channel_id));
        const messages = await client.getMessages(chat, {
            ids: [parseInt(messageId)]
        });

        if (!messages || messages.length === 0 || !messages[0].media) {
            await client.disconnect();
            return res.status(404).send('File not found');
        }

        const fileBuffer = await client.downloadMedia(messages[0], {
            outputFile: undefined
        });

        await client.disconnect();

        res.setHeader('Content-Type', fileRecord.mime_type);
        res.setHeader('Content-Disposition', `attachment; filename="${fileRecord.original_name}"`);
        res.setHeader('Content-Length', fileBuffer.length);
        res.send(fileBuffer);

    } catch (error) {
        console.error('Download error:', error);
        res.status(500).send(`Error downloading file: ${error.message}`);
    }
});

// SEARCH FILES
router.get('/search', authenticateUser, async (req, res) => {
    try {
        const query = req.query.q;
        if (!query) {
            return res.status(400).json({ error: 'Search query required' });
        }

        const [files] = await pool.execute(
            'SELECT * FROM uploaded_files WHERE user_id = ? AND original_name LIKE ? ORDER BY created_at DESC',
            [req.user.id, `%${query}%`]
        );

        res.json({
            success: true,
            query: query,
            count: files.length,
            files: files
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET USER STATS
router.get('/stats', authenticateUser, async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT 
                COUNT(*) as totalFiles,
                SUM(file_size) as totalSize,
                AVG(file_size) as avgSize
            FROM uploaded_files 
            WHERE user_id = ?`,
            [req.user.id]
        );
        
        const stats = rows[0];
        res.json({
            success: true,
            stats: {
                totalFiles: stats.totalFiles || 0,
                totalSize: stats.totalSize || 0,
                avgSize: stats.avgSize || 0,
                totalSizeInGB: ((stats.totalSize || 0) / (1024 * 1024 * 1024)).toFixed(2),
                totalSizeInMB: ((stats.totalSize || 0) / (1024 * 1024)).toFixed(2)
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// DELETE FILE
router.delete('/files/:id', authenticateUser, async (req, res) => {
    try {
        const [result] = await pool.execute(
            'DELETE FROM uploaded_files WHERE id = ? AND user_id = ?',
            [req.params.id, req.user.id]
        );

        if (result.affectedRows > 0) {
            res.json({
                success: true,
                message: 'File record deleted from database'
            });
        } else {
            res.status(404).json({ error: 'File not found' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get user's channels
router.get('/channels', authenticateUser, async (req, res) => {
    try {
        const [channels] = await pool.execute(
            'SELECT * FROM user_channels WHERE user_id = ? AND is_active = TRUE',
            [req.user.id]
        );

        res.json({
            success: true,
            channels: channels
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;