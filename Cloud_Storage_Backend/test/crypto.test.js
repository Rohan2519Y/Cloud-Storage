const path = require('path');
const root = require('path').resolve(__dirname, '..');
process.env.JWT_SECRET = 'j'.repeat(40);
process.env.TELEGRAM_2FA_ENC_KEY = 'k'.repeat(48);
const c = require(root + '/utils/crypto.js');
const crypto = require('crypto');
const assert = require('assert');

// v2 round trip + purpose separation
const s = '1AgAOMTQ5LjE1NC4xNjcuNTEBu_-session==';
const enc = c.encryptSession(s);
assert(enc.startsWith('v2.') && !enc.includes(s)); assert.equal(c.decryptSession(enc), s);
assert.notEqual(c.encryptSession(s), enc, 'random IV');
assert.throws(() => c.decrypt(enc), 'session ciphertext must not decrypt as a 2FA value');
const e2 = c.encrypt('hunter2!'); assert.equal(c.decrypt(e2), 'hunter2!');
// tamper
const bad = enc.slice(0, -3) + (enc.endsWith('AAA') ? 'BBB' : 'AAA'); assert.throws(() => c.decryptSession(bad));
// legacy plaintext session passes through
assert.equal(c.decryptSession(s), s);

// legacy v1 2FA value keyed by JWT_SECRET (the old fallback) must still decrypt
function legacyEncrypt(pt, secret) {
  const iv = crypto.randomBytes(12); const k = crypto.createHash('sha256').update(secret).digest();
  const ci = crypto.createCipheriv('aes-256-gcm', k, iv);
  const e = Buffer.concat([ci.update(pt, 'utf8'), ci.final()]);
  return Buffer.concat([iv, ci.getAuthTag(), e]).toString('base64');
}
assert.equal(c.decrypt(legacyEncrypt('oldpass', process.env.JWT_SECRET)), 'oldpass');
assert.equal(c.decrypt(legacyEncrypt('oldpass2', process.env.TELEGRAM_2FA_ENC_KEY)), 'oldpass2');

// missing / short key fails closed
delete process.env.TELEGRAM_2FA_ENC_KEY;
assert.throws(() => c.encryptSession(s), /TELEGRAM_2FA_ENC_KEY/);
process.env.TELEGRAM_2FA_ENC_KEY = 'short';
assert.throws(() => c.assertConfigured());
console.log('crypto: all assertions passed');
