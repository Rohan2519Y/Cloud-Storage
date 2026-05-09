const mysql = require('mysql2/promise');
const { v4: uuidv4 } = require('uuid');
const pool = require('./database')

class UserDatabase {
    constructor() {
        this.pool = pool;
    }

    async init() {
        console.log('✅ User database initialized');
    }

    async saveUserSession(phoneNumber, sessionString, telegramId, userInfo, apiId, apiHash, groupId, channelUsername) {
        const id = uuidv4();

        const [existing] = await this.pool.execute(
            'SELECT * FROM users WHERE phone_number = ?',
            [phoneNumber]
        );

        if (existing.length > 0) {
            await this.pool.execute(
                `UPDATE users SET 
                    telegram_session = ?,
                    telegram_id = ?,
                    username = ?,
                    first_name = ?,
                    last_name = ?,
                    telegram_api_id = ?,
                    telegram_api_hash = ?,
                    default_group_id = ?,
                    default_channel_username = ?,
                    last_login = NOW(),
                    updated_at = NOW()
                WHERE phone_number = ?`,
                [sessionString, telegramId, userInfo.username, userInfo.firstName, userInfo.lastName,
                    apiId, apiHash, groupId, channelUsername, phoneNumber]
            );
            return existing[0];
        } else {
            await this.pool.execute(
                `INSERT INTO users (id, phone_number, telegram_session, telegram_id, username, 
                    first_name, last_name, telegram_api_id, telegram_api_hash, 
                    default_group_id, default_channel_username) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [id, phoneNumber, sessionString, telegramId, userInfo.username,
                    userInfo.firstName, userInfo.lastName, apiId, apiHash, groupId, channelUsername]
            );
            return { id, phone_number: phoneNumber, ...userInfo };
        }
    }

    async getUserByPhone(phoneNumber) {
        const [rows] = await this.pool.execute(
            'SELECT * FROM users WHERE phone_number = ?',
            [phoneNumber]
        );
        return rows[0];
    }

    async getUserById(userId) {
        const [rows] = await this.pool.execute(
            'SELECT * FROM users WHERE id = ?',
            [userId]
        );
        return rows[0];
    }

    async saveUserChannel(userId, channelId, channelUsername, channelTitle, accessHash) {
        const id = uuidv4();

        const [existing] = await this.pool.execute(
            'SELECT * FROM user_channels WHERE user_id = ? AND channel_id = ?',
            [userId, channelId]
        );

        if (existing.length === 0) {
            await this.pool.execute(
                `INSERT INTO user_channels (id, user_id, channel_id, channel_username, channel_title, access_hash) 
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [id, userId, channelId, channelUsername, channelTitle, accessHash]
            );
        }
    }

    async getUserChannels(userId) {
        const [rows] = await this.pool.execute(
            'SELECT * FROM user_channels WHERE user_id = ? AND is_active = TRUE',
            [userId]
        );
        return rows;
    }

    async saveLoginSession(phoneNumber, sessionData, expiresIn = 300000) {
        const id = uuidv4();
        const expiresAt = new Date(Date.now() + expiresIn);

        await this.pool.execute(
            `INSERT INTO login_sessions (id, phone_number, session_data, expires_at) 
             VALUES (?, ?, ?, ?)`,
            [id, phoneNumber, JSON.stringify(sessionData), expiresAt]
        );

        return id;
    }

    async getLoginSession(phoneNumber) {
        const [rows] = await this.pool.execute(
            'SELECT * FROM login_sessions WHERE phone_number = ? AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1',
            [phoneNumber]
        );

        if (rows.length > 0) {
            return JSON.parse(rows[0].session_data);
        }
        return null;
    }

    async deleteLoginSession(phoneNumber) {
        await this.pool.execute(
            'DELETE FROM login_sessions WHERE phone_number = ?',
            [phoneNumber]
        );
    }

    async logActivity(userId, action, details = {}, ip = null) {
        const id = uuidv4();
        await this.pool.execute(
            `INSERT INTO activity_logs (id, user_id, action, details, ip_address) 
             VALUES (?, ?, ?, ?, ?)`,
            [id, userId, action, JSON.stringify(details), ip]
        );
    }

    async close() {
        if (this.pool) {
            await this.pool.end();
        }
    }
}

module.exports = new UserDatabase();