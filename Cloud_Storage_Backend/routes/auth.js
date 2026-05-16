// routes/auth.js — mtcute version (minimum changes from gramjs)
const express = require('express');
const router = express.Router();
const { TelegramClient } = require('@mtcute/node');
const { MemoryStorage } = require('@mtcute/core');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const pool = require('../utils/database');

// ─── JWT helpers ────────────────────────────────────────────────────────────

function getJwtSecret() {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET environment variable is not set');
    return secret;
}
function signToken(payload) { return jwt.sign(payload, getJwtSecret(), { expiresIn: '7d' }); }
function verifyToken(token) { return jwt.verify(token, getJwtSecret()); }

// ─── Temp OTP store with auto cleanup ───────────────────────────────────────
// Same structure as before — stores mtcute client instead of gramjs client

const tempLogins = new Map();

setInterval(async () => {
    const now = Date.now();
    for (const [phone, data] of tempLogins) {
        if (now > data.expiresAt) {
            try { await data.client.disconnect(); } catch (_) { }
            tempLogins.delete(phone);
            console.log(`🧹 Cleaned up expired OTP session for ${phone}`);
        }
    }
}, 60 * 1000);

// ─── Rate limiter ────────────────────────────────────────────────────────────

const rateLimitStore = new Map();
function rateLimit(maxReq, windowMs) {
    return (req, res, next) => {
        const key = req.ip;
        const now = Date.now();
        const entry = rateLimitStore.get(key) || { count: 0, resetAt: now + windowMs };
        if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + windowMs; }
        entry.count++;
        rateLimitStore.set(key, entry);
        if (entry.count > maxReq) return res.status(429).json({ error: 'Too many requests. Try again later.' });
        next();
    };
}
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of rateLimitStore) if (now > v.resetAt) rateLimitStore.delete(k);
}, 5 * 60 * 1000);

// ─── Auth middleware ─────────────────────────────────────────────────────────

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

// ─── STEP 1: Send OTP ────────────────────────────────────────────────────────

router.post('/send-code', rateLimit(5, 60 * 1000), async (req, res) => {
    try {
        const { phoneNumber, apiId, apiHash } = req.body;
        if (!phoneNumber) return res.status(400).json({ error: 'Phone number required' });
        if (!apiId || !apiHash) return res.status(400).json({ error: 'API ID and API Hash required' });

        // Disconnect any existing session for this phone
        if (tempLogins.has(phoneNumber)) {
            try { await tempLogins.get(phoneNumber).client.disconnect(); } catch (_) { }
            tempLogins.delete(phoneNumber);
        }

        console.log(`📱 Sending OTP to ${phoneNumber}`);

        // mtcute client — storage: 'mem' = in-memory, no file
        const client = new TelegramClient({
            apiId: Number(apiId),
            apiHash: apiHash,
            storage: new MemoryStorage(),
        });

        await client.connect();
        const sentCode = await client.sendCode({ phone: phoneNumber });

        tempLogins.set(phoneNumber, {
            client,
            phoneCodeHash: sentCode.phoneCodeHash,
            apiId,
            apiHash,
            expiresAt: Date.now() + 5 * 60 * 1000,
            keepalive: setInterval(() => {
                client.call({ _: 'ping', pingId: BigInt(Date.now()) }).catch(() => { });
            }, 20 * 1000)
        });

        res.json({ success: true, message: 'Code sent to Telegram', phoneNumber });

    } catch (err) {
        console.error('Send code error:', err.message);

        // Handle FLOOD_WAIT errors
        if (err.message.includes('FLOOD_WAIT')) {
            const waitSeconds = err.message.match(/FLOOD_WAIT_(\d+)/)?.[1];
            const waitMinutes = Math.ceil(waitSeconds / 60);
            return res.status(429).json({
                error: `Too many attempts. Please wait ${waitMinutes} minutes before requesting a new code.`,
                retryAfter: parseInt(waitSeconds)
            });
        }

        res.status(500).json({ error: err.message });
    }
});

router.post('/verify', rateLimit(10, 60 * 1000), async (req, res) => {
    try {
        const { phoneNumber, code, groupUsername, groupId } = req.body;

        const tempData = tempLogins.get(phoneNumber);
        if (!tempData) return res.status(400).json({ error: 'Session expired. Request a new code.' });
        if (Date.now() > tempData.expiresAt) {
            try { await tempData.client.disconnect(); } catch (_) { }
            tempLogins.delete(phoneNumber);
            return res.status(400).json({ error: 'Code expired. Request a new one.' });
        }

        // Reconnect if needed — auth key must stay alive between send-code and verify
        try {
            if (!tempData.client.connected) {
                await tempData.client.connect();
            }
        } catch (_) {
            await tempData.client.connect();
        }

        // ── Step 1: Sign in with OTP ──────────────────────────────────────
        try {
            await tempData.client.signIn({
                phone: phoneNumber,
                phoneCodeHash: tempData.phoneCodeHash,
                phoneCode: String(code),
            });
        } catch (signInError) {
            if (String(signInError.message).includes('SESSION_PASSWORD_NEEDED')) {
                const twoFAPassword = req.body.password;
                if (!twoFAPassword) {
                    await tempData.client.disconnect();
                    tempLogins.delete(phoneNumber);
                    return res.status(401).json({ error: '2FA password required', requirePassword: true });
                }
                try {
                    await tempData.client.checkPassword(twoFAPassword);
                } catch (pwdErr) {
                    console.error('2FA error:', pwdErr.message);
                    await tempData.client.disconnect();
                    tempLogins.delete(phoneNumber);
                    return res.status(401).json({ error: 'Invalid 2FA password.', invalidPassword: true });
                }
            } else {
                throw signInError;
            }
        }

        const me = await tempData.client.getMe();
        const sessionString = await tempData.client.exportSession();

        // ── Step 2: Channel verification (optional) ───────────────────────
        let channelEntity = null;
        if (groupId || groupUsername) {
            try {
                if (groupId) {
                    channelEntity = await tempData.client.getChat(parseInt(groupId));
                } else {
                    const uname = groupUsername.toLowerCase().replace('@', '');
                    try {
                        const peer = await tempData.client.resolveChannel('@' + uname);
                        channelEntity = await tempData.client.getChat(peer);
                    } catch {
                        let found = null;
                        for await (const dialog of tempData.client.iterDialogs({ limit: 200 })) {
                            const chat = dialog.chat;
                            if (!chat) continue;
                            const u = (chat.username || '').toLowerCase();
                            const t = (chat.title || '').toLowerCase();
                            if (u === uname || t === uname) { found = chat; break; }
                        }
                        if (!found) throw new Error('Channel not found in your dialogs');
                        channelEntity = found;
                    }
                }
            } catch (err) {
                await tempData.client.disconnect();
                tempLogins.delete(phoneNumber);
                return res.status(400).json({ error: `Cannot access channel: ${err.message}` });
            }
        }

        await tempData.client.disconnect();
        tempLogins.delete(phoneNumber);

        // ── Step 3: Save to DB ────────────────────────────────────────────
        const telegramId = me.id.toString();
        const resolvedGroupId = groupId || channelEntity?.id?.toString() || null;
        const resolvedChannelUsername = groupUsername || channelEntity?.username || null;

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
                [sessionString, telegramId, me.username, me.firstName, me.lastName,
                    tempData.apiId, tempData.apiHash, resolvedGroupId, resolvedChannelUsername, phoneNumber]
            );
        } else {
            userId = uuidv4();
            await pool.execute(
                `INSERT INTO users (id, phone_number, telegram_session, telegram_id, username,
                 first_name, last_name, telegram_api_id, telegram_api_hash,
                 default_group_id, default_channel_username)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [userId, phoneNumber, sessionString, telegramId, me.username,
                    me.firstName, me.lastName, tempData.apiId, tempData.apiHash,
                    resolvedGroupId, resolvedChannelUsername]
            );
        }

        // ── Step 4: Sync channels ─────────────────────────────────────────
        const userClient = new TelegramClient({
            apiId: Number(tempData.apiId),
            apiHash: tempData.apiHash,
            storage: new MemoryStorage(),
        });
        await userClient.importSession(sessionString);
        await userClient.connect();

        const channels = [];
        for await (const dialog of userClient.iterDialogs({ limit: 500 })) {
            const chat = dialog.chat;
            if (!chat) continue;
            const isChannel = chat.type === 'channel' || chat.type === 'supergroup' || chat.type === 'group';
            if (!isChannel) continue;

            channels.push({ id: chat.id, title: chat.title, username: chat.username });

            const [existing] = await pool.execute(
                'SELECT id FROM user_channels WHERE user_id = ? AND channel_id = ?',
                [userId, chat.id.toString()]
            );
            if (existing.length === 0) {
                await pool.execute(
                    `INSERT INTO user_channels (id, user_id, channel_id, channel_username, channel_title, access_hash)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                    [uuidv4(), userId, chat.id.toString(), chat.username, chat.title, null]
                );
            }
        }

        await userClient.disconnect();

        // Clean up session file after successful auth
        try {
            const fs = require('fs');
            const sessionFile = `./sessions/auth_${phoneNumber.replace(/[^0-9]/g, '')}.json`;
            if (fs.existsSync(sessionFile)) fs.unlinkSync(sessionFile);
        } catch (_) { }

        const token = signToken({ userId, phoneNumber, defaultGroupId: resolvedGroupId });

        res.json({
            success: true,
            token,
            user: {
                id: userId,
                phoneNumber,
                username: me.username,
                firstName: me.firstName,
                lastName: me.lastName,
                defaultGroupId: resolvedGroupId,
                defaultChannelUsername: resolvedChannelUsername,
            },
            channels,
        });

    } catch (err) {
        console.error('Verify error:', err.message);
        const tempData = tempLogins.get(req.body.phoneNumber);
        if (tempData?.client) {
            try { await tempData.client.disconnect(); } catch (_) { }
            tempLogins.delete(req.body.phoneNumber);
        }
        // Clean up session file on error too
        try {
            const fs = require('fs');
            const sessionFile = `./sessions/auth_${(req.body.phoneNumber || '').replace(/[^0-9]/g, '')}.json`;
            if (fs.existsSync(sessionFile)) fs.unlinkSync(sessionFile);
        } catch (_) { }
        res.status(500).json({ error: err.message });
    }
});

// ─── Get current user ────────────────────────────────────────────────────────

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

// ─── Complete profile ────────────────────────────────────────────────────────

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

// ─── Email/password login ────────────────────────────────────────────────────

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

// ─── Profile status ──────────────────────────────────────────────────────────

router.get('/profile-status', authenticate, (req, res) => {
    const { is_profile_complete, email, first_name } = req.user;
    res.json({ isProfileComplete: is_profile_complete, email, firstName: first_name });
});

// ─── Logout ──────────────────────────────────────────────────────────────────

router.post('/logout', (req, res) => {
    res.json({ success: true, message: 'Logged out' });
});

module.exports = router;