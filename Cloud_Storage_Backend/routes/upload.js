// Upload pipeline: browser → this server → Telegram, streamed (never buffered whole), plus the
// progress stream and cancel endpoints that go with it.
const express = require('express');
const busboy = require('busboy');
const { Readable } = require('stream');
const { InputMedia } = require('@mtcute/node');
const tgManager = require('../utils/telegramClientManager');
const { rateLimit } = require('../utils/rateLimit');
const { requireUser, requireTelegram } = require('../utils/authMiddleware');
const { HttpError, sendError } = require('../utils/httpErrors');
const { handleTelegramFailure, revokedExtra } = require('../services/telegram');
const files = require('../services/fileService');
const folders = require('../services/folderService');
const {
    progress: uploadProgressMap,
    cancelled: uploadCancelMap,
    key: uploadKey,
    isValidUploadId,
    tryStartUpload,
    finishUpload,
    getActiveUploads,
    MAX_CONCURRENT_UPLOADS,
} = require('../services/uploadProgress');

const router = express.Router();

// ─── SSE PROGRESS ────────────────────────────────────────────────────────────
// Authenticated with the normal Authorization header — the browser client reads this
// stream with fetch() rather than EventSource precisely so the JWT never has to be put
// in a URL (where it would land in logs and history).

router.get('/upload-progress/:uploadId', requireUser, (req, res) => {
    if (!isValidUploadId(req.params.uploadId)) return res.status(400).json({ error: 'Invalid upload id' });
    const key = uploadKey(req.user.id, req.params.uploadId);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Pre-seed so it's never undefined when the interval fires — but don't clobber
    // progress the upload route already recorded before this stream connected.
    if (!uploadProgressMap.has(key)) uploadProgressMap.set(key, 0);
    res.write(`data: ${JSON.stringify({ progress: uploadProgressMap.get(key) })}\n\n`);

    const interval = setInterval(() => {
        const progress = uploadProgressMap.get(key) ?? 0;
        res.write(`data: ${JSON.stringify({ progress })}\n\n`);
        if (progress >= 100) {
            clearInterval(interval);
            uploadProgressMap.delete(key);
            res.end();
        }
    }, 150);

    req.on('close', () => {
        clearInterval(interval);
        uploadProgressMap.delete(key);
    });
});

// ─── CANCEL ──────────────────────────────────────────────────────────────────

router.post('/upload-cancel/:uploadId', requireUser, rateLimit(30, 60 * 1000), (req, res) => {
    if (!isValidUploadId(req.params.uploadId)) return res.status(400).json({ error: 'Invalid upload id' });
    const key = uploadKey(req.user.id, req.params.uploadId);
    uploadCancelMap.set(key, true);
    uploadProgressMap.delete(key);
    res.json({ success: true });
});
// ─── UPLOAD ──────────────────────────────────────────────────────────────────

router.post('/upload',
    requireTelegram,
    rateLimit(10, 60 * 1000),
    async (req, res) => {

        if (!tryStartUpload()) {
            return res.status(429).json({
                error: `Server busy (${getActiveUploads()}/${MAX_CONCURRENT_UPLOADS} uploads active). Try again shortly.`
            });
        }
        const user = req.user;
        // Acquired once the upload actually starts touching Telegram (inside the
        // busboy 'file' handler below) and released in the outer finally, so an
        // in-progress upload can't interleave its requests with a concurrent
        // download/view on the same shared connection.
        let releaseDownloadSlot = null;
        // Only true once getClient() actually returned a client — mirrors /download
        // and /view, so a failure before ever reaching Telegram (bad request body, DB
        // error, etc.) doesn't needlessly force-reconnect a perfectly fine client.
        let tgOperationStarted = false;
        let progressKey = null;

        try {
            const channelId = req.query.channelId || user.default_group_id;
            const uploadId = req.query.uploadId || null;
            const folderId = req.query.folderId || null;

            if (!channelId || !/^-?\d{1,20}$/.test(String(channelId))) {
                return res.status(400).json({ error: 'No channel specified' });
            }
            if (uploadId !== null && !isValidUploadId(uploadId)) {
                return res.status(400).json({ error: 'Invalid upload id' });
            }
            progressKey = uploadId ? uploadKey(user.id, uploadId) : null;

            if (folderId && !(await folders.belongsToUser(user.id, folderId))) {
                return res.status(404).json({ error: 'Target folder not found' });
            }

            // FIX: Signal immediately that request reached the server
            if (progressKey) uploadProgressMap.set(progressKey, 1);

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
                        if (progressKey) uploadProgressMap.set(progressKey, 3);

                        const client = await tgManager.getClient(user);
                        tgOperationStarted = true;
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
                            if (uploadCancelMap.get(progressKey)) {
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
                                if (progressKey) uploadProgressMap.set(progressKey, p);
                            }
                        });

                        fileStream.on('end', () => {
                            trackingStream.push(null);
                            fileSize = received;
                            // FIX: Explicitly land at 30% when receive is done
                            // so the UI doesn't stall while Telegram upload begins
                            if (progressKey) uploadProgressMap.set(progressKey, 30);
                        });

                        fileStream.on('error', (err) => trackingStream.destroy(err));
                        fileStream.on('limit', () => reject(new HttpError(413, 'File exceeds 2GB limit')));

                        const uploadedFile = await client.uploadFile({
                            file: trackingStream,
                            fileName,
                            fileSize: estimatedFileSize || undefined,
                            fileMime: mimeType,
                            progressCallback: (uploaded, total) => {
                                if (uploadCancelMap.get(progressKey)) {
                                    throw new Error('UPLOAD_CANCELLED');
                                }
                                // FIX: Telegram phase = 30–99%
                                const p = total > 0
                                    ? Math.round(30 + (uploaded / total) * 69)
                                    : Math.min(Math.round(30 + (uploaded / (estimatedFileSize || uploaded)) * 69), 99);
                                if (progressKey) uploadProgressMap.set(progressKey, Math.min(p, 99));
                                process.stdout.write(`\r📤 Telegram: ${total > 0 ? Math.round(uploaded / total * 100) : '?'}%`);
                            },
                        });

                        console.log(`\n📦 Sending message to channel...`);

                        const result = await client.sendMedia(chatId, InputMedia.document(uploadedFile, {
                            caption: `Uploaded by ${user.first_name || ''} ${user.last_name || ''}`.trim(),
                            fileName,
                        }));

                        console.log(`✅ Done — message ID ${result.id}`);
                        if (progressKey) uploadProgressMap.set(progressKey, 100);
                        resolve(result);

                    } catch (err) { reject(err); }
                });

                bb.on('error', reject);
                bb.on('finish', () => {
                    if (!fileName) reject(new HttpError(400, 'No file field in request'));
                });
            });

            req.pipe(bb);

            const result = await uploadPromise;

            const fileId = await files.insert(user.id, {
                name: fileName, size: fileSize, mimeType, messageId: result.id, channelId, folderId,
            });

            res.json({
                success: true,
                file: { id: fileId, name: fileName, size: fileSize, messageId: result.id, channelId }
            });

        } catch (err) {
            const wasCancelled = err.message === 'UPLOAD_CANCELLED' || (progressKey && uploadCancelMap.get(progressKey));

            if (wasCancelled) {
                console.log(`🚫 Upload cancelled: ${req.query.uploadId}`);
                if (!res.headersSent) res.status(499).json({ error: 'Upload cancelled' });
            } else {
                // See the matching comments on /download and /view: a revoked session
                // must be marked dead here too, or every retried upload keeps rebuilding
                // a connection from the same dead auth key — the exact hammering pattern
                // that gets an account's sessions (including other devices) terminated.
                const sessionRevoked = handleTelegramFailure(user, err, { operationStarted: tgOperationStarted });
                sendError(res, err, 'Upload error', revokedExtra(sessionRevoked));
            }

            if (progressKey) {
                uploadProgressMap.delete(progressKey);
                uploadCancelMap.delete(progressKey);
            }

        } finally {
            finishUpload();
            tgManager.resumeTimer(user.id);
            releaseDownloadSlot?.();
        }
    }
);

module.exports = router;
