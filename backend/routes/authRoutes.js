const express = require('express');
const router  = express.Router();
const {
    login, getMe, getAllUsers, createUser, updateUser, deleteUser, getAuditLogs, exportAuditLogs,
    forgotPassword, verifyOtp, resetPassword, updateProfile,
    requestEmailChangeOtp, confirmEmailChangeOtp
} = require('../controllers/authController');
const { verifyToken, requireRole } = require('../middleware/authMiddleware');

router.post('/login', login);
router.get('/me',     verifyToken, getMe);

// Self-service profile update (name + avatar) -- any logged-in role,
// unlike /users/:id below which is admin/owner only.
router.put('/profile', verifyToken, updateProfile);

// Forgot Password (OTP via email) -- public, no login required. These
// share the same authLimiter as /login (applied once in server.js on the
// whole /api/auth prefix), so they're already rate-limited against abuse.
router.post('/forgot-password', forgotPassword);
router.post('/verify-otp',      verifyOtp);
router.post('/reset-password',  resetPassword);

// User management routes — super_admin ("owner") only. Admins can view
// inventory/reports/forecasting but not manage staff accounts.
router.get('/users',      verifyToken, requireRole('super_admin'), getAllUsers);
router.post('/users',     verifyToken, requireRole('super_admin'), createUser);
router.put('/users/:id',  verifyToken, requireRole('super_admin'), updateUser);
router.delete('/users/:id', verifyToken, requireRole('super_admin'), deleteUser);

// Email change (OTP) -- the code is sent to the OWNER performing the
// change (req.user), not to the target account, so this stays gated the
// same as the rest of User Management (super_admin only).
router.post('/users/:id/email-otp/request', verifyToken, requireRole('super_admin'), requestEmailChangeOtp);
router.post('/users/:id/email-otp/confirm', verifyToken, requireRole('super_admin'), confirmEmailChangeOtp);

// Audit logs – Super Admin only. Export route before the plain GET so
// Express doesn't need any special-casing (different path shape anyway).
router.get('/audit-logs/export/:format', verifyToken, requireRole('super_admin'), exportAuditLogs);
router.get('/audit-logs', verifyToken, requireRole('super_admin'), getAuditLogs);

module.exports = router;
