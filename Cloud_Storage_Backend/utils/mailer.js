const nodemailer = require('nodemailer');
const jwt = require('jsonwebtoken');

const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
    },
    tls: {
        rejectUnauthorized: false,
        minVersion: 'TLSv1.2',
    },
    family: 4,  // 👈 FORCE IPv4
});

transporter.verify(function (error, success) {
    if (error) {
        console.log('SMTP Connection Error:', error);
    } else {
        console.log('SMTP Server is ready');
    }
});

async function sendMail({ to, subject, text, html }) {
    try {
        const info = await transporter.sendMail({
            from: `"CloudStorage" <${process.env.GMAIL_USER}>`,
            to,
            subject,
            text,
            html,
        });
        console.log('Email sent:', info.messageId);
        return { success: true, messageId: info.messageId };
    } catch (err) {
        console.error('Email error:', err.message);
        return { success: false, error: err.message };
    }
}

// Generate reset token (JWT-based, expires in 30 min)
function generateResetToken(userId, email) {
    return jwt.sign(
        { userId, email, type: 'password_reset' },
        process.env.JWT_SECRET,
        { expiresIn: '30m' }
    );
}

// Verify reset token
function verifyResetToken(token) {
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded.type !== 'password_reset') return null;
        return decoded;
    } catch {
        return null;
    }
}

module.exports = { sendMail, generateResetToken, verifyResetToken };