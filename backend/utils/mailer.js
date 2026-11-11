// Mailer Utility - Sends transactional OTP emails via EmailJS's Node.js SDK
const emailjs = require('@emailjs/nodejs');

emailjs.init({
    publicKey:  process.env.EMAILJS_PUBLIC_KEY,
    privateKey: process.env.EMAILJS_PRIVATE_KEY // required for sending from a server (non-browser) context
});

// Formats "when this code stops working" as a plain clock time in the pharmacy's own...
function formatExpiryTime(minutesFromNow) {
    const expiry = new Date(Date.now() + minutesFromNow * 60 * 1000);
    return expiry.toLocaleTimeString('en-US', {
        timeZone: 'Asia/Manila',
        hour:     '2-digit',
        minute:   '2-digit',
        hour12:   true
    });
}

/** Sends the shared OTP template via EmailJS. */
async function sendOtpViaEmailJs(toEmail, otp) {
    await emailjs.send(
        process.env.EMAILJS_SERVICE_ID,
        process.env.EMAILJS_TEMPLATE_ID,
        {
            email:    toEmail,
            passcode: otp,
            time:     formatExpiryTime(15) // keep in sync with authController.js's OTP_EXPIRY_MINUTES
        }
    );
}

/** Sends a 6-digit OTP code for password reset. */
async function sendOtpEmail(toEmail, otp, userName) {
    await sendOtpViaEmailJs(toEmail, otp);
}

/** Sends a 6-digit OTP code confirming an EMAIL CHANGE on a user account. */
async function sendEmailChangeOtp(toEmail, otp, requesterName, targetUserName, newEmail) {
    await sendOtpViaEmailJs(toEmail, otp);
}

/** Sends a 6-digit OTP code confirming a sensitive User Management action */
async function sendActionOtp(toEmail, otp, requesterName, actionDescriptionHtml) {
    await sendOtpViaEmailJs(toEmail, otp);
}

module.exports = { sendOtpEmail, sendEmailChangeOtp, sendActionOtp };
