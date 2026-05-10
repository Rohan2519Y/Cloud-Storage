// utils/database.js — optimized for Aiven free tier + Render free tier
const mysql = require('mysql2/promise');

if (!process.env.DB_HOST) throw new Error('DB_HOST not set in environment');

const pool = mysql.createPool({
    host:     process.env.DB_HOST,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port:     parseInt(process.env.DB_PORT) || 3306,
    connectionLimit:    3,
    queueLimit:         50,    
    waitForConnections: true,
    connectTimeout:     10000,
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