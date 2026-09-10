// Each call gets its own isolated store, so different routes never silently share
// a request budget just because they're both rate-limited — that bug once meant
// loading thumbnails ate into a separate download quota.
function rateLimit(maxRequests, windowMs) {
    const store = new Map();
    setInterval(() => {
        const now = Date.now();
        for (const [k, v] of store) if (now > v.resetAt) store.delete(k);
    }, 5 * 60 * 1000);

    return (req, res, next) => {
        const key = req.ip;
        const now = Date.now();
        const entry = store.get(key) || { count: 0, resetAt: now + windowMs };
        if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + windowMs; }
        entry.count++;
        store.set(key, entry);
        if (entry.count > maxRequests) return res.status(429).json({ error: 'Too many requests. Please slow down.' });
        next();
    };
}

module.exports = { rateLimit };
