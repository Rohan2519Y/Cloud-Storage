// One-off migration: encrypt Telegram sessions that were stored in plaintext, and
// re-encrypt 2FA passwords written in the old (v1, JWT_SECRET-keyed) format as v2.
//
//   node scripts/encrypt-existing-secrets.js           # dry run — reports, changes nothing
//   node scripts/encrypt-existing-secrets.js --apply   # performs the migration
//
// Safe to re-run (already-migrated rows are skipped). Each UPDATE is compare-and-swap on
// the old value, so a row changed by the live app mid-migration is left alone.
//
// ORDER OF OPERATIONS when deploying:
//   1. Set TELEGRAM_2FA_ENC_KEY (same value everywhere that shares this database).
//   2. Deploy the new code. It reads BOTH plaintext and encrypted sessions, so nothing breaks.
//   3. Run this script with --apply.
// Do NOT run it before step 2: the previously deployed code cannot read encrypted sessions.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const pool = require('../utils/database');
const { assertConfigured, encryptSession, decryptSession, encrypt, decrypt, isEncryptedSession } = require('../utils/crypto');

const APPLY = process.argv.includes('--apply');

(async () => {
    assertConfigured();
    console.log(APPLY ? '🔐 APPLY mode — writing changes' : '🔍 DRY RUN — no changes will be written (add --apply)');

    const [users] = await pool.execute('SELECT id, telegram_session, telegram_2fa_password_enc FROM users');
    const stats = { sessions: 0, twoFA: 0, skipped: 0, failed: 0 };

    for (const u of users) {
        if (u.telegram_session && !isEncryptedSession(u.telegram_session)) {
            const encrypted = encryptSession(u.telegram_session);
            if (decryptSession(encrypted) !== u.telegram_session) throw new Error(`Round-trip check failed for user ${u.id}`);
            console.log(`  session  user ${u.id}: plaintext → v2`);
            if (APPLY) {
                const [r] = await pool.execute(
                    'UPDATE users SET telegram_session = ? WHERE id = ? AND telegram_session = ?',
                    [encrypted, u.id, u.telegram_session]
                );
                if (r.affectedRows !== 1) { console.warn(`  ⚠️ user ${u.id}: row changed during migration, skipped`); stats.skipped++; continue; }
            }
            stats.sessions++;
        }

        if (u.telegram_2fa_password_enc && !isEncryptedSession(u.telegram_2fa_password_enc)) {
            let plain;
            try {
                plain = decrypt(u.telegram_2fa_password_enc);
            } catch (err) {
                console.warn(`  ⚠️ 2FA user ${u.id}: cannot decrypt legacy value (${err.message}); left unchanged`);
                stats.failed++;
                continue;
            }
            const encrypted = encrypt(plain);
            if (decrypt(encrypted) !== plain) throw new Error(`2FA round-trip check failed for user ${u.id}`);
            console.log(`  2fa      user ${u.id}: v1 → v2`);
            if (APPLY) {
                const [r] = await pool.execute(
                    'UPDATE users SET telegram_2fa_password_enc = ? WHERE id = ? AND telegram_2fa_password_enc = ?',
                    [encrypted, u.id, u.telegram_2fa_password_enc]
                );
                if (r.affectedRows !== 1) { console.warn(`  ⚠️ 2FA user ${u.id}: row changed during migration, skipped`); stats.skipped++; continue; }
            }
            stats.twoFA++;
        }
    }

    console.log(`\n${APPLY ? 'Migrated' : 'Would migrate'}: ${stats.sessions} session(s), ${stats.twoFA} 2FA password(s). Skipped: ${stats.skipped}. Failed: ${stats.failed}.`);
    await pool.end();
})().catch((err) => {
    console.error('Migration failed:', err.message);
    process.exit(1);
});
