// Reading files back out of Telegram: the download ticket, the (Range-capable) download stream,
// and inline view / thumbnails. All three share the user's single Telegram connection and
// therefore go through the same per-user queue (see utils/telegramClientManager.js).
const express = require('express');
const { pipeline } = require('stream/promises');
const { Thumbnail } = require('@mtcute/node');
const tgManager = require('../utils/telegramClientManager');
const { withTimeout } = require('../utils/withTimeout');
const { rateLimit } = require('../utils/rateLimit');
const { requireUser, requireTelegram, requireDownloadTicket, signDownloadTicket } = require('../utils/authMiddleware');
const { sendError } = require('../utils/httpErrors');
const { handleTelegramFailure, revokedExtra } = require('../services/telegram');
const files = require('../services/fileService');

const router = express.Router();

// ─── DOWNLOAD TICKET ─────────────────────────────────────────────────────────
// Mints a short-lived, single-file token so the browser can download natively
// (streamed straight to disk, native progress UI) without an Authorization header.

router.get('/download-ticket/:messageId', requireUser, async (req, res) => {
    try {
        const fileRecord = await files.getByMessageId(req.user.id, req.params.messageId);
        if (!fileRecord) return res.status(404).json({ error: 'File not found' });

        res.json({ token: signDownloadTicket(req.user.id, req.params.messageId) });
    } catch (err) {
        sendError(res, err, `${req.method} ${req.path} error`);
    }
});

// ─── DOWNLOAD ────────────────────────────────────────────────────────────────

router.get('/download/:messageId', requireDownloadTicket, rateLimit(60, 60 * 1000), async (req, res) => {
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
    // Same idea if the client disconnects while setup() is still waiting its turn in
    // the queue — no point burning a Telegram round trip finishing setup for a
    // response nobody will receive. (The streaming phase below has its own
    // abortController for cancelling mid-transfer once setup has already succeeded.)
    req.on('close', () => { abandoned = true; });
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
        const fileRecord = await files.getByMessageId(req.user.id, req.params.messageId);
        if (!fileRecord) return { notFound: true };

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
            if (!res.headersSent) res.status(500).json({ error: 'Download failed' });
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
        // A revoked session can't be fixed by reconnecting — it's marked dead so every
        // later request fails instantly. Any other failure once we'd reached the Telegram
        // client suggests the connection itself is wedged, so it's dropped and the next
        // request gets a fresh one instead of piling up behind the same broken client.
        const sessionRevoked = handleTelegramFailure(req.user, err, { operationStarted: tgOperationStarted });
        releaseTgOperation();
        sendError(res, err, 'Download error', revokedExtra(sessionRevoked));
    }
});

// ─── VIEW ─────────────────────────────────────────────────────────────────────

router.get('/view/:messageId', requireTelegram, rateLimit(60, 60 * 1000), async (req, res) => {
    // Thumbnails also pull raw file data over the shared Telegram connection, so they
    // must go through the same per-user queue as /download or they can interleave with
    // an in-progress download and trigger the same session-reset problem.
    let tgOperationStarted = false;
    let releaseDownloadSlot = null;
    let inactivityTimer = null;
    let abortController = null;
    // See the matching comment in /download above: once the outer withTimeout gives
    // up, setup() keeps executing in the background, and if it was still waiting for
    // acquireDownloadSlot at that moment it would otherwise acquire and never
    // release the slot, wedging every request queued behind it for this user.
    let abandoned = false;
    // A folder view can queue up a dozen thumbnail requests at once; if the user
    // navigates away while several are still waiting their turn, the browser aborts
    // the connection but this handler would otherwise keep running to completion for
    // nobody — burning a real Telegram round trip and holding up whatever's still
    // queued behind it. Reuses the same `abandoned` checkpoint above.
    req.once('aborted', () => {
        abandoned = true;
        abortController?.abort();
    });
    const releaseTgOperation = () => {
        const timerWasPaused = tgOperationStarted;
        tgOperationStarted = false;
        if (timerWasPaused) tgManager.resumeTimer(req.user.id);
        // Always release a slot if one arrived late after the outer setup timeout.
        // In that case the earlier cleanup already reset tgOperationStarted, but the
        // queued acquire can still resolve afterward and must not remain locked.
        releaseDownloadSlot?.();
        releaseDownloadSlot = null;
    };

    // Setup has an overall timeout so DB lookup, Telegram connection, queue waiting,
    // and message resolution cannot hang forever. The stream itself instead uses an
    // inactivity timeout, allowing large files to take longer while bytes keep moving.
    const setup = async () => {
        const fileRecord = await files.getByMessageId(req.user.id, req.params.messageId);
        if (!fileRecord) return { notFound: true, message: 'File not found' };

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
            return { notFound: true, message: 'File not found on Telegram' };

        // Grid thumbnails only need Telegram's small pre-generated preview (a few KB),
        // not the full original file. Downloading the whole thing just to render a
        // thumbnail wastes memory and CPU decrypting it — on a memory-capped host that
        // can OOM the process once a few multi-MB images load thumbnails at once.
        const wantsThumbnail = req.query.thumb === '1';
        const thumb = wantsThumbnail
            ? (message.media.getThumbnail?.(Thumbnail.THUMB_320x320_BOX) || message.media.thumbnails?.[0])
            : null;
        const mediaToFetch = thumb || message.media;
        const reportedMediaSize = thumb
            ? (thumb.fileSize || thumb.size || undefined)
            : (fileRecord.file_size || message.media.fileSize || undefined);
        const mediaSize = Number.isFinite(Number(reportedMediaSize)) && Number(reportedMediaSize) > 0
            ? Number(reportedMediaSize)
            : undefined;

        return { client, fileRecord, mediaToFetch, mediaSize, isThumbnail: Boolean(thumb) };
    };

    try {
        // Time out only the setup phase. Once bytes start flowing, large previews are
        // governed by the inactivity watchdog instead of an arbitrary total duration.
        const result = await withTimeout(setup(), 45000, 'view setup');
        if (result.notFound) {
            return res.status(404).json({ error: result.message });
        }
        if (abandoned) {
            throw new Error('view request abandoned during setup');
        }

        const { client, fileRecord, mediaToFetch, mediaSize, isThumbnail } = result;
        abortController = new AbortController();

        const tgStream = client.downloadAsNodeStream(mediaToFetch, {
            fileSize: mediaSize,
            partSize: mediaSize && mediaSize > 5 * 1024 * 1024 ? 512 : undefined,
            abortSignal: abortController.signal,
        });

        res.setHeader('Content-Type', isThumbnail ? 'image/jpeg' : (fileRecord.mime_type || 'application/octet-stream'));
        if (isThumbnail) {
            // A message's thumbnail never changes: let the browser reuse it instead of
            // re-requesting (and re-queuing on the user's Telegram connection) every time.
            res.setHeader('Cache-Control', 'private, max-age=86400');
            res.setHeader('Vary', 'Authorization');
        }
        res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(fileRecord.original_name)}"`);
        if (mediaSize) res.setHeader('Content-Length', mediaSize);

        const INACTIVITY_TIMEOUT = 30000;
        const resetInactivityTimer = () => {
            clearTimeout(inactivityTimer);
            inactivityTimer = setTimeout(() => {
                tgStream.destroy(new Error(`View stalled — no data for ${INACTIVITY_TIMEOUT / 1000}s`));
            }, INACTIVITY_TIMEOUT);
        };
        resetInactivityTimer();
        tgStream.on('data', resetInactivityTimer);

        // Awaiting pipeline keeps the Telegram client and per-user queue slot reserved
        // until the response has actually finished, while applying stream backpressure.
        await pipeline(tgStream, res);
    } catch (err) {
        abandoned = true;
        console.error('View error:', err.message);
        const clientDisconnected = req.aborted
            || err.code === 'ERR_STREAM_PREMATURE_CLOSE'
            || (err.name === 'AbortError' && abortController?.signal.aborted);
        // See the matching comments in /download: a revoked session is marked dead so
        // later requests fail instantly; anything else just gets a fresh connection.
        const sessionRevoked = handleTelegramFailure(req.user, err, { operationStarted: tgOperationStarted && !clientDisconnected });
        if (!res.headersSent && !clientDisconnected) {
            sendError(res, err, 'View error (response)', revokedExtra(sessionRevoked));
        } else if (!clientDisconnected && !res.destroyed) {
            res.destroy(err);
        }
    } finally {
        clearTimeout(inactivityTimer);
        abortController?.abort();
        releaseTgOperation();
    }
});

module.exports = router;
