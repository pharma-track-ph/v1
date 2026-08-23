// ============================================================
// Mailer Utility
// Sends transactional emails (currently just password-reset OTP codes)
// via Gmail SMTP using an App Password — not the account's real
// password. See EMAIL_USER / EMAIL_APP_PASSWORD in .env.
//
// Nodemailer's 'gmail' shorthand service handles the host/port/security
// details automatically (smtp.gmail.com, port 465, TLS).
// ============================================================
const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
    if (!transporter) {
        transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_APP_PASSWORD
            }
        });
    }
    return transporter;
}

/**
 * Sends a 6-digit OTP code for password reset.
 * @param {string} toEmail
 * @param {string} otp - plain 6-digit code (never store this anywhere, only its hash)
 * @param {string} userName
 */
async function sendOtpEmail(toEmail, otp, userName) {
    const fromAddress = process.env.EMAIL_USER;

    await getTransporter().sendMail({
        from: `"PharmaTrack" <${fromAddress}>`,
        to: toEmail,
        subject: 'Your PharmaTrack password reset code',
        html: `
            <div style="font-family:Segoe UI,Arial,sans-serif;max-width:420px;margin:0 auto;padding:24px;border:1px solid #e9ecef;border-radius:12px;">
                <div style="text-align:center;margin-bottom:20px">
                    <div style="font-size:28px">💊</div>
                    <div style="font-size:18px;font-weight:700;color:#0d6efd">PharmaTrack</div>
                </div>
                <p style="font-size:14px;color:#212529">Hi ${userName || 'there'},</p>
                <p style="font-size:14px;color:#212529">Use this code to reset your password. It expires in 10 minutes.</p>
                <div style="text-align:center;margin:24px 0">
                    <span style="font-size:32px;font-weight:700;letter-spacing:8px;color:#0d6efd">${otp}</span>
                </div>
                <p style="font-size:12px;color:#6c757d">If you didn't request this, you can safely ignore this email — your password won't change unless this code is used.</p>
            </div>
        `
    });
}

module.exports = { sendOtpEmail };
