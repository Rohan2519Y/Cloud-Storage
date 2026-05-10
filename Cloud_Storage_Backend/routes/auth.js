// routes/auth.js — optimized and secured
const express = require('express');
const router  = express.Router();
const { TelegramClient } = require('telegram');
const { StringSession }  = require('telegram/sessions');
const { Api }  = require('telegram');
const jwt      = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const bcrypt   = require('bcrypt');
const pool     = require('../utils/database');

// ─── JWT helper — no fallback secret ──────────────────────────────────────

function getJwtSecret() {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET environment variable is not set');
    return secret;
}

function signToken(payload) {
    return jwt.sign(payload, getJwtSecret(), { expiresIn: '7d' });
}

function verifyToken(token) {
    return jwt.verify(token, getJwtSecret());
}

// ─── Temp OTP store with automatic cleanup ─────────────────────────────────

const tempLogins = new Map();

// Clean up expired OTP sessions every 60 seconds
setInterval(async () => {
    const now = Date.now();
    for (const [phone, data] of tempLogins) {
        if (now > data.expiresAt) {
            try { await data.client.disconnect(); } catch (_) {}
            tempLogins.delete(phone);
            console.log(`🧹 Cleaned up expired OTP session for ${phone}`);
        }
    }
}, 60 * 1000);

// ─── Simple rate limiter ────────────────────────────────────────────────────

const rateLimitStore = new Map();
function rateLimit(maxReq, windowMs) {
    return (req, res, next) => {
        const key = req.ip;
        const now = Date.now();
        const entry = rateLimitStore.get(key) || { count: 0, resetAt: now + windowMs };
        if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + windowMs; }
        entry.count++;
        rateLimitStore.set(key, entry);
        if (entry.count > maxReq) {
            return res.status(429).json({ error: 'Too many requests. Try again later.' });
        }
        next();
    };
}

// Clean rate store every 5 min
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of rateLimitStore) {
        if (now > v.resetAt) rateLimitStore.delete(k);
    }
}, 5 * 60 * 1000);

// ─── Auth middleware ────────────────────────────────────────────────────────

async function authenticate(req, res, next) {
    try {
        const token = req.headers.authorization?.replace('Bearer ', '');
        if (!token) return res.status(401).json({ error: 'No token provided' });
        const decoded = verifyToken(token);
        const [users] = await pool.execute('SELECT * FROM users WHERE id = ?', [decoded.userId]);
        if (users.length === 0) return res.status(401).json({ error: 'User not found' });
        req.user = users[0];
        req.decoded = decoded;
        next();
    } catch {
        res.status(401).json({ error: 'Invalid or expired token' });
    }
}

// ─── STEP 1: Send OTP ──────────────────────────────────────────────────────

router.post('/send-code', rateLimit(5, 60 * 1000), async (req, res) => {
    try {
        const { phoneNumber, apiId, apiHash } = req.body;

        if (!phoneNumber) return res.status(400).json({ error: 'Phone number required' });
        if (!apiId || !apiHash) return res.status(400).json({ error: 'API ID and API Hash required' });

        // Disconnect any existing session for this phone
        if (tempLogins.has(phoneNumber)) {
            try { await tempLogins.get(phoneNumber).client.disconnect(); } catch (_) {}
            tempLogins.delete(phoneNumber);
        }

        console.log(`📱 Sending OTP to ${phoneNumber}`);

        const client = new TelegramClient(
            new StringSession(''),
            Number(apiId),
            apiHash,
            { connectionRetries: 3, timeout: 20 }
        );

        await client.connect();

        const sentCode = await client.sendCode({ apiId: Number(apiId), apiHash }, phoneNumber);

        tempLogins.set(phoneNumber, {
            client,
            phoneCodeHash: sentCode.phoneCodeHash,
            apiId,
            apiHash,
            expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes
        });

        res.json({ success: true, message: 'Code sent to Telegram', phoneNumber });

    } catch (err) {
        console.error('Send code error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── STEP 2: Verify OTP ────────────────────────────────────────────────────

router.post('/verify', rateLimit(10, 60 * 1000), async (req, res) => {
    try {
        const { phoneNumber, code, groupUsername, groupId } = req.body;

        const tempData = tempLogins.get(phoneNumber);
        if (!tempData) return res.status(400).json({ error: 'Session expired. Request a new code.' });
        if (Date.now() > tempData.expiresAt) {
            try { await tempData.client.disconnect(); } catch (_) {}
            tempLogins.delete(phoneNumber);
            return res.status(400).json({ error: 'Code expired. Request a new one.' });
        }
        if (!groupId && !groupUsername) {
            return res.status(400).json({ error: 'Group ID or username required' });
        }

        await tempData.client.invoke(new Api.auth.SignIn({
            phoneNumber,
            phoneCode: String(code),
            phoneCodeHash: tempData.phoneCodeHash,
        }));

        const me = await tempData.client.getMe();
        const sessionString = tempData.client.session.save();

        // Verify channel access
        let channelEntity;
        try {
            channelEntity = groupId
                ? await tempData.client.getEntity(groupId)
                : await (async () => {
                    const dialogs = await tempData.client.getDialogs();
                    const term = groupUsername.toLowerCase().replace('@', '');
                    const found = dialogs.find(d =>
                        d.entity?.username?.toLowerCase() === term ||
                        d.title?.toLowerCase() === term
                    );
                    if (!found) throw new Error('Channel not found in your dialogs');
                    return found.entity;
                })();
        } catch (err) {
            await tempData.client.disconnect();
            tempLogins.delete(phoneNumber);
            return res.status(400).json({ error: `Cannot access "${groupUsername || groupId}": ${err.message}` });
        }

        await tempData.client.disconnect();
        tempLogins.delete(phoneNumber);

        // Save/update user in DB
        const [existingUsers] = await pool.execute(
            'SELECT * FROM users WHERE phone_number = ?', [phoneNumber]
        );

        let userId;
        if (existingUsers.length > 0) {
            userId = existingUsers[0].id;
            await pool.execute(
                `UPDATE users SET telegram_session=?, telegram_id=?, username=?, first_name=?,
                 last_name=?, telegram_api_id=?, telegram_api_hash=?, default_group_id=?,
                 default_channel_username=?, last_login=NOW() WHERE phone_number=?`,
                [sessionString, me.id.toString(), me.username, me.firstName, me.lastName,
                 tempData.apiId, tempData.apiHash,
                 groupId || channelEntity.id.toString(),
                 groupUsername || channelEntity.username, phoneNumber]
            );
        } else {
            userId = uuidv4();
            await pool.execute(
                `INSERT INTO users (id, phone_number, telegram_session, telegram_id, username,
                 first_name, last_name, telegram_api_id, telegram_api_hash,
                 default_group_id, default_channel_username)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [userId, phoneNumber, sessionString, me.id.toString(), me.username,
                 me.firstName, me.lastName, tempData.apiId, tempData.apiHash,
                 groupId || channelEntity.id.toString(),
                 groupUsername || channelEntity.username]
            );
        }

        // Sync user's channels — reuse fresh client from saved session
        const userClient = new TelegramClient(
            new StringSession(sessionString),
            Number(tempData.apiId),
            tempData.apiHash,
            { connectionRetries: 3 }
        );
        await userClient.connect();

        const dialogs  = await userClient.getDialogs();
        const channels = dialogs.filter(d => d.isChannel || d.isGroup);

        // Batch insert channels (skip duplicates)
        for (const ch of channels) {
            const [existing] = await pool.execute(
                'SELECT id FROM user_channels WHERE user_id = ? AND channel_id = ?',
                [userId, ch.id.toString()]
            );
            if (existing.length === 0) {
                await pool.execute(
                    `INSERT INTO user_channels (id, user_id, channel_id, channel_username, channel_title, access_hash)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                    [uuidv4(), userId, ch.id.toString(), ch.entity.username, ch.title,
                     ch.entity.accessHash?.toString()]
                );
            }
        }

        await userClient.disconnect();

        const token = signToken({
            userId,
            phoneNumber,
            defaultGroupId: groupId || channelEntity.id.toString(),
        });

        res.json({
            success: true,
            token,
            user: {
                id: userId, phoneNumber, username: me.username,
                firstName: me.firstName, lastName: me.lastName,
                defaultGroupId: groupId || channelEntity.id.toString(),
                defaultChannelUsername: groupUsername || channelEntity.username,
            },
            channels: channels.map(c => ({ id: c.id, title: c.title, username: c.entity.username })),
        });

    } catch (err) {
        console.error('Verify error:', err.message);
        const tempData = tempLogins.get(req.body.phoneNumber);
        if (tempData?.client) {
            try { await tempData.client.disconnect(); } catch (_) {}
            tempLogins.delete(req.body.phoneNumber);
        }
        res.status(500).json({ error: err.message });
    }
});

// ─── Get current user ──────────────────────────────────────────────────────

router.get('/me', authenticate, async (req, res) => {
    try {
        const [channels] = await pool.execute(
            'SELECT channel_id, channel_title, channel_username FROM user_channels WHERE user_id = ?',
            [req.user.id]
        );
        const { id, phone_number, username, first_name, last_name, default_group_id, default_channel_username } = req.user;
        res.json({ user: { id, phone_number, username, first_name, last_name, default_group_id, default_channel_username }, channels });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Complete profile ──────────────────────────────────────────────────────

router.post('/complete-profile', authenticate, async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
        if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

        const password_hash = await bcrypt.hash(password, 10);
        const [result] = await pool.execute(
            'UPDATE users SET email=?, password_hash=?, is_profile_complete=TRUE, updated_at=NOW() WHERE id=?',
            [email, password_hash, req.user.id]
        );

        if (result.affectedRows === 0) return res.status(404).json({ error: 'User not found' });
        res.json({ success: true, message: 'Profile complete. You can now log in with email/password.' });

    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Email already in use' });
        res.status(500).json({ error: err.message });
    }
});

// ─── Email/password login ──────────────────────────────────────────────────

router.post('/login', rateLimit(10, 60 * 1000), async (req, res) => {
    try {
        const { identifier, password } = req.body;
        if (!identifier || !password) return res.status(400).json({ error: 'Email/phone and password required' });

        const [users] = await pool.execute(
            'SELECT * FROM users WHERE (email=? OR phone_number=?) AND is_profile_complete=TRUE',
            [identifier, identifier]
        );

        if (users.length === 0) return res.status(401).json({ error: 'Invalid credentials' });

        const user = users[0];
        if (!user.password_hash) return res.status(401).json({ error: 'Please login via Telegram OTP first' });

        const isValid = await bcrypt.compare(password, user.password_hash);
        if (!isValid) return res.status(401).json({ error: 'Invalid credentials' });

        await pool.execute('UPDATE users SET last_login=NOW() WHERE id=?', [user.id]);

        const token = signToken({ userId: user.id, phoneNumber: user.phone_number, defaultGroupId: user.default_group_id });

        res.json({
            success: true, token,
            user: {
                id: user.id, email: user.email, phoneNumber: user.phone_number,
                username: user.username, firstName: user.first_name, lastName: user.last_name,
                defaultGroupId: user.default_group_id,
                defaultChannelUsername: user.default_channel_username,
            },
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Profile status ────────────────────────────────────────────────────────

router.get('/profile-status', authenticate, (req, res) => {
    const { is_profile_complete, email, first_name } = req.user;
    res.json({ isProfileComplete: is_profile_complete, email, firstName: first_name });
});

// ─── Logout ────────────────────────────────────────────────────────────────

router.post('/logout', (req, res) => {
    res.json({ success: true, message: 'Logged out' });
});

module.exports = router;