const { TelegramClient } = require('@mtcute/node');
const { MemoryStorage } = require('@mtcute/core');
const MAX_CACHED_CLIENTS = 4;
const CLIENT_IDLE_TIMEOUT = 5 * 60 * 1000;
// Hard ceiling on how long one request may hold a user's download slot. Route-level
// timeouts should always release well before this, but this is the backstop: without
// it, any caller that fails to release (a bug, an edge case, a crash mid-request)
// would permanently wedge every future download/view for that user until the server
// process itself restarts — this guarantees the queue always recovers on its own.
const MAX_DOWNLOAD_SLOT_HOLD = 10 * 60 * 1000;
const CONNECT_TIMEOUT = 20 * 1000;

function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Thrown by getClient() when we already know this user's stored session is dead.
// Routes surface it as `sessionRevoked` so the UI can say "reconnect Telegram"
// instead of showing a generic failure.
class SessionRevokedError extends Error {
    constructor() {
        super('Telegram session revoked — reconnect required');
        this.sessionRevoked = true;
    }
}

class TelegramClientManager {
    constructor() {
        this.clients = new Map();
        this.downloadQueues = new Map(); // userId -> tail promise of the serialized download queue
        this.pendingConnections = new Map(); // userId -> in-flight getClient() creation promise
        // userId -> the exact session string Telegram told us is revoked. Storing the
        // string (rather than a bare flag) makes this self-healing: once the user
        // reconnects, the DB holds a different string, so the check below stops
        // matching and normal operation resumes with no explicit reset needed.
        this.deadSessions = new Map();
    }

    // A revoked session can never be revived by reconnecting — the auth key itself is
    // gone. Without this, every request rebuilt a fresh connection from the same dead
    // session string, which Telegram then stalls rather than rejecting, so each request
    // burned a full 45s route timeout AND a new connection. Queued thumbnails turned
    // that into minutes of hanging plus a burst of repeated auth attempts from one IP —
    // exactly the pattern that gets an account flagged, making the problem stickier.
    markSessionDead(userId, sessionString) {
        if (!sessionString) return;
        if (this.deadSessions.get(userId) === sessionString) return;
        this.deadSessions.set(userId, sessionString);
        console.warn(`🚫 Marking Telegram session dead for user ${userId} — further requests fail fast until reconnect`);
        this.forceReconnect(userId);
    }

    // Telegram file downloads for one user share a single MTProto connection.
    // Running downloadAsNodeStream for two files at once on that connection makes
    // their raw file-part requests interleave, which can trigger a session reset
    // that kills whichever download's requests were still pending — so only the
    // most recently started one survives. Serializing per user avoids that.
    // Resolves once it's this caller's turn; the caller must invoke the returned
    // function exactly once, when it's done with the client, to release its turn.
    async acquireDownloadSlot(userId) {
        const previous = this.downloadQueues.get(userId) || Promise.resolve();
        let release;
        const current = new Promise((resolve) => { release = resolve; });
        this.downloadQueues.set(userId, previous.then(() => current));
        await previous;

        let released = false;
        const safetyTimer = setTimeout(() => {
            console.warn(`⚠️ Download slot for user ${userId} force-released after exceeding max hold time — the caller never released it`);
            released = true;
            release();
        }, MAX_DOWNLOAD_SLOT_HOLD);

        return () => {
            if (released) return;
            released = true;
            clearTimeout(safetyTimer);
            release();
        };
    }

    async getClient(user) {
        const userId = user.id;

        // Fail fast on a session we already know is revoked, rather than opening yet
        // another connection that Telegram will just stall. Matching on the session
        // string means a reconnect (which writes a new one to the DB) clears this by
        // itself.
        if (this.deadSessions.get(userId) === user.telegram_session) {
            throw new SessionRevokedError();
        }

        // Return cached client if available
        if (this.clients.has(userId)) {
            const entry = this.clients.get(userId);
            entry.lastUsed = Date.now();
            this._rearm(userId, entry);
            return entry.client;
        }

        // Several requests can land before any client is cached (e.g. a page's
        // thumbnails all firing at once right after a server restart). Without this,
        // each one races to create and connect() its own TelegramClient with the same
        // session concurrently — which can make one of those handshakes hang forever
        // with no timeout protection. Collapse concurrent callers onto one creation.
        if (this.pendingConnections.has(userId)) {
            return this.pendingConnections.get(userId);
        }

        const creation = this._createClient(user).finally(() => {
            this.pendingConnections.delete(userId);
        });
        this.pendingConnections.set(userId, creation);
        return creation;
    }

    async _createClient(user) {
        const userId = user.id;

        // Evict oldest if at capacity
        if (this.clients.size >= MAX_CACHED_CLIENTS) {
            await this._evictOldest();
        }

        // Create mtcute client using saved session string
        const client = new TelegramClient({
            apiId: parseInt(user.telegram_api_id),
            apiHash: user.telegram_api_hash,
            storage: new MemoryStorage(),
        });

        // Import the saved gramjs-compatible session
        // mtcute uses its own session format — we store it as a string in DB same way
        await withTimeout(client.importSession(user.telegram_session), CONNECT_TIMEOUT, 'importSession');
        await withTimeout(client.connect(), CONNECT_TIMEOUT, 'connect');

        console.log(`📡 mtcute client connected for user ${userId}`);

        const entry = {
            client,
            lastUsed: Date.now(),
            timer: null,
            activeOps: 0, // number of in-flight long-running operations (uploads/downloads) holding this client busy
        };

        this.clients.set(userId, entry);
        this._rearm(userId, entry);
        return client;
    }

    // (Re)schedules the idle-disconnect timer, unless an operation currently holds
    // the client busy — a short-lived request (e.g. thumbnail /view) must never
    // restart the countdown out from under a long-running upload/download.
    _rearm(userId, entry) {
        clearTimeout(entry.timer);
        entry.timer = entry.activeOps > 0 ? null : this._idleTimer(userId, entry.client);
    }

    _idleTimer(userId, client) {
        return setTimeout(async () => {
            try {
                await client.disconnect();
                console.log(`💤 mtcute client idle-disconnected for user ${userId}`);
            } catch (_) { }
            this.clients.delete(userId);
        }, CLIENT_IDLE_TIMEOUT);
    }

    async _evictOldest() {
        let oldestId = null;
        let oldestTime = Infinity;

        for (const [userId, entry] of this.clients) {
            if (entry.activeOps > 0) continue; // never evict a client mid-transfer
            if (entry.lastUsed < oldestTime) {
                oldestTime = entry.lastUsed;
                oldestId = userId;
            }
        }

        if (oldestId) {
            const entry = this.clients.get(oldestId);
            clearTimeout(entry.timer);
            try { await entry.client.disconnect(); } catch (_) { }
            this.clients.delete(oldestId);
            console.log(`🗑️ Evicted mtcute client for user ${oldestId}`);
        }
    }

    // Forcibly drops a client regardless of activeOps — used when an operation on it
    // hung or errored out in a way that suggests the underlying connection is wedged,
    // so the next request gets a fresh connection instead of piling up behind a dead one.
    forceReconnect(userId) {
        const entry = this.clients.get(userId);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.clients.delete(userId);
        // Not async / not awaited: disconnect() on a wedged connection can itself
        // hang waiting on network I/O that will never arrive. The entry is already
        // out of the cache, so no future getClient() call depends on this finishing.
        // Callers used to `await` this before releasing their download-queue slot and
        // responding — if disconnect() hung, that slot (and the in-flight HTTP
        // response) would be stuck until the 10-minute safety valve, effectively
        // wedging every queued request behind it until a manual restart.
        entry.client.disconnect()
            .then(() => console.log(`♻️ mtcute client force-reconnected for user ${userId}`))
            .catch(() => {});
    }

    async disconnectAll() {
        for (const [, entry] of this.clients) {
            clearTimeout(entry.timer);
            try { await entry.client.disconnect(); } catch (_) { }
        }
        this.clients.clear();
    }

    // Call before starting a long-running operation (upload/download stream) so
    // no concurrent request can idle-disconnect the client out from under it.
    // Counter-based: safe for multiple overlapping long operations on the same client.
    pauseTimer(userId) {
        const entry = this.clients.get(userId);
        if (!entry) return;
        entry.activeOps++;
        clearTimeout(entry.timer);
        entry.timer = null;
    }

    resumeTimer(userId) {
        const entry = this.clients.get(userId);
        if (!entry) return;
        entry.activeOps = Math.max(0, entry.activeOps - 1);
        entry.lastUsed = Date.now();
        this._rearm(userId, entry);
    }
}

module.exports = new TelegramClientManager();
