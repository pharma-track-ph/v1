// ============================================================
// Auth Controller
// Handles login, token refresh, user management (Admin+)
// ============================================================
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const bcrypt  = require('bcryptjs');
const User    = require('../models/User');
const db      = require('../config/db');           // ← FIX: was missing, causes ReferenceError in getAuditLogs
const { logAudit } = require('../middleware/authMiddleware');
const { sendOtpEmail, sendEmailChangeOtp } = require('../utils/mailer');
const { exportReport, formatShortDateTime } = require('../utils/reportExporter');
const EmailChangeOtpStore = require('../utils/emailChangeOtpStore');

/**
 * POST /api/auth/login
 * Authenticates user and returns a JWT.
 */
const login = async (req, res, next) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ success: false, message: 'Email and password are required.' });
        }

        const user = await User.findByEmail(email.toLowerCase().trim());

        if (!user) {
            return res.status(401).json({ success: false, message: 'Invalid email or password.' });
        }

        const isMatch = await User.comparePassword(password, user.password);

        if (!isMatch) {
            await logAudit(user.id, 'LOGIN_FAILED', 'users', user.id, { email }, req.ip);
            return res.status(401).json({ success: false, message: 'Invalid email or password.' });
        }

        const token = jwt.sign(
            { id: user.id, role: user.role, name: user.name },
            process.env.JWT_SECRET,
            { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
        );

        await logAudit(user.id, 'LOGIN_SUCCESS', 'users', user.id, {}, req.ip);

        res.json({
            success: true,
            message: 'Login successful.',
            token,
            user: {
                id:     user.id,
                name:   user.name,
                email:  user.email,
                role:   user.role,
                avatar: user.avatar || null
            }
        });

    } catch (err) {
        next(err);
    }
};

/**
 * GET /api/auth/me
 * Returns currently authenticated user profile -- a REAL, fresh database
 * lookup (not just echoing back whatever's in the JWT), since the JWT
 * deliberately doesn't carry the avatar (a base64 image would bloat every
 * single request's Authorization header) and may be stale on name if a
 * profile update happened since the token was issued.
 */
const getMe = async (req, res, next) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
        res.json({ success: true, user });
    } catch (err) { next(err); }
};

/**
 * GET /api/auth/users  [Admin+]
 */
const getAllUsers = async (req, res, next) => {
    try {
        const users = await User.findAll();
        res.json({ success: true, data: users });
    } catch (err) { next(err); }
};

/**
 * POST /api/auth/users  [Admin+]
 * Super Admin can create any role; Admin can only create Cashier accounts.
 */
const createUser = async (req, res, next) => {
    try {
        const { name, email, password, role } = req.body;

        if (!name || !email || !password || !role) {
            return res.status(400).json({ success: false, message: 'All fields are required.' });
        }

        if (req.user.role === 'admin' && role !== 'cashier') {
            return res.status(403).json({ success: false, message: 'Admins can only create Cashier accounts.' });
        }

        const existing = await User.findByEmail(email.toLowerCase().trim());
        if (existing) {
            return res.status(409).json({ success: false, message: 'Email already in use.' });
        }

        const id = await User.create({ name, email: email.toLowerCase().trim(), password, role });
        await logAudit(req.user.id, 'CREATE_USER', 'users', id, { name, email, role }, req.ip);

        res.status(201).json({ success: true, message: 'User created successfully.', id });

    } catch (err) { next(err); }
};

/**
 * PUT /api/auth/users/:id  [Admin+]
 *
 * Self-edit: allowed for Name/Email/Password, but NOT Role or Active-status
 * -- letting someone change their own role or deactivate their own account
 * risks locking themselves out with no one else able to undo it in the
 * moment. This mirrors the frontend's users.js, which disables those two
 * fields when editing your own row, but it's enforced here too so it can't
 * be bypassed with a direct API call.
 *
 * Other-owner accounts remain fully protected regardless (unchanged).
 */
const updateUser = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { name, role, is_active, password } = req.body;
        const isSelf = parseInt(id) === req.user.id;

        // Always fetched -- needed below regardless of isSelf, since email
        // changes are deliberately IGNORED here (see comment on the email
        // line) and we need the target's CURRENT email to keep it unchanged.
        const target = await User.findById(id);
        if (!target) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }

        if (isSelf) {
            if (role !== req.user.role) {
                return res.status(400).json({ success: false, message: 'You cannot change your own role.' });
            }
            if (parseInt(is_active) !== 1) {
                return res.status(400).json({ success: false, message: 'You cannot deactivate your own account.' });
            }
        } else {
            // Owner (super_admin) accounts can only be managed by the account
            // holder themselves, never by another owner.
            if (target.role === 'super_admin') {
                return res.status(403).json({ success: false, message: 'Owner accounts can only be managed by the account holder.' });
            }
        }

        // Email is deliberately NOT accepted here anymore -- it can only be
        // changed via the dedicated OTP-verified flow below
        // (requestEmailChangeOtp / confirmEmailChangeOtp), which sends a code
        // to the PERSON MAKING THE CHANGE before it takes effect. Even if a
        // client sends a different email in this request body, the target's
        // existing email is kept untouched here.
        const affected = await User.update(id, { name, email: target.email, role, is_active });

        if (!affected) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }

        // Optional password change in the same request
        if (password && password.length >= 8) {
            await User.updatePassword(id, password);
        }

        await logAudit(req.user.id, 'UPDATE_USER', 'users', id, { name, role, is_active }, req.ip);
        res.json({ success: true, message: 'User updated.' });

    } catch (err) { next(err); }
};

/**
 * POST /api/auth/users/:id/email-otp/request  [Admin+]
 * Body: { newEmail }
 *
 * Step 1 of the email-change flow. The 6-digit code is emailed to the
 * PERSON PERFORMING THE CHANGE (req.user -- the admin/owner logged in and
 * using User Management right now), never to the target account's new or
 * old address. This mirrors the forgot-password OTP pattern, but its
 * purpose is different: it's confirming "the person at this keyboard, in
 * this session, really meant to do this" rather than confirming that the
 * new address is reachable by its eventual owner.
 */
const requestEmailChangeOtp = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { newEmail } = req.body;

        if (!newEmail) {
            return res.status(400).json({ success: false, message: 'New email is required.' });
        }

        const normalizedEmail = newEmail.toLowerCase().trim();

        const target = await User.findById(id);
        if (!target) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }

        // Same owner-protection rule as updateUser above.
        if (parseInt(id) !== req.user.id && target.role === 'super_admin') {
            return res.status(403).json({ success: false, message: 'Owner accounts can only be managed by the account holder.' });
        }

        if (normalizedEmail === target.email.toLowerCase()) {
            return res.status(400).json({ success: false, message: 'That is already this user\'s email address.' });
        }

        const existing = await User.findByEmail(normalizedEmail);
        if (existing && parseInt(existing.id) !== parseInt(id)) {
            return res.status(409).json({ success: false, message: 'Email already in use by another account.' });
        }

        const requester = await User.findById(req.user.id);

        const otp       = String(crypto.randomInt(100000, 1000000));
        const otpHash   = await bcrypt.hash(otp, 10);
        const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

        // In-memory only -- see utils/emailChangeOtpStore.js for why this
        // isn't written to the users table.
        EmailChangeOtpStore.set(req.user.id, {
            otpHash, expiresAt, targetId: id, newEmail: normalizedEmail
        });

        try {
            await sendEmailChangeOtp(requester.email, otp, requester.name, target.name, normalizedEmail);
        } catch (mailErr) {
            console.error('[requestEmailChangeOtp] Failed to send OTP email:', mailErr.message);
            EmailChangeOtpStore.clear(req.user.id);
            return res.status(500).json({ success: false, message: 'Could not send the verification email. Please try again later.' });
        }

        res.json({ success: true, message: `A verification code has been sent to ${requester.email}.` });

    } catch (err) { next(err); }
};

/**
 * POST /api/auth/users/:id/email-otp/confirm  [Admin+]
 * Body: { otp }
 *
 * Step 2 -- verifies the code against the REQUESTER's (not the target's)
 * stored hash, then applies the pending email change to the target
 * account it was originally requested for. The pending target id is
 * checked against the :id in the URL so a stale/mismatched confirm
 * request (e.g. two edit tabs open) can't silently apply to the wrong
 * user.
 */
const confirmEmailChangeOtp = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { otp } = req.body;

        if (!otp) {
            return res.status(400).json({ success: false, message: 'Verification code is required.' });
        }

        const pending = EmailChangeOtpStore.get(req.user.id);

        if (!pending) {
            return res.status(400).json({ success: false, message: 'No pending email change found. Please start again.' });
        }

        if (parseInt(pending.targetId) !== parseInt(id)) {
            return res.status(400).json({ success: false, message: 'This code does not match the pending change. Please start again.' });
        }

        if (new Date(pending.expiresAt) < new Date()) {
            EmailChangeOtpStore.clear(req.user.id);
            return res.status(400).json({ success: false, message: 'This code has expired. Please request a new one.' });
        }

        if (pending.attempts >= MAX_OTP_ATTEMPTS) {
            EmailChangeOtpStore.clear(req.user.id);
            return res.status(429).json({ success: false, message: 'Too many incorrect attempts. Please request a new code.' });
        }

        const matches = await bcrypt.compare(otp, pending.otpHash);

        if (!matches) {
            EmailChangeOtpStore.incrementAttempts(req.user.id);
            const remaining = MAX_OTP_ATTEMPTS - (pending.attempts + 1);
            return res.status(400).json({
                success: false,
                message: remaining > 0 ? `Incorrect code. ${remaining} attempt(s) left.` : 'Too many incorrect attempts. Please request a new code.'
            });
        }

        // Re-check the target email hasn't been claimed by someone else while
        // this code was pending (e.g. two admins editing at once).
        const stillAvailable = await User.findByEmail(pending.newEmail);
        if (stillAvailable && parseInt(stillAvailable.id) !== parseInt(id)) {
            EmailChangeOtpStore.clear(req.user.id);
            return res.status(409).json({ success: false, message: 'That email was taken by another account while this code was pending. Please start again.' });
        }

        await User.updateEmail(id, pending.newEmail);
        EmailChangeOtpStore.clear(req.user.id);
        await logAudit(req.user.id, 'CHANGE_USER_EMAIL', 'users', id, { new_email: pending.newEmail }, req.ip);

        res.json({ success: true, message: 'Email updated successfully.', email: pending.newEmail });

    } catch (err) { next(err); }
};

/**
 * DELETE /api/auth/users/:id  [Super Admin only]
 */
const deleteUser = async (req, res, next) => {
    try {
        const { id } = req.params;

        if (parseInt(id) === req.user.id) {
            return res.status(400).json({ success: false, message: 'Cannot delete your own account.' });
        }

        // Same owner-protection rule as updateUser above.
        const target = await User.findById(id);
        if (!target) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }
        if (target.role === 'super_admin') {
            return res.status(403).json({ success: false, message: 'Owner accounts can only be managed by the account holder.' });
        }

        await User.softDelete(id);
        await logAudit(req.user.id, 'DELETE_USER', 'users', id, {}, req.ip);

        res.json({ success: true, message: 'User deactivated.' });

    } catch (err) { next(err); }
};

/**
 * GET /api/auth/audit-logs  [Super Admin only]
 * Query params: limit, offset, action, user, date_start, date_end
 */
const getAuditLogs = async (req, res, next) => {
    try {
        const {
            limit      = 500,
            offset     = 0,
            action     = '',
            user       = '',
            date_start = '',
            date_end   = ''
        } = req.query;

        let sql = `
            SELECT al.*, u.name AS user_name, u.role AS user_role
            FROM audit_logs al
            JOIN users u ON u.id = al.user_id
            WHERE 1=1
        `;
        const params = [];

        if (action) {
            sql += ' AND al.action LIKE ?';
            params.push(`${action}%`);
        }

        if (user) {
            sql += ' AND (u.name LIKE ? OR u.email LIKE ?)';
            const pattern = `%${user}%`;
            params.push(pattern, pattern);
        }

        if (date_start) {
            sql += ' AND DATE(al.created_at) >= ?';
            params.push(date_start);
        }
        if (date_end) {
            sql += ' AND DATE(al.created_at) <= ?';
            params.push(date_end);
        }

        sql += ' ORDER BY al.created_at DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limit), parseInt(offset));

        const [rows] = await db.query(sql, params);

        res.json({ success: true, data: rows });

    } catch (err) {
        next(err);
    }
};

const AUDIT_COLUMNS = [
    { label: 'Date/Time',  excelWidth: 20, pdfWidth: 95  },
    { label: 'User',        excelWidth: 18, pdfWidth: 85  },
    { label: 'Role',        excelWidth: 10, pdfWidth: 50  },
    { label: 'Action',      excelWidth: 16, pdfWidth: 80  },
    { label: 'Entity',      excelWidth: 14, pdfWidth: 70  },
    { label: 'Entity ID',   excelWidth: 10, pdfWidth: 50  }
];

const AUDIT_ROLE_LABELS   = { super_admin: 'Owner', admin: 'Admin', cashier: 'Cashier' };
const AUDIT_ENTITY_LABELS = {
    products: 'Product', users: 'User', orders: 'Order', order_items: 'Order Item',
    cash_sessions: 'Cash Session', cash_movements: 'Cash Movement', audit_logs: 'Audit Log',
    backups: 'Backups', app_settings: 'App Settings'
};

/**
 * GET /api/auth/audit-logs/export/:format (excel|pdf|word)
 * Mirrors the exact same filters the Audit Logs PAGE applies client-side
 * (search/action/entity/date) -- entity filtering in particular isn't
 * supported by getAuditLogs above at all, so it's handled here instead,
 * to keep "what you're looking at" and "what you exported" consistent.
 */
const exportAuditLogs = async (req, res, next) => {
    try {
        const { search = '', action = '', entity = '', date = '' } = req.query;

        let sql = `
            SELECT al.*, u.name AS user_name, u.role AS user_role
            FROM audit_logs al
            JOIN users u ON u.id = al.user_id
            WHERE 1=1
        `;
        const params = [];

        if (search) {
            sql += ' AND (u.name LIKE ? OR al.action LIKE ? OR al.entity LIKE ?)';
            const pattern = `%${search}%`;
            params.push(pattern, pattern, pattern);
        }
        if (action) { sql += ' AND al.action LIKE ?'; params.push(`${action}%`); }
        if (entity) { sql += ' AND al.entity = ?';     params.push(entity); }
        if (date)   { sql += ' AND DATE(al.created_at) = ?'; params.push(date); }

        sql += ' ORDER BY al.created_at DESC LIMIT 500';

        const [rows] = await db.query(sql, params);

        const exportRows = rows.map(log => [
            formatShortDateTime(log.created_at),
            log.user_name || '—',
            log.user_role ? (AUDIT_ROLE_LABELS[log.user_role] || log.user_role) : '—',
            (log.action || '').replace(/_/g, ' '),
            log.entity ? (AUDIT_ENTITY_LABELS[log.entity] || log.entity) : '—',
            log.entity_id || '—'
        ]);

        await exportReport(req.params.format, {
            res,
            title:       'Audit Log',
            generatedBy: req.user.name,
            filename:    'PharmaTrack_Audit_Log',
            columns:     AUDIT_COLUMNS,
            rows:        exportRows,
            periodLabel: date ? `Date: ${date}` : null
        });
    } catch (err) { next(err); }
};

/**
 * POST /api/auth/forgot-password
 * Body: { email }
 * Public endpoint (no login required -- that's the whole point). Always
 * returns the same generic success message whether or not the email is
 * actually registered, so this can't be used to check which emails exist
 * in the system. If the email IS registered, a 6-digit code is emailed
 * to it, valid for 10 minutes. Only a bcrypt HASH of the code is ever
 * stored -- never the plain code itself.
 */
const GENERIC_OTP_MESSAGE = 'If that email is registered, a reset code has been sent to it.';
const OTP_EXPIRY_MINUTES  = 10;
const MAX_OTP_ATTEMPTS    = 5;

const forgotPassword = async (req, res, next) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ success: false, message: 'Email is required.' });
        }

        const user = await User.findByEmail(email.toLowerCase().trim());

        if (!user) {
            // Deliberately identical response to the "found" case below --
            // see GENERIC_OTP_MESSAGE comment.
            return res.json({ success: true, message: GENERIC_OTP_MESSAGE });
        }

        const otp     = String(crypto.randomInt(100000, 1000000)); // 6 digits, never all-zeros-prefixed issue since randomInt is inclusive-exclusive over this range
        const otpHash = await bcrypt.hash(otp, 10);
        const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

        await User.setResetOtp(user.id, otpHash, expiresAt);

        try {
            await sendOtpEmail(user.email, otp, user.name);
        } catch (mailErr) {
            // A real registered user whose email genuinely failed to send is
            // worth surfacing loudly (almost certainly an SMTP config
            // issue) -- this is the one deliberate exception to "always
            // return the same generic message", since silently failing
            // here would just leave someone waiting forever for a code
            // that was never going to arrive.
            console.error('[forgotPassword] Failed to send OTP email:', mailErr.message);
            return res.status(500).json({ success: false, message: 'Could not send the reset email. Please try again later.' });
        }

        res.json({ success: true, message: GENERIC_OTP_MESSAGE });

    } catch (err) { next(err); }
};

/**
 * POST /api/auth/verify-otp
 * Body: { email, otp }
 * Checks the 6-digit code against its stored hash. On success, issues a
 * short-lived (10 min) single-purpose JWT that authorizes ONE password
 * reset -- this is what /reset-password requires, so the OTP itself
 * can't be reused/replayed after this step.
 */
const verifyOtp = async (req, res, next) => {
    try {
        const { email, otp } = req.body;
        if (!email || !otp) {
            return res.status(400).json({ success: false, message: 'Email and code are required.' });
        }

        const user = await User.findByEmail(email.toLowerCase().trim());

        // Same generic-sounding failure for "no such user" and "no pending
        // code" -- no need to distinguish these to the caller.
        if (!user || !user.reset_otp_hash || !user.reset_otp_expires_at) {
            return res.status(400).json({ success: false, message: 'Invalid or expired code. Please request a new one.' });
        }

        if (new Date(user.reset_otp_expires_at) < new Date()) {
            await User.clearResetOtp(user.id);
            return res.status(400).json({ success: false, message: 'This code has expired. Please request a new one.' });
        }

        if (user.reset_otp_attempts >= MAX_OTP_ATTEMPTS) {
            await User.clearResetOtp(user.id);
            return res.status(429).json({ success: false, message: 'Too many incorrect attempts. Please request a new code.' });
        }

        const matches = await bcrypt.compare(otp, user.reset_otp_hash);

        if (!matches) {
            await User.incrementOtpAttempts(user.id);
            const remaining = MAX_OTP_ATTEMPTS - (user.reset_otp_attempts + 1);
            return res.status(400).json({
                success: false,
                message: remaining > 0 ? `Incorrect code. ${remaining} attempt(s) left.` : 'Too many incorrect attempts. Please request a new code.'
            });
        }

        const resetToken = jwt.sign(
            { id: user.id, email: user.email, purpose: 'password_reset' },
            process.env.JWT_SECRET,
            { expiresIn: '10m' }
        );

        res.json({ success: true, message: 'Code verified.', resetToken });

    } catch (err) { next(err); }
};

/**
 * POST /api/auth/reset-password
 * Body: { resetToken, newPassword, confirmPassword }
 * resetToken is the short-lived token issued by /verify-otp -- this is
 * what actually authorizes the change, not the OTP again, so this step
 * can't be replayed once used (see User.clearResetOtp below) or after
 * the 10-minute window closes.
 */
const resetPassword = async (req, res, next) => {
    try {
        const { resetToken, newPassword, confirmPassword } = req.body;

        if (!resetToken || !newPassword || !confirmPassword) {
            return res.status(400).json({ success: false, message: 'All fields are required.' });
        }
        if (newPassword.length < 8) {
            return res.status(400).json({ success: false, message: 'Password must be at least 8 characters.' });
        }
        if (newPassword !== confirmPassword) {
            return res.status(400).json({ success: false, message: 'Passwords do not match.' });
        }

        let payload;
        try {
            payload = jwt.verify(resetToken, process.env.JWT_SECRET);
        } catch (jwtErr) {
            return res.status(401).json({ success: false, message: 'This reset session has expired. Please start over.' });
        }

        if (payload.purpose !== 'password_reset') {
            return res.status(401).json({ success: false, message: 'Invalid reset session. Please start over.' });
        }

        await User.updatePassword(payload.id, newPassword);
        await User.clearResetOtp(payload.id); // defense in depth -- the token is single-use by design already
        await logAudit(payload.id, 'RESET_PASSWORD_VIA_OTP', 'users', payload.id, {}, req.ip);

        res.json({ success: true, message: 'Password updated. You can now sign in with your new password.' });

    } catch (err) { next(err); }
};

/**
 * PUT /api/auth/profile
 * Body: { name, avatar }
 * Self-service profile update -- available to EVERY role, unlike
 * /users/:id which is admin/owner-only. Cashiers can change their
 * profile picture but NOT their name (enforced here regardless of what
 * the client sends, same principle as the role/is_active self-edit lock
 * elsewhere); admins/owners can change both.
 *
 * `avatar` is expected as a data-URL string (e.g. "data:image/jpeg;
 * base64,..."), already resized client-side to a small thumbnail before
 * it ever reaches here -- kept as a reasonably-sized string in the
 * database rather than a file on disk (see the avatar column's own
 * comment in the migration for why).
 */
const updateProfile = async (req, res, next) => {
    try {
        const { name, avatar } = req.body;

        const current = await User.findById(req.user.id);
        if (!current) return res.status(404).json({ success: false, message: 'User not found.' });

        // Cashiers keep their existing name no matter what was sent --
        // they can still see it, just not change it.
        const finalName   = req.user.role === 'cashier' ? current.name : (name || current.name);
        const finalAvatar = avatar !== undefined ? avatar : current.avatar;

        await User.updateProfile(req.user.id, { name: finalName, avatar: finalAvatar });
        await logAudit(req.user.id, 'UPDATE_PROFILE', 'users', req.user.id, { name: finalName }, req.ip);

        res.json({
            success: true,
            message: 'Profile updated.',
            user: { id: req.user.id, name: finalName, avatar: finalAvatar }
        });
    } catch (err) { next(err); }
};

module.exports = {
    login, getMe, getAllUsers, createUser, updateUser, deleteUser, getAuditLogs, exportAuditLogs,
    forgotPassword, verifyOtp, resetPassword, updateProfile,
    requestEmailChangeOtp, confirmEmailChangeOtp
};
