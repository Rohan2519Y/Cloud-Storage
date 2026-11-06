const express = require('express');
const { requireUser } = require('../utils/authMiddleware');
const { asyncHandler } = require('../utils/httpErrors');
const folders = require('../services/folderService');

const router = express.Router();

// Express 4 doesn't catch rejected promises from async handlers; asyncHandler forwards them
// to the app-level error handler (generic 500) instead of crashing the process.

router.get('/folders', requireUser, asyncHandler(async (req, res) => {
    const parentId = req.query.parent_id === 'null' ? null : req.query.parent_id || null;
    res.json({ success: true, folders: await folders.listChildren(req.user.id, parentId) });
}));

router.post('/folders', requireUser, asyncHandler(async (req, res) => {
    const name = folders.cleanName(req.body.name);
    const parentId = req.body.parent_id || null;
    if (!name || name.length > folders.MAX_FOLDER_NAME) {
        return res.status(400).json({ error: `Folder name must be 1-${folders.MAX_FOLDER_NAME} characters` });
    }
    if (parentId && !(await folders.belongsToUser(req.user.id, parentId))) {
        return res.status(404).json({ error: 'Parent folder not found' });
    }
    const id = await folders.create(req.user.id, name, parentId);
    res.json({ success: true, folder: { id, name, parent_id: parentId } });
}));

router.delete('/folders/:id', requireUser, asyncHandler(async (req, res) => {
    await folders.remove(req.user.id, req.params.id);
    res.json({ success: true });
}));

router.get('/folders/path/:id', requireUser, asyncHandler(async (req, res) => {
    res.json({ success: true, path: await folders.getPath(req.user.id, req.params.id) });
}));

router.put('/folders/:id/rename', requireUser, asyncHandler(async (req, res) => {
    const newName = folders.cleanName(req.body.newName);
    if (!newName) return res.status(400).json({ error: 'New name required' });
    if (newName.length > folders.MAX_FOLDER_NAME) {
        return res.status(400).json({ error: `Folder name must be 1-${folders.MAX_FOLDER_NAME} characters` });
    }
    if (!(await folders.rename(req.user.id, req.params.id, newName))) {
        return res.status(404).json({ error: 'Folder not found' });
    }
    res.json({ success: true, message: 'Folder renamed' });
}));

module.exports = router;
