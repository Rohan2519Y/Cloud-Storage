// Channels the user can upload to (the user_channels table).
const { v4: uuidv4 } = require('uuid');
const pool = require('../utils/database');
const { runTelegramOperation } = require('./telegram');

async function listActive(userId) {
    const [channels] = await pool.execute(
        `SELECT channel_id, channel_title, channel_username FROM user_channels WHERE user_id = ? AND is_active = TRUE`,
        [userId]
    );
    return channels;
}

// Pulls the user's dialogs from Telegram and stores the channels/groups they own or
// administer. A sync can iterate hundreds of dialogs, so it runs under runTelegramOperation
// (per-user queue slot) rather than interleaving with an in-progress download/view.
function syncFromTelegram(user) {
    return runTelegramOperation(user, async (client) => {
        const channels = [];
        let count = 0;

        for await (const dialog of client.iterDialogs({ limit: 500 })) {
            count++;
            if (count % 100 === 0) await new Promise((r) => setTimeout(r, 1000));

            const peer = dialog.peer;
            if (!peer) continue;
            if (peer.type === 'user') continue;

            const title = peer.title || '';
            if (!title) continue;

            const id = peer.id?.toString();
            if (!id) continue;

            // Right here in peer — no extra API call needed
            if (!peer.isCreator && !peer.isAdmin) continue;

            channels.push({ id, title, username: peer.username || null });
        }

        // One batched insert instead of a SELECT + INSERT per dialog (up to 500
        // dialogs = up to 1000 round trips otherwise) — the unique (user_id,
        // channel_id) index makes IGNORE the existence check for us.
        if (channels.length > 0) {
            const rows = channels.map((c) => [uuidv4(), user.id, c.id, c.username, c.title]);
            await pool.query(
                `INSERT IGNORE INTO user_channels (id, user_id, channel_id, channel_username, channel_title) VALUES ?`,
                [rows]
            );
        }
        return channels;
    });
}

module.exports = { listActive, syncFromTelegram };
