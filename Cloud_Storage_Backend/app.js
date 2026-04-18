// app.js
const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const logger = require('morgan');
const cors = require('cors');
const multer = require('multer');

// Import routes
const uploadRouter = require('./routes/upload');

// Import database for testing (optional - remove if not needed)
const pool = require('./utils/database');

const app = express();

// CORS middleware
app.use(cors());

// Logging middleware
app.use(logger('dev'));

// Body parsing middleware
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Use upload routes
app.use('/api', uploadRouter);

// Test database connection (optional - remove if causing issues)
(async () => {
    try {
        const connection = await pool.getConnection();
        console.log('✅ MySQL database connected');
        connection.release();
    } catch (error) {
        console.error('⚠️ MySQL connection warning:', error.message);
        console.log('📌 Make sure MySQL is running and credentials are correct in .env');
    }
})();

// Root route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handler for multer
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'FILE_TOO_LARGE') {
            return res.status(400).json({ error: 'File exceeds 2GB limit' });
        }
    }
    res.status(500).json({ error: err.message });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

module.exports = app;