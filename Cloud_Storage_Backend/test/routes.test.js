// Route-level tests for files / folders / channels / download / view.
// Real Express app + real services; the DB is an in-memory fake and the Telegram client is a stub.
// Run with: npm test
const assert = require('assert');
const { Readable } = require('stream');
const ROOT = require('path').resolve(__dirname, '..');

process.env.NODE_ENV = 'production';
process.env.TRUST_PROXY = '1';
process.env.JWT_SECRET = 'j'.repeat(40);
process.env.TELEGRAM_2FA_ENC_KEY = 'k'.repeat(48);
process.env.DB_HOST = 'fake';

// ── fake DB ───────────────────────────────────────────────────────────────────
const db = { users: [], files: [], folders: [], channels: [] };
const norm = (sql) => sql.replace(/\s+/g, ' ').trim();
const ok = (n) => [{ affectedRows: n }];

const fakePool = {
  async execute(sql, p = []) {
    const s = norm(sql);
    let m;
    if (/^SELECT .* FROM users WHERE id = \?$/.test(s)) {
      const u = db.users.find((x) => x.id === p[0]);
      if (!u) return [[]];
      const cols = s.replace(/^SELECT (.*) FROM users.*$/, '$1').split(',').map((c) => c.trim());
      return [[Object.fromEntries(cols.map((c) => [c, u[c]]))]];
    }
    // files
    if ((m = /^SELECT id, original_name, .* FROM uploaded_files WHERE user_id = \? AND folder_id (IS NULL|= \?) ORDER BY created_at DESC LIMIT (\d+)$/.exec(s))) {
      const folder = m[1] === 'IS NULL' ? null : p[1];
      return [db.files.filter((f) => f.user_id === p[0] && (f.folder_id ?? null) === folder).slice(0, Number(m[2]))];
    }
    if (/^SELECT \* FROM uploaded_files WHERE id = \? AND user_id = \?$/.test(s)) return [db.files.filter((f) => f.id === p[0] && f.user_id === p[1])];
    if (/^SELECT \* FROM uploaded_files WHERE telegram_message_id = \? AND user_id = \?$/.test(s)) return [db.files.filter((f) => f.telegram_message_id === p[0] && f.user_id === p[1])];
    if (/^SELECT id FROM uploaded_files WHERE channel_id = \? AND telegram_message_id = \? AND user_id = \? AND id != \?$/.test(s)) {
      return [db.files.filter((f) => f.channel_id === p[0] && f.telegram_message_id === p[1] && f.user_id === p[2] && f.id !== p[3])];
    }
    if (/FROM uploaded_files WHERE user_id = \? AND original_name LIKE \?/.test(s)) {
      const needle = p[1].replace(/%/g, '');
      return [db.files.filter((f) => f.user_id === p[0] && f.original_name.includes(needle))];
    }
    if (/^SELECT COUNT\(\*\) as totalFiles/.test(s)) {
      const mine = db.files.filter((f) => f.user_id === p[0]);
      return [[{ totalFiles: mine.length, totalSize: mine.reduce((a, f) => a + f.file_size, 0) }]];
    }
    if (/^INSERT INTO uploaded_files/.test(s)) {
      db.files.push({ id: p[0], user_id: p[1], original_name: p[2], file_size: p[3], mime_type: p[4], telegram_message_id: p[5], channel_id: p[6], folder_id: p[7] });
      return ok(1);
    }
    if (/^DELETE FROM uploaded_files WHERE id = \? AND user_id = \?$/.test(s)) {
      const n = db.files.length; db.files = db.files.filter((f) => !(f.id === p[0] && f.user_id === p[1])); return ok(n - db.files.length);
    }
    if (/^UPDATE uploaded_files SET folder_id = \?/.test(s)) { const f = db.files.find((x) => x.id === p[1] && x.user_id === p[2]); if (f) f.folder_id = p[0]; return ok(f ? 1 : 0); }
    if (/^UPDATE uploaded_files SET original_name = \?/.test(s)) { const f = db.files.find((x) => x.id === p[1] && x.user_id === p[2]); if (f) f.original_name = p[0]; return ok(f ? 1 : 0); }
    // folders
    if (/^SELECT id FROM folders WHERE id = \? AND user_id = \?$/.test(s)) return [db.folders.filter((f) => f.id === p[0] && f.user_id === p[1]).map((f) => ({ id: f.id }))];
    if (/^SELECT \* FROM folders WHERE id = \? AND user_id = \?$/.test(s)) return [db.folders.filter((f) => f.id === p[0] && f.user_id === p[1])];
    if ((m = /^SELECT \* FROM folders WHERE user_id = \? AND parent_id (IS NULL|= \?) ORDER BY name$/.exec(s))) {
      const parent = m[1] === 'IS NULL' ? null : p[1];
      return [db.folders.filter((f) => f.user_id === p[0] && (f.parent_id ?? null) === parent)];
    }
    if (/^INSERT INTO folders/.test(s)) { db.folders.push({ id: p[0], user_id: p[1], name: p[2], parent_id: p[3] }); return ok(1); }
    if (/^DELETE FROM folders/.test(s)) { db.folders = db.folders.filter((f) => !(f.id === p[0] && f.user_id === p[1])); return ok(1); }
    if (/^UPDATE folders SET name = \?/.test(s)) { const f = db.folders.find((x) => x.id === p[1] && x.user_id === p[2]); if (f) f.name = p[0]; return ok(f ? 1 : 0); }
    // channels
    if (/FROM user_channels WHERE user_id = \? AND is_active = TRUE/.test(s)) return [db.channels.filter((c) => c.user_id === p[0])];
    throw new Error('unexpected SQL in test: ' + s);
  },
  async query(sql, p) {
    if (/^INSERT IGNORE INTO user_channels/.test(norm(sql))) {
      for (const [id, user_id, channel_id, channel_username, channel_title] of p[0]) db.channels.push({ id, user_id, channel_id, channel_username, channel_title });
      return ok(p[0].length);
    }
    throw new Error('unexpected query in test');
  },
  async getConnection() { return { release() {} }; },
};
const dbPath = require.resolve(ROOT + '/utils/database.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakePool };

// ── stub Telegram client ──────────────────────────────────────────────────────
const tg = { deleted: [], failDelete: null, getClientCalls: 0, downloads: [] };
const tgManager = require(ROOT + '/utils/telegramClientManager.js');
const BODY = Buffer.from('0123456789abcdefghij'); // 20 bytes
const fakeClient = {
  async getChat(id) { return { id }; },
  async uploadFile({ file, fileName, progressCallback }) {
    let n = 0; for await (const chunk of file) n += chunk.length;
    progressCallback?.(n, n);
    if (tg.failUpload) throw tg.failUpload;
    return { fileName, bytes: n };
  },
  async sendMedia() { return { id: 555 }; },
  async deleteMessagesById(chat, ids, opts) { if (tg.failDelete) throw tg.failDelete; tg.deleted.push({ chat, ids, opts }); },
  async *iterDialogs() {
    yield { peer: { type: 'user', title: 'Alice', id: 1 } };
    yield { peer: { type: 'channel', title: 'My Storage', id: -1001, isCreator: true, username: 'mystore' } };
    yield { peer: { type: 'channel', title: 'Not Mine', id: -1002, isCreator: false, isAdmin: false } };
  },
  async getMessages() {
    return [{ media: { fileSize: BODY.length, getThumbnail: () => ({ fileSize: 5 }) } }];
  },
  downloadAsNodeStream(media, opts) { tg.downloads.push({ media, opts }); return Readable.from([media.fileSize === 5 ? BODY.subarray(0, 5) : BODY.subarray(opts.offset || 0, (opts.offset || 0) + (opts.limit || BODY.length))]); },
};
tgManager.getClient = async () => { tg.getClientCalls++; return fakeClient; };

const { signSessionToken, signDownloadTicket } = require(ROOT + '/utils/authMiddleware.js');
const crypto = require(ROOT + '/utils/crypto.js');
const realSetInterval = global.setInterval;
global.setInterval = (...a) => { const t = realSetInterval(...a); t.unref?.(); return t; };
const app = require(ROOT + '/app.js');

let passed = 0;
const pass = (name) => { passed++; console.log('  ✓', name); };

(async () => {
  db.users = [1, 2].map((n) => ({
    id: `u${n}`, phone_number: `+91${n}`, email: `u${n}@x.com`, is_profile_complete: 1, password_changed_at: null,
    telegram_session: crypto.encryptSession(`SESSION-${n}`), telegram_api_id: '1', telegram_api_hash: 'h', first_name: `U${n}`,
  }));
  const file = (id, user, name, msg, extra = {}) => ({ id, user_id: user, original_name: name, file_size: 20, mime_type: 'image/png', telegram_message_id: msg, channel_id: '-100', folder_id: null, ...extra });
  db.files = [file('f1', 'u1', 'cat.png', '101'), file('f2', 'u1', 'dog.png', '102'), file('f3', 'u2', 'secret.png', '201')];
  db.folders = [{ id: 'd1', user_id: 'u1', name: 'Pics', parent_id: null }, { id: 'd2', user_id: 'u2', name: 'Theirs', parent_id: null }];

  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const A = { Authorization: `Bearer ${signSessionToken({ userId: 'u1' })}` };
  const B = { Authorization: `Bearer ${signSessionToken({ userId: 'u2' })}` };
  const call = (method, path, headers = {}, body) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  const json = async (r) => r.json();

  console.log('Health');
  let r = await call('GET', '/health'); let b = await json(r);
  assert.equal(r.status, 200); assert.equal(b.status, 'OK'); assert.equal(b.maxConcurrentUploads, 2); assert.equal(b.activeUploads, 0); pass('health reports upload gate');

  console.log('Files');
  r = await call('GET', '/files?folder_id=null', A); b = await json(r);
  assert.deepEqual(b.files.map((f) => f.id).sort(), ['f1', 'f2']); assert.equal(b.count, 2); pass("lists only the caller's root files");
  r = await call('GET', '/files/f1', A); assert.equal(r.status, 200); pass('get own file');
  r = await call('GET', '/files/f3', A); assert.equal(r.status, 404); pass("cannot get another user's file");
  r = await call('GET', '/search?q=cat', A); b = await json(r); assert.deepEqual(b.files.map((f) => f.id), ['f1']); pass('search');
  r = await call('GET', '/search?q=c', A); assert.equal(r.status, 400); pass('search rejects 1-char query');
  r = await call('GET', '/search?q[]=a&q[]=b', A); assert.equal(r.status, 400); pass('search rejects non-string query');
  r = await call('GET', '/stats', A); b = await json(r); assert.equal(b.stats.totalFiles, 2); assert.equal(b.stats.totalSizeInMB, '0.00'); pass('stats');

  r = await call('PUT', '/files/f1/rename', A, { newName: '  kitten.png  ' }); assert.equal(r.status, 200); assert.equal(db.files[0].original_name, 'kitten.png'); pass('rename trims');
  r = await call('PUT', '/files/f1/rename', A, { newName: '   ' }); assert.equal(r.status, 400); pass('rename rejects blank');
  r = await call('PUT', '/files/f1/rename', A, { newName: 'x'.repeat(501) }); assert.equal(r.status, 400); pass('rename rejects >500 chars');
  r = await call('PUT', '/files/f3/rename', A, { newName: 'pwned' }); assert.equal(r.status, 404); assert.equal(db.files[2].original_name, 'secret.png'); pass("cannot rename another user's file");

  r = await call('PUT', '/files/f1/move', A, { folderId: 'd1' }); assert.equal(r.status, 200); assert.equal(db.files[0].folder_id, 'd1'); pass('move into own folder');
  r = await call('PUT', '/files/f1/move', A, { folderId: 'd2' }); assert.equal(r.status, 404); assert.equal(db.files[0].folder_id, 'd1'); pass("cannot move into another user's folder");
  r = await call('PUT', '/files/f1/move', A, { folderId: null }); assert.equal(r.status, 200); assert.equal(db.files[0].folder_id, null); pass('move back to root');

  r = await call('POST', '/files/f1/copy', A, { folderId: 'd1' }); b = await json(r);
  assert.equal(r.status, 200); assert.equal(b.file.telegram_message_id, '101'); assert.equal(b.file.folder_id, 'd1');
  const copyId = b.file.id; assert.equal(db.files.filter((f) => f.telegram_message_id === '101').length, 2); pass('copy shares the Telegram message');
  r = await call('POST', '/files/f3/copy', A, {}); assert.equal(r.status, 404); pass("cannot copy another user's file");

  console.log('Delete');
  r = await call('DELETE', `/files/${copyId}`, A); assert.equal(r.status, 200);
  assert.equal(tg.deleted.length, 0); assert(!db.files.some((f) => f.id === copyId)); pass('deleting one of two references keeps the Telegram message');
  r = await call('DELETE', '/files/f1', A); assert.equal(r.status, 200);
  assert.deepEqual(tg.deleted[0], { chat: -100, ids: [101], opts: { revoke: true } }); assert(!db.files.some((f) => f.id === 'f1')); pass('deleting the last reference deletes it from Telegram too');
  r = await call('DELETE', '/files/f3', A); assert.equal(r.status, 404); assert(db.files.some((f) => f.id === 'f3')); pass("cannot delete another user's file");
  tg.failDelete = new Error('AUTH_KEY_UNREGISTERED'); r = await call('DELETE', '/files/f2', A);
  assert.equal(r.status, 200); assert(!db.files.some((f) => f.id === 'f2')); pass('Telegram failure still removes the DB record');
  tg.failDelete = null;
  const before = tg.getClientCalls; r = await call('DELETE', '/files/nope', B); assert.equal(r.status, 404); assert.equal(tg.getClientCalls, before); pass('404 delete never touches Telegram');

  console.log('Folders');
  r = await call('POST', '/folders', A, { name: '  Docs  ' }); b = await json(r); assert.equal(b.folder.name, 'Docs'); const docs = b.folder.id; pass('create trims name');
  r = await call('POST', '/folders', A, { name: '' }); assert.equal(r.status, 400); pass('create rejects blank');
  r = await call('POST', '/folders', A, { name: 'x'.repeat(256) }); assert.equal(r.status, 400); pass('create rejects >255 chars');
  r = await call('POST', '/folders', A, { name: 'Sub', parent_id: 'd2' }); assert.equal(r.status, 404); pass("cannot nest under another user's folder");
  r = await call('POST', '/folders', A, { name: 'Sub', parent_id: docs }); b = await json(r); const sub = b.folder.id; assert.equal(r.status, 200); pass('create nested');
  r = await call('GET', `/folders?parent_id=${docs}`, A); b = await json(r); assert.deepEqual(b.folders.map((f) => f.id), [sub]); pass('list children');
  r = await call('GET', `/folders/path/${sub}`, A); b = await json(r); assert.deepEqual(b.path.map((f) => f.name), ['Docs', 'Sub']); pass('breadcrumb path root→leaf');
  r = await call('GET', '/folders/path/d2', A); b = await json(r); assert.deepEqual(b.path, []); pass("path hides another user's folders");
  r = await call('PUT', `/folders/${sub}/rename`, A, { newName: 'Renamed' }); assert.equal(r.status, 200); pass('rename folder');
  r = await call('PUT', '/folders/d2/rename', A, { newName: 'pwned' }); assert.equal(r.status, 404); pass("cannot rename another user's folder");
  r = await call('DELETE', '/folders/d2', A); assert(db.folders.some((f) => f.id === 'd2')); pass("delete is scoped to the caller's folders");

  console.log('Channels');
  r = await call('POST', '/sync-channels', A); b = await json(r);
  assert.equal(b.synced, 1); assert.equal(b.channels[0].title, 'My Storage'); pass('sync keeps only channels the user owns/administers');
  r = await call('GET', '/channels', A); b = await json(r); assert.equal(b.channels.length, 1); pass('lists stored channels');
  r = await call('GET', '/channels', B); b = await json(r); assert.equal(b.channels.length, 0); pass("channels are per-user");

  console.log('Download / view');
  r = await call('GET', '/download-ticket/201', A); assert.equal(r.status, 404); pass("no ticket for another user's file");
  r = await call('GET', '/download-ticket/201', B); b = await json(r); assert.equal(r.status, 200); const ticket = b.token; pass('ticket for own file');
  r = await fetch(`${base}/download/201?dt=${ticket}`); const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(r.status, 200); assert.equal(buf.toString(), BODY.toString()); assert(/attachment/.test(r.headers.get('content-disposition'))); pass('download with ticket streams the file');
  r = await fetch(`${base}/download/201`, { headers: { ...B, Range: 'bytes=0-4' } });
  assert.equal(r.status, 206); assert.equal(r.headers.get('content-range'), 'bytes 0-4/20'); assert.equal((await r.text()), '01234'); pass('Range request → 206 with correct Content-Range');
  r = await fetch(`${base}/download/201`, { headers: { ...B, Range: 'bytes=50-60' } }); assert.equal(r.status, 416); pass('unsatisfiable range → 416');
  r = await fetch(`${base}/download/201?dt=${signDownloadTicket('u2', '999')}`); assert.equal(r.status, 401); pass('ticket for a different file rejected');
  r = await fetch(`${base}/download/201`, { headers: A }); assert.equal(r.status, 404); pass("another user cannot download by message id");
  r = await fetch(`${base}/download/201`); assert.equal(r.status, 401); pass('no credentials → 401');

  r = await fetch(`${base}/view/201?thumb=1`, { headers: B }); const t = Buffer.from(await r.arrayBuffer());
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'image/jpeg'); assert.equal(t.length, 5);
  assert.equal(r.headers.get('cache-control'), 'private, max-age=86400'); assert(/authorization/i.test(r.headers.get('vary'))); pass('thumbnail: jpeg, cacheable by the browser, varies on Authorization');
  r = await fetch(`${base}/view/201`, { headers: B }); await r.arrayBuffer();
  assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), null); pass('full view is NOT cached');
  r = await fetch(`${base}/view/201?thumb=1`, { headers: A }); assert.equal(r.status, 404); pass("another user cannot view by message id");

  console.log('Upload');
  const upload = (query, name = 'hello.txt', content = 'hello world', headers = A) => {
    const fd = new FormData(); fd.append('file', new Blob([content], { type: 'text/plain' }), name);
    return fetch(`${base}/upload?${query}`, { method: 'POST', headers, body: fd });
  };
  const activeUploads = async () => (await json(await call('GET', '/health'))).activeUploads;
  r = await upload('channelId=-100&uploadId=abcdefgh-0001'); b = await json(r);
  assert.equal(r.status, 200); assert.equal(b.success, true); assert.equal(b.file.size, 11); assert.equal(b.file.messageId, 555); pass('upload streams a file to Telegram');
  const rec = db.files.find((f) => f.id === b.file.id);
  assert(rec && rec.user_id === 'u1' && rec.original_name === 'hello.txt' && rec.telegram_message_id === '555' && rec.channel_id === '-100' && rec.file_size === 11); pass('upload records the file for the right user');
  assert.equal(await activeUploads(), 0); pass('upload gate released after success');
  r = await upload('channelId=-100&folderId=d1'); b = await json(r); assert.equal(r.status, 200); assert.equal(db.files.find((f) => f.id === b.file.id).folder_id, 'd1'); pass('upload into own folder');
  r = await upload('channelId=-100&folderId=d2'); assert.equal(r.status, 404); assert.equal(await activeUploads(), 0); pass("upload into another user's folder rejected (gate released)");
  r = await upload('channelId=-100&uploadId=bad id!'); assert.equal(r.status, 400); assert.equal(await activeUploads(), 0); pass('malformed upload id rejected');
  r = await upload('channelId=abc'); assert.equal(r.status, 400); pass('non-numeric channel id rejected');
  r = await upload('channelId=-100', 'x.txt', 'x', {}); assert.equal(r.status, 401); pass('upload requires auth');
  const filesBefore = db.files.length;
  const markedDead = [];
  const realMarkDead = tgManager.markSessionDead.bind(tgManager);
  tgManager.markSessionDead = (userId, session) => { markedDead.push({ userId, session }); };
  tg.failUpload = new Error('AUTH_KEY_UNREGISTERED: db password is hunter2');
  r = await upload('channelId=-100&uploadId=abcdefgh-0002'); b = await json(r);
  assert.equal(r.status, 500); assert.equal(b.sessionRevoked, true); assert(!JSON.stringify(b).includes('hunter2')); assert.equal(db.files.length, filesBefore);
  assert.equal(await activeUploads(), 0); pass('failed upload: no record, no leaked internals, gate released');
  assert.deepEqual(markedDead, [{ userId: 'u1', session: 'SESSION-1' }]); pass('revoked session is marked dead with the DECRYPTED session string');
  tg.failUpload = null;
  tgManager.markSessionDead = realMarkDead;

  console.log('Telegram failure handling');
  const origGet = fakeClient.getMessages;
  fakeClient.getMessages = async () => { throw new Error('AUTH_KEY_UNREGISTERED: boom with internal detail'); };
  r = await fetch(`${base}/view/201?thumb=1`, { headers: B }); b = await json(r);
  assert.equal(r.status, 500); assert.equal(b.sessionRevoked, true); assert(!JSON.stringify(b).includes('internal detail')); assert(/reconnect/i.test(b.error)); pass('revoked session → sessionRevoked flag, no internals leaked');
  fakeClient.getMessages = origGet;

  console.log(`\nAll ${passed} route checks passed`);
  server.close(); process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e.stack || e); process.exit(1); });
