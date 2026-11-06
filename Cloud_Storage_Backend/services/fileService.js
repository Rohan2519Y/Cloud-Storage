// File-record data access (the uploaded_files table). Every query is scoped by user_id.
const { v4: uuidv4 } = require('uuid');
const pool = require('../utils/database');

const LIST_COLUMNS = 'id, original_name, file_size, mime_type, telegram_message_id, channel_id, folder_id, created_at';

async function list(userId, folderId, limit) {
    const lim = Math.min(parseInt(limit) || 50, 100); // integer by construction, safe to inline
    const [files] = folderId
        ? await pool.execute(
            `SELECT ${LIST_COLUMNS} FROM uploaded_files WHERE user_id = ? AND folder_id = ? ORDER BY created_at DESC LIMIT ${lim}`,
            [userId, folderId])
        : await pool.execute(
            `SELECT ${LIST_COLUMNS} FROM uploaded_files WHERE user_id = ? AND folder_id IS NULL ORDER BY created_at DESC LIMIT ${lim}`,
            [userId]);
    return files;
}

async function getById(userId, id) {
    const [files] = await pool.execute('SELECT * FROM uploaded_files WHERE id = ? AND user_id = ?', [id, userId]);
    return files[0] || null;
}

async function getByMessageId(userId, messageId) {
    const [files] = await pool.execute(
        'SELECT * FROM uploaded_files WHERE telegram_message_id = ? AND user_id = ?',
        [messageId, userId]
    );
    return files[0] || null;
}

async function search(userId, query) {
    const [files] = await pool.execute(
        `SELECT id, original_name, file_size, mime_type, telegram_message_id, created_at
         FROM uploaded_files WHERE user_id = ? AND original_name LIKE ? ORDER BY created_at DESC LIMIT 50`,
        [userId, `%${query}%`]
    );
    return files;
}

async function getStats(userId) {
    const [[stats]] = await pool.execute(
        `SELECT COUNT(*) as totalFiles, COALESCE(SUM(file_size), 0) as totalSize FROM uploaded_files WHERE user_id = ?`,
        [userId]
    );
    return stats;
}

async function insert(userId, { name, size, mimeType, messageId, channelId, folderId }) {
    const id = uuidv4();
    await pool.execute(
        `INSERT INTO uploaded_files
         (id, user_id, original_name, file_size, mime_type, telegram_message_id, channel_id, folder_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [id, userId, name, size, mimeType, String(messageId), channelId, folderId]
    );
    return id;
}

// Copies (see copy()) share the same underlying Telegram message, so the message may only be
// deleted from Telegram once the last record referencing it is being removed.
async function hasOtherReferences(userId, file) {
    const [rows] = await pool.execute(
        'SELECT id FROM uploaded_files WHERE channel_id = ? AND telegram_message_id = ? AND user_id = ? AND id != ?',
        [file.channel_id, file.telegram_message_id, userId, file.id]
    );
    return rows.length > 0;
}

// Each returns true if a row was affected.
async function remove(userId, id) {
    const [result] = await pool.execute('DELETE FROM uploaded_files WHERE id = ? AND user_id = ?', [id, userId]);
    return result.affectedRows > 0;
}

async function move(userId, id, folderId) {
    const [result] = await pool.execute(
        'UPDATE uploaded_files SET folder_id = ? WHERE id = ? AND user_id = ?',
        [folderId, id, userId]
    );
    return result.affectedRows > 0;
}

async function rename(userId, id, newName) {
    const [result] = await pool.execute(
        'UPDATE uploaded_files SET original_name = ? WHERE id = ? AND user_id = ?',
        [newName, id, userId]
    );
    return result.affectedRows > 0;
}

// The copy shares the same underlying Telegram message rather than re-uploading —
// cheap and instant, at the cost of both records pointing at one file (see
// hasOtherReferences). Returns the new record's fields, or null if the source isn't found.
async function copy(userId, id, folderId) {
    const src = await getById(userId, id);
    if (!src) return null;
    const newId = await insert(userId, {
        name: src.original_name,
        size: src.file_size,
        mimeType: src.mime_type,
        messageId: src.telegram_message_id,
        channelId: src.channel_id,
        folderId,
    });
    return {
        id: newId,
        original_name: src.original_name,
        file_size: src.file_size,
        mime_type: src.mime_type,
        telegram_message_id: src.telegram_message_id,
        channel_id: src.channel_id,
        folder_id: folderId,
    };
}

module.exports = {
    list, getById, getByMessageId, search, getStats, insert,
    hasOtherReferences, remove, move, rename, copy,
};
