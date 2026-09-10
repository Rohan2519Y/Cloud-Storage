// routes/auth.js — mtcute version (minimum changes from gramjs)
const express = require('express');
const router = express.Router();
const { TelegramClient } = require('@mtcute/node');
const { MemoryStorage } = require('@mtcute/core');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const pool = require('../utils/database');
const { sendMail, generateResetToken, verifyResetToken } = require('../utils/mailer');
const { encrypt, decrypt } = require('../utils/crypto');
const tgManager = require('../utils/telegramClientManager');

// A wedged MTProto connection can leave a call pending forever with no error — timing
// it out turns that into a normal failure instead of hanging the request.
function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

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
        // Reject tokens issued before the password was last reset, so a password
        // change actually forces a fresh login instead of leaving old sessions valid.
        const passwordChangedAt = users[0].password_changed_at;
        if (passwordChangedAt && decoded.iat * 1000 < new Date(passwordChangedAt).getTime()) {
            return res.status(401).json({ error: 'Password was changed. Please log in again.' });
        }
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
        // Only attempted once per session — once Telegram tells us 2FA is needed,
        // the phone+code step has already succeeded, so a retry (e.g. after a wrong
        // 2FA password) must go straight to checkPassword rather than redoing signIn,
        // which would just throw SESSION_PASSWORD_NEEDED again.
        if (!tempData.awaiting2FA) {
            try {
                await tempData.client.signIn({
                    phone: phoneNumber,
                    phoneCodeHash: tempData.phoneCodeHash,
                    phoneCode: String(code),
                });
            } catch (signInError) {
                if (String(signInError.message).includes('SESSION_PASSWORD_NEEDED')) {
                    tempData.awaiting2FA = true;
                } else {
                    throw signInError;
                }
            }
        }

        if (tempData.awaiting2FA) {
            const twoFAPassword = req.body.password;
            if (!twoFAPassword) {
                // Don't tear down the session — the phone+code step already succeeded.
                // Let the client re-prompt for the (possibly changed) password and
                // resubmit against this same still-connected session.
                return res.status(401).json({ error: '2FA password required', requirePassword: true });
            }
            try {
                await tempData.client.checkPassword(twoFAPassword);
            } catch (pwdErr) {
                console.error('2FA error:', pwdErr.message);
                // Wrong/stale password (e.g. it was changed on Telegram's side) — ask
                // again instead of forcing the user all the way back to a new OTP.
                return res.status(401).json({ error: 'Invalid 2FA password. Please try again.', invalidPassword: true });
            }
            // Remembered (encrypted) so a later broken/revoked session can be silently
            // re-checked against it — see /reconnect-verify.
            tempData.verified2FAPassword = twoFAPassword;
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
        // NULL when this account has no 2FA — also clears a previously stored password
        // if the user has since disabled 2FA on Telegram's side.
        const encrypted2FAPassword = tempData.verified2FAPassword ? encrypt(tempData.verified2FAPassword) : null;

        const [existingUsers] = await pool.execute(
            'SELECT * FROM users WHERE phone_number = ?', [phoneNumber]
        );

        let userId;
        if (existingUsers.length > 0) {
            userId = existingUsers[0].id;
            await pool.execute(
                `UPDATE users SET telegram_session=?, telegram_id=?, username=?, first_name=?,
                 last_name=?, telegram_api_id=?, telegram_api_hash=?, default_group_id=?,
                 default_channel_username=?, telegram_2fa_password_enc=?, last_login=NOW() WHERE phone_number=?`,
                [sessionString, telegramId, me.username, me.firstName, me.lastName,
                    tempData.apiId, tempData.apiHash, resolvedGroupId, resolvedChannelUsername, encrypted2FAPassword, phoneNumber]
            );
        } else {
            userId = uuidv4();
            await pool.execute(
                `INSERT INTO users (id, phone_number, telegram_session, telegram_id, username,
                 first_name, last_name, telegram_api_id, telegram_api_hash,
                 default_group_id, default_channel_username, telegram_2fa_password_enc)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [userId, phoneNumber, sessionString, telegramId, me.username,
                    me.firstName, me.lastName, tempData.apiId, tempData.apiHash,
                    resolvedGroupId, resolvedChannelUsername, encrypted2FAPassword]
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

        // Every login double-checks the stored Telegram session still works. Telegram
        // doesn't invalidate it just because the 2FA password changed — but it does if
        // the user revoked/terminated it on Telegram's side, which commonly happens
        // right around a password change. A dead session would otherwise fail silently
        // on the next upload/download; catching it here sends the user to reconnect
        // immediately instead. Only a definitive "this session is dead" error counts —
        // a transient timeout on a flaky connection must not force a needless reconnect.
        // Deliberately not routed through acquireDownloadSlot: that queue exists to
        // stop raw file-part requests from interleaving on one connection, which a
        // plain getMe() call never touches — and login must never be able to hang
        // waiting on a queue slot the way a wedged download/view already could before
        // that was fixed elsewhere.
        let telegramReconnectRequired = false;
        try {
            const client = await withTimeout(tgManager.getClient(user), 15000, 'telegram health check connect');
            await withTimeout(client.getMe(), 10000, 'telegram health check getMe');
        } catch (healthErr) {
            if (/AUTH_KEY_UNREGISTERED|AUTH_KEY_INVALID|SESSION_REVOKED|USER_DEACTIVATED/.test(healthErr.message)) {
                console.warn(`⚠️ Telegram session dead for user ${user.id}: ${healthErr.message}`);
                telegramReconnectRequired = true;
            } else {
                console.warn(`Telegram health check inconclusive for user ${user.id} (treating as OK): ${healthErr.message}`);
            }
        }

        res.json({
            success: true, token,
            telegramReconnectRequired,
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

// ─── TELEGRAM RECONNECT — used when /login reports telegramReconnectRequired ──
// Same OTP + 2FA dance as signup, but scoped to the already-authenticated user
// instead of a phone-number-keyed public session, and it overwrites telegram_session
// (and the stored 2FA password, if a new one was needed) on this same user row.

const reconnectSessions = new Map(); // userId -> { client, phoneCodeHash, expiresAt, awaiting2FA, triedStoredPassword }

setInterval(async () => {
    const now = Date.now();
    for (const [userId, data] of reconnectSessions) {
        if (now > data.expiresAt) {
            try { await data.client.disconnect(); } catch (_) { }
            reconnectSessions.delete(userId);
        }
    }
}, 60 * 1000);

router.post('/reconnect-send-code', authenticate, rateLimit(5, 60 * 1000), async (req, res) => {
    try {
        const user = req.user;
        if (!user.telegram_api_id || !user.telegram_api_hash) {
            return res.status(400).json({ error: 'No Telegram API credentials on file — link Telegram again from Sign Up.' });
        }

        const existing = reconnectSessions.get(user.id);
        if (existing) {
            try { await existing.client.disconnect(); } catch (_) { }
            reconnectSessions.delete(user.id);
        }

        const client = new TelegramClient({
            apiId: Number(user.telegram_api_id),
            apiHash: user.telegram_api_hash,
            storage: new MemoryStorage(),
        });
        await client.connect();
        const sentCode = await client.sendCode({ phone: user.phone_number });

        reconnectSessions.set(user.id, {
            client,
            phoneCodeHash: sentCode.phoneCodeHash,
            expiresAt: Date.now() + 5 * 60 * 1000,
            awaiting2FA: false,
            triedStoredPassword: false,
        });

        res.json({ success: true, message: 'Code sent to Telegram' });
    } catch (err) {
        console.error('Reconnect send-code error:', err.message);
        if (err.message.includes('FLOOD_WAIT')) {
            const waitSeconds = err.message.match(/FLOOD_WAIT_(\d+)/)?.[1];
            return res.status(429).json({
                error: `Too many attempts. Please wait ${Math.ceil(waitSeconds / 60)} minutes and try again.`,
                retryAfter: parseInt(waitSeconds),
            });
        }
        res.status(500).json({ error: err.message });
    }
});

router.post('/reconnect-verify', authenticate, rateLimit(10, 60 * 1000), async (req, res) => {
    const user = req.user;
    const session = reconnectSessions.get(user.id);
    try {
        if (!session) return res.status(400).json({ error: 'Reconnect session expired. Request a new code.' });
        if (Date.now() > session.expiresAt) {
            try { await session.client.disconnect(); } catch (_) { }
            reconnectSessions.delete(user.id);
            return res.status(400).json({ error: 'Code expired. Request a new one.' });
        }

        const { code } = req.body;

        if (!session.awaiting2FA) {
            if (!code) return res.status(400).json({ error: 'Verification code required' });
            try {
                await session.client.signIn({
                    phone: user.phone_number,
                    phoneCodeHash: session.phoneCodeHash,
                    phoneCode: String(code),
                });
            } catch (signInError) {
                if (String(signInError.message).includes('SESSION_PASSWORD_NEEDED')) {
                    session.awaiting2FA = true;
                } else {
                    throw signInError;
                }
            }
        }

        if (session.awaiting2FA) {
            let passwordToTry = req.body.password;
            let isStoredAttempt = false;

            // First attempt: silently try the password we already have on file,
            // before ever bothering the user — this is the "check the saved 2FA
            // password" step.
            if (!passwordToTry && !session.triedStoredPassword && user.telegram_2fa_password_enc) {
                passwordToTry = decrypt(user.telegram_2fa_password_enc);
                isStoredAttempt = true;
            }

            // 400, not 401: the user's JWT is perfectly valid here, this just means
            // "send more info" — a 401 would trip the frontend's global interceptor,
            // which clears the token and hard-redirects to /login on any 401, wiping
            // the very session this flow is trying to fix.
            if (!passwordToTry) {
                return res.status(400).json({ error: '2FA password required', requirePassword: true });
            }

            try {
                await session.client.checkPassword(passwordToTry);
            } catch (pwdErr) {
                if (isStoredAttempt) {
                    session.triedStoredPassword = true;
                    console.warn(`Stored 2FA password no longer works for user ${user.id} — asking for the new one.`);
                    return res.status(400).json({ error: 'Your saved 2FA password no longer works. Please enter the current one.', requirePassword: true });
                }
                console.error('Reconnect 2FA error:', pwdErr.message);
                return res.status(400).json({ error: 'Invalid 2FA password. Please try again.', invalidPassword: true });
            }

            // A password the user had to type by hand (not the auto-tried stored one)
            // just proved correct — refresh the stored copy so future reconnects work
            // silently again.
            if (!isStoredAttempt) {
                await pool.execute('UPDATE users SET telegram_2fa_password_enc = ? WHERE id = ?', [encrypt(passwordToTry), user.id]);
            }
        }

        const sessionString = await session.client.exportSession();
        await session.client.disconnect();
        reconnectSessions.delete(user.id);

        await pool.execute('UPDATE users SET telegram_session = ?, last_login = NOW() WHERE id = ?', [sessionString, user.id]);
        // The cached client (if any) still holds the dead session — drop it so the
        // next Telegram operation picks up the freshly reconnected one.
        await tgManager.forceReconnect(user.id);

        res.json({ success: true, message: 'Telegram reconnected' });
    } catch (err) {
        console.error('Reconnect verify error:', err.message);
        if (session?.client) {
            try { await session.client.disconnect(); } catch (_) { }
            reconnectSessions.delete(user.id);
        }
        res.status(500).json({ error: err.message });
    }
});

// ─── FORGOT PASSWORD — send reset email ─────────────────────────────────
router.post('/forgot-password', rateLimit(10, 60 * 1000), async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: 'Email required' });

        const [users] = await pool.execute(
            'SELECT id, email FROM users WHERE email = ? AND is_profile_complete = TRUE',
            [email]
        );

        // Always return success to prevent email enumeration
        if (users.length === 0) {
            return res.json({ success: true, message: 'If the email exists, a reset link has been sent.' });
        }

        const user = users[0];
        const token = generateResetToken(user.id, user.email);
        const resetUrl = `${process.env.ALLOWED_ORIGINS || 'http://localhost:4000'}/password?token=${token}`;

        await sendMail({
            to: user.email,
            subject: 'Reset Your Password - CloudStorage',
            html: `
                <h2>Reset Your Password</h2>
                <p>Click the link below to reset your password. This link expires in 30 minutes.</p>
                <a href="${resetUrl}" style="display:inline-block;padding:12px 24px;background:#000;color:#fff;border-radius:8px;text-decoration:none;font-weight:bold;">Reset Password</a>
                <p style="margin-top:16px;color:#666;">If you didn't request this, you can safely ignore this email.</p>
            `
        });

        res.json({ success: true, message: 'If the email exists, a reset link has been sent.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── RESET PASSWORD — verify token and update password ──────────────────
router.post('/reset-password', rateLimit(10, 60 * 1000), async (req, res) => {
    try {
        const { token, newPassword } = req.body;
        if (!token || !newPassword) return res.status(400).json({ error: 'Token and new password required' });
        if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

        const decoded = verifyResetToken(token);
        if (!decoded) return res.status(400).json({ error: 'Invalid or expired token' });

        const password_hash = await bcrypt.hash(newPassword, 10);
        // password_changed_at invalidates any JWT issued before this moment (see
        // `authenticate`) — otherwise sessions started under the old password would
        // stay valid for up to 7 more days after a reset.
        await pool.execute(
            'UPDATE users SET password_hash = ?, password_changed_at = NOW() WHERE id = ?',
            [password_hash, decoded.userId]
        );

        res.json({ success: true, message: 'Password reset successfully' });
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