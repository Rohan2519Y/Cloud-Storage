// In-memory fixed-window rate limiter.
//
// Each rateLimit() call gets its own isolated store, so different routes never silently
// share a request budget just because they're both rate-limited — that bug once meant
// loading thumbnails ate into a separate download quota.
//
// Keying: authenticated requests are limited per *user id* (so users behind one NAT or
// proxy don't throttle each other, and a user can't dodge limits by changing IP);
// unauthenticated ones fall back to req.ip. req.ip is only the real client address when
// Express's `trust proxy` is configured for the hosting setup — see app.js.
//
// State lives in this process, which matches the rest of the app (single instance).
// Putting a second instance behind a load balancer would require a shared store.

const stores = new Set();

// One sweeper for all limiters (previously each rateLimit() call leaked its own interval).
const sweeper = setInterval(() => {
    const now = Date.now();
    for (const store of stores) {
        for (const [k, v] of store) if (now > v.resetAt) store.delete(k);
    }
}, 5 * 60 * 1000);
sweeper.unref();

function rateLimit(maxRequests, windowMs, { keyFn } = {}) {
    const store = new Map();
    stores.add(store);

    return (req, res, next) => {
        const key = keyFn ? keyFn(req) : (req.user?.id ? `u:${req.user.id}` : `ip:${req.ip}`);
        const now = Date.now();
        let entry = store.get(key);
        if (!entry || now > entry.resetAt) {
            entry = { count: 0, resetAt: now + windowMs };
            store.set(key, entry);
        }
        entry.count++;
        if (entry.count > maxRequests) {
            res.setHeader('Retry-After', Math.max(1, Math.ceil((entry.resetAt - now) / 1000)));
            return res.status(429).json({ error: 'Too many requests. Please slow down.' });
        }
        next();
    };
}

module.exports = { rateLimit };
