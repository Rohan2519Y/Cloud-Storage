// utils/telegramClientManager.js — mtcute version
// Drop-in replacement for gramjs telegramClientManager.
// mtcute supports true streaming — RAM per upload ≈ 512KB (one part), not full file size.

const { TelegramClient } = require('@mtcute/node');

const MAX_CACHED_CLIENTS = 4;
const CLIENT_IDLE_TIMEOUT = 5 * 60 * 1000; // 5 min

class TelegramClientManager {
    constructor() {
        // Map<userId, { client, lastUsed, timer }>
        this.clients = new Map();
    }

    async getClient(user) {
        const userId = user.id;

        // Return cached client if available
        if (this.clients.has(userId)) {
            const entry = this.clients.get(userId);
            clearTimeout(entry.timer);
            entry.timer = this._idleTimer(userId, entry.client);
            entry.lastUsed = Date.now();
            return entry.client;
        }

        // Evict oldest if at capacity
        if (this.clients.size >= MAX_CACHED_CLIENTS) {
            await this._evictOldest();
        }

        // Create mtcute client using saved session string
        const client = new TelegramClient({
            apiId:   parseInt(user.telegram_api_id),
            apiHash: user.telegram_api_hash,
            // 'mem' uses in-memory storage — session is loaded from DB string below
            storage: 'mem',
        });

        // Import the saved gramjs-compatible session
        // mtcute uses its own session format — we store it as a string in DB same way
        await client.importSession(user.telegram_session);
        await client.connect();

        console.log(`📡 mtcute client connected for user ${userId}`);

        const entry = {
            client,
            lastUsed: Date.now(),
            timer:    this._idleTimer(userId, client),
        };

        this.clients.set(userId, entry);
        return client;
    }

    _idleTimer(userId, client) {
        return setTimeout(async () => {
            try {
                await client.disconnect();
                console.log(`💤 mtcute client idle-disconnected for user ${userId}`);
            } catch (_) {}
            this.clients.delete(userId);
        }, CLIENT_IDLE_TIMEOUT);
    }

    async _evictOldest() {
        let oldestId   = null;
        let oldestTime = Infinity;

        for (const [userId, entry] of this.clients) {
            if (entry.lastUsed < oldestTime) {
                oldestTime = entry.lastUsed;
                oldestId   = userId;
            }
        }

        if (oldestId) {
            const entry = this.clients.get(oldestId);
            clearTimeout(entry.timer);
            try { await entry.client.disconnect(); } catch (_) {}
            this.clients.delete(oldestId);
            console.log(`🗑️ Evicted mtcute client for user ${oldestId}`);
        }
    }

    async disconnectAll() {
        for (const [, entry] of this.clients) {
            clearTimeout(entry.timer);
            try { await entry.client.disconnect(); } catch (_) {}
        }
        this.clients.clear();
    }
}

module.exports = new TelegramClientManager();