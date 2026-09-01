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

// Small (32x32, ~1.4KB) base64-embedded copy of the real PharmaTrack
// logo, used inline in the emails below via a data: URI -- deliberately
// NOT the full-size frontend/images/pharmatrack-logo.png (191KB) that
// PDF/Excel/Word exports use, since email clients often flag/strip
// large embedded images, and this only ever needs to render at ~28px.
// A data: URI (rather than a linked <img src="https://...">) also means
// the logo always shows immediately, since most email clients block
// loading external images by default until the user explicitly allows
// it -- exactly wrong for something meant to build trust in a one-time
// code the person needs to read right now.
const LOGO_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAFV0lEQVR42s2XS2wcVRaGv3NvdVVXtbudkASbQQrYiIiAICBASDxmpDARbJDYGJZICJAAhQWyYMEjYkMQsOChbLKIZoQEAxlmpGEYZhIBIRAgoEAgwZg8nBiCSGLHSdxtu7se97AovxPHNhEMJV21quveOv/9z/n/Ohf+z5dMuVuzxnR0XSa/ZsCNl36jPPWUO80jld9u3xOxvAkmRK+8Ye2KYnlRu4vrqlZERBWAdNpsQFWmABZRJQUbWKz1IEuJs2x8bSZGfb8otaH+/bu2yq5R9lU6Ot6wGzfekV298uVVUdPCd6wXWNSBzJMQBWOFRiOjEWdYK0RhAVUFHZ0ghjRtpMPVgVu+eP+h9zo63rBeT89xA2SeZ/9cCJps3DjZQCfvdW6XMcJgNaZtaYWL286hf2CEnd/0EfgFjAFVQEj9oDlIR2orgfd6eo6b8UBiJFbNFLAiYucbvDYUc/ut7XQ+cD1hGADw1n+7ePql7VhbABRFVTVTROPxtZPqQubPe74iThznt0Q8uvpGwjAgyxzOKbfdeimr/riUai3GGpm0YiKOOWsdS573C5c24/sFnANrDc450syxfNkSsmzmmjprAKpK4Ft6Dw1ycnBkNN+KMQbPGrr39mPtWBH8KgAg8C3f/1jl2z1Hc8llijHCfzZ3s2lrL+Umn8ydHoB39imAOMloXRKxfNm5+Us9w/PrPuSVv3fTXAln3P2sDIyVy5mGNYZ6I+Xy5YuplIs4pwxWR9j0QS/lcjFPyRlinJGBJM1NRFGE0xeRs444zlj1p3ZEBBHYufswR/pGqJRD4sThWZk/AAEWLShgjCAiOKeInMqmiFAuSdrXdyLdvKW7qKps/eQHWhaHhKFHlinVWjojC95M3KdpwjOP30zbBYtIklQDv0DmHIKojr9OxjLl1YZjz2X5/9dedQG+b0Gh99AA93X+D2Ps3GvAGqE2lNK97zjFwOf+zn/J0f4hSlFRoyigFBVHR0ApCiSKAs5dXKa1pUJrS4WFCyKiMKBUCth34ARDw2kuxbkCUFWKQYE3/92NMcIfWius/+tnAkiSZDJdhqo6+jt5KKrKW5v24nk2/yidGcBEj+CcEkUFuvYMsO2zgzzRuZJt23s5+P2AFApWnFMzutbkapApysiNSNjx1SF27u6jFBVwbp5GpE4JAp8X139OcyXk/ruvY+0LW8YZms2cADa8+tWsXjfjU6dKFHrs6TnJug2fcsftKzi/tczf3vxy1OtPDyJNHdYKb2/u5pMdh2lq8mecO6sRZZljQXORDa/uZtOWPTz5yCqODdTY9ul+xAhuGhPOKZ5n2H+gn+fWbadUCnDO/TIGJhdkVApY8+xHvPPudzx47014Hhw5cgIjMk63U0VE2NX1E/c8/DaNRPCsMEu25gIgrzRjLPt6jhEnKdddcxFLFld0rItQzTsu5xzGwNVXtCLorMHnBMAYYaSesqy9wup7r8cv5N41Wdci+TxrDZddch533Xk59XqCMbP3NxNOKGMK5pS8FgPLvgODvLj+Y26+qY3zWso0NQXiF3J3S5KMoeGY/mPDfLu3j9f+0UVQnEl6U+N4E7ITX8QKkKlOPSOMGe5fXu/itX92U6n4NJUKhL4HItQbCUPDCdVawvBIhu97BL49tQCFTMR6qPjjANrbF7odOyBNkneTRq3T88IA1aktVN7RsuicCKdQbziGRxSnyfgHyRofPwgIw1wdbnoXpgpibFyvZo2k/j5Ae/tCJ5M2qVfesHZFWFnSFsd1tepk5qRZrJ0uWYCJg8gpkh49mFSrR3p2f/TY12MxfzdHM0D0tzuciuP3cv0MEYFpBaRji5wAAAAASUVORK5CYII=';

let transporter = null;

// Render's containers have no outbound IPv6 routing at all -- Gmail's
// SMTP host (smtp.gmail.com) resolves to BOTH an IPv4 and an IPv6
// address, and depending on DNS ordering Node can end up trying the
// unreachable IPv6 one first, failing with ENETUNREACH or hanging until
// a connection timeout. server.js already sets
// dns.setDefaultResultOrder('ipv4first') globally, but that setting only
// governs dns.lookup() specifically -- it turned out NOT to be enough on
// its own here (confirmed live: the exact same ENETUNREACH/timeout
// errors kept happening on Render even with that in place), most likely
// because nodemailer's own connection setup doesn't route its DNS
// resolution through dns.lookup() in a way that setting actually
// reaches. `family: 4` below is the more direct fix -- it's passed
// straight through to the underlying net/tls socket options and forces
// an IPv4-only connection at the actual point of failure, regardless of
// how the hostname got resolved. Harmless locally too (real IPv6 routing
// exists there, but forcing IPv4 doesn't break anything -- Gmail is
// reachable over both).
function getTransporter() {
    if (!transporter) {
        transporter = nodemailer.createTransport({
            service: 'gmail',
            family:  4,
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
                    <img src="${LOGO_DATA_URI}" alt="PharmaTrack" width="28" height="28" style="display:inline-block;vertical-align:middle">
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

/**
 * Sends a 6-digit OTP code confirming an EMAIL CHANGE on a user account.
 * Deliberately sent to the person PERFORMING the change (the admin/owner
 * doing the edit in User Management), not to the target account's new or
 * old address -- this confirms the person at the keyboard actually owns
 * the session making the request, the same way a re-authentication step
 * would, rather than confirming that the new address is reachable.
 * @param {string} toEmail - the requester's (admin/owner's) own email
 * @param {string} otp - plain 6-digit code (never store this anywhere, only its hash)
 * @param {string} requesterName - name of the admin/owner making the change
 * @param {string} targetUserName - name of the account whose email is being changed
 * @param {string} newEmail - the email address being changed TO
 */
async function sendEmailChangeOtp(toEmail, otp, requesterName, targetUserName, newEmail) {
    const fromAddress = process.env.EMAIL_USER;

    await getTransporter().sendMail({
        from: `"PharmaTrack" <${fromAddress}>`,
        to: toEmail,
        subject: 'Your PharmaTrack email change verification code',
        html: `
            <div style="font-family:Segoe UI,Arial,sans-serif;max-width:420px;margin:0 auto;padding:24px;border:1px solid #e9ecef;border-radius:12px;">
                <div style="text-align:center;margin-bottom:20px">
                    <img src="${LOGO_DATA_URI}" alt="PharmaTrack" width="28" height="28" style="display:inline-block;vertical-align:middle">
                    <div style="font-size:18px;font-weight:700;color:#0d6efd">PharmaTrack</div>
                </div>
                <p style="font-size:14px;color:#212529">Hi ${requesterName || 'there'},</p>
                <p style="font-size:14px;color:#212529">
                    You requested to change the email address for the account
                    <strong>${targetUserName || 'a user'}</strong> to <strong>${newEmail}</strong>.
                    Use this code to confirm the change. It expires in 10 minutes.
                </p>
                <div style="text-align:center;margin:24px 0">
                    <span style="font-size:32px;font-weight:700;letter-spacing:8px;color:#0d6efd">${otp}</span>
                </div>
                <p style="font-size:12px;color:#6c757d">If you didn't request this, you can safely ignore this email and the address will not change -- but you may want to check who has access to your User Management page.</p>
            </div>
        `
    });
}

/**
 * Sends a 6-digit OTP code confirming a sensitive User Management action
 * (Add User, Change Password, or Delete/Deactivate) -- sent to the
 * person PERFORMING the action (the owner using User Management right
 * now), same "confirm it's really you" reasoning as sendEmailChangeOtp
 * above, generalized across all three actions instead of being specific
 * to email changes.
 * @param {string} toEmail - the requester's (owner's) own email
 * @param {string} otp - plain 6-digit code (never store this anywhere, only its hash)
 * @param {string} requesterName - name of the owner performing the action
 * @param {string} actionDescriptionHtml - plain-language HTML description of what's being confirmed, e.g. "create a new Pharmacy Assistant account for Maria Santos"
 */
async function sendActionOtp(toEmail, otp, requesterName, actionDescriptionHtml) {
    const fromAddress = process.env.EMAIL_USER;

    await getTransporter().sendMail({
        from: `"PharmaTrack" <${fromAddress}>`,
        to: toEmail,
        subject: 'Your PharmaTrack action verification code',
        html: `
            <div style="font-family:Segoe UI,Arial,sans-serif;max-width:420px;margin:0 auto;padding:24px;border:1px solid #e9ecef;border-radius:12px;">
                <div style="text-align:center;margin-bottom:20px">
                    <img src="${LOGO_DATA_URI}" alt="PharmaTrack" width="28" height="28" style="display:inline-block;vertical-align:middle">
                    <div style="font-size:18px;font-weight:700;color:#0d6efd">PharmaTrack</div>
                </div>
                <p style="font-size:14px;color:#212529">Hi ${requesterName || 'there'},</p>
                <p style="font-size:14px;color:#212529">
                    You requested to ${actionDescriptionHtml}.
                    Use this code to confirm. It expires in 10 minutes.
                </p>
                <div style="text-align:center;margin:24px 0">
                    <span style="font-size:32px;font-weight:700;letter-spacing:8px;color:#0d6efd">${otp}</span>
                </div>
                <p style="font-size:12px;color:#6c757d">If you didn't request this, you can safely ignore this email -- nothing will change unless this code is used.</p>
            </div>
        `
    });
}

module.exports = { sendOtpEmail, sendEmailChangeOtp, sendActionOtp };
