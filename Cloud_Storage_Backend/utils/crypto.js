// Symmetric encryption for secrets we must be able to read back (unlike passwords,
// which are one-way hashed):
//   - the user's Telegram session string (full account access if leaked)
//   - the user's Telegram 2FA password (so a revoked session can be silently re-authorized)
//
// Format v2:  "v2." + base64( iv(12) | authTag(16) | ciphertext )
//   - key = HKDF-SHA256(TELEGRAM_2FA_ENC_KEY, info = purpose), so the session key and the
//     2FA key differ and neither is derived from JWT_SECRET.
//   - "." never appears in base64 or in Telegram session strings, so the prefix can't be
//     confused with legacy data.
//
// Legacy (v1, no prefix): base64(iv | tag | ciphertext) keyed by sha256(secret) where
// secret was TELEGRAM_2FA_ENC_KEY or, if that was unset, JWT_SECRET. Still *readable*
// (so existing rows keep working until migrated) but never written.
const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const V2_PREFIX = 'v2.';
const HKDF_SALT = Buffer.from('cloud-storage/enc/v2');
const MIN_KEY_LENGTH = 32;

const PURPOSE_2FA = 'telegram-2fa-password';
const PURPOSE_SESSION = 'telegram-session';

function getMasterSecret() {
    const secret = process.env.TELEGRAM_2FA_ENC_KEY;
    if (!secret || secret.length < MIN_KEY_LENGTH) {
        throw new Error(
            `TELEGRAM_2FA_ENC_KEY must be set to a random string of at least ${MIN_KEY_LENGTH} characters ` +
            `(generate one with: node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"). ` +
            `It must be different from JWT_SECRET and identical on every environment that shares the database.`
        );
    }
    return secret;
}

// Call at boot so a missing key fails the deploy immediately instead of the first login.
function assertConfigured() {
    getMasterSecret();
}

function deriveKey(purpose) {
    return Buffer.from(crypto.hkdfSync('sha256', getMasterSecret(), HKDF_SALT, purpose, 32));
}

function encryptWith(plaintext, purpose) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGO, deriveKey(purpose), iv);
    const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return V2_PREFIX + Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

function decryptBuffer(buf, key) {
    const iv = buf.subarray(0, 12);
    const authTag = buf.subarray(12, 28);
    const encrypted = buf.subarray(28);
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

function decryptWith(payload, purpose) {
    if (payload.startsWith(V2_PREFIX)) {
        return decryptBuffer(Buffer.from(payload.slice(V2_PREFIX.length), 'base64'), deriveKey(purpose));
    }
    return decryptLegacy(payload);
}

// v1 values were keyed by sha256(TELEGRAM_2FA_ENC_KEY || JWT_SECRET). Try whichever of
// those secrets exist, so rows written before this change still decrypt.
function decryptLegacy(payload) {
    const buf = Buffer.from(payload, 'base64');
    const candidates = [process.env.TELEGRAM_2FA_ENC_KEY, process.env.JWT_SECRET].filter(Boolean);
    let lastErr = new Error('No legacy key available to decrypt value');
    for (const secret of candidates) {
        try {
            return decryptBuffer(buf, crypto.createHash('sha256').update(secret).digest());
        } catch (err) {
            lastErr = err;
        }
    }
    throw lastErr;
}

// ─── 2FA password (existing API, now v2 on write) ───────────────────────────
const encrypt = (plaintext) => encryptWith(plaintext, PURPOSE_2FA);
const decrypt = (payload) => decryptWith(payload, PURPOSE_2FA);

// ─── Telegram session string ────────────────────────────────────────────────
const isEncryptedSession = (stored) => typeof stored === 'string' && stored.startsWith(V2_PREFIX);
const encryptSession = (session) => encryptWith(session, PURPOSE_SESSION);

// Returns the usable session string. A value without the v2 prefix is a legacy
// plaintext session (not yet migrated) and is returned as-is.
function decryptSession(stored) {
    if (!stored) return stored;
    if (!isEncryptedSession(stored)) return stored;
    return decryptWith(stored, PURPOSE_SESSION);
}

module.exports = {
    assertConfigured,
    encrypt,
    decrypt,
    encryptSession,
    decryptSession,
    isEncryptedSession,
    V2_PREFIX,
};
