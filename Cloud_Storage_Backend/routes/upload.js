// routes/upload.js
const express = require('express');
const multer = require('multer');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const telegramClient = require('../utils/telegramUserClient');
const dbStorage = require('../utils/mysql'); // Changed from supabase to mysql

// Configure multer for 2GB file uploads
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 2 * 1024 * 1024 * 1024 // 2GB
    }
});

// Initialize Telegram client on server start
let isTelegramReady = false;
let initializationPromise = null;

const initTelegram = async () => {
    if (isTelegramReady) return true;

    if (initializationPromise) {
        return await initializationPromise;
    }

    initializationPromise = (async () => {
        try {
            console.log('🔐 Initializing Telegram client...');
            await telegramClient.initialize();
            isTelegramReady = true;
            console.log('✅ Telegram client ready for uploads');
            return true;
        } catch (error) {
            console.error('❌ Failed to initialize Telegram:', error.message);
            isTelegramReady = false;
            return false;
        }
    })();

    return await initializationPromise;
};

// Auto-initialize when server starts
initTelegram();

// STATUS ENDPOINT
router.get('/status', async (req, res) => {
    try {
        const isReady = isTelegramReady && telegramClient && telegramClient.isReady;
        res.json({
            telegramReady: isReady,
            message: isReady ? 'Ready to upload' : 'Telegram client not initialized'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
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

// UPLOAD ENDPOINT
router.post('/upload', upload.single('file'), async (req, res) => {
    try {
        console.log('📥 Upload request received');

        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const file = req.file;
        const fileSizeMB = (file.size / 1024 / 1024).toFixed(2);

        // Generate UUID for stored filename
        const fileExtension = path.extname(file.originalname);
        const storedName = file.originalname;;

        console.log(`📁 Original: ${file.originalname}`);
        console.log(`📁 Stored as: ${storedName}`);
        console.log(`📊 Size: ${fileSizeMB} MB`);

        if (file.size > 2 * 1024 * 1024 * 1024) {
            return res.status(400).json({
                error: 'File exceeds 2GB limit',
                maxSize: '2GB',
                fileSize: `${fileSizeMB}MB`
            });
        }

        // Initialize Telegram if not ready
        const isReady = await initTelegram();
        if (!isReady) {
            return res.status(500).json({
                error: 'Telegram client not initialized'
            });
        }

        // Upload to Telegram private group
        console.log('📤 Uploading to Telegram...');
        const telegramResult = await telegramClient.uploadFileToPrivateGroup(
            file.buffer,
            file.originalname,
            file.mimetype
        );

        // Save to MySQL database
        const fileData = {
            originalName: file.originalname,
            storedName: storedName,
            fileSize: file.size,
            mimeType: file.mimetype,
            telegramMessageId: telegramResult.messageId.toString(),
            telegramGroupId: process.env.TELEGRAM_GROUP_ID || 'private_group',
            fileUrl: `tg://message?id=${telegramResult.messageId}`
        };

        const savedRecord = await dbStorage.saveFileRecord(fileData);

        res.json({
            success: true,
            message: 'File uploaded and saved to database!',
            file: {
                id: savedRecord.id,
                originalName: file.originalname,
                storedName: storedName,
                size: file.size,
                sizeInMB: fileSizeMB,
                mimeType: file.mimetype
            },
            telegram: {
                messageId: telegramResult.messageId,
                groupName: telegramResult.groupName,
                status: 'delivered'
            },
            database: {
                saved: true,
                recordId: savedRecord.id
            }
        });

    } catch (error) {
        console.error('❌ Upload error:', error);
        res.status(500).json({
            error: 'Upload failed',
            details: error.message
        });
    }
});

// GET ALL FILES endpoint
router.get('/files', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const files = await dbStorage.getAllFiles(limit);

        res.json({
            success: true,
            count: files.length,
            files: files
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET FILE BY ID endpoint
router.get('/files/:id', async (req, res) => {
    try {
        const file = await dbStorage.getFileById(req.params.id);

        if (!file) {
            return res.status(404).json({ error: 'File not found' });
        }

        res.json({
            success: true,
            file: file
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// VIEW FILE ONLINE
router.get('/view/:messageId', async (req, res) => {
    try {
        const messageId = req.params.messageId;
        const groupId = parseInt(process.env.TELEGRAM_GROUP_ID);

        // Get file info from database
        const fileRecord = await dbStorage.getFileByMessageId(messageId);

        if (!fileRecord) {
            return res.status(404).send('File record not found');
        }

        const chat = await telegramClient.client.getEntity(groupId);
        const messages = await telegramClient.client.getMessages(chat, {
            ids: [parseInt(messageId)]
        });

        if (!messages || messages.length === 0) {
            return res.status(404).send('File not found');
        }

        const message = messages[0];

        if (!message.media) {
            return res.status(404).send('No file in this message');
        }

        // Use filename from database
        const fileName = fileRecord.original_name;
        const mimeType = fileRecord.mime_type;

        const fileBuffer = await telegramClient.client.downloadMedia(message, {
            outputFile: undefined
        });

        res.setHeader('Content-Type', mimeType);
        res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
        res.setHeader('Content-Length', fileBuffer.length);
        res.send(fileBuffer);

    } catch (error) {
        console.error('View error:', error);
        res.status(500).send(`Error viewing file: ${error.message}`);
    }
});

// DOWNLOAD FILE endpoint
router.get('/download/:messageId', async (req, res) => {
    try {
        const messageId = req.params.messageId;
        const groupId = parseInt(process.env.TELEGRAM_GROUP_ID);

        // Get file info from database
        const fileRecord = await dbStorage.getFileByMessageId(messageId);

        if (!fileRecord) {
            return res.status(404).send('File record not found in database');
        }

        const chat = await telegramClient.client.getEntity(groupId);
        const messages = await telegramClient.client.getMessages(chat, {
            ids: [parseInt(messageId)]
        });

        if (!messages || messages.length === 0) {
            return res.status(404).send('File not found in Telegram');
        }

        const message = messages[0];

        if (!message.media) {
            return res.status(404).send('No file in this message');
        }

        // Use filename from database
        const fileName = fileRecord.original_name;
        const mimeType = fileRecord.mime_type;

        const fileBuffer = await telegramClient.client.downloadMedia(message, {
            outputFile: undefined
        });

        res.setHeader('Content-Type', mimeType);
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.setHeader('Content-Length', fileBuffer.length);
        res.send(fileBuffer);

    } catch (error) {
        console.error('Download error:', error);
        res.status(500).send(`Error downloading file: ${error.message}`);
    }
});

// SEARCH FILES endpoint
router.get('/search', async (req, res) => {
    try {
        const query = req.query.q;
        if (!query) {
            return res.status(400).json({ error: 'Search query required' });
        }

        const files = await dbStorage.searchFiles(query);

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

// GET STATS endpoint
router.get('/stats', async (req, res) => {
    try {
        const stats = await dbStorage.getStats();

        res.json({
            success: true,
            stats: stats
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// DELETE FILE endpoint
router.delete('/files/:id', async (req, res) => {
    try {
        const deleted = await dbStorage.deleteFileRecord(req.params.id);

        if (deleted) {
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

module.exports = router;