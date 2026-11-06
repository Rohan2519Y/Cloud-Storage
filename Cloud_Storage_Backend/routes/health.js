const express = require('express');
const tgManager = require('../utils/telegramClientManager');
const uploads = require('../services/uploadProgress');

const router = express.Router();

router.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        activeUploads: uploads.getActiveUploads(),
        maxConcurrentUploads: uploads.MAX_CONCURRENT_UPLOADS,
        cachedTelegramClients: tgManager.clients?.size ?? 0,
        mode: 'mtcute-streaming',
    });
});

module.exports = router;
