// All /api routes except auth (mounted separately at /api/auth in app.js).
const express = require('express');

const router = express.Router();

router.use(require('./health'));
router.use(require('./upload'));    // upload, progress stream, cancel
router.use(require('./download'));  // download ticket, download, view/thumbnails
router.use(require('./files'));     // list, get, search, stats, delete, move, copy, rename
router.use(require('./folders'));
router.use(require('./channels'));  // sync-channels, channels

module.exports = router;
