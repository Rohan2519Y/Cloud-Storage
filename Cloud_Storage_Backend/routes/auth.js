// routes/auth.js — mtcute version (minimum changes from gramjs)
const express = require('express');
const router = express.Router();
const { TelegramClient } = require('@mtcute/node');
const { MemoryStorage } = require('@mtcute/core');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const pool = require('../utils/database');
const { sendMail, generateResetToken, verifyResetToken } = require('../utils/mailer');
const { encrypt, decrypt, encryptSession } = require('../utils/crypto');
const tgManager = require('../utils/telegramClientManager');
const { rateLimit } = require('../utils/rateLimit');
const { authenticate, signSessionToken } = require('../utils/authMiddleware');
const { sendError } = require('../utils/httpErrors');

const signToken = signSessionToken;

// ─── Input validation ───────────────────────────────────────────────────────

const BCRYPT_COST = 12;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_BYTES = 72; // bcrypt silently ignores everything past 72 bytes
const COMMON_PASSWORDS = new Set([
    'password', 'password1', 'password123', '12345678', '123456789', '1234567890',
    'qwertyui', 'qwerty123', 'iloveyou', 'admin123', 'welcome1', 'letmein123',
]);

// Returns an error message, or null when the password is acceptable.
function validatePassword(password) {
    if (typeof password !== 'string') return 'Password required';
    if (password.length < PASSWORD_MIN_LENGTH) return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
    if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) return `Password must be at most ${PASSWORD_MAX_BYTES} bytes`;
    if (COMMON_PASSWORDS.has(password.toLowerCase()) || /^(.)\1+$/.test(password)) return 'That password is too easy to guess';
    return null;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Returns the normalized (trimmed, lower-cased) email, or null when it isn't valid.
function normalizeEmail(email) {
    if (typeof email !== 'string') return null;
    const e = email.trim().toLowerCase();
    return e.length <= 254 && EMAIL_PATTERN.test(e) ? e : null;
}

// Reset links go to the first configured frontend origin (ALLOWED_ORIGINS is a list).
function frontendOrigin() {
    const first = (process.env.ALLOWED_ORIGINS || '').split(',')[0].trim().replace(/\/+$/, '');
    return first || 'http://localhost:4000';
}

// ─── Temp OTP store with auto cleanup ───────────────────────────────────────
// Same structure as before — stores mtcute client instead of gramjs client

const tempLogins = new Map();

// The ONLY way a temp login should ever be torn down. Each entry owns a 20s keepalive
// interval, and deleting the map entry does not stop it — a missed clearInterval leaves
// that loop pinging Telegram every 20 seconds, forever, on an already-disconnected
// client, with one more leaked loop per OTP request. Enough of those from a single IP
// on dead auth keys reads as abuse and gets the account's sessions terminated.
async function destroyTempLogin(phoneNumber) {
    const data = tempLogins.get(phoneNumber);
    if (!data) return;
    tempLogins.delete(phoneNumber);
    clearInterval(data.keepalive);
    try { await data.client.disconnect(); } catch (_) { }
}

setInterval(async () => {
    const now = Date.now();
    for (const [phone, data] of tempLogins) {
        if (now > data.expiresAt) {
            await destroyTempLogin(phone);
            console.log(`🧹 Cleaned up expired OTP session for ${phone}`);
        }
    }
}, 60 * 1000);

// ─── STEP 1: Send OTP ────────────────────────────────────────────────────────

const isValidPhone = (p) => typeof p === 'string' && /^\+?[0-9 ()-]{6,25}$/.test(p);

router.post('/send-code', rateLimit(5, 60 * 1000), async (req, res) => {
    let pendingClient = null;
    try {
        const { phoneNumber, apiId, apiHash } = req.body;
        if (!phoneNumber) return res.status(400).json({ error: 'Phone number required' });
        if (!isValidPhone(phoneNumber)) return res.status(400).json({ error: 'Invalid phone number' });
        if (!apiId || !apiHash) return res.status(400).json({ error: 'API ID and API Hash required' });
        if (!/^\d{1,12}$/.test(String(apiId)) || typeof apiHash !== 'string' || !/^[0-9a-zA-Z]{8,64}$/.test(apiHash)) {
            return res.status(400).json({ error: 'Invalid API ID or API Hash' });
        }

        // Tear down any existing session for this phone (keepalive included)
        await destroyTempLogin(phoneNumber);

        console.log(`📱 Sending OTP to ${phoneNumber}`);

        // mtcute client — storage: 'mem' = in-memory, no file
        const client = new TelegramClient({
            apiId: Number(apiId),
            apiHash: apiHash,
            storage: new MemoryStorage(),
        });

        pendingClient = client;
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
        // A client that connected but never made it into tempLogins would otherwise leak.
        if (pendingClient && !tempLogins.get(req.body?.phoneNumber)?.client) {
            try { await pendingClient.disconnect(); } catch (_) { }
        }
        sendError(res, err, 'Send code error');
    }
});

router.post('/verify', rateLimit(10, 60 * 1000), async (req, res) => {
    try {
        const { phoneNumber, code, groupUsername, groupId } = req.body;

        const tempData = tempLogins.get(phoneNumber);
        if (!tempData) return res.status(400).json({ error: 'Session expired. Request a new code.' });
        if (Date.now() > tempData.expiresAt) {
            await destroyTempLogin(phoneNumber);
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
                // The Telegram authorization itself succeeded — only the channel the
                // user picked is unusable. Report that, but note the session created
                // here is deliberately abandoned; see the persistence note below.
                console.error('Channel verification error:', err.message);
                await destroyTempLogin(phoneNumber);
                return res.status(400).json({ error: 'Cannot access that channel. Check the username/ID and that your account is a member.' });
            }
        }

        // Never let cleanup failure cost us the session we just authorized — a throw
        // here would skip the DB save below and orphan it on Telegram's side.
        await destroyTempLogin(phoneNumber);

        // ── Step 3: Save to DB ────────────────────────────────────────────
        const telegramId = me.id.toString();
        const resolvedGroupId = groupId || channelEntity?.id?.toString() || null;
        const resolvedChannelUsername = groupUsername || channelEntity?.username || null;
        // NULL when this account has no 2FA — also clears a previously stored password
        // if the user has since disabled 2FA on Telegram's side.
        const encrypted2FAPassword = tempData.verified2FAPassword ? encrypt(tempData.verified2FAPassword) : null;

        // The session string is full access to the user's Telegram account — it is only
        // ever stored encrypted (see utils/crypto.js).
        const storedSession = encryptSession(sessionString);

        const [existingUsers] = await pool.execute(
            'SELECT id FROM users WHERE phone_number = ?', [phoneNumber]
        );

        let userId;
        if (existingUsers.length > 0) {
            userId = existingUsers[0].id;
            await pool.execute(
                `UPDATE users SET telegram_session=?, telegram_id=?, username=?, first_name=?,
                 last_name=?, telegram_api_id=?, telegram_api_hash=?, default_group_id=?,
                 default_channel_username=?, telegram_2fa_password_enc=?, last_login=NOW() WHERE phone_number=?`,
                [storedSession, telegramId, me.username, me.firstName, me.lastName,
                    tempData.apiId, tempData.apiHash, resolvedGroupId, resolvedChannelUsername, encrypted2FAPassword, phoneNumber]
            );
        } else {
            userId = uuidv4();
            await pool.execute(
                `INSERT INTO users (id, phone_number, telegram_session, telegram_id, username,
                 first_name, last_name, telegram_api_id, telegram_api_hash,
                 default_group_id, default_channel_username, telegram_2fa_password_enc)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [userId, phoneNumber, storedSession, telegramId, me.username,
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
        }

        // One batched insert instead of a SELECT + INSERT per dialog — the unique
        // (user_id, channel_id) index makes IGNORE the existence check for us.
        if (channels.length > 0) {
            const rows = channels.map((c) => [uuidv4(), userId, c.id.toString(), c.username, c.title]);
            await pool.query(
                `INSERT IGNORE INTO user_channels (id, user_id, channel_id, channel_username, channel_title) VALUES ?`,
                [rows]
            );
        }

        await userClient.disconnect();

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
        await destroyTempLogin(req.body?.phoneNumber);
        sendError(res, err, 'Verify error');
    }
});

// ─── Get current user ────────────────────────────────────────────────────────

router.get('/me', authenticate(), async (req, res) => {
    try {
        const [channels] = await pool.execute(
            'SELECT channel_id, channel_title, channel_username FROM user_channels WHERE user_id = ?',
            [req.user.id]
        );
        const { id, phone_number, username, first_name, last_name, default_group_id, default_channel_username } = req.user;
        res.json({ user: { id, phone_number, username, first_name, last_name, default_group_id, default_channel_username }, channels });
    } catch (err) {
        sendError(res, err, 'Get current user error');
    }
});

// ─── Complete profile ────────────────────────────────────────────────────────

router.post('/complete-profile', authenticate(), async (req, res) => {
    try {
        const { password } = req.body;
        if (!req.body.email || !password) return res.status(400).json({ error: 'Email and password required' });

        const email = normalizeEmail(req.body.email);
        if (!email) return res.status(400).json({ error: 'Please enter a valid email address' });
        const passwordError = validatePassword(password);
        if (passwordError) return res.status(400).json({ error: passwordError });

        const password_hash = await bcrypt.hash(password, BCRYPT_COST);
        const [result] = await pool.execute(
            'UPDATE users SET email=?, password_hash=?, is_profile_complete=TRUE, updated_at=NOW() WHERE id=?',
            [email, password_hash, req.user.id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: 'User not found' });
        res.json({ success: true, message: 'Profile complete. You can now log in with email/password.' });

    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Email already in use' });
        sendError(res, err, 'Complete profile error');
    }
});

// ─── Email/password login ────────────────────────────────────────────────────

router.post('/login', rateLimit(10, 60 * 1000), async (req, res) => {
    try {
        const { identifier, password } = req.body;
        if (!identifier || !password) return res.status(400).json({ error: 'Email/phone and password required' });
        if (typeof identifier !== 'string' || typeof password !== 'string' || identifier.length > 254 || password.length > 1024) {
            return res.status(400).json({ error: 'Invalid credentials' });
        }
        const loginId = identifier.trim();

        const [users] = await pool.execute(
            `SELECT id, email, phone_number, username, first_name, last_name, default_group_id,
                    default_channel_username, password_hash
             FROM users WHERE (email=? OR phone_number=?) AND is_profile_complete=TRUE`,
            [loginId, loginId]
        );
        if (users.length === 0) return res.status(401).json({ error: 'Invalid credentials' });

        const user = users[0];
        if (!user.password_hash) return res.status(401).json({ error: 'Please login via Telegram OTP first' });

        const isValid = await bcrypt.compare(password, user.password_hash);
        if (!isValid) return res.status(401).json({ error: 'Invalid credentials' });

        // Hashes created before the cost bump are upgraded transparently on login.
        if (bcrypt.getRounds(user.password_hash) < BCRYPT_COST) {
            try {
                await pool.execute('UPDATE users SET password_hash=? WHERE id=?', [await bcrypt.hash(password, BCRYPT_COST), user.id]);
            } catch (err) {
                console.warn('Password rehash failed (login continues):', err.message);
            }
        }

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
        sendError(res, err, 'Login error');
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

router.post('/reconnect-send-code', authenticate({ telegram: true }), rateLimit(5, 60 * 1000), async (req, res) => {
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
        sendError(res, err, 'Reconnect send-code error');
    }
});

router.post('/reconnect-verify', authenticate({ telegram: true }), rateLimit(10, 60 * 1000), async (req, res) => {
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
                try {
                    passwordToTry = decrypt(user.telegram_2fa_password_enc);
                    isStoredAttempt = true;
                } catch (decryptErr) {
                    // Unreadable (key changed) — fall through and ask the user instead.
                    console.error(`Could not decrypt stored 2FA password for user ${user.id}: ${decryptErr.message}`);
                    session.triedStoredPassword = true;
                }
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

        // Persist BEFORE anything else that can fail. An authorization that succeeded
        // but never got saved is orphaned: it stays alive on Telegram (visible in
        // Settings > Devices, consuming a session slot) while the DB keeps serving the
        // old dead one — which looks exactly like "Telegram says active, app says
        // revoked". Disconnecting is cleanup and must never cost us the new session.
        await pool.execute('UPDATE users SET telegram_session = ?, last_login = NOW() WHERE id = ?', [encryptSession(sessionString), user.id]);

        try { await session.client.disconnect(); } catch (_) { }
        reconnectSessions.delete(user.id);
        // The cached client (if any) still holds the dead session — drop it so the
        // next Telegram operation picks up the freshly reconnected one.
        await tgManager.forceReconnect(user.id);

        res.json({ success: true, message: 'Telegram reconnected' });
    } catch (err) {
        if (session?.client) {
            try { await session.client.disconnect(); } catch (_) { }
            reconnectSessions.delete(user.id);
        }
        sendError(res, err, 'Reconnect verify error');
    }
});

// ─── FORGOT PASSWORD — send reset email ─────────────────────────────────
router.post('/forgot-password', rateLimit(10, 60 * 1000), async (req, res) => {
    try {
        if (!req.body.email) return res.status(400).json({ error: 'Email required' });
        const GENERIC = { success: true, message: 'If the email exists, a reset link has been sent.' };
        const email = normalizeEmail(req.body.email);
        if (!email) return res.json(GENERIC); // same answer as "unknown email"

        const [users] = await pool.execute(
            'SELECT id, email FROM users WHERE email = ? AND is_profile_complete = TRUE',
            [email]
        );

        // Always return the same response to prevent email enumeration.
        if (users.length === 0) return res.json(GENERIC);

        const user = users[0];
        const token = generateResetToken(user.id, user.email);
        const resetUrl = `${frontendOrigin()}/password?token=${encodeURIComponent(token)}`;

        // Not awaited: waiting on the mail provider would make "account exists"
        // measurably slower than "no such account", re-opening the enumeration hole.
        sendMail({
            to: user.email,
            subject: 'Reset Your Password - CloudStorage',
            html: `
                <h2>Reset Your Password</h2>
                <p>Click the link below to reset your password. This link expires in 30 minutes.</p>
                <a href="${resetUrl}" style="display:inline-block;padding:12px 24px;background:#000;color:#fff;border-radius:8px;text-decoration:none;font-weight:bold;">Reset Password</a>
                <p style="margin-top:16px;color:#666;">If you didn't request this, you can safely ignore this email.</p>
            `
        }).catch((err) => console.error('Reset email failed:', err.message));

        res.json(GENERIC);
    } catch (err) {
        sendError(res, err, 'Forgot password error');
    }
});

// ─── RESET PASSWORD — verify token and update password ──────────────────
router.post('/reset-password', rateLimit(10, 60 * 1000), async (req, res) => {
    try {
        const { token, newPassword } = req.body;
        if (!token || !newPassword) return res.status(400).json({ error: 'Token and new password required' });
        const passwordError = validatePassword(newPassword);
        if (passwordError) return res.status(400).json({ error: passwordError });

        const decoded = typeof token === 'string' ? verifyResetToken(token) : null;
        if (!decoded) return res.status(400).json({ error: 'Invalid or expired token' });

        // A reset link is single-use: once the password has changed since the link was
        // issued, the link is dead (otherwise it stays replayable for its full 30 minutes).
        const [rows] = await pool.execute('SELECT password_changed_at FROM users WHERE id = ?', [decoded.userId]);
        if (rows.length === 0) return res.status(400).json({ error: 'Invalid or expired token' });
        if (rows[0].password_changed_at && decoded.iat * 1000 < new Date(rows[0].password_changed_at).getTime()) {
            return res.status(400).json({ error: 'Invalid or expired token' });
        }

        const password_hash = await bcrypt.hash(newPassword, BCRYPT_COST);
        // password_changed_at invalidates any JWT issued before this moment (see
        // `authenticate`) — otherwise sessions started under the old password would
        // stay valid for up to 7 more days after a reset.
        await pool.execute(
            'UPDATE users SET password_hash = ?, password_changed_at = NOW() WHERE id = ?',
            [password_hash, decoded.userId]
        );

        res.json({ success: true, message: 'Password reset successfully' });
    } catch (err) {
        sendError(res, err, 'Reset password error');
    }
});

// ─── Profile status ──────────────────────────────────────────────────────────

router.get('/profile-status', authenticate(), (req, res) => {
    const { is_profile_complete, email, first_name } = req.user;
    res.json({ isProfileComplete: is_profile_complete, email, firstName: first_name });
});

// ─── Logout ──────────────────────────────────────────────────────────────────

router.post('/logout', (req, res) => {
    res.json({ success: true, message: 'Logged out' });
});

module.exports = router;