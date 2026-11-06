// API integration test: runs the real Express app against an in-memory fake DB.
// No network, no real database, no Telegram. Run with: npm test
const assert = require('assert');
const path = require('path');
const ROOT = require('path').resolve(__dirname, '..');

process.env.NODE_ENV = 'production';
process.env.TRUST_PROXY = '1';
process.env.JWT_SECRET = 'j'.repeat(40);
process.env.TELEGRAM_2FA_ENC_KEY = 'k'.repeat(48);
process.env.ALLOWED_ORIGINS = 'https://example.vercel.app/';
process.env.DB_HOST = 'fake';

const bcrypt = require(ROOT + '/node_modules/bcrypt');
const jwt = require(ROOT + '/node_modules/jsonwebtoken');

// ── fake DB ───────────────────────────────────────────────────────────────────
const calls = [];
const db = {
  users: [],
  failNext: null,
};
const fakePool = {
  async execute(sql, params = []) {
    calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    if (db.failNext) { const e = db.failNext; db.failNext = null; throw e; }
    const s = sql.replace(/\s+/g, ' ').trim();
    if (/^SELECT .* FROM users WHERE id = \?$/.test(s)) {
      const u = db.users.find((x) => x.id === params[0]);
      if (!u) return [[]];
      const cols = s.replace(/^SELECT (.*) FROM users.*$/, '$1').split(',').map((c) => c.trim());
      assert(!cols.includes('*'), 'SELECT * must not be used for auth');
      return [[Object.fromEntries(cols.map((c) => [c, u[c]]))]];
    }
    if (/FROM users WHERE \(email=\? OR phone_number=\?\)/.test(s)) {
      return [db.users.filter((u) => u.is_profile_complete && (u.email === params[0] || u.phone_number === params[1]))];
    }
    if (/^SELECT id, email FROM users WHERE email = \?/.test(s)) return [db.users.filter((u) => u.email === params[0])];
    if (/^SELECT password_changed_at FROM users/.test(s)) return [db.users.filter((u) => u.id === params[0])];
    if (/^UPDATE users SET password_hash=\? WHERE id=\?/.test(s)) { db.users.find((u) => u.id === params[1]).password_hash = params[0]; return [{ affectedRows: 1 }]; }
    if (/^UPDATE users SET last_login/.test(s)) return [{ affectedRows: 1 }];
    if (/^UPDATE users SET password_hash = \?, password_changed_at = NOW\(\)/.test(s)) {
      const u = db.users.find((x) => x.id === params[1]); u.password_hash = params[0]; u.password_changed_at = new Date(); return [{ affectedRows: 1 }];
    }
    if (/^UPDATE users SET email=\?/.test(s)) { const u = db.users.find((x) => x.id === params[2]); u.email = params[0]; u.password_hash = params[1]; return [{ affectedRows: 1 }]; }
    if (/FROM user_channels/.test(s)) return [[]];
    if (/FROM uploaded_files WHERE user_id/.test(s)) return [[]];
    if (/FROM folders WHERE id = \? AND user_id = \?/.test(s)) {
      const f = (db.folders || []).find((x) => x.id === params[0] && x.user_id === params[1]);
      return [f ? [f] : []];
    }
    throw new Error('unexpected SQL in test: ' + s);
  },
  async getConnection() { return { release() {} }; },
  async query() { return [[]]; },
};
const dbPath = require.resolve(ROOT + '/utils/database.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakePool };

// Don't send real mail
const mailerPath = require.resolve(ROOT + '/utils/mailer.js');
const realMailer = require(mailerPath);
const sent = [];
realMailer.sendMail = async (m) => { sent.push(m); return { success: true }; };

const { signSessionToken, signDownloadTicket } = require(ROOT + '/utils/authMiddleware.js');
const crypto = require(ROOT + '/utils/crypto.js');

// make setInterval()s from app.js not keep the process alive
const realSetInterval = global.setInterval;
global.setInterval = (...a) => { const t = realSetInterval(...a); t.unref?.(); return t; };
const app = require(ROOT + '/app.js');

let passed = 0;
const ok = (name) => { passed++; console.log('  ✓', name); };

(async () => {
  const hash10 = await bcrypt.hash('Correct-horse-9', 10);
  db.users = [
    { id: 'u1', phone_number: '+911', email: 'a@x.com', is_profile_complete: 1, password_hash: hash10, password_changed_at: null,
      telegram_session: crypto.encryptSession('PLAINSESSION-1'), telegram_api_id: '1', telegram_api_hash: 'h', first_name: 'A' },
    { id: 'u2', phone_number: '+912', email: 'b@x.com', is_profile_complete: 1, password_hash: hash10, password_changed_at: null,
      telegram_session: 'LEGACY-PLAINTEXT-SESSION', telegram_api_id: '1', telegram_api_hash: 'h', first_name: 'B' },
  ];
  db.folders = [{ id: 'f-u2', user_id: 'u2', name: 'secret-b', parent_id: null }];

  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p, headers = {}) => fetch(base + p, { headers });
  const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const bearer = (t) => ({ Authorization: `Bearer ${t}` });

  console.log('Token handling');
  const t1 = signSessionToken({ userId: 'u1' });
  assert.equal((await get('/api/auth/me', bearer(t1))).status, 200); ok('valid session token accepted');
  assert.equal((await get('/api/auth/me')).status, 401); ok('missing token → 401');
  const resetTok = realMailer.generateResetToken('u1', 'a@x.com');
  assert.equal((await get('/api/auth/me', bearer(resetTok))).status, 401); ok('password-reset token is NOT accepted as a login token');
  const dl = signDownloadTicket('u1', '123');
  assert.equal((await get('/api/auth/me', bearer(dl))).status, 401); ok('download ticket is NOT accepted as a login token');
  assert.equal((await get('/api/files', bearer(dl))).status, 401); ok('download ticket rejected on /api/files too');
  const noneTok = jwt.sign({ userId: 'u1' }, 'wrong-secret-wrong-secret-wrong-secret');
  assert.equal((await get('/api/auth/me', bearer(noneTok))).status, 401); ok('bad signature → 401');
  const oldTok = jwt.sign({ userId: 'u1', iat: Math.floor(Date.now() / 1000) - 3600 }, process.env.JWT_SECRET);
  db.users[0].password_changed_at = new Date();
  assert.equal((await get('/api/auth/me', bearer(oldTok))).status, 401); ok('token issued before password change → 401');
  db.users[0].password_changed_at = null;

  console.log('Least-privilege user loading');
  calls.length = 0;
  await get('/api/files', bearer(t1));
  const authQ = calls.find((c) => /FROM users WHERE id/.test(c.sql));
  assert(authQ && !/telegram_session|telegram_api_hash|telegram_2fa/.test(authQ.sql), authQ?.sql); ok('plain routes never load Telegram secrets');

  console.log('Session encryption at the auth layer');
  const { authenticate } = require(ROOT + '/utils/authMiddleware.js');
  const express = require(ROOT + '/node_modules/express');
  const mini = express();
  mini.get('/tg', authenticate({ telegram: true }), (req, res) => res.json({ s: req.user.telegram_session }));
  const ms = mini.listen(0); const mb = `http://127.0.0.1:${ms.address().port}`;
  let r = await fetch(mb + '/tg', { headers: bearer(t1) }); assert.equal((await r.json()).s, 'PLAINSESSION-1'); ok('encrypted session is decrypted for Telegram routes');
  r = await fetch(mb + '/tg', { headers: bearer(signSessionToken({ userId: 'u2' })) }); assert.equal((await r.json()).s, 'LEGACY-PLAINTEXT-SESSION'); ok('legacy plaintext session still readable (pre-migration)');
  ms.close();

  console.log('Error responses do not leak internals');
  db.failNext = new Error("Table 'cloud_storage.secret' doesn't exist; SELECT * FROM users");
  r = await get('/api/files', bearer(t1)); // auth query itself fails → generic 500
  let body = await r.json();
  assert.equal(r.status, 500); assert.equal(body.error, 'Internal server error'); ok('DB failure in auth → generic 500');
  const origExec = fakePool.execute;
  fakePool.execute = async (sql, p) => { if (/FROM uploaded_files WHERE user_id/.test(sql)) throw new Error('ER_BAD_FIELD_ERROR: Unknown column secret_col'); return origExec(sql, p); };
  r = await get('/api/files', bearer(t1)); body = await r.json();
  assert.equal(r.status, 500); assert(!JSON.stringify(body).includes('secret_col')); ok('route DB error text not returned to client');
  fakePool.execute = origExec;

  console.log('Progress stream & cancel');
  r = await get(`/api/upload-progress/abcdefgh-1234?token=${t1}`);
  assert.equal(r.status, 401); ok('?token= in the URL no longer authenticates');
  const ac = new AbortController();
  r = await fetch(`${base}/api/upload-progress/abcdefgh-1234`, { headers: bearer(t1), signal: ac.signal });
  assert.equal(r.status, 200); assert(/event-stream/.test(r.headers.get('content-type')));
  const reader = r.body.getReader(); const first = new TextDecoder().decode((await reader.read()).value);
  assert(first.startsWith('data: {"progress":0}')); ac.abort(); ok('header-authenticated SSE works');
  r = await post('/api/upload-cancel/abcdefgh-1234', {}); assert.equal(r.status, 401); ok('cancel requires auth header');
  r = await post('/api/upload-cancel/bad id!', {}, bearer(t1)); assert.equal(r.status, 400); ok('malformed upload id rejected');

  console.log('Authorization / IDOR');
  r = await get('/api/folders/path/f-u2', bearer(t1)); body = await r.json();
  assert.deepEqual(body.path, []); ok("user 1 cannot read user 2's folder via /folders/path");
  r = await get('/api/folders/path/f-u2', bearer(signSessionToken({ userId: 'u2' }))); body = await r.json();
  assert.equal(body.path.length, 1); ok('owner can');

  console.log('Passwords & email');
  r = await post('/api/auth/complete-profile', { email: 'new@x.com', password: 'short' }, bearer(t1)); assert.equal(r.status, 400); ok('short password rejected');
  r = await post('/api/auth/complete-profile', { email: 'new@x.com', password: 'password123' }, bearer(t1)); assert.equal(r.status, 400); ok('common password rejected');
  r = await post('/api/auth/complete-profile', { email: 'new@x.com', password: 'x'.repeat(80) + 'Qz9' }, bearer(t1)); assert.equal(r.status, 400); ok('>72 byte password rejected (bcrypt truncation)');
  r = await post('/api/auth/complete-profile', { email: 'not-an-email', password: 'Str0ng-pass-phrase' }, bearer(t1)); assert.equal(r.status, 400); ok('invalid email rejected');
  r = await post('/api/auth/complete-profile', { email: ' New@X.com ', password: 'Str0ng-pass-phrase' }, bearer(t1)); assert.equal(r.status, 200);
  assert.equal(db.users[0].email, 'new@x.com'); assert.equal(bcrypt.getRounds(db.users[0].password_hash), 12); ok('email normalised, bcrypt cost 12');

  console.log('Login');
  r = await post('/api/auth/login', { identifier: 'b@x.com', password: 'Correct-horse-9' }); assert.equal(r.status, 200);
  assert.equal(bcrypt.getRounds(db.users[1].password_hash), 12); ok('old cost-10 hash transparently upgraded to 12 on login');
  r = await post('/api/auth/login', { identifier: 'b@x.com', password: 'nope' }); assert.equal(r.status, 401); ok('wrong password → 401');
  r = await post('/api/auth/login', { identifier: { $ne: 1 }, password: 'x' }); assert.equal(r.status, 400); ok('non-string identifier rejected');

  console.log('Forgot / reset password');
  const a = await post('/api/auth/forgot-password', { email: 'b@x.com' }); const b = await post('/api/auth/forgot-password', { email: 'ghost@x.com' });
  const c = await post('/api/auth/forgot-password', { email: 'garbage' });
  assert.deepEqual(await a.json(), await b.json()); assert.deepEqual(await c.json(), { success: true, message: 'If the email exists, a reset link has been sent.' });
  ok('same response for known / unknown / invalid email'); await new Promise((r2) => setTimeout(r2, 20));
  assert(sent.length === 1 && sent[0].html.includes('https://example.vercel.app/password?token=') && !sent[0].html.includes('app//password')); ok('reset link uses first origin, no double slash');
  const rt = realMailer.generateResetToken('u2', 'b@x.com');
  r = await post('/api/auth/reset-password', { token: rt, newPassword: 'abc' }); assert.equal(r.status, 400); ok('weak new password rejected');
  await new Promise((r2) => setTimeout(r2, 1100));
  r = await post('/api/auth/reset-password', { token: rt, newPassword: 'Another-Str0ng-One' }); assert.equal(r.status, 200); ok('reset works');
  r = await post('/api/auth/reset-password', { token: rt, newPassword: 'Yet-Another-One-99' }); assert.equal(r.status, 400); ok('reset link is single-use');

  console.log('Rate limiting');
  // trust proxy = 1 → req.ip is the last X-Forwarded-For hop; spoofing the first hop changes nothing
  const codes = [];
  for (let i = 0; i < 12; i++) codes.push((await post('/api/auth/login', { identifier: 'z@x.com', password: 'whatever12' }, { 'X-Forwarded-For': `9.9.9.${i}, 5.5.5.5` })).status);
  assert(codes.slice(0, 10).every((c2) => c2 === 401) && codes[10] === 429, JSON.stringify(codes)); ok('spoofed X-Forwarded-For does not evade login rate limit');
  const t2 = signSessionToken({ userId: 'u2' });
  let limited1 = 0, limited2 = 0;
  for (let i = 0; i < 35; i++) if ((await get('/api/search?q=hello', { ...bearer(t1), 'X-Forwarded-For': '7.7.7.7' })).status === 429) limited1++;
  for (let i = 0; i < 3; i++) if ((await get('/api/search?q=hello', { ...bearer(t2), 'X-Forwarded-For': '7.7.7.7' })).status === 429) limited2++;
  assert(limited1 >= 5 && limited2 === 0, `${limited1}/${limited2}`); ok('per-user buckets: one user hitting the limit does not lock out another on the same IP');

  console.log(`\nAll ${passed} checks passed`);
  server.close(); process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e.stack || e); process.exit(1); });
