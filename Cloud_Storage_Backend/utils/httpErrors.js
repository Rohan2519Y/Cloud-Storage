// Central error → HTTP response mapping.
//
// Raw `err.message` must never reach the client: it carries DB error text, SQL, file
// paths and Telegram internals. Handlers log the real error server-side and call
// sendError(), which responds with either
//   - an HttpError's message (only thrown deliberately, with text meant for users),
//   - a friendly message for well-known Telegram failures, or
//   - a generic "Internal server error".

class HttpError extends Error {
    constructor(status, message, extra = {}) {
        super(message);
        this.status = status;
        this.extra = extra;
        this.expose = true;
    }
}

const TELEGRAM_ERRORS = [
    [/PHONE_CODE_INVALID/, 400, 'Invalid verification code.'],
    [/PHONE_CODE_EMPTY/, 400, 'Verification code required.'],
    [/PHONE_CODE_EXPIRED/, 400, 'Verification code expired. Request a new one.'],
    [/PHONE_NUMBER_INVALID/, 400, 'Invalid phone number.'],
    [/PHONE_NUMBER_BANNED/, 403, 'This phone number is banned by Telegram.'],
    [/API_ID_INVALID|API_ID_PUBLISHED_FLOOD/, 400, 'Invalid or unusable Telegram API ID / API hash.'],
    [/PASSWORD_HASH_INVALID/, 400, 'Invalid 2FA password.'],
    [/timed out/i, 504, 'The request timed out. Please try again.'],
];

function mapKnownError(err) {
    if (err instanceof HttpError || err?.expose) {
        return { status: err.status || 400, message: err.message, extra: err.extra || {} };
    }
    const text = `${err?.text || ''} ${err?.message || ''}`;

    const flood = /FLOOD_WAIT_(\d+)/.exec(text);
    if (flood) {
        const seconds = parseInt(flood[1], 10);
        return {
            status: 429,
            message: `Too many attempts. Please wait ${Math.ceil(seconds / 60)} minute(s) and try again.`,
            extra: { retryAfter: seconds },
        };
    }
    for (const [pattern, status, message] of TELEGRAM_ERRORS) {
        if (pattern.test(text)) return { status, message, extra: {} };
    }
    return null;
}

// Logs the real error, responds with a safe one. `extra` is merged into the JSON body
// (e.g. { sessionRevoked }). Safe to call after headers were sent (it then does nothing).
function sendError(res, err, context, extra = {}) {
    console.error(`${context}:`, err?.message || err);
    if (res.headersSent) return;
    const known = mapKnownError(err);
    res.status(known?.status ?? 500).json({
        error: known?.message ?? 'Internal server error',
        ...(known?.extra || {}),
        ...extra,
    });
}

// Express 4 does not catch rejected promises from async handlers; an unhandled
// rejection crashes the process on modern Node. Wrap handlers that have no try/catch.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { HttpError, sendError, asyncHandler, mapKnownError };
