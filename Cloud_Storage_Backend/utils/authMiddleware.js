// The one place JWTs are verified and users are loaded. (Previously auth.js and
// upload.js each had their own copy, and they had already drifted apart.)
const jwt = require('jsonwebtoken');
const pool = require('./database');
const { decryptSession } = require('./crypto');

function getJwtSecret() {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET environment variable is not set');
    return secret;
}

function signSessionToken(payload) {
    return jwt.sign(payload, getJwtSecret(), { expiresIn: '7d', algorithm: 'HS256' });
}

// Every token this app signs shares JWT_SECRET: login sessions, password-reset links
// (`type`) and download tickets (`purpose`). Only a plain session token may authenticate
// an API call — otherwise the reset link in an email, or a 2-minute download ticket,
// would also work as a login. (Session tokens carry neither claim.)
function verifySessionToken(token) {
    const decoded = jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] });
    if (decoded.type || decoded.purpose) throw new Error('Not a session token');
    if (!decoded.userId) throw new Error('Malformed token');
    return decoded;
}

function bearerToken(req) {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
    return header.slice(7).trim() || null;
}

// Only the columns routes actually use. Secrets (Telegram session, API hash, stored 2FA
// password) are loaded — and the session decrypted — only for routes that talk to Telegram.
const BASE_COLUMNS = [
    'id', 'phone_number', 'email', 'username', 'first_name', 'last_name',
    'default_group_id', 'default_channel_username', 'is_profile_complete', 'password_changed_at',
];
const TELEGRAM_COLUMNS = [
    'telegram_session', 'telegram_api_id', 'telegram_api_hash', 'telegram_2fa_password_enc',
];
const SQL_BASE = `SELECT ${BASE_COLUMNS.join(', ')} FROM users WHERE id = ?`;
const SQL_TELEGRAM = `SELECT ${[...BASE_COLUMNS, ...TELEGRAM_COLUMNS].join(', ')} FROM users WHERE id = ?`;

// Tokens issued before the password was last reset are rejected, so a password change
// actually forces a fresh login instead of leaving old sessions valid.
function issuedBeforePasswordChange(user, iatSeconds) {
    return Boolean(user.password_changed_at) && iatSeconds * 1000 < new Date(user.password_changed_at).getTime();
}

async function loadUser(userId, { telegram }) {
    const [rows] = await pool.execute(telegram ? SQL_TELEGRAM : SQL_BASE, [userId]);
    const user = rows[0];
    if (user && telegram && user.telegram_session) {
        try {
            user.telegram_session = decryptSession(user.telegram_session);
        } catch (err) {
            // Wrong/rotated key. Treat as "no session" so the UI asks to reconnect rather
            // than crashing every request; reconnecting writes a fresh encrypted session.
            console.error(`Could not decrypt Telegram session for user ${userId}: ${err.message}`);
            user.telegram_session = null;
        }
    }
    return user;
}

// authenticate()                    → basic user columns
// authenticate({ telegram: true })  → plus decrypted Telegram session + API credentials
function authenticate({ telegram = false } = {}) {
    return async (req, res, next) => {
        try {
            const token = bearerToken(req);
            if (!token) return res.status(401).json({ error: 'Authentication required' });

            const decoded = verifySessionToken(token);
            const user = await loadUser(decoded.userId, { telegram });
            if (!user) return res.status(401).json({ error: 'User not found' });
            if (issuedBeforePasswordChange(user, decoded.iat)) {
                return res.status(401).json({ error: 'Password was changed. Please log in again.' });
            }
            req.user = user;
            next();
        } catch (err) {
            // Token problems (expired, bad signature, wrong type) are 401. A DB failure
            // would also land here — don't report that as the client's fault.
            if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError' || err.name === 'NotBeforeError' ||
                err.message === 'Not a session token' || err.message === 'Malformed token') {
                return res.status(401).json({ error: 'Invalid or expired token' });
            }
            console.error('Auth middleware error:', err.message);
            res.status(500).json({ error: 'Internal server error' });
        }
    };
}

// Native <a href> downloads can't send an Authorization header, so a short-lived
// single-file ticket (?dt=) is accepted as an alternate credential on download routes.
// Bound to one user + one message, 2 minutes, and not usable anywhere else.
function authenticateDownload() {
    const normal = authenticate({ telegram: true });
    return async (req, res, next) => {
        const ticket = req.query.dt;
        if (!ticket) return normal(req, res, next);

        try {
            const decoded = jwt.verify(ticket, getJwtSecret(), { algorithms: ['HS256'] });
            if (decoded.purpose !== 'download' || String(decoded.messageId) !== String(req.params.messageId)) {
                return res.status(401).json({ error: 'Invalid or expired download link' });
            }
            const user = await loadUser(decoded.userId, { telegram: true });
            if (!user) return res.status(401).json({ error: 'User not found' });
            if (issuedBeforePasswordChange(user, decoded.iat)) {
                return res.status(401).json({ error: 'Invalid or expired download link' });
            }
            req.user = user;
            next();
        } catch (err) {
            if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError' || err.name === 'NotBeforeError') {
                return res.status(401).json({ error: 'Invalid or expired download link' });
            }
            console.error('Download auth error:', err.message);
            res.status(500).json({ error: 'Internal server error' });
        }
    };
}

function signDownloadTicket(userId, messageId) {
    return jwt.sign(
        { userId, messageId: String(messageId), purpose: 'download' },
        getJwtSecret(),
        { expiresIn: '2m', algorithm: 'HS256' }
    );
}

module.exports = {
    authenticate,
    authenticateDownload,
    signSessionToken,
    signDownloadTicket,
    // Ready-made instances, so route files don't each rebuild them:
    //   requireUser           → basic user columns (no Telegram secrets loaded)
    //   requireTelegram       → plus the decrypted Telegram session + API credentials
    //   requireDownloadTicket → Authorization header OR a short-lived ?dt= download ticket
    requireUser: authenticate(),
    requireTelegram: authenticate({ telegram: true }),
    requireDownloadTicket: authenticateDownload(),
};
