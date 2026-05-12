const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const MAX_CACHED_CLIENTS = 4;          // safe limit for 512MB RAM
const CLIENT_IDLE_TIMEOUT = 5 * 60 * 1000; // disconnect after 5min idle

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
            // Reset idle timer
            clearTimeout(entry.timer);
            entry.timer = this._idleTimer(userId, entry.client);
            entry.lastUsed = Date.now();
            return entry.client;
        }

        // Evict oldest client if at capacity
        if (this.clients.size >= MAX_CACHED_CLIENTS) {
            await this._evictOldest();
        }

        // Create new client
        const client = new TelegramClient(
            new StringSession(user.telegram_session),
            parseInt(user.telegram_api_id),
            user.telegram_api_hash,
            { connectionRetries: 3, timeout: 30 }
        );

        await client.connect();
        console.log(`📡 Telegram client connected for user ${userId}`);

        const entry = {
            client,
            lastUsed: Date.now(),
            timer: this._idleTimer(userId, client),
        };

        this.clients.set(userId, entry);
        return client;
    }

    _idleTimer(userId, client) {
        return setTimeout(async () => {
            try {
                await client.disconnect();
                console.log(`💤 Telegram client idle-disconnected for user ${userId}`);
            } catch (_) {}
            this.clients.delete(userId);
        }, CLIENT_IDLE_TIMEOUT);
    }

    async _evictOldest() {
        let oldestId = null;
        let oldestTime = Infinity;

        for (const [userId, entry] of this.clients) {
            if (entry.lastUsed < oldestTime) {
                oldestTime = entry.lastUsed;
                oldestId = userId;
            }
        }

        if (oldestId) {
            const entry = this.clients.get(oldestId);
            clearTimeout(entry.timer);
            try { await entry.client.disconnect(); } catch (_) {}
            this.clients.delete(oldestId);
            console.log(`🗑️ Evicted Telegram client for user ${oldestId}`);
        }
    }

    async disconnectAll() {
        for (const [userId, entry] of this.clients) {
            clearTimeout(entry.timer);
            try { await entry.client.disconnect(); } catch (_) {}
        }
        this.clients.clear();
    }
}

module.exports = new TelegramClientManager();