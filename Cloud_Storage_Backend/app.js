// app.js — production-ready for Render free tier
const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const logger = require('morgan');
const cors = require('cors');
const multer = require('multer');

const authRoutes = require('./routes/auth');
const uploadRouter = require('./routes/upload');
const tgManager = require('./utils/telegramClientManager');

const app = express();

// ─── Security headers (no extra package needed) ────────────────────────────
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
});

// ─── CORS ──────────────────────────────────────────────────────────────────
const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : ['http://localhost:4000'];

app.use(cors({
    origin: (origin, cb) => {
        // Allow no-origin (mobile apps, Postman) and listed origins
        if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
        cb(new Error('Not allowed by CORS'));
    },
    credentials: true,
}));

// ─── Body parsing ──────────────────────────────────────────────────────────
// Limit JSON body to 10MB (files come via multipart, not JSON)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false, limit: '10mb' }));
app.use(cookieParser());

// ─── Logging ───────────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'production') {
    app.use(logger('dev'));
} else {
    // In production, only log errors
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
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: 'File exceeds 2GB limit' });
        }
    }
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