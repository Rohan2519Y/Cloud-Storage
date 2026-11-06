const express = require('express');
const { requireUser, requireTelegram } = require('../utils/authMiddleware');
const { sendError, asyncHandler } = require('../utils/httpErrors');
const { rateLimit } = require('../utils/rateLimit');
const tgManager = require('../utils/telegramClientManager');
const { DEAD_SESSION_PATTERN, runTelegramOperation } = require('../services/telegram');
const files = require('../services/fileService');
const folders = require('../services/folderService');

const router = express.Router();

router.get('/files', requireUser, asyncHandler(async (req, res) => {
    const folderId = req.query.folder_id === 'null' ? null : req.query.folder_id || null;
    const list = await files.list(req.user.id, folderId, req.query.limit);
    res.json({ success: true, count: list.length, files: list });
}));

router.get('/files/:id', requireUser, asyncHandler(async (req, res) => {
    const file = await files.getById(req.user.id, req.params.id);
    if (!file) return res.status(404).json({ error: 'File not found' });
    res.json({ success: true, file });
}));

router.get('/search', requireUser, rateLimit(30, 60 * 1000), asyncHandler(async (req, res) => {
    const q = req.query.q;
    if (typeof q !== 'string' || q.length < 2) return res.status(400).json({ error: 'Query must be at least 2 characters' });
    const found = await files.search(req.user.id, q);
    res.json({ success: true, query: q, count: found.length, files: found });
}));

router.get('/stats', requireUser, asyncHandler(async (req, res) => {
    const stats = await files.getStats(req.user.id);
    res.json({
        success: true,
        stats: {
            totalFiles: stats.totalFiles,
            totalSizeInMB: (stats.totalSize / 1024 / 1024).toFixed(2),
            totalSizeInGB: (stats.totalSize / 1024 / 1024 / 1024).toFixed(3),
        },
    });
}));

router.delete('/files/:id', requireTelegram, async (req, res) => {
    try {
        const file = await files.getById(req.user.id, req.params.id);
        if (!file) return res.status(404).json({ error: 'File not found' });

        // Copies share the same Telegram message — only delete it there once the last
        // reference to it is being removed.
        if (!(await files.hasOtherReferences(req.user.id, file))) {
            try {
                await runTelegramOperation(req.user, async (client) => {
                    await client.deleteMessagesById(parseInt(file.channel_id), [parseInt(file.telegram_message_id)], { revoke: true });
                    console.log(`🗑️ Deleted message ${file.telegram_message_id} from Telegram`);
                });
            } catch (tgErr) {
                console.error('Telegram delete error:', tgErr.message);
                // Bulk deletes fire one request per file — without this, deleting many files after
                // the session died means each one retries a fresh connection on the same dead auth
                // key, the exact repeated-failed-auth pattern that gets Telegram to terminate every
                // session on the account, phone included. (The DB record is still removed below.)
                if (tgErr.sessionRevoked || DEAD_SESSION_PATTERN.test(tgErr.message)) {
                    tgManager.markSessionDead(req.user.id, req.user.telegram_session);
                }
            }
        }

        if (!(await files.remove(req.user.id, req.params.id))) return res.status(404).json({ error: 'File not found' });
        res.json({ success: true, message: 'File deleted from Telegram and database' });
    } catch (err) {
        sendError(res, err, `${req.method} ${req.path} error`);
    }
});

// Move: drag & drop into a folder, or cut+paste.
router.put('/files/:id/move', requireUser, asyncHandler(async (req, res) => {
    const folderId = req.body.folderId || null;
    if (folderId && !(await folders.belongsToUser(req.user.id, folderId))) {
        return res.status(404).json({ error: 'Target folder not found' });
    }
    if (!(await files.move(req.user.id, req.params.id, folderId))) return res.status(404).json({ error: 'File not found' });
    res.json({ success: true });
}));

// Copy: copy+paste (shares the underlying Telegram message; see fileService.copy).
router.post('/files/:id/copy', requireUser, asyncHandler(async (req, res) => {
    const folderId = req.body.folderId || null;
    if (folderId && !(await folders.belongsToUser(req.user.id, folderId))) {
        return res.status(404).json({ error: 'Target folder not found' });
    }
    const copied = await files.copy(req.user.id, req.params.id, folderId);
    if (!copied) return res.status(404).json({ error: 'File not found' });
    res.json({ success: true, file: copied });
}));

router.put('/files/:id/rename', requireUser, asyncHandler(async (req, res) => {
    const newName = typeof req.body.newName === 'string' ? req.body.newName.trim() : '';
    if (!newName) return res.status(400).json({ error: 'New name required' });
    if (newName.length > 500) return res.status(400).json({ error: 'Name is too long' });
    if (!(await files.rename(req.user.id, req.params.id, newName))) return res.status(404).json({ error: 'File not found' });
    res.json({ success: true, message: 'File renamed' });
}));

module.exports = router;
