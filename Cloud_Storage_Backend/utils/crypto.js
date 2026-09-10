// Symmetric encryption for secrets we must be able to read back (unlike passwords,
// which are one-way hashed) — currently just the user's Telegram 2FA password, so a
// broken/revoked Telegram session can be silently re-authorized without re-prompting.
const crypto = require('crypto');

const ALGO = 'aes-256-gcm';

function getKey() {
    const secret = process.env.TELEGRAM_2FA_ENC_KEY || process.env.JWT_SECRET;
    if (!secret) throw new Error('TELEGRAM_2FA_ENC_KEY (or JWT_SECRET) environment variable is not set');
    return crypto.createHash('sha256').update(secret).digest();
}

function encrypt(plaintext) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

function decrypt(payload) {
    const buf = Buffer.from(payload, 'base64');
    const iv = buf.subarray(0, 12);
    const authTag = buf.subarray(12, 28);
    const encrypted = buf.subarray(28);
    const decipher = crypto.createDecipheriv(ALGO, getKey(), iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
