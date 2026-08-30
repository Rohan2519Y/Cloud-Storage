// utils/database.js — optimized for Aiven free tier + Render free tier
const mysql = require('mysql2/promise');

if (!process.env.DB_HOST) throw new Error('DB_HOST not set in environment');

const pool = mysql.createPool({
    host:     process.env.DB_HOST,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port:     parseInt(process.env.DB_PORT) || 3306,
    connectionLimit:    5,
    queueLimit:         0,    
    waitForConnections: true,
    connectTimeout:     30000,
    // Aiven's server clock/session is UTC, but mysql2 defaults to interpreting raw
    // DATETIME values as being in the Node process's local timezone — on a host set to
    // IST (UTC+5:30) that silently shifted every created_at 5.5 hours into the past.
    // 'Z' tells mysql2 the raw values ARE UTC, so Date objects come out correct.
    timezone: 'Z',
    ssl: { rejectUnauthorized: false },
    enableKeepAlive:    true,
    keepAliveInitialDelay: 30000,
});

// Test connection on startup
pool.getConnection()
    .then(conn => {
        console.log('✅ MySQL connected to Aiven');
        conn.release();
    })
    .catch(err => {
        console.error('❌ MySQL connection failed:', err.message);
        process.exit(1);
    });

module.exports = pool;