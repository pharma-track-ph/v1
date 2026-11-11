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

module.exports = { loginLimiter, forgotPasswordLimiter, resetStepLimiter };
