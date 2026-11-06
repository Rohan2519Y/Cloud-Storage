// app.js — production-ready with @mtcute/node
const express = require('express');
const path = require('path');
const logger = require('morgan');
const cors = require('cors');
const helmet = require('helmet');

const { assertConfigured: assertEncryptionConfigured } = require('./utils/crypto');

// Fail the boot (and therefore the deploy) if secrets are missing or weak, rather than
// failing the first user's login.
assertEncryptionConfigured();
if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET must be set');
}
if (process.env.JWT_SECRET.length < 32) {
    // Not fatal (rotating it logs every user out), but a short HS256 secret can be brute-forced.
    console.warn('⚠️  JWT_SECRET is shorter than 32 characters — rotate it to a random 48+ character string.');
}
if (process.env.JWT_SECRET === process.env.TELEGRAM_2FA_ENC_KEY) {
    throw new Error('TELEGRAM_2FA_ENC_KEY must be different from JWT_SECRET');
}

const authRoutes = require('./routes/auth');
const uploadRouter = require('./routes/upload');
const tgManager = require('./utils/telegramClientManager');

const app = express();

// ─── Proxy trust (req.ip) ───────────────────────────────────────────────────
// Behind Render's load balancer every connection arrives from the proxy, so without this
// req.ip is the proxy's address for *all* users — one shared rate-limit bucket (one person
// can lock everyone out) — and with too much trust a client could spoof X-Forwarded-For
// to dodge limits. TRUST_PROXY = number of proxy hops in front of the app ("1" on Render),
// or "false" to disable. Defaults: 1 in production, off locally.
function parseTrustProxy(value, isProd) {
    if (value === undefined || value === '') return isProd ? 1 : false;
    if (value === 'false') return false;
    if (value === 'true') throw new Error('TRUST_PROXY=true trusts every X-Forwarded-For hop and lets clients spoof their IP; use a hop count such as 1');
    const hops = Number(value);
    if (!Number.isInteger(hops) || hops < 0) throw new Error('TRUST_PROXY must be a non-negative integer or "false"');
    return hops;
}
app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY, process.env.NODE_ENV === 'production'));

// ─── Security headers ────────────────────────────────────────────────────
// CSP disabled: public/index.html is a static status page with inline <style>
// and isn't part of the app's real security surface (the actual frontend is a
// separate app on Vercel) — not worth hand-tuning a policy for it.
app.use(helmet({ contentSecurityPolicy: false }));

// ─── CORS ──────────────────────────────────────────────────────────────────
// Wide open in dev for convenience; in production, restricted to ALLOWED_ORIGINS
// (comma-separated) so any site can't ride an authenticated user's browser to
// this API — previously this was unrestricted even in production despite
// ALLOWED_ORIGINS already being set and used elsewhere (password reset emails).
const isProduction = process.env.NODE_ENV === 'production';
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);

app.use(cors({
    origin: (origin, callback) => {
        if (!isProduction || !origin || allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        callback(new Error('Not allowed by CORS'));
    },
}));

// ─── Body parsing ──────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false, limit: '10mb' }));

// ─── Logging ───────────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'production') {
    app.use(logger('dev'));
} else {
    app.use(logger('combined', {
        skip: (req, res) => res.statusCode < 400,
    }));
}

// ─── Static files ──────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── Routes ────────────────────────────────────────────────────────────────
app.use('/api', uploadRouter);
app.use('/api/auth', authRoutes);

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Error handlers ────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
    if (err.message === 'Not allowed by CORS') {
        return res.status(403).json({ error: 'CORS: origin not allowed' });
    }
    console.error('Unhandled error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
});

app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

process.on('SIGTERM', async () => {
    console.log('🛑 SIGTERM received — shutting down gracefully');
    await tgManager.disconnectAll();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('🛑 SIGINT received — shutting down');
    await tgManager.disconnectAll();
    process.exit(0);
});

const SELF_URL = process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000';

setInterval(async () => {
    try {
        const res = await fetch(`${SELF_URL}/api/health`);
        const data = await res.json();
        console.log(`💓 Keep-alive ping OK — ${data.timestamp}`);
    } catch (err) {
        console.warn(`⚠️ Keep-alive ping failed: ${err.message}`);
    }
}, 14 * 60 * 1000);

module.exports = app;