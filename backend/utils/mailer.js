// ============================================================
// Mailer Utility
// Sends transactional OTP emails via EmailJS's Node.js SDK (HTTPS API),
// not SMTP and not the Gmail API directly.
//
// Why EmailJS instead of the earlier approaches: Render's free tier
// blocks all outbound SMTP ports (25/465/587), which killed the original
// nodemailer/Gmail-SMTP setup entirely. The Gmail API (OAuth2) sidestepped
// that by sending over HTTPS instead, but brought its own complexity --
// a Google Cloud project, OAuth consent screen, test users, and a
// 7-day refresh-token expiry while the app stays in "Testing" publishing
// status (fixed by publishing the app, but still a lot of moving parts
// for what is fundamentally "send a 6-digit code"). EmailJS connects to
// the same Gmail account through ITS OWN already-approved Google app --
// no Cloud Console project, no consent screen, no token expiry to
// manage on our end at all.
//
// All three OTP situations (password reset, email change confirmation,
// and the generic Add User/Change Password/Delete action confirmation)
// now share ONE EmailJS template (see EMAILJS_TEMPLATE_ID) rather than
// each having its own custom HTML email -- the template only has room
// for the code and its expiry time, not a per-situation description, so
// none of these emails say WHAT the code is for anymore, just that
// there is one. That's a deliberate simplicity trade-off; if a
// per-situation description is wanted later, it just needs a new
// variable added to the template and threaded through here.
// ============================================================
const emailjs = require('@emailjs/nodejs');

emailjs.init({
    publicKey:  process.env.EMAILJS_PUBLIC_KEY,
    privateKey: process.env.EMAILJS_PRIVATE_KEY // required for sending from a server (non-browser) context
});

// Formats "when this code stops working" as a plain clock time in the
// pharmacy's own timezone (Asia/Manila), e.g. "2:15 PM" -- matches the
// EmailJS template's own wording ("valid for 15 minutes till {{time}}").
function formatExpiryTime(minutesFromNow) {
    const expiry = new Date(Date.now() + minutesFromNow * 60 * 1000);
    return expiry.toLocaleTimeString('en-US', {
        timeZone: 'Asia/Manila',
        hour:     '2-digit',
        minute:   '2-digit',
        hour12:   true
    });
}

/**
 * Sends the shared OTP template via EmailJS. Template variables
 * ({{email}}, {{passcode}}, {{time}}) must match exactly what's actually
 * defined in the EmailJS dashboard template (EMAILJS_TEMPLATE_ID) --
 * changing them on either side without the other breaks sending.
 */
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

/**
 * Sends a 6-digit OTP code for password reset.
 * @param {string} toEmail
 * @param {string} otp - plain 6-digit code (never store this anywhere, only its hash)
 * @param {string} userName - unused with the shared template (kept in the signature so authController.js doesn't need to change)
 */
async function sendOtpEmail(toEmail, otp, userName) {
    await sendOtpViaEmailJs(toEmail, otp);
}

/**
 * Sends a 6-digit OTP code confirming an EMAIL CHANGE on a user account.
 * Sent to the person PERFORMING the change (the admin/owner doing the
 * edit in User Management), not to the target account's new or old
 * address.
 * @param {string} toEmail - the requester's (admin/owner's) own email
 * @param {string} otp - plain 6-digit code (never store this anywhere, only its hash)
 * @param {string} requesterName - unused with the shared template
 * @param {string} targetUserName - unused with the shared template
 * @param {string} newEmail - unused with the shared template
 */
async function sendEmailChangeOtp(toEmail, otp, requesterName, targetUserName, newEmail) {
    await sendOtpViaEmailJs(toEmail, otp);
}

/**
 * Sends a 6-digit OTP code confirming a sensitive User Management action
 * (Add User, Change Password, or Delete/Deactivate) -- sent to the
 * person PERFORMING the action.
 * @param {string} toEmail - the requester's (owner's) own email
 * @param {string} otp - plain 6-digit code (never store this anywhere, only its hash)
 * @param {string} requesterName - unused with the shared template
 * @param {string} actionDescriptionHtml - unused with the shared template
 */
async function sendActionOtp(toEmail, otp, requesterName, actionDescriptionHtml) {
    await sendOtpViaEmailJs(toEmail, otp);
}

module.exports = { sendOtpEmail, sendEmailChangeOtp, sendActionOtp };
