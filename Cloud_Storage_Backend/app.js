// app.js — production-ready with @mtcute/node
const express = require('express');
const path = require('path');
const logger = require('morgan');
const cors = require('cors');
const helmet = require('helmet');

const authRoutes = require('./routes/auth');
const uploadRouter = require('./routes/upload');
const tgManager = require('./utils/telegramClientManager');

const app = express();

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