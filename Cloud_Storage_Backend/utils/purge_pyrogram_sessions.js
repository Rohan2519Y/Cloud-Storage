require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { TelegramClient } = require('@mtcute/node');
const { MemoryStorage } = require('@mtcute/core');
const pool = require('./database');
const { withTimeout } = require('./withTimeout');

const TERMINATE = process.argv.includes('--terminate');
const CONNECT_TIMEOUT = 20 * 1000;
const API_CALL_TIMEOUT = 15 * 1000;
const DELAY_BETWEEN_USERS = 2000;

// The stored session strings predate the mtcute rewrite: they're gramjs/Telethon
// format ("1" + base64 of dc_id/address/port/auth_key). This mtcute build only reads
// its own version-3 strings, so the old key (which may still be live on Telegram's
// side) must be re-encoded before import.
function convertLegacySession(sessionString) {
    const payload = Buffer.from(sessionString.slice(1), 'base64');
    if (payload.length < 3 + 2) throw new Error('legacy session string too short');
    const dcId = payload[0];
    const addressLength = payload.readUInt16BE(1);
    const address = payload.subarray(3, 3 + addressLength).toString('utf8');
    const port = payload.readUInt16BE(3 + addressLength);
    const authKey = payload.subarray(3 + addressLength + 2);
    if (authKey.length !== 256) throw new Error(`legacy session auth key has unexpected length ${authKey.length}`);
    console.log(`   🔁 Converting legacy session: dc ${dcId}, ${address}:${port}, key ${authKey.length} bytes`);
    const main = { id: dcId, ipAddress: address, port, ipv6: false, mediaOnly: false, testMode: false };
    return { version: 3, primaryDcs: { main, media: main }, self: null, authKey };
}

function norm(v) {
    if (v === undefined || v === null) return '';
    return String(v);
}

function isPyrogramSession(a) {
    const haystack = [
        a.deviceModel, a.device_model,
        a.appName, a.app_name,
        a.appVersion, a.app_version,
        a.platform,
        a.systemVersion, a.system_version,
    ].map(norm).join(' | ').toLowerCase();
    return haystack.includes('pyrogram') || haystack.includes('cpython');
}

async function listAndPurge(user) {
    const client = new TelegramClient({
        apiId: parseInt(user.telegram_api_id),
        apiHash: user.telegram_api_hash,
        storage: new MemoryStorage(),
    });

    let ids = [];
    const sessionString = user.telegram_session;
    if (!sessionString) {
        console.log(`\n⚠️ No session in DB for user ${user.id} — skipping.`);
        return;
    }
    let session = sessionString;
    if (sessionString.startsWith('1')) session = convertLegacySession(sessionString);
    try {
        await withTimeout(client.importSession(session), CONNECT_TIMEOUT, 'importSession');
        await withTimeout(client.connect(), CONNECT_TIMEOUT, 'connect');
        let meInfo = '';
        try {
            const me = await withTimeout(client.getMe(), API_CALL_TIMEOUT, 'getMe');
            meInfo = ` (${me.username || me.firstName || me.lastName || ''} id ${me.id})`;
        } catch (_) { }
        console.log(`\n📡 Connected as DB user ${user.id} (${user.phone_number || 'no phone'})${meInfo}`);

        const res = await withTimeout(client.call({ _: 'account.getAuthorizations' }), API_CALL_TIMEOUT, 'getAuthorizations');
        const authorizations = res.authorizations || [];

        console.log(`   Active sessions on this Telegram account (${authorizations.length}):`);
        for (const a of authorizations) {
            const deviceModel = norm(a.deviceModel || a.device_model);
            const appName = norm(a.appName || a.app_name);
            const appVersion = norm(a.appVersion || a.app_version);
            const platform = norm(a.platform);
            const current = a.current === true;
            const isPy = isPyrogramSession(a);
            console.log(
                `   - [${isPy ? '🚫 PYROGRAM' : current ? '✅ CURRENT' : '   other   '}] "${deviceModel} / ${appName} ${appVersion}" (${platform}, apiId ${a.apiId ?? a.api_id ?? '?'})`
            );
            if (isPy && !current) ids.push(a.hash);
        }
    } catch (err) {
        console.error(`   ⚠️ Could not inspect sessions for DB user ${user.id}: ${err.message}`);
        try { await client.disconnect(); } catch (_) { }
        return;
    }

    if (ids.length === 0) {
        console.log('   No Pyrogram sessions found on this account.');
        try { await client.disconnect(); } catch (_) { }
        return;
    }

    if (!TERMINATE) {
        console.log(`   Would terminate ${ids.length} Pyrogram session(s) — rerun with --terminate to actually kill them.`);
        try { await client.disconnect(); } catch (_) { }
        return;
    }

    for (const hash of ids) {
        try {
            await withTimeout(client.call({ _: 'account.resetAuthorization', hash: BigInt(hash) }), API_CALL_TIMEOUT, 'resetAuthorization');
            console.log(`   ✅ Terminated session hash ${hash}`);
        } catch (err) {
            console.error(`   ⚠️ Failed to terminate hash ${hash}: ${err.message}`);
        }
        await new Promise((r) => setTimeout(r, 1500));
    }

    try { await client.disconnect(); } catch (_) { }
}

(async () => {
    console.log(TERMINATE
        ? '🚨 TERMINATE MODE — will kill detected Pyrogram sessions'
        : '🔍 DRY RUN — listing sessions only, no changes. Add --terminate to kill detected Pyrogram sessions.');

    const [users] = await pool.execute(
        'SELECT id, phone_number, telegram_session, telegram_api_id, telegram_api_hash FROM users WHERE telegram_session IS NOT NULL AND telegram_api_id IS NOT NULL AND telegram_api_hash IS NOT NULL'
    );

    if (users.length === 0) {
        console.log('No DB users with a stored Telegram session — call this on the host where users have linked their Telegram.');
        await pool.end();
        return;
    }

    console.log(`Found ${users.length} user(s) with a stored Telegram session.`);

    for (const user of users) {
        await listAndPurge(user);
        await new Promise((r) => setTimeout(r, DELAY_BETWEEN_USERS));
    }

    await pool.end();
    console.log('\nDone.');
})();