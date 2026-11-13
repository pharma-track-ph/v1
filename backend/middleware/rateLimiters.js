// Rate limiters for the sign-in and password-reset routes Before, ONE limiter

const rateLimit = require('express-rate-limit');

const WINDOW = 15 * 60 * 1000;

const common = { windowMs: WINDOW, standardHeaders: true, legacyHeaders: false };

const loginLimiter = rateLimit({
    ...common,
    max: 15,
    skipSuccessfulRequests: true,
    message: { success: false, message: 'Too many failed login attempts from this network. Please wait 15 minutes and try again.' }
});

const forgotPasswordLimiter = rateLimit({
    ...common,
    max: 6,
    message: { success: false, message: 'Too many password reset requests. Please wait 15 minutes and try again.' }
});

const resetStepLimiter = rateLimit({
    ...common,
    max: 20,
    message: { success: false, message: 'Too many attempts. Please wait 15 minutes and try again.' }
});

// Verification codes sent to a NEW email address (own email change, Owner changing an email, Add User).
// Each request emails an address chosen by the user, so it is limited per person: 5 per 15 minutes.
// Only requests that really sent codes count (failed checks do not), and the other action codes
// (change password, delete user) are not limited here.
const emailCodeLimiter = rateLimit({
    ...common,
    max: 5,
    skipFailedRequests: true,
    keyGenerator: (req) => `user-${req.user && req.user.id !== undefined ? req.user.id : 'unknown'}`,
    skip: (req) => req.path.includes('action-otp') && !(req.body && req.body.action === 'create_user'),
    message: { success: false, message: 'Too many verification codes were requested. Please wait 15 minutes and try again.' }
});

module.exports = { loginLimiter, forgotPasswordLimiter, resetStepLimiter, emailCodeLimiter };
