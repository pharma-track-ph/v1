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

router.post('/login', login);
router.get('/me',     verifyToken, getMe);

// Sign out, with the register check: ANY logged-in role (the rule is "has an open register",
// not a role). /sign-out-check answers "may I?"; /logout checks AGAIN and says OK (it writes
// nothing to the Audit Logs).
router.get('/sign-out-check', verifyToken, signOutCheck);
router.post('/logout',        verifyToken, signOut);

// Self-service profile update (name + avatar) -- any logged-in role,
// unlike /users/:id below which is admin/owner only.
router.put('/profile', verifyToken, updateProfile);

// Self-service password change (OTP) -- any logged-in role, since this
// only ever touches the requester's OWN account. Deliberately separate
// from the /action-otp routes below, which stay super_admin-only since
// THOSE act on other people's accounts.
router.post('/change-password-otp/request', verifyToken, requestChangePasswordOtp);
router.post('/change-password-otp/confirm', verifyToken, confirmChangePasswordOtp);

// Self-service email change (OTP) -- any logged-in role, since this only
// ever touches the requester's OWN account. The code goes to their CURRENT
// email; nothing is written until it is confirmed.
router.post('/change-email-otp/request', verifyToken, requestChangeEmailOtp);
router.post('/change-email-otp/confirm', verifyToken, confirmChangeEmailOtp);

// Forgot Password (OTP via email) -- public, no login required. These
// share the same authLimiter as /login (applied once in server.js on the
// whole /api/auth prefix), so they're already rate-limited against abuse.
router.post('/forgot-password', forgotPassword);
router.post('/verify-otp',      verifyOtp);
router.post('/reset-password',  resetPassword);

// User management routes — super_admin ("owner") only. Admins can view
// inventory/reports/forecasting but not manage staff accounts.
router.get('/users',      verifyToken, requireRole('super_admin'), getAllUsers);
// Creating, deleting and changing the password of an account are NOT direct routes any more:
// they only happen through /action-otp/request + /action-otp/confirm below, which needs the
// 6-digit code. (A direct POST /users and DELETE /users/:id used to exist beside them and
// skipped the code entirely; no page used them.)
router.put('/users/:id',  verifyToken, requireRole('super_admin'), updateUser);

// Email change (OTP) -- the code is sent to the OWNER performing the
// change (req.user), not to the target account, so this stays gated the
// same as the rest of User Management (super_admin only).
router.post('/users/:id/email-otp/request', verifyToken, requireRole('super_admin'), requestEmailChangeOtp);
router.post('/users/:id/email-otp/confirm', verifyToken, requireRole('super_admin'), confirmEmailChangeOtp);

// Action verification (OTP) -- generic version of the above, reused for
// Add User, Change Password, and Delete/Deactivate. Same reasoning: the
// code goes to the owner PERFORMING the action, nothing is written to
// the database until confirmed.
router.post('/action-otp/request', verifyToken, requireRole('super_admin'), requestActionOtp);
router.post('/action-otp/confirm', verifyToken, requireRole('super_admin'), confirmActionOtp);

// Audit logs -- Owner (every entry) and Admin (ONLY entries made by Pharmacists; the
// controller adds that rule to the SQL). Pharmacists are refused here (403). Export route
// before the plain GET so Express doesn't need any special-casing (different path shape anyway).
router.get('/audit-logs/export/:format', verifyToken, requireRole('admin'), exportAuditLogs);
router.get('/audit-logs', verifyToken, requireRole('admin'), getAuditLogs);

module.exports = router;
