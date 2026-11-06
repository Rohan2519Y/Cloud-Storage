const express = require('express');
const { requireUser, requireTelegram } = require('../utils/authMiddleware');
const { sendError, asyncHandler } = require('../utils/httpErrors');
const { handleTelegramFailure, revokedExtra } = require('../services/telegram');
const channels = require('../services/channelService');

const router = express.Router();

router.post('/sync-channels', requireTelegram, async (req, res) => {
    try {
        const synced = await channels.syncFromTelegram(req.user);
        res.json({ success: true, synced: synced.length, channels: synced });
    } catch (err) {
        // A revoked session must be marked dead so a sync retry doesn't keep reconnecting with
        // the same dead auth key (see services/telegram.js).
        const sessionRevoked = handleTelegramFailure(req.user, err, { operationStarted: err.tgOperationStarted });
        sendError(res, err, 'Sync-channels error', revokedExtra(sessionRevoked));
    }
});

router.get('/channels', requireUser, asyncHandler(async (req, res) => {
    res.json({ success: true, channels: await channels.listActive(req.user.id) });
}));

module.exports = router;
