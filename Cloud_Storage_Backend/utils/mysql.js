// utils/mysql.js
const mysql = require('mysql2/promise');

// Create connection pool
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'cloud_storage',
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

class MySQLStorage {
    // Save file record to database
    async saveFileRecord(fileData) {
        try {
            const query = `
                INSERT INTO uploaded_files 
                (id, original_name, stored_name, file_size, mime_type, telegram_message_id, telegram_group_id, file_url, created_at)
                VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, NOW())
            `;
            
            const [result] = await pool.execute(query, [
                fileData.originalName,
                fileData.storedName,
                fileData.fileSize,
                fileData.mimeType,
                fileData.telegramMessageId,
                fileData.telegramGroupId,
                fileData.fileUrl
            ]);
            
            // Get the inserted record
            const [rows] = await pool.execute(
                'SELECT * FROM uploaded_files WHERE telegram_message_id = ?',
                [fileData.telegramMessageId]
            );
            
            console.log('✅ File record saved to MySQL');
            return rows[0];
        } catch (error) {
            console.error('❌ Error saving to MySQL:', error.message);
            throw error;
        }
    }

    // Get all files - FIXED VERSION
    async getAllFiles(limit = 50) {
        try {
            // Remove the ? placeholder and use string concatenation for LIMIT
            const query = `SELECT * FROM uploaded_files ORDER BY created_at DESC LIMIT ${parseInt(limit)}`;
            const [rows] = await pool.execute(query);
            return rows;
        } catch (error) {
            console.error('Error fetching files:', error.message);
            return [];
        }
    }

    // Get file by ID
    async getFileById(id) {
        try {
            const [rows] = await pool.execute(
                'SELECT * FROM uploaded_files WHERE id = ?',
                [id]
            );
            return rows[0] || null;
        } catch (error) {
            console.error('Error fetching file:', error.message);
            return null;
        }
    }

    // Get file by message ID
    async getFileByMessageId(messageId) {
        try {
            const [rows] = await pool.execute(
                'SELECT * FROM uploaded_files WHERE telegram_message_id = ?',
                [String(messageId)]
            );
            return rows[0] || null;
        } catch (error) {
            console.error('Error fetching file by message ID:', error.message);
            return null;
        }
    }

    // Get file by stored name
    async getFileByStoredName(storedName) {
        try {
            const [rows] = await pool.execute(
                'SELECT * FROM uploaded_files WHERE stored_name = ?',
                [storedName]
            );
            return rows[0] || null;
        } catch (error) {
            console.error('Error fetching file:', error.message);
            return null;
        }
    }

    // Delete file record
    async deleteFileRecord(id) {
        try {
            const [result] = await pool.execute(
                'DELETE FROM uploaded_files WHERE id = ?',
                [id]
            );
            console.log('✅ File record deleted from MySQL');
            return result.affectedRows > 0;
        } catch (error) {
            console.error('Error deleting file:', error.message);
            return false;
        }
    }

    // Search files by name
    async searchFiles(searchTerm) {
        try {
            const [rows] = await pool.execute(
                'SELECT * FROM uploaded_files WHERE original_name LIKE ? ORDER BY created_at DESC',
                [`%${searchTerm}%`]
            );
            return rows;
        } catch (error) {
            console.error('Error searching files:', error.message);
            return [];
        }
    }

    // Get file statistics
    async getStats() {
        try {
            const [rows] = await pool.execute(`
                SELECT 
                    COUNT(*) as totalFiles,
                    SUM(file_size) as totalSize,
                    AVG(file_size) as avgSize
                FROM uploaded_files
            `);
            
            const stats = rows[0];
            return {
                totalFiles: stats.totalFiles || 0,
                totalSize: stats.totalSize || 0,
                avgSize: stats.avgSize || 0,
                totalSizeInGB: ((stats.totalSize || 0) / (1024 * 1024 * 1024)).toFixed(2),
                totalSizeInMB: ((stats.totalSize || 0) / (1024 * 1024)).toFixed(2)
            };
        } catch (error) {
            console.error('Error getting stats:', error.message);
            return null;
        }
    }

    // Update file record
    async updateFileRecord(id, updates) {
        try {
            const fields = [];
            const values = [];
            
            if (updates.original_name) {
                fields.push('original_name = ?');
                values.push(updates.original_name);
            }
            if (updates.stored_name) {
                fields.push('stored_name = ?');
                values.push(updates.stored_name);
            }
            
            if (fields.length === 0) return false;
            
            values.push(id);
            const query = `UPDATE uploaded_files SET ${fields.join(', ')} WHERE id = ?`;
            
            const [result] = await pool.execute(query, values);
            return result.affectedRows > 0;
        } catch (error) {
            console.error('Error updating file:', error.message);
            return false;
        }
    }
}

module.exports = new MySQLStorage();