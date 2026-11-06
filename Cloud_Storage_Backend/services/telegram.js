// Shared plumbing for every route that talks to Telegram.
const tgManager = require('../utils/telegramClientManager');

// Telegram sessions don't die from the 2FA password changing, but they do from the
// user revoking/terminating them on Telegram's own side — which often happens right
// around a password change. Flagging it lets the frontend send the user to
// /reconnect-telegram instead of just showing a generic failure forever.
const DEAD_SESSION_PATTERN = /AUTH_KEY_UNREGISTERED|AUTH_KEY_INVALID|SESSION_REVOKED|USER_DEACTIVATED/;

// Shared failure path: a revoked session is marked dead so retries fail fast (reconnecting
// can't fix a revoked auth key, and repeated failed auth is what gets Telegram to terminate
// every session on the account); any other failure after the client was reached drops the
// cached, possibly wedged, connection so the next request starts fresh.
// Returns whether the session was revoked.
function handleTelegramFailure(user, err, { operationStarted }) {
    const sessionRevoked = Boolean(err.sessionRevoked) || DEAD_SESSION_PATTERN.test(err.message || '');
    if (sessionRevoked) {
        tgManager.markSessionDead(user.id, user.telegram_session);
    } else if (operationStarted) {
        tgManager.forceReconnect(user.id);
    }
    return sessionRevoked;
}

// Extra fields for sendError(): tells the UI to prompt a Telegram reconnect.
function revokedExtra(sessionRevoked) {
    return sessionRevoked
        ? { sessionRevoked, error: 'Telegram session expired — reconnect required' }
        : { sessionRevoked };
}

// Runs fn(client) while holding the user's Telegram connection exclusively:
//   - the idle-disconnect timer is paused so the client can't be closed mid-operation, and
//   - the per-user queue slot is held so requests on the shared connection don't interleave
//     (interleaved raw file-part requests can trigger a session reset that kills whichever
//     one was still pending).
// Everything is released on the way out, success or failure. If fn (or connecting) throws,
// the error gets `tgOperationStarted` so callers can pass it to handleTelegramFailure.
// (Only used for short operations; streaming transfers manage their own slot lifetime.)
async function runTelegramOperation(user, fn) {
    let started = false;
    let releaseSlot = null;
    try {
        const client = await tgManager.getClient(user);
        started = true;
        tgManager.pauseTimer(user.id);
        releaseSlot = await tgManager.acquireDownloadSlot(user.id);
        return await fn(client);
    } catch (err) {
        err.tgOperationStarted = started;
        throw err;
    } finally {
        // Only undo a pause we actually made — resuming without a matching pause would
        // decrement the busy-count of some other in-flight operation.
        if (started) tgManager.resumeTimer(user.id);
        releaseSlot?.();
    }
}

module.exports = { DEAD_SESSION_PATTERN, handleTelegramFailure, revokedExtra, runTelegramOperation };
