const express = require('express');
const router = express.Router();
const busboy = require('busboy');
const { Readable } = require('stream');
const { InputMedia } = require('@mtcute/node');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const pool = require('../utils/database');
const tgManager = require('../utils/telegramClientManager');

const uploadProgressMap = new Map();
const uploadCancelMap = new Map();

// ─── Auth middleware ─────────────────────────────────────────────────────────

async function authenticateUser(req, res, next) {
    try {
        const token = req.headers.authorization?.replace('Bearer ', '');
        if (!token) return res.status(401).json({ error: 'Authentication required' });
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const [users] = await pool.execute('SELECT * FROM users WHERE id = ?', [decoded.userId]);
        if (users.length === 0) return res.status(401).json({ error: 'User not found' });
        req.user = users[0];
        next();
    } catch (err) {
        res.status(401).json({ error: 'Invalid token' });
    }
}

// Native <a href> downloads can't send an Authorization header, so a short-lived
// single-file ticket (?dt=) is accepted as an alternate credential on download routes.
async function authenticateDownload(req, res, next) {
    const ticket = req.query.dt;
    if (!ticket) return authenticateUser(req, res, next);

    try {
        const decoded = jwt.verify(ticket, process.env.JWT_SECRET);
        if (decoded.purpose !== 'download' || decoded.messageId !== req.params.messageId) {
            return res.status(401).json({ error: 'Invalid or expired download link' });
        }
        const [users] = await pool.execute('SELECT * FROM users WHERE id = ?', [decoded.userId]);
        if (users.length === 0) return res.status(401).json({ error: 'User not found' });
        req.user = users[0];
        next();
    } catch (err) {
        res.status(401).json({ error: 'Invalid or expired download link' });
    }
}

// A wedged MTProto connection can leave a call pending forever with no error — timing
// it out turns that into a normal failure so the per-user download queue keeps moving.
function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ─── Rate limiter ─────────────────────────────────────────────────────────────

const rateLimitMap = new Map();
function rateLimit(maxRequests, windowMs) {
    return (req, res, next) => {
        const key = req.ip;
        const now = Date.now();
        const entry = rateLimitMap.get(key) || { count: 0, resetAt: now + windowMs };
        if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + windowMs; }
        entry.count++;
        rateLimitMap.set(key, entry);
        if (entry.count > maxRequests) return res.status(429).json({ error: 'Too many requests. Please slow down.' });
        next();
    };
}

setInterval(() => {
    const now = Date.now();
    for (const [k, v] of rateLimitMap) if (now > v.resetAt) rateLimitMap.delete(k);
}, 5 * 60 * 1000);

let activeUploads = 0;
const MAX_CONCURRENT_UPLOADS = 3;

// ─── HEALTH ──────────────────────────────────────────────────────────────────

router.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        activeUploads,
        maxConcurrentUploads: MAX_CONCURRENT_UPLOADS,
        cachedTelegramClients: tgManager.clients?.size ?? 0,
        mode: 'mtcute-streaming',
    });
});

// ─── SSE PROGRESS ────────────────────────────────────────────────────────────

router.get('/upload-progress/:uploadId', async (req, res) => {
    const token = req.query.token || req.headers.authorization?.replace('Bearer ', '');
    try { jwt.verify(token, process.env.JWT_SECRET); }
    catch { return res.status(401).end(); }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const id = req.params.uploadId;

    // Pre-seed map so it's never undefined when interval fires
    uploadProgressMap.set(id, 0);
    res.write(`data: ${JSON.stringify({ progress: 0 })}\n\n`);

    const interval = setInterval(() => {
        const progress = uploadProgressMap.get(id) ?? 0;
        // Always send — no more silent heartbeats swallowing real progress
        res.write(`data: ${JSON.stringify({ progress })}\n\n`);
        if (progress >= 100) {
            clearInterval(interval);
            uploadProgressMap.delete(id);
            res.end();
        }
    }, 150); // tighter than 300ms for smoother UI

    req.on('close', () => {
        clearInterval(interval);
        uploadProgressMap.delete(id);
    });
});

// ─── CANCEL ──────────────────────────────────────────────────────────────────

router.post('/upload-cancel/:uploadId', async (req, res) => {
    const token = req.query.token || req.headers.authorization?.replace('Bearer ', '');
    try { jwt.verify(token, process.env.JWT_SECRET); }
    catch { return res.status(401).end(); }
    const id = req.params.uploadId;
    uploadCancelMap.set(id, true);
    uploadProgressMap.delete(id);
    res.json({ success: true });
});

// ─── UPLOAD ──────────────────────────────────────────────────────────────────

router.post('/upload',
    authenticateUser,
    rateLimit(10, 60 * 1000),
    async (req, res) => {

        if (activeUploads >= MAX_CONCURRENT_UPLOADS) {
            return res.status(429).json({
                error: `Server busy (${activeUploads}/${MAX_CONCURRENT_UPLOADS} uploads active). Try again shortly.`
            });
        }

        activeUploads++;
        const user = req.user;
        // Acquired once the upload actually starts touching Telegram (inside the
        // busboy 'file' handler below) and released in the outer finally, so an
        // in-progress upload can't interleave its requests with a concurrent
        // download/view on the same shared connection.
        let releaseDownloadSlot = null;

        try {
            const channelId = req.query.channelId || user.default_group_id;
            const uploadId = req.query.uploadId || null;
            const folderId = req.query.folderId || null;

            if (!channelId) {
                activeUploads--;
                return res.status(400).json({ error: 'No channel specified' });
            }

            // FIX: Signal immediately that request reached the server
            if (uploadId) uploadProgressMap.set(uploadId, 1);

            const bb = busboy({
                headers: req.headers,
                limits: { fileSize: 2 * 1024 * 1024 * 1024 }
            });

            let fileName = '';
            let mimeType = 'application/octet-stream';
            let fileSize = 0;

            const contentLength = parseInt(req.headers['content-length'] || '0');
            const estimatedFileSize = contentLength > 200 ? contentLength - 200 : 0;

            const uploadPromise = new Promise((resolve, reject) => {

                bb.on('file', async (fieldname, fileStream, info) => {
                    fileName = info.filename || 'unnamed_file';
                    mimeType = info.mimeType || 'application/octet-stream';

                    console.log(`📤 Upload started: ${fileName} (uploadId: ${uploadId})`);

                    try {
                        // FIX: 3% as soon as busboy fires the file event
                        if (uploadId) uploadProgressMap.set(uploadId, 3);

                        const client = await tgManager.getClient(user);
                        tgManager.pauseTimer(user.id);
                        releaseDownloadSlot = await tgManager.acquireDownloadSlot(user.id);

                        const chatId = parseInt(channelId);
                        let received = 0;
                        // read() fires when the consumer (mtcute's uploadFile, reading this
                        // stream to send parts to Telegram) wants more data — use that as the
                        // signal to resume the incoming HTTP stream if it was paused below.
                        const trackingStream = new Readable({
                            read() {
                                if (fileStream.isPaused()) fileStream.resume();
                            }
                        });

                        fileStream.on('data', (chunk) => {
                            if (uploadCancelMap.get(uploadId)) {
                                fileStream.destroy();
                                trackingStream.destroy();
                                return;
                            }
                            received += chunk.length;
                            // Without checking push()'s return value, a fast upload arriving
                            // faster than Telegram can accept it would buffer the whole file
                            // in memory — a real OOM risk for large files on a ~512MB free tier.
                            // false means the internal buffer is full: pause until read() says
                            // the consumer is ready for more.
                            if (!trackingStream.push(chunk)) {
                                fileStream.pause();
                            }

                            // FIX: Receive phase = 3–30% (was 5–40%)
                            // Gives more headroom for the Telegram phase to feel smooth
                            if (estimatedFileSize > 0) {
                                const p = Math.min(3 + Math.round((received / estimatedFileSize) * 27), 30);
                                if (uploadId) uploadProgressMap.set(uploadId, p);
                            }
                        });

                        fileStream.on('end', () => {
                            trackingStream.push(null);
                            fileSize = received;
                            // FIX: Explicitly land at 30% when receive is done
                            // so the UI doesn't stall while Telegram upload begins
                            if (uploadId) uploadProgressMap.set(uploadId, 30);
                        });

                        fileStream.on('error', (err) => trackingStream.destroy(err));
                        fileStream.on('limit', () => reject(new Error('File exceeds 2GB limit')));

                        const uploadedFile = await client.uploadFile({
                            file: trackingStream,
                            fileName,
                            fileSize: estimatedFileSize || undefined,
                            fileMime: mimeType,
                            progressCallback: (uploaded, total) => {
                                if (uploadCancelMap.get(uploadId)) {
                                    throw new Error('UPLOAD_CANCELLED');
                                }
                                // FIX: Telegram phase = 30–99%
                                const p = total > 0
                                    ? Math.round(30 + (uploaded / total) * 69)
                                    : Math.min(Math.round(30 + (uploaded / (estimatedFileSize || uploaded)) * 69), 99);
                                if (uploadId) uploadProgressMap.set(uploadId, Math.min(p, 99));
                                process.stdout.write(`\r📤 Telegram: ${total > 0 ? Math.round(uploaded / total * 100) : '?'}%`);
                            },
                        });

                        console.log(`\n📦 Sending message to channel...`);

                        const result = await client.sendMedia(chatId, InputMedia.document(uploadedFile, {
                            caption: `Uploaded by ${user.first_name || ''} ${user.last_name || ''}`.trim(),
                            fileName,
                        }));

                        console.log(`✅ Done — message ID ${result.id}`);
                        if (uploadId) uploadProgressMap.set(uploadId, 100);
                        resolve(result);

                    } catch (err) { reject(err); }
                });

                bb.on('error', reject);
                bb.on('finish', () => {
                    if (!fileName) reject(new Error('No file field in request'));
                });
            });

            req.pipe(bb);

            const result = await uploadPromise;

            const fileId = uuidv4();
            await pool.execute(
                `INSERT INTO uploaded_files 
                 (id, user_id, original_name, file_size, mime_type, telegram_message_id, channel_id, folder_id, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
                [fileId, user.id, fileName, fileSize, mimeType, result.id.toString(), channelId, folderId]
            );

            res.json({
                success: true,
                file: { id: fileId, name: fileName, size: fileSize, messageId: result.id, channelId }
            });

        } catch (err) {
            const wasCancelled = err.message === 'UPLOAD_CANCELLED' || uploadCancelMap.get(req.query.uploadId);

            if (wasCancelled) {
                console.log(`🚫 Upload cancelled: ${req.query.uploadId}`);
                if (!res.headersSent) res.status(499).json({ error: 'Upload cancelled' });
            } else {
                console.error('Upload error:', err.message);
                if (!res.headersSent) res.status(500).json({ error: err.message });
            }

            if (req.query.uploadId) {
                uploadProgressMap.delete(req.query.uploadId);
                uploadCancelMap.delete(req.query.uploadId);
            }

        } finally {
            activeUploads--;
            tgManager.resumeTimer(user.id);
            releaseDownloadSlot?.();
        }
    }
);

// ─── GET FILES ───────────────────────────────────────────────────────────────

router.get('/files', authenticateUser, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 50, 100);
        const folderId = req.query.folder_id === 'null' ? null : req.query.folder_id || null;
        let query, params;
        if (folderId) {
            query = `SELECT id, original_name, file_size, mime_type, telegram_message_id, channel_id, folder_id, created_at 
                     FROM uploaded_files WHERE user_id = ? AND folder_id = ? ORDER BY created_at DESC LIMIT ` + limit;
            params = [req.user.id, folderId];
        } else {
            query = `SELECT id, original_name, file_size, mime_type, telegram_message_id, channel_id, folder_id, created_at 
                     FROM uploaded_files WHERE user_id = ? AND folder_id IS NULL ORDER BY created_at DESC LIMIT ` + limit;
            params = [req.user.id];
        }
        const [files] = await pool.execute(query, params);
        res.json({ success: true, count: files.length, files });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── GET FILE BY ID ──────────────────────────────────────────────────────────

router.get('/files/:id', authenticateUser, async (req, res) => {
    try {
        const [files] = await pool.execute('SELECT * FROM uploaded_files WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
        if (files.length === 0) return res.status(404).json({ error: 'File not found' });
        res.json({ success: true, file: files[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── DOWNLOAD TICKET ─────────────────────────────────────────────────────────
// Mints a short-lived, single-file token so the browser can download natively
// (streamed straight to disk, native progress UI) without an Authorization header.

router.get('/download-ticket/:messageId', authenticateUser, async (req, res) => {
    try {
        const [fileRecords] = await pool.execute(
            'SELECT id FROM uploaded_files WHERE telegram_message_id = ? AND user_id = ?',
            [req.params.messageId, req.user.id]
        );
        if (fileRecords.length === 0) return res.status(404).json({ error: 'File not found' });

        const token = jwt.sign(
            { userId: req.user.id, messageId: req.params.messageId, purpose: 'download' },
            process.env.JWT_SECRET,
            { expiresIn: '2m' }
        );
        res.json({ token });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── DOWNLOAD ────────────────────────────────────────────────────────────────

router.get('/download/:messageId', authenticateDownload, rateLimit(20, 60 * 1000), async (req, res) => {
    // Set once this request has acquired the client and its download-queue slot,
    // so the catch block below only tears down what this request actually holds.
    let tgOperationStarted = false;
    let releaseDownloadSlot = null;
    // Once the outer withTimeout below gives up on setup(), setup() itself keeps
    // running in the background (withTimeout only stops waiting on it, it can't
    // cancel it). If setup() was still waiting for its turn in acquireDownloadSlot
    // at that moment, releaseTgOperation() below fires as a no-op (nothing to
    // release yet) and then never runs again — so when the abandoned setup()
    // finally gets the slot, it would hold it forever with nobody left to release
    // it, wedging every request queued behind it. This flag lets setup() notice
    // it's been abandoned and release the slot itself instead of leaking it.
    let abandoned = false;
    const releaseTgOperation = () => {
        if (!tgOperationStarted) return;
        tgOperationStarted = false;
        tgManager.resumeTimer(req.user.id);
        releaseDownloadSlot?.();
        releaseDownloadSlot = null;
    };

    // Wraps setup only (DB query through creating the stream) — not the transfer
    // itself, which the inactivity watchdog below already guards without an overall
    // cap (a legitimately large file must be allowed to keep taking its time as long
    // as bytes keep arriving). This guarantees setup can't hang on a step with no
    // timeout of its own, like pool.execute or acquireDownloadSlot's wait.
    const setup = async () => {
        const [fileRecords] = await pool.execute(
            'SELECT * FROM uploaded_files WHERE telegram_message_id = ? AND user_id = ?',
            [req.params.messageId, req.user.id]
        );
        if (fileRecords.length === 0) return { notFound: true };

        const fileRecord = fileRecords[0];
        const client = await tgManager.getClient(req.user);
        // Prevent the idle-disconnect timer from killing the client mid-stream on large files
        tgManager.pauseTimer(req.user.id);
        tgOperationStarted = true;
        // Telegram downloads for this user are serialized (see acquireDownloadSlot) —
        // concurrent raw file-part requests on one connection can otherwise interleave
        // and trigger a session reset that kills whichever request was still pending.
        releaseDownloadSlot = await tgManager.acquireDownloadSlot(req.user.id);

        if (abandoned) {
            releaseTgOperation();
            throw new Error('download setup abandoned after timeout');
        }

        // Resolve peer first to add it to cache
        let chat;
        try {
            chat = await client.getChat(fileRecord.channel_id);
        } catch {
            try {
                chat = await client.getChat(parseInt(fileRecord.channel_id));
            } catch {
                return { notFound: true, notFoundMessage: 'Channel not found' };
            }
        }

        const messages = await client.getMessages(chat, parseInt(req.params.messageId));
        const message = Array.isArray(messages) ? messages[0] : messages;
        if (!message || !message.media) return { notFound: true };

        return { fileRecord, client, message };
    };

    try {
        const setupResult = await withTimeout(setup(), 45000, 'download setup');
        if (setupResult.notFound) {
            releaseTgOperation();
            return res.status(404).json({ error: setupResult.notFoundMessage || 'File not found on Telegram' });
        }
        const { fileRecord, client, message } = setupResult;

        const fileSize = fileRecord.file_size || message.media.fileSize || undefined;

        let start = 0;
        let end = fileSize ? fileSize - 1 : undefined;
        let status = 200;

        const range = req.headers.range;
        if (range && fileSize) {
            const match = /^bytes=(\d*)-(\d*)$/.exec(range);
            if (!match || (!match[1] && !match[2])) {
                releaseTgOperation();
                res.setHeader('Content-Range', `bytes */${fileSize}`);
                return res.status(416).json({ error: 'Invalid range' });
            }

            if (match[1]) start = parseInt(match[1], 10);
            if (match[2]) end = parseInt(match[2], 10);

            if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= fileSize) {
                releaseTgOperation();
                res.setHeader('Content-Range', `bytes */${fileSize}`);
                return res.status(416).json({ error: 'Range not satisfiable' });
            }
            status = 206;
        }

        // Telegram requires the download offset to be aligned to 4096 bytes,
        // so we align down and trim the extra leading bytes before streaming to the client.
        const alignedOffset = start - (start % 4096);
        const leadingSkip = start - alignedOffset;
        const limit = fileSize ? end - alignedOffset + 1 : undefined;

        const abortController = new AbortController();
        req.on('close', () => abortController.abort());

        const tgStream = client.downloadAsNodeStream(message.media, {
            fileSize,
            offset: alignedOffset,
            limit,
            // Render's free tier has a shared/low CPU quota — fewer, larger parts means
            // fewer round-trips. Only worth forcing for files big enough that it matters;
            // requesting a 512KB part for a file that's only a few hundred bytes is an
            // oversized/malformed-looking request that Telegram may not answer cleanly.
            // Below that, let mtcute auto-pick a part size appropriate to the file.
            partSize: fileSize && fileSize > 5 * 1024 * 1024 ? 512 : undefined,
            abortSignal: abortController.signal,
        });

        // Client stayed disconnected from Telegram's idle-disconnect timer and held its
        // download-queue slot for the whole transfer; release both once it's done either way.
        res.on('close', releaseTgOperation);
        res.on('finish', releaseTgOperation);

        res.status(status);
        res.setHeader('Content-Type', fileRecord.mime_type || 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileRecord.original_name)}"`);
        res.setHeader('Accept-Ranges', 'bytes');
        if (fileSize) {
            res.setHeader('Content-Length', end - start + 1);
            if (status === 206) res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
        }

        // A wedged connection can leave downloadAsNodeStream emitting neither data nor
        // an error — this converts silence into an explicit failure so the queued
        // downloads behind it aren't stuck waiting on a slot that never gets released.
        let inactivityTimer;
        const INACTIVITY_TIMEOUT = 30000;
        const resetInactivityTimer = () => {
            clearTimeout(inactivityTimer);
            inactivityTimer = setTimeout(() => {
                tgStream.destroy(new Error(`Download stalled — no data for ${INACTIVITY_TIMEOUT / 1000}s`));
            }, INACTIVITY_TIMEOUT);
        };
        resetInactivityTimer();
        tgStream.on('data', resetInactivityTimer);
        tgStream.once('end', () => clearTimeout(inactivityTimer));
        tgStream.once('close', () => clearTimeout(inactivityTimer));

        tgStream.on('error', (err) => {
            console.error('Download stream error:', err.message);
            clearTimeout(inactivityTimer);
            tgManager.forceReconnect(req.user.id);
            if (!res.headersSent) res.status(500).json({ error: err.message });
            res.destroy(err);
        });

        if (leadingSkip > 0) {
            let skipped = 0;
            tgStream.on('data', function onData(chunk) {
                if (skipped + chunk.length <= leadingSkip) {
                    skipped += chunk.length;
                    return;
                }
                const sliceStart = leadingSkip - skipped;
                skipped = leadingSkip;
                tgStream.removeListener('data', onData);
                res.write(chunk.subarray(sliceStart));
                tgStream.pipe(res);
            });
        } else {
            tgStream.pipe(res);
        }
    } catch (err) {
        abandoned = true;
        console.error('Download error:', err.message);
        if (/timed out/.test(err.message)) await tgManager.forceReconnect(req.user.id);
        releaseTgOperation();
        if (!res.headersSent) res.status(500).json({ error: err.message });
    }
});

// ─── VIEW ─────────────────────────────────────────────────────────────────────

router.get('/view/:messageId', authenticateUser, rateLimit(20, 60 * 1000), async (req, res) => {
    // Thumbnails also pull raw file data over the shared Telegram connection, so they
    // must go through the same per-user queue as /download or they can interleave with
    // an in-progress download and trigger the same session-reset problem.
    let tgOperationStarted = false;
    let releaseDownloadSlot = null;
    // See the matching comment in /download above: once the outer withTimeout gives
    // up, run() keeps executing in the background, and if it was still waiting for
    // acquireDownloadSlot at that moment it would otherwise acquire and never
    // release the slot, wedging every request queued behind it for this user.
    let abandoned = false;
    const releaseTgOperation = () => {
        if (!tgOperationStarted) return;
        tgOperationStarted = false;
        tgManager.resumeTimer(req.user.id);
        releaseDownloadSlot?.();
        releaseDownloadSlot = null;
    };

    // Wrapping the whole body (not just individual calls) means the request can never
    // hang past this no matter which step turns out to be the stuck one — including
    // ones with no timeout of their own, like pool.execute or acquireDownloadSlot's wait.
    const run = async () => {
        const [fileRecords] = await pool.execute(
            'SELECT * FROM uploaded_files WHERE telegram_message_id = ? AND user_id = ?',
            [req.params.messageId, req.user.id]
        );
        if (fileRecords.length === 0) return res.status(404).json({ error: 'File not found' });

        const fileRecord = fileRecords[0];
        const client = await tgManager.getClient(req.user);
        tgManager.pauseTimer(req.user.id);
        tgOperationStarted = true;
        releaseDownloadSlot = await tgManager.acquireDownloadSlot(req.user.id);

        if (abandoned) {
            releaseTgOperation();
            throw new Error('view request abandoned after timeout');
        }

        // mtcute getMessages signature: (chatId, messageIds, fromReply?)
        const messages = await client.getMessages(parseInt(fileRecord.channel_id), parseInt(req.params.messageId));

        const message = Array.isArray(messages) ? messages[0] : messages;
        if (!message || !message.media)
            return res.status(404).json({ error: 'File not found on Telegram' });

        const fileBuffer = await client.downloadAsBuffer(message.media);
        res.setHeader('Content-Type', fileRecord.mime_type || 'application/octet-stream');
        res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(fileRecord.original_name)}"`);
        res.setHeader('Content-Length', fileBuffer.length);
        res.send(Buffer.from(fileBuffer));
    };

    try {
        await withTimeout(run(), 45000, 'view request');
    } catch (err) {
        abandoned = true;
        console.error('View error:', err.message);
        if (/timed out/.test(err.message)) await tgManager.forceReconnect(req.user.id);
        if (!res.headersSent) res.status(500).json({ error: err.message });
    } finally {
        releaseTgOperation();
    }
});

// ─── SEARCH ──────────────────────────────────────────────────────────────────

router.get('/search', authenticateUser, rateLimit(30, 60 * 1000), async (req, res) => {
    try {
        const q = req.query.q;
        if (!q || q.length < 2) return res.status(400).json({ error: 'Query must be at least 2 characters' });
        const [files] = await pool.execute(
            `SELECT id, original_name, file_size, mime_type, telegram_message_id, created_at
             FROM uploaded_files WHERE user_id = ? AND original_name LIKE ? ORDER BY created_at DESC LIMIT 50`,
            [req.user.id, `%${q}%`]
        );
        res.json({ success: true, query: q, count: files.length, files });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── STATS ───────────────────────────────────────────────────────────────────

router.get('/stats', authenticateUser, async (req, res) => {
    try {
        const [[stats]] = await pool.execute(
            `SELECT COUNT(*) as totalFiles, COALESCE(SUM(file_size), 0) as totalSize FROM uploaded_files WHERE user_id = ?`,
            [req.user.id]
        );
        res.json({
            success: true,
            stats: {
                totalFiles: stats.totalFiles,
                totalSizeInMB: (stats.totalSize / 1024 / 1024).toFixed(2),
                totalSizeInGB: (stats.totalSize / 1024 / 1024 / 1024).toFixed(3),
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── DELETE ──────────────────────────────────────────────────────────────────

router.delete('/files/:id', authenticateUser, async (req, res) => {
    try {
        const [files] = await pool.execute('SELECT * FROM uploaded_files WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
        if (files.length === 0) return res.status(404).json({ error: 'File not found' });

        const file = files[0];

        // Copies (see POST /files/:id/copy) share the same underlying Telegram message —
        // only delete it from Telegram once the last reference to it is being removed.
        const [otherRefs] = await pool.execute(
            'SELECT id FROM uploaded_files WHERE channel_id = ? AND telegram_message_id = ? AND user_id = ? AND id != ?',
            [file.channel_id, file.telegram_message_id, req.user.id, file.id]
        );

        if (otherRefs.length === 0) {
            try {
                const client = await tgManager.getClient(req.user);
                tgManager.pauseTimer(req.user.id);
                const releaseDownloadSlot = await tgManager.acquireDownloadSlot(req.user.id);
                try {
                    // mtcute deleteMessagesById
                    await client.deleteMessagesById(parseInt(file.channel_id), [parseInt(file.telegram_message_id)], { revoke: true });
                    console.log(`🗑️ Deleted message ${file.telegram_message_id} from Telegram`);
                } finally {
                    tgManager.resumeTimer(req.user.id);
                    releaseDownloadSlot();
                }
            } catch (tgErr) {
                console.error('Telegram delete error:', tgErr.message);
            }
        }

        const [result] = await pool.execute('DELETE FROM uploaded_files WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
        if (result.affectedRows === 0) return res.status(404).json({ error: 'File not found' });
        res.json({ success: true, message: 'File deleted from Telegram and database' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── MOVE FILE (drag & drop into a folder, or cut+paste) ─────────────────────

router.put('/files/:id/move', authenticateUser, async (req, res) => {
    try {
        const folderId = req.body.folderId || null;
        if (folderId) {
            const [folders] = await pool.execute('SELECT id FROM folders WHERE id = ? AND user_id = ?', [folderId, req.user.id]);
            if (folders.length === 0) return res.status(404).json({ error: 'Target folder not found' });
        }
        const [result] = await pool.execute(
            'UPDATE uploaded_files SET folder_id = ? WHERE id = ? AND user_id = ?',
            [folderId, req.params.id, req.user.id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: 'File not found' });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── COPY FILE (copy+paste) ───────────────────────────────────────────────────
// The copy shares the same underlying Telegram message rather than re-uploading —
// cheap and instant, at the cost of both entries pointing at one file (handled in
// DELETE above, which only removes the Telegram message once the last entry referencing
// it is deleted).

router.post('/files/:id/copy', authenticateUser, async (req, res) => {
    try {
        const folderId = req.body.folderId || null;
        if (folderId) {
            const [folders] = await pool.execute('SELECT id FROM folders WHERE id = ? AND user_id = ?', [folderId, req.user.id]);
            if (folders.length === 0) return res.status(404).json({ error: 'Target folder not found' });
        }
        const [files] = await pool.execute('SELECT * FROM uploaded_files WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
        if (files.length === 0) return res.status(404).json({ error: 'File not found' });

        const src = files[0];
        const newId = uuidv4();
        await pool.execute(
            `INSERT INTO uploaded_files
             (id, user_id, original_name, file_size, mime_type, telegram_message_id, channel_id, folder_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
            [newId, req.user.id, src.original_name, src.file_size, src.mime_type, src.telegram_message_id, src.channel_id, folderId]
        );
        res.json({
            success: true,
            file: { id: newId, original_name: src.original_name, file_size: src.file_size, mime_type: src.mime_type, telegram_message_id: src.telegram_message_id, channel_id: src.channel_id, folder_id: folderId },
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── SYNC CHANNELS FROM TELEGRAM ─────────────────────────────────────────
router.post('/sync-channels', authenticateUser, async (req, res) => {
    // A dialog sync can iterate hundreds of dialogs and take a while — sharing the
    // per-user Telegram connection with an in-progress download/view without going
    // through the same queue lets their requests interleave and stall each other.
    let releaseDownloadSlot = null;
    try {
        const user = req.user;
        const client = await tgManager.getClient(user);
        tgManager.pauseTimer(user.id);
        releaseDownloadSlot = await tgManager.acquireDownloadSlot(user.id);

        const channels = [];
        let count = 0;

        for await (const dialog of client.iterDialogs({ limit: 500 })) {
            count++;
            if (count % 100 === 0) await new Promise(r => setTimeout(r, 1000));

            const peer = dialog.peer;
            if (!peer) continue;
            if (peer.type === 'user') continue;

            const title = peer.title || '';
            if (!title) continue;

            const id = peer.id?.toString();
            if (!id) continue;

            // Right here in peer — no extra API call needed
            if (!peer.isCreator && !peer.isAdmin) continue;

            const username = peer.username || null;
            channels.push({ id, title, username });

            const [existing] = await pool.execute(
                'SELECT id FROM user_channels WHERE user_id = ? AND channel_id = ?',
                [user.id, id]
            );
            if (existing.length === 0) {
                await pool.execute(
                    `INSERT INTO user_channels (id, user_id, channel_id, channel_username, channel_title, access_hash)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                    [uuidv4(), user.id, id, username, title, null]
                );
            }
        }

        res.json({ success: true, synced: channels.length, channels });
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        tgManager.resumeTimer(req.user.id);
        releaseDownloadSlot?.();
    }
});

// ─── GET CHANNELS FROM DB ─────────────────────────────────────────────────
router.get('/channels', authenticateUser, async (req, res) => {
    try {
        const [channels] = await pool.execute(
            `SELECT channel_id, channel_title, channel_username FROM user_channels WHERE user_id = ? AND is_active = TRUE`,
            [req.user.id]
        );
        res.json({ success: true, channels });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── FOLDERS ─────────────────────────────────────────────────────────────────

router.get('/folders', authenticateUser, async (req, res) => {
    const parentId = req.query.parent_id === 'null' ? null : req.query.parent_id || null;
    const [folders] = await pool.execute(
        'SELECT * FROM folders WHERE user_id = ? AND parent_id ' + (parentId ? '= ?' : 'IS NULL') + ' ORDER BY name',
        parentId ? [req.user.id, parentId] : [req.user.id]
    );
    res.json({ success: true, folders });
});

router.post('/folders', authenticateUser, async (req, res) => {
    const { name, parent_id } = req.body;
    const id = uuidv4();
    await pool.execute('INSERT INTO folders (id, user_id, name, parent_id) VALUES (?, ?, ?, ?)', [id, req.user.id, name, parent_id || null]);
    res.json({ success: true, folder: { id, name, parent_id } });
});

router.delete('/folders/:id', authenticateUser, async (req, res) => {
    await pool.execute('DELETE FROM folders WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    res.json({ success: true });
});

router.get('/folders/path/:id', authenticateUser, async (req, res) => {
    const path = [];
    let currentId = req.params.id;
    while (currentId) {
        const [rows] = await pool.execute('SELECT * FROM folders WHERE id = ?', [currentId]);
        if (rows.length === 0) break;
        path.unshift(rows[0]);
        currentId = rows[0].parent_id;
    }
    res.json({ success: true, path });
});

// ─── RENAME FILE ─────────────────────────────────────────────────────────────

router.put('/files/:id/rename', authenticateUser, async (req, res) => {
    try {
        const { newName } = req.body;
        if (!newName?.trim()) return res.status(400).json({ error: 'New name required' });
        const [result] = await pool.execute(
            'UPDATE uploaded_files SET original_name = ? WHERE id = ? AND user_id = ?',
            [newName.trim(), req.params.id, req.user.id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: 'File not found' });
        res.json({ success: true, message: 'File renamed' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── RENAME FOLDER ───────────────────────────────────────────────────────────

router.put('/folders/:id/rename', authenticateUser, async (req, res) => {
    try {
        const { newName } = req.body;
        if (!newName?.trim()) return res.status(400).json({ error: 'New name required' });
        const [result] = await pool.execute(
            'UPDATE folders SET name = ? WHERE id = ? AND user_id = ?',
            [newName.trim(), req.params.id, req.user.id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Folder not found' });
        res.json({ success: true, message: 'Folder renamed' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;