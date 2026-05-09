const express = require('express');
const router = express.Router();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const pool = require('../utils/database')

// Store temporary login data
const tempLogins = new Map();

// STEP 1: Send code to user's phone
router.post('/send-code', async (req, res) => {
    try {
        const { phoneNumber, apiId, apiHash } = req.body;

        if (!phoneNumber) {
            return res.status(400).json({ error: 'Phone number required' });
        }

        if (!apiId || !apiHash) {
            return res.status(400).json({ error: 'API ID and API Hash required' });
        }

        console.log(`📱 Sending code to ${phoneNumber}`);

        // Create client with user's API credentials
        const client = new TelegramClient(
            new StringSession(''),
            Number(apiId),
            apiHash,
            { connectionRetries: 3 }
        );

        await client.connect();

        const sentCode = await client.sendCode(
            {
                apiId: Number(apiId),
                apiHash: apiHash
            },
            phoneNumber
        );

        tempLogins.set(phoneNumber, {
            client: client,
            phoneCodeHash: sentCode.phoneCodeHash,
            apiId: apiId,
            apiHash: apiHash,
            expiresAt: Date.now() + 300000
        });

        res.json({
            success: true,
            message: 'Verification code sent to your Telegram',
            phoneNumber
        });

    } catch (error) {
        console.error('Send code error:', error);
        res.status(500).json({ error: error.message });
    }
});

// STEP 2: Verify code and save user session
router.post('/verify', async (req, res) => {
    try {
        const { phoneNumber, code, groupUsername, groupId } = req.body;

        const tempData = tempLogins.get(phoneNumber);
        if (!tempData) {
            return res.status(400).json({ error: 'Session expired. Request new code.' });
        }

        if (!groupId && !groupUsername) {
            return res.status(400).json({ error: 'Group ID or username required' });
        }

        console.log(`🔐 Verifying code for ${phoneNumber}`);

        // Complete login
        await tempData.client.invoke(
            new Api.auth.SignIn({
                phoneNumber: phoneNumber,
                phoneCode: String(code),
                phoneCodeHash: tempData.phoneCodeHash
            })
        );

        const me = await tempData.client.getMe();
        const sessionString = tempData.client.session.save();

        // Verify group/channel access
        let channelEntity;
        try {
            if (groupId) {
                channelEntity = await tempData.client.getEntity(groupId);
            } else if (groupUsername) {
                const dialogs = await tempData.client.getDialogs();
                const found = dialogs.find(d => {
                    const username = d.entity?.username?.toLowerCase();
                    const title = d.title?.toLowerCase();
                    const searchTerm = groupUsername.toLowerCase().replace('@', '');
                    return username === searchTerm || title === searchTerm;
                });

                if (found) {
                    channelEntity = found.entity;
                } else {
                    throw new Error('Channel not found in your dialogs');
                }
            }
        } catch (error) {
            console.log('Channel access error:', error.message);
            await tempData.client.disconnect();
            tempLogins.delete(phoneNumber);
            return res.status(400).json({
                error: `Cannot access "${groupUsername || groupId}". Make sure you have joined it in Telegram app.`
            });
        }

        // Disconnect temp client
        await tempData.client.disconnect();
        tempLogins.delete(phoneNumber);

        console.log(`✅ User verified: ${me.firstName} ${me.lastName}`);

        // Save to database with user's credentials
        const [existingUsers] = await pool.execute(
            'SELECT * FROM users WHERE phone_number = ?',
            [phoneNumber]
        );

        let user;
        if (existingUsers.length > 0) {
            user = existingUsers[0];
            await pool.execute(
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
                    last_login = NOW()
                WHERE phone_number = ?`,
                [
                    sessionString,
                    me.id.toString(),
                    me.username,
                    me.firstName,
                    me.lastName,
                    tempData.apiId,
                    tempData.apiHash,
                    groupId || channelEntity.id.toString(),
                    groupUsername || channelEntity.username,
                    phoneNumber
                ]
            );
        } else {
            const userId = uuidv4();
            await pool.execute(
                `INSERT INTO users (id, phone_number, telegram_session, telegram_id, username, 
                    first_name, last_name, telegram_api_id, telegram_api_hash, 
                    default_group_id, default_channel_username) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    userId,
                    phoneNumber,
                    sessionString,
                    me.id.toString(),
                    me.username,
                    me.firstName,
                    me.lastName,
                    tempData.apiId,
                    tempData.apiHash,
                    groupId || channelEntity.id.toString(),
                    groupUsername || channelEntity.username
                ]
            );
            user = { id: userId };
        }

        // Get user's channels with a NEW client
        const userClient = new TelegramClient(
            new StringSession(sessionString),
            Number(tempData.apiId),
            tempData.apiHash,
            { connectionRetries: 3 }
        );

        await userClient.connect();

        const dialogs = await userClient.getDialogs();
        const channels = dialogs.filter(d => d.isChannel || d.isGroup);

        for (const channel of channels) {
            const [existing] = await pool.execute(
                'SELECT * FROM user_channels WHERE user_id = ? AND channel_id = ?',
                [user.id, channel.id.toString()]
            );

            if (existing.length === 0) {
                await pool.execute(
                    `INSERT INTO user_channels (id, user_id, channel_id, channel_username, channel_title, access_hash) 
                     VALUES (?, ?, ?, ?, ?, ?)`,
                    [
                        uuidv4(),
                        user.id,
                        channel.id.toString(),
                        channel.entity.username,
                        channel.title,
                        channel.entity.accessHash?.toString()
                    ]
                );
            }
        }

        await userClient.disconnect();

        // Generate JWT token
        const token = jwt.sign(
            {
                userId: user.id,
                phoneNumber: phoneNumber,
                defaultGroupId: groupId || channelEntity.id.toString()
            },
            process.env.JWT_SECRET || 'your-secret-key',
            { expiresIn: '7d' }
        );

        res.json({
            success: true,
            token,
            user: {
                id: user.id,
                phoneNumber: phoneNumber,
                username: me.username,
                firstName: me.firstName,
                lastName: me.lastName,
                defaultGroupId: groupId || channelEntity.id.toString(),
                defaultChannelUsername: groupUsername || channelEntity.username
            },
            channels: channels.map(c => ({
                id: c.id,
                title: c.title,
                username: c.entity.username
            }))
        });

    } catch (error) {
        console.error('Verify error:', error);
        // Clean up on error
        const tempData = tempLogins.get(req.body.phoneNumber);
        if (tempData && tempData.client) {
            await tempData.client.disconnect();
            tempLogins.delete(req.body.phoneNumber);
        }
        res.status(500).json({ error: error.message });
    }
});

// Get user info
router.get('/me', async (req, res) => {
    try {
        const token = req.headers.authorization?.replace('Bearer ', '');
        if (!token) {
            return res.status(401).json({ error: 'No token' });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');

        const [users] = await pool.execute(
            'SELECT id, phone_number, username, first_name, last_name, default_group_id, default_channel_username FROM users WHERE id = ?',
            [decoded.userId]
        );

        if (users.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const [channels] = await pool.execute(
            'SELECT channel_id, channel_title, channel_username FROM user_channels WHERE user_id = ?',
            [users[0].id]
        );

        res.json({
            user: users[0],
            channels: channels
        });

    } catch (error) {
        res.status(401).json({ error: 'Invalid token' });
    }
});

router.post('/complete-profile', async (req, res) => {
    try {
        const token = req.headers.authorization?.replace('Bearer ', '');
        if (!token) {
            return res.status(401).json({ error: 'No token provided' });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password required' });
        }

        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }

        const bcrypt = require('bcrypt');
        const password_hash = await bcrypt.hash(password, 10);

        const [result] = await pool.execute(
            `UPDATE users 
             SET email = ?, password_hash = ?, is_profile_complete = TRUE, updated_at = NOW()
             WHERE id = ?`,
            [email, password_hash, decoded.userId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.json({
            success: true,
            message: 'Profile completed. You can now login with email/password.'
        });

    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'Email already in use' });
        }
        console.error('Complete profile error:', error);
        res.status(500).json({ error: error.message });
    }
});

router.post('/login', async (req, res) => {
    try {
        const { identifier, password } = req.body; // identifier = email or phone

        if (!identifier || !password) {
            return res.status(400).json({ error: 'Email/phone and password required' });
        }

        const [users] = await pool.execute(
            'SELECT * FROM users WHERE (email = ? OR phone_number = ?) AND is_profile_complete = TRUE',
            [identifier, identifier]
        );

        if (users.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials or profile not set up' });
        }

        const user = users[0];

        if (!user.password_hash) {
            return res.status(401).json({ error: 'Please login via Telegram OTP first' });
        }

        const isValid = await bcrypt.compare(password, user.password_hash);
        if (!isValid) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        await pool.execute('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);

        const token = jwt.sign(
            { userId: user.id, phoneNumber: user.phone_number, defaultGroupId: user.default_group_id },
            process.env.JWT_SECRET || 'your-secret-key',
            { expiresIn: '7d' }
        );

        res.json({
            success: true,
            token,
            user: {
                id: user.id,
                email: user.email,
                phoneNumber: user.phone_number,
                username: user.username,
                firstName: user.first_name,
                lastName: user.last_name,
                defaultGroupId: user.default_group_id,
                defaultChannelUsername: user.default_channel_username
            }
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// CHECK if user needs to complete profile (call after Telegram verify)
router.get('/profile-status', async (req, res) => {
    try {
        const token = req.headers.authorization?.replace('Bearer ', '');
        if (!token) return res.status(401).json({ error: 'No token' });

        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
        const [users] = await pool.execute(
            'SELECT is_profile_complete, email, first_name FROM users WHERE id = ?',
            [decoded.userId]
        );

        if (users.length === 0) return res.status(404).json({ error: 'User not found' });

        res.json({
            isProfileComplete: users[0].is_profile_complete,
            email: users[0].email,
            firstName: users[0].first_name
        });
    } catch (error) {
        res.status(401).json({ error: 'Invalid token' });
    }
});

// Logout
router.post('/logout', (req, res) => {
    res.json({ success: true, message: 'Logged out' });
});

module.exports = router;