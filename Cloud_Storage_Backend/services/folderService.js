// Folder data access. Every query is scoped by user_id.
const { v4: uuidv4 } = require('uuid');
const pool = require('../utils/database');

const MAX_FOLDER_NAME = 255;
const MAX_FOLDER_DEPTH = 50;

const cleanName = (v) => (typeof v === 'string' ? v.trim() : '');

async function belongsToUser(userId, folderId) {
    const [rows] = await pool.execute('SELECT id FROM folders WHERE id = ? AND user_id = ?', [folderId, userId]);
    return rows.length > 0;
}

async function listChildren(userId, parentId) {
    const [folders] = await pool.execute(
        'SELECT * FROM folders WHERE user_id = ? AND parent_id ' + (parentId ? '= ?' : 'IS NULL') + ' ORDER BY name',
        parentId ? [userId, parentId] : [userId]
    );
    return folders;
}

async function create(userId, name, parentId) {
    const id = uuidv4();
    await pool.execute('INSERT INTO folders (id, user_id, name, parent_id) VALUES (?, ?, ?, ?)', [id, userId, name, parentId]);
    return id;
}

async function remove(userId, folderId) {
    await pool.execute('DELETE FROM folders WHERE id = ? AND user_id = ?', [folderId, userId]);
}

// Returns true if a row was renamed.
async function rename(userId, folderId, newName) {
    const [result] = await pool.execute(
        'UPDATE folders SET name = ? WHERE id = ? AND user_id = ?',
        [newName, folderId, userId]
    );
    return result.affectedRows > 0;
}

// Root → leaf. user_id is in the lookup so a user can't read another user's folder names
// by id; the depth cap stops a corrupted parent cycle from looping forever.
async function getPath(userId, folderId) {
    const path = [];
    let currentId = folderId;
    while (currentId && path.length < MAX_FOLDER_DEPTH) {
        const [rows] = await pool.execute('SELECT * FROM folders WHERE id = ? AND user_id = ?', [currentId, userId]);
        if (rows.length === 0) break;
        path.unshift(rows[0]);
        currentId = rows[0].parent_id;
    }
    return path;
}

module.exports = { MAX_FOLDER_NAME, cleanName, belongsToUser, listChildren, create, remove, rename, getPath };
