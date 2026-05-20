const jwt = require('jsonwebtoken');

async function sendMail({ to, subject, text, html }) {
    try {
        const res = await fetch('https://api.brevo.com/v3/smtp/email', {
            method: 'POST',
            headers: {
                'api-key': process.env.BREVO_API_KEY,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                sender: { name: 'CloudStorage', email: process.env.FROM_EMAIL },
                to: [{ email: to }],
                subject,
                htmlContent: html || text,
            }),
        });
        const data = await res.json();
        if (data.messageId) {
            console.log('Email sent:', data.messageId);
            return { success: true };
        }
        console.error('Brevo error:', JSON.stringify(data));
        return { success: false, error: data.message || 'Unknown error' };
    } catch (err) {
        console.error('Email error:', err.message);
        return { success: false, error: err.message };
    }
}

function generateResetToken(userId, email) {
    return jwt.sign(
        { userId, email, type: 'password_reset' },
        process.env.JWT_SECRET,
        { expiresIn: '30m' }
    );
}

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