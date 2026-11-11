const express = require('express');
const router  = express.Router();
const {
    signOutCheck, signOut,
    login, getMe, getAllUsers, updateUser, getAuditLogs, exportAuditLogs,
    forgotPassword, verifyOtp, resetPassword, updateProfile,
    requestEmailChangeOtp, confirmEmailChangeOtp,
    requestActionOtp, confirmActionOtp,
    requestChangePasswordOtp, confirmChangePasswordOtp,
    requestChangeEmailOtp, confirmChangeEmailOtp
} = require('../controllers/authController');
const { verifyToken, requireRole } = require('../middleware/authMiddleware');
const { loginLimiter, forgotPasswordLimiter, resetStepLimiter } = require('../middleware/rateLimiters');

// Login: 15 FAILED attempts per 15 minutes per IP (a successful login never counts)
router.post('/login', loginLimiter, login);
router.get('/me',     verifyToken, getMe);

// Sign out, with the register check: ANY logged-in role
router.get('/sign-out-check', verifyToken, signOutCheck);
router.post('/logout',        verifyToken, signOut);

// Self-service profile update (name + avatar)
router.put('/profile', verifyToken, updateProfile);

// Self-service password change (OTP)
router.post('/change-password-otp/request', verifyToken, requestChangePasswordOtp);
router.post('/change-password-otp/confirm', verifyToken, confirmChangePasswordOtp);

// Self-service email change (OTP)
router.post('/change-email-otp/request', verifyToken, requestChangeEmailOtp);
router.post('/change-email-otp/confirm', verifyToken, confirmChangeEmailOtp);

// Forgot Password (OTP via email) - public, no login required.
router.post('/forgot-password', forgotPasswordLimiter, forgotPassword);
router.post('/verify-otp',      resetStepLimiter,      verifyOtp);
router.post('/reset-password',  resetStepLimiter,      resetPassword);

// User management routes - super_admin ("owner") only.
router.get('/users',      verifyToken, requireRole('super_admin'), getAllUsers);
// Creating, deleting and changing the password of an account are NOT direct routes...
router.put('/users/:id',  verifyToken, requireRole('super_admin'), updateUser);

// Email change (OTP)
router.post('/users/:id/email-otp/request', verifyToken, requireRole('super_admin'), requestEmailChangeOtp);
router.post('/users/:id/email-otp/confirm', verifyToken, requireRole('super_admin'), confirmEmailChangeOtp);

// Action verification (OTP)
router.post('/action-otp/request', verifyToken, requireRole('super_admin'), requestActionOtp);
router.post('/action-otp/confirm', verifyToken, requireRole('super_admin'), confirmActionOtp);

// Audit logs - Owner (every entry) and Admin...
router.get('/audit-logs/export/:format', verifyToken, requireRole('admin'), exportAuditLogs);
router.get('/audit-logs', verifyToken, requireRole('admin'), getAuditLogs);

module.exports = router;
