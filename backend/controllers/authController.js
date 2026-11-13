// Auth Controller - Handles login, token refresh, user management (Admin+)
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const bcrypt  = require('bcryptjs');
const User    = require('../models/User');
const db      = require('../config/db');           // ← FIX: was missing, causes ReferenceError in getAuditLogs
const { logAudit } = require('../middleware/authMiddleware');
const { sendOtpEmail, sendEmailChangeOtp, sendActionOtp } = require('../utils/mailer');
const { exportReport, formatShortDateTime } = require('../utils/reportExporter');
const EmailChangeOtpStore = require('../utils/emailChangeOtpStore');
const ActionOtpStore      = require('../utils/actionOtpStore');
const CashSession         = require('../models/CashSession');
const { plainTextProblem, passwordProblem, avatarProblem, emailProblem } = require('../utils/inputGuards');
const { passwordVersion } = require('../utils/passwordVersion');
const loginThrottle = require('../utils/loginThrottle');

// The login token: who you are, plus a fingerprint of the password it was issued under
const issueToken = (user) => jwt.sign(
    { id: user.id, role: user.role, name: user.name, pwv: passwordVersion(user.password) },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
);

const lockedMessage = (seconds) =>
    `Too many failed attempts. Please try again in ${Math.max(1, Math.ceil(seconds / 60))} minute(s).`;

// ---- Email verification with TWO codes ----
// Code 1 goes to the person making the change, code 2 to the NEW address (proves it is real).
const makeCodePair = async () => {
    const first = String(crypto.randomInt(100000, 1000000));
    let second = String(crypto.randomInt(100000, 1000000));
    while (second === first) second = String(crypto.randomInt(100000, 1000000));
    return { first, second, firstHash: await bcrypt.hash(first, 10), secondHash: await bcrypt.hash(second, 10) };
};

// Sends both codes. Returns null when both went out, otherwise the message to show.
const sendCodePair = async (requesterEmail, newEmail, requesterName, description, codes, tag) => {
    const [toRequester, toNew] = await Promise.allSettled([
        sendActionOtp(requesterEmail, codes.first, requesterName, description),
        sendActionOtp(newEmail, codes.second, requesterName, description)
    ]);
    for (const r of [toRequester, toNew]) {
        if (r.status === 'rejected') console.error(`[${tag}] Failed to send OTP email:`, r.reason?.text || r.reason?.message || r.reason);
    }
    if (toNew.status === 'rejected') return 'Could not send a code to the new email address. Check the address and try again.';
    if (toRequester.status === 'rejected') return 'Could not send the verification email. Please try again later.';
    return null;
};

// Both codes are always compared, so the time taken never reveals which one was wrong.
const codesMatch = async (pending, otp, otpNew) => {
    const first = await bcrypt.compare(String(otp ?? ''), pending.otpHash);
    if (!pending.otpHashNew) return first;
    const second = await bcrypt.compare(String(otpNew ?? ''), pending.otpHashNew);
    return first && second;
};

const wrongCodeMessage = (pending, remaining) => remaining > 0
    ? `${pending.otpHashNew ? 'One or both codes are incorrect.' : 'Incorrect code.'} ${remaining} attempt(s) left.`
    : 'Too many incorrect attempts. Please request a new code.';

/** POST /api/auth/login - Authenticates user and returns a JWT. */
const login = async (req, res, next) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ success: false, message: 'Email and password are required.' });
        }

        const emailKey = String(email).toLowerCase().trim();

        // Locked after too many wrong passwords for this email?
        const lock = loginThrottle.check(emailKey);
        if (lock.locked) {
            return res.status(429).json({ success: false, message: lockedMessage(lock.retryAfterSeconds) });
        }

        const user = await User.findByEmail(emailKey);

        if (!user) {
            // counted too, so the replies never reveal which emails have an account
            const attempt = loginThrottle.fail(emailKey);
            if (attempt.justLocked) {
                return res.status(429).json({ success: false, message: lockedMessage(attempt.retryAfterSeconds) });
            }
            return res.status(401).json({ success: false, message: 'Invalid email or password.' });
        }

        const isMatch = await User.comparePassword(password, user.password);

        if (!isMatch) {
            await logAudit(user.id, 'LOGIN_FAILED', 'users', user.id, { email }, req.ip);
            const attempt = loginThrottle.fail(emailKey);
            if (attempt.justLocked) {
                await logAudit(user.id, 'LOGIN_LOCKED', 'users', user.id,
                    { email, minutes: Math.round(attempt.retryAfterSeconds / 60) }, req.ip);
                return res.status(429).json({ success: false, message: lockedMessage(attempt.retryAfterSeconds) });
            }
            return res.status(401).json({ success: false, message: 'Invalid email or password.' });
        }

        loginThrottle.clear(emailKey);
        const token = issueToken(user);

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

/** GET /api/auth/me - Returns currently authenticated user profile */
const getMe = async (req, res, next) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
        res.json({ success: true, user });
    } catch (err) { next(err); }
};

/** GET /api/auth/users [Admin+] */
const getAllUsers = async (req, res, next) => {
    try {
        const users = await User.findAll();
        res.json({ success: true, data: users });
    } catch (err) { next(err); }
};

/** PUT /api/auth/users/:id [Admin+] - Manages Role and Active-status ONLY */
const updateUser = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { role, is_active } = req.body;

        // Name, email and password are NOT editable through this endpoint any more
        const VALID_ROLES = ['super_admin', 'admin', 'cashier'];
        if (!VALID_ROLES.includes(role)) {
            return res.status(400).json({ success: false, message: 'A valid role is required.' });
        }
        const activeFlag = parseInt(is_active);
        if (activeFlag !== 0 && activeFlag !== 1) {
            return res.status(400).json({ success: false, message: 'Account status must be Active or Inactive.' });
        }
        const isSelf = parseInt(id) === req.user.id;

        // Always fetched - needed below regardless of isSelf
        const target = await User.findById(id);
        if (!target) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }

        // Self-edit: an Admin may change their OWN role or status only
        if (!isSelf) {
            // Owner (super_admin) accounts can only be managed by the account holder...
            if (target.role === 'super_admin') {
                // The ONE thing another Admin may do to an Admin account
                const isReactivation = !target.is_active && role === 'super_admin' && activeFlag === 1;
                if (!isReactivation) {
                    return res.status(403).json({
                        success: false,
                        message: 'Owner accounts can only be managed by the account holder. The only change another Owner can make is reactivating a deactivated Owner account.'
                    });
                }
            }
        }

        // Email is deliberately NOT accepted here anymore
        const roleChanged   = role !== target.role;
        const statusChanged = activeFlag !== (target.is_active ? 1 : 0);

        if (!roleChanged && !statusChanged) {
            return res.json({ success: true, message: 'No changes to save.' });
        }

        // Would this update take an ACTIVE Admin out of the Admin role
        const removesAdmin = target.role === 'super_admin' && !!target.is_active
            && (role !== 'super_admin' || activeFlag !== 1);

        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();

            if (removesAdmin) {
                const [activeAdmins] = await connection.query(
                    "SELECT id FROM users WHERE role = 'super_admin' AND is_active = 1 FOR UPDATE"
                );
                if (activeAdmins.length < 2) {
                    await connection.rollback();
                    return res.status(409).json({
                        success: false,
                        message: 'You are the only active Owner. Create or activate another Owner first, or the system would be left with no Owner.'
                    });
                }
            }

            // name and email are never touched here
            const [updated] = await connection.query(
                'UPDATE users SET role = ?, is_active = ? WHERE id = ?',
                [role, activeFlag, id]
            );

            if (!updated.affectedRows) {
                await connection.rollback();
                return res.status(404).json({ success: false, message: 'User not found.' });
            }

            await connection.commit();
        } catch (txErr) {
            await connection.rollback();
            throw txErr;
        } finally {
            connection.release();
        }

        // One audit entry per thing that actually changed, with before/after
        if (roleChanged) {
            await logAudit(req.user.id, 'CHANGE_USER_ROLE', 'users', id,
                { user: target.name, from_role: target.role, to_role: role }, req.ip);
        }
        if (statusChanged) {
            await logAudit(req.user.id, 'CHANGE_USER_STATUS', 'users', id,
                { user: target.name, from_status: target.is_active ? 'active' : 'inactive', to_status: activeFlag ? 'active' : 'inactive' }, req.ip);
        }

        res.json({ success: true, message: 'User updated.' });

    } catch (err) { next(err); }
};

/** POST /api/auth/users/:id/email-otp/request [Admin+] Body */
const requestEmailChangeOtp = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { newEmail } = req.body;

        if (!newEmail || typeof newEmail !== 'string') {
            return res.status(400).json({ success: false, message: 'New email is required.' });
        }

        const emailIssue = emailProblem(newEmail);
        if (emailIssue) {
            return res.status(400).json({ success: false, message: emailIssue });
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

        const existing = await User.findByEmailIncludingInactive(normalizedEmail);
        if (existing && parseInt(existing.id) !== parseInt(id)) {
            return res.status(409).json({ success: false, message: 'Email already in use by another account.' });
        }

        const requester = await User.findById(req.user.id);

        const codes     = await makeCodePair();
        const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

        // In-memory only - see utils/emailChangeOtpStore.js for why this isn't...
        EmailChangeOtpStore.set(req.user.id, {
            otpHash: codes.firstHash, otpHashNew: codes.secondHash, expiresAt, targetId: id, newEmail: normalizedEmail
        });

        // Code 1 to the Owner making the change, code 2 to the NEW address
        const sendProblem = await sendCodePair(requester.email, normalizedEmail, requester.name,
            `change ${target.name}'s email`, codes, 'requestEmailChangeOtp');
        if (sendProblem) {
            EmailChangeOtpStore.clear(req.user.id);
            return res.status(500).json({ success: false, message: sendProblem });
        }

        res.json({
            success: true,
            requiresNewCode: true,
            sentTo: { current: requester.email, newEmail: normalizedEmail },
            message: 'Verification codes sent.'
        });

    } catch (err) { next(err); }
};

/** POST /api/auth/users/:id/email-otp/confirm [Admin+] Body: { otp } Step 2 */
const confirmEmailChangeOtp = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { otp, otpNew } = req.body;

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

        if (pending.otpHashNew && !otpNew) {
            return res.status(400).json({ success: false, message: 'Enter both verification codes.' });
        }

        const matches = await codesMatch(pending, otp, otpNew);

        if (!matches) {
            EmailChangeOtpStore.incrementAttempts(req.user.id);
            const remaining = MAX_OTP_ATTEMPTS - (pending.attempts + 1);
            return res.status(400).json({ success: false, message: wrongCodeMessage(pending, remaining) });
        }

        // Re-check the target email hasn't been claimed by someone else
        const stillAvailable = await User.findByEmailIncludingInactive(pending.newEmail);
        if (stillAvailable && parseInt(stillAvailable.id) !== parseInt(id)) {
            EmailChangeOtpStore.clear(req.user.id);
            return res.status(409).json({ success: false, message: 'That email was taken by another account while this code was pending. Please start again.' });
        }

        await User.updateEmail(id, pending.newEmail);
        EmailChangeOtpStore.clear(req.user.id);
        await logAudit(req.user.id, 'CHANGE_USER_EMAIL', 'users', id, { new_email: pending.newEmail, new_email_verified: !!pending.otpHashNew }, req.ip);

        res.json({ success: true, message: 'Email updated successfully.', email: pending.newEmail });

    } catch (err) { next(err); }
};

/** POST /api/auth/action-otp/request [Super Admin only] Body: { action */
const requestActionOtp = async (req, res, next) => {
    try {
        const { action, payload = {} } = req.body;
        const validActions = ['create_user', 'update_password', 'delete_user'];

        if (!validActions.includes(action)) {
            return res.status(400).json({ success: false, message: 'Invalid action.' });
        }

        let actionDescription;
        // Names people see: super_admin = Owner (full access), admin = Admin (limited)
        const roleLabels = { super_admin: 'Owner', admin: 'Admin', cashier: 'Pharmacist' };

        if (action === 'create_user') {
            const { name, email, password, role } = payload;
            if (!name || !email || !password || !role) {
                return res.status(400).json({ success: false, message: 'All fields are required.' });
            }
            // A name is plain words (never HTML); a password follows the shared rules
            const nameProblem = plainTextProblem('Name', name);
            if (nameProblem) {
                return res.status(400).json({ success: false, message: nameProblem });
            }
            const pwProblem = passwordProblem(password, { email, name });
            if (pwProblem) {
                return res.status(400).json({ success: false, message: pwProblem });
            }

            const emailIssue = emailProblem(email);
            if (emailIssue) {
                return res.status(400).json({ success: false, message: emailIssue });
            }

            const normalizedEmail = email.toLowerCase().trim();
            // Checked WITHOUT the is_active filter findByEmail normally applies
            const existingAny = await User.findByEmailIncludingInactive(normalizedEmail);

            if (existingAny && existingAny.is_active) {
                return res.status(409).json({ success: false, message: 'Email already in use.' });
            }

            if (existingAny && !existingAny.is_active) {
                // Reactivation instead of a fresh account
                if (req.user.role === 'admin' && existingAny.role !== 'cashier') {
                    return res.status(403).json({ success: false, message: 'Admins can only reactivate Pharmacist accounts.' });
                }
                payload.reactivateUserId = existingAny.id;
                const oldRoleLabel = roleLabels[existingAny.role] || existingAny.role;
                actionDescription = `reactivate the deactivated ${oldRoleLabel} account for ${existingAny.name}, restoring their previous role and access`;
            } else {
                if (req.user.role === 'admin' && role !== 'cashier') {
                    return res.status(403).json({ success: false, message: 'Admins can only create Pharmacist accounts.' });
                }
                actionDescription = `create a new ${roleLabels[role] || role} account for ${name}`;
            }

        } else if (action === 'update_password') {
            const { targetId, newPassword } = payload;
            if (!targetId || !newPassword) {
                return res.status(400).json({ success: false, message: 'Target user and new password are required.' });
            }
            const target = await User.findById(targetId);
            if (!target) {
                return res.status(404).json({ success: false, message: 'User not found.' });
            }
            // the shared password rules, including...
            const pwProblem = passwordProblem(newPassword, { email: target.email, name: target.name });
            if (pwProblem) {
                return res.status(400).json({ success: false, message: pwProblem });
            }
            // Same owner-protection rule as updateUser above
            if (parseInt(targetId) !== req.user.id && target.role === 'super_admin') {
                return res.status(403).json({ success: false, message: 'Owner accounts can only be managed by the account holder.' });
            }
            actionDescription = `change the password for ${target.name}'s account`;

        } else if (action === 'delete_user') {
            const { targetId } = payload;
            if (!targetId) {
                return res.status(400).json({ success: false, message: 'Target user is required.' });
            }

            const isSelfDelete = parseInt(targetId) === req.user.id;

            if (isSelfDelete) {
                // Self-delete is allowed ONLY for a super_admin, and ONLY
                if (req.user.role !== 'super_admin') {
                    return res.status(400).json({ success: false, message: 'Cannot delete your own account.' });
                }
                const allUsersForCount = await User.findAll();
                const activeOwnerCount = allUsersForCount.filter(u => u.role === 'super_admin' && u.is_active).length;
                if (activeOwnerCount < 2) {
                    return res.status(400).json({ success: false, message: 'At least one Owner must remain in the system. You cannot delete your own account while you are the only active Owner.' });
                }
                actionDescription = 'deactivate your own account';
            } else {
                const target = await User.findById(targetId);
                if (!target) {
                    return res.status(404).json({ success: false, message: 'User not found.' });
                }
                if (target.role === 'super_admin') {
                    return res.status(403).json({ success: false, message: 'Owner accounts can only be managed by the account holder.' });
                }
                actionDescription = `deactivate ${target.name}'s account`;
            }
        }

        const requester = await User.findById(req.user.id);
        const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

        // Add User needs TWO codes: one to the Owner, one to the NEW person's address (proves it is real).
        // Every other action keeps its single code to the Owner.
        const needsNewCode = action === 'create_user';
        const newAddress    = needsNewCode ? String(payload.email).toLowerCase().trim() : null;

        if (needsNewCode) {
            const codes = await makeCodePair();
            // In-memory only - see utils/actionOtpStore.js for why.
            ActionOtpStore.set(req.user.id, { otpHash: codes.firstHash, otpHashNew: codes.secondHash, expiresAt, action, payload });

            const sendProblem = await sendCodePair(requester.email, newAddress, requester.name, actionDescription, codes, 'requestActionOtp');
            if (sendProblem) {
                ActionOtpStore.clear(req.user.id);
                return res.status(500).json({ success: false, message: sendProblem });
            }
        } else {
            const otp     = String(crypto.randomInt(100000, 1000000));
            const otpHash = await bcrypt.hash(otp, 10);

            // In-memory only - see utils/actionOtpStore.js for why.
            ActionOtpStore.set(req.user.id, { otpHash, expiresAt, action, payload });

            try {
                await sendActionOtp(requester.email, otp, requester.name, actionDescription);
            } catch (mailErr) {
                // See forgotPassword's comment above
                console.error('[requestActionOtp] Failed to send OTP email:', mailErr?.text || mailErr?.message || mailErr);
                ActionOtpStore.clear(req.user.id);
                return res.status(500).json({ success: false, message: 'Could not send the verification email. Please try again later.' });
            }
        }

        // description included so the frontend can correct its own on-screen wording...
        res.json({
            success: true,
            requiresNewCode: needsNewCode,
            ...(needsNewCode && { sentTo: { current: requester.email, newEmail: newAddress } }),
            message: needsNewCode
                ? 'Verification codes sent.'
                : `A verification code has been sent to ${requester.email}.`,
            data: { description: actionDescription }
        });

    } catch (err) { next(err); }
};

/** POST /api/auth/action-otp/confirm [Super Admin only] Body: { otp } Step 2 */
const confirmActionOtp = async (req, res, next) => {
    try {
        const { otp, otpNew } = req.body;
        if (!otp) {
            return res.status(400).json({ success: false, message: 'Verification code is required.' });
        }

        const pending = ActionOtpStore.get(req.user.id);
        if (!pending || !['create_user', 'update_password', 'delete_user'].includes(pending.action)) {
            return res.status(400).json({ success: false, message: 'No pending action found. Please start again.' });
        }

        if (new Date(pending.expiresAt) < new Date()) {
            ActionOtpStore.clear(req.user.id);
            return res.status(400).json({ success: false, message: 'This code has expired. Please request a new one.' });
        }

        if (pending.attempts >= MAX_OTP_ATTEMPTS) {
            ActionOtpStore.clear(req.user.id);
            return res.status(429).json({ success: false, message: 'Too many incorrect attempts. Please request a new code.' });
        }

        if (pending.otpHashNew && !otpNew) {
            return res.status(400).json({ success: false, message: 'Enter both verification codes.' });
        }

        const matches = await codesMatch(pending, otp, otpNew);
        if (!matches) {
            ActionOtpStore.incrementAttempts(req.user.id);
            const remaining = MAX_OTP_ATTEMPTS - (pending.attempts + 1);
            return res.status(400).json({ success: false, message: wrongCodeMessage(pending, remaining) });
        }

        const { action, payload } = pending;
        let responseMessage;

        if (action === 'create_user') {
            const { name, email, password, role, reactivateUserId } = payload;

            if (reactivateUserId) {
                // Reactivation - re-verify the account is STILL deactivated
                const target = await User.findById(reactivateUserId);
                if (!target) {
                    ActionOtpStore.clear(req.user.id);
                    return res.status(404).json({ success: false, message: 'That account no longer exists.' });
                }
                if (target.is_active) {
                    ActionOtpStore.clear(req.user.id);
                    return res.status(409).json({ success: false, message: 'That account has already been reactivated.' });
                }
                await User.reactivate(reactivateUserId, password);
                await logAudit(req.user.id, 'REACTIVATE_USER', 'users', reactivateUserId, { email, email_verified: !!pending.otpHashNew }, req.ip);
                responseMessage = `Account reactivated -- ${target.name}'s previous role and access have been restored.`;
            } else {
                // Re-check email uniqueness
                const stillAvailable = await User.findByEmail(email.toLowerCase().trim());
                if (stillAvailable) {
                    ActionOtpStore.clear(req.user.id);
                    return res.status(409).json({ success: false, message: 'That email was taken by another account while this code was pending. Please start again.' });
                }
                const id = await User.create({ name, email: email.toLowerCase().trim(), password, role });
                await logAudit(req.user.id, 'CREATE_USER', 'users', id, { name, email, role, email_verified: !!pending.otpHashNew }, req.ip);
                responseMessage = 'User created successfully.';
            }

        } else if (action === 'update_password') {
            const { targetId, newPassword } = payload;
            const target = await User.findById(targetId);
            if (!target) {
                ActionOtpStore.clear(req.user.id);
                return res.status(404).json({ success: false, message: 'User not found.' });
            }
            await User.updatePassword(targetId, newPassword);
            await logAudit(req.user.id, 'RESET_USER_PASSWORD', 'users', targetId, {}, req.ip);
            responseMessage = 'Password updated successfully.';

        } else if (action === 'delete_user') {
            const { targetId } = payload;
            const target = await User.findById(targetId);
            if (!target) {
                ActionOtpStore.clear(req.user.id);
                return res.status(404).json({ success: false, message: 'User not found.' });
            }
            // Re-check the active-owner count for a self-delete
            if (parseInt(targetId) === req.user.id) {
                const allUsersForCount = await User.findAll();
                const activeOwnerCount = allUsersForCount.filter(u => u.role === 'super_admin' && u.is_active).length;
                if (activeOwnerCount < 2) {
                    ActionOtpStore.clear(req.user.id);
                    return res.status(400).json({ success: false, message: 'At least one Owner must remain in the system. You cannot delete your own account while you are the only active Owner.' });
                }
            }
            await User.softDelete(targetId);
            await logAudit(req.user.id, 'DELETE_USER', 'users', targetId, {}, req.ip);
            responseMessage = 'User deactivated.';
        }

        ActionOtpStore.clear(req.user.id);
        res.json({ success: true, message: responseMessage });

    } catch (err) { next(err); }
};

// An Admin (DB role 'admin') may read the Audit Logs
const auditScopeSql = (req) =>
    (req.user.role === 'super_admin' ? '' : " AND u.role = 'cashier'") + " AND al.action <> 'LOGOUT'";

/** GET /api/auth/audit-logs [Owner: every entry | Admin */
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

        // Admin: Pharmacist entries only (Owner: everything) - see auditScopeSql
        sql += auditScopeSql(req);

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
    { label: 'Date/Time',  excelWidth: 26, pdfWidth: 108 },
    { label: 'User',        excelWidth: 18, pdfWidth: 85  },
    { label: 'Role',        excelWidth: 10, pdfWidth: 50  },
    { label: 'Action',      excelWidth: 16, pdfWidth: 80  },
    { label: 'Entity',      excelWidth: 14, pdfWidth: 70  },
    { label: 'Entity ID',   excelWidth: 10, pdfWidth: 50  }
];

// Names people see: super_admin = Owner, admin = Admin, cashier = Pharmacist.
const AUDIT_ROLE_LABELS   = { super_admin: 'Owner', admin: 'Admin', cashier: 'Pharmacist' };
const AUDIT_ENTITY_LABELS = {
    products: 'Product', users: 'User', orders: 'Order', order_items: 'Order Item',
    cash_sessions: 'Cash Session', cash_movements: 'Cash Movement', audit_logs: 'Audit Log',
    backups: 'Backups', app_settings: 'App Settings'
};

/** GET /api/auth/audit-logs/export/:format (excel|pdf|word) Mirrors the exact... */
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

        // Admin: Pharmacist entries only (Owner: everything)
        sql += auditScopeSql(req);

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

/** POST /api/auth/forgot-password - Body: { email } Public endpoint */
const GENERIC_OTP_MESSAGE = 'If that email is registered, a reset code has been sent to it.';
const OTP_EXPIRY_MINUTES  = 15; // matches the EmailJS template's own wording
const MAX_OTP_ATTEMPTS    = 5;

const forgotPassword = async (req, res, next) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ success: false, message: 'Email is required.' });
        }

        const user = await User.findByEmail(email.toLowerCase().trim());

        if (!user) {
            // Deliberately identical response to the "found" case below see...
            return res.json({ success: true, message: GENERIC_OTP_MESSAGE });
        }

        const otp     = String(crypto.randomInt(100000, 1000000)); // 6 digits, never all-zeros-prefixed...
        const otpHash = await bcrypt.hash(otp, 10);
        const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

        await User.setResetOtp(user.id, otpHash, expiresAt);

        try {
            await sendOtpEmail(user.email, otp, user.name);
        } catch (mailErr) {
            // A real registered user whose email genuinely failed to send is worth...
            console.error('[forgotPassword] Failed to send OTP email:', mailErr?.text || mailErr?.message || mailErr);
            return res.status(500).json({ success: false, message: 'Could not send the reset email. Please try again later.' });
        }

        res.json({ success: true, message: GENERIC_OTP_MESSAGE });

    } catch (err) { next(err); }
};

/** POST /api/auth/verify-otp - Body: { email, otp } Checks the 6-digit code... */
const verifyOtp = async (req, res, next) => {
    try {
        const { email, otp } = req.body;
        if (!email || !otp) {
            return res.status(400).json({ success: false, message: 'Email and code are required.' });
        }

        const user = await User.findByEmail(email.toLowerCase().trim());

        // Same generic-sounding failure for "no such user" and "no pending code"
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

/** POST /api/auth/reset-password - Body: { resetToken, newPassword */
const resetPassword = async (req, res, next) => {
    try {
        const { resetToken, newPassword, confirmPassword } = req.body;

        if (!resetToken || !newPassword || !confirmPassword) {
            return res.status(400).json({ success: false, message: 'All fields are required.' });
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

        // The shared password rules...
        const resetUser = await User.findById(payload.id);
        if (!resetUser) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }
        const pwProblem = passwordProblem(newPassword, { email: resetUser.email, name: resetUser.name });
        if (pwProblem) {
            return res.status(400).json({ success: false, message: pwProblem });
        }

        await User.updatePassword(payload.id, newPassword);
        await User.clearResetOtp(payload.id); // defense in depth - the token is single-use by design already
        await logAudit(payload.id, 'RESET_PASSWORD_VIA_OTP', 'users', payload.id, {}, req.ip);

        res.json({ success: true, message: 'Password updated. You can now sign in with your new password.' });

    } catch (err) { next(err); }
};

/** PUT /api/auth/profile - Body: { name, avatar } Self-service profile update */
const updateProfile = async (req, res, next) => {
    try {
        const { name, avatar } = req.body;

        // A name is plain words, and a picture must be a small real image
        const profileProblem = plainTextProblem('Name', name) || avatarProblem(avatar);
        if (profileProblem) {
            return res.status(400).json({ success: false, message: profileProblem });
        }

        const current = await User.findById(req.user.id);
        if (!current) return res.status(404).json({ success: false, message: 'User not found.' });

        // Cashiers keep their existing name no matter what was sent they can still...
        const finalName   = req.user.role === 'cashier' ? current.name : (name || current.name);
        const finalAvatar = avatar !== undefined ? (avatar || null) : current.avatar;

        await User.updateProfile(req.user.id, { name: finalName, avatar: finalAvatar });
        await logAudit(req.user.id, 'UPDATE_PROFILE', 'users', req.user.id, { name: finalName }, req.ip);

        res.json({
            success: true,
            message: 'Profile updated.',
            user: { id: req.user.id, name: finalName, avatar: finalAvatar }
        });
    } catch (err) { next(err); }
};

/** POST /api/auth/change-password-otp/request [Any authenticated role] Body */
const requestChangePasswordOtp = async (req, res, next) => {
    try {
        const { currentPassword, newPassword, checkOnly } = req.body;

        // Every problem is reported together, each against its own field, so the screen can show them all at once
        const errors = {};
        if (!currentPassword) errors.currentPassword = 'Enter your current password.';
        const pwProblem = passwordProblem(newPassword);
        if (pwProblem) errors.newPassword = pwProblem;

        const requester = await User.findByIdWithPassword(req.user.id);
        if (!requester) return res.status(404).json({ success: false, message: 'User not found.' });

        // Wrong current-password guesses are limited like logins: 5 wrong in 15 minutes locks this check for 15 minutes
        const throttleKey = `password-change:${req.user.id}`;
        const lock = loginThrottle.check(throttleKey);
        if (lock.locked) {
            const message = lockedMessage(lock.retryAfterSeconds);
            return res.status(429).json({ success: false, message, errors: { ...errors, currentPassword: message } });
        }
        if (currentPassword) {
            const matches = await User.comparePassword(currentPassword, requester.password);
            if (matches) {
                loginThrottle.clear(throttleKey);
            } else {
                const attempt = loginThrottle.fail(throttleKey);
                errors.currentPassword = attempt.justLocked ? lockedMessage(attempt.retryAfterSeconds) : 'Incorrect password.';
            }
        }
        if (errors.currentPassword || errors.newPassword) {
            // 400, not 401 - these are wrong FORM FIELDS
            return res.status(400).json({ success: false, message: errors.currentPassword || errors.newPassword, errors });
        }

        // checkOnly: the screen only wants to know the fields are right; nothing is emailed or stored
        if (checkOnly === true) return res.json({ success: true, checkOnly: true });

        const otp       = String(crypto.randomInt(100000, 1000000));
        const otpHash   = await bcrypt.hash(otp, 10);
        const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

        // Reuses the same generic in-memory store as the Add User/Change...
        ActionOtpStore.set(req.user.id, {
            otpHash, expiresAt, action: 'self_change_password', payload: { newPassword }
        });

        try {
            await sendActionOtp(requester.email, otp, requester.name, 'change your own account password');
        } catch (mailErr) {
            console.error('[requestChangePasswordOtp] Failed to send OTP email:', mailErr?.text || mailErr?.message || mailErr);
            ActionOtpStore.clear(req.user.id);
            return res.status(500).json({ success: false, message: 'Could not send the verification email. Please try again later.' });
        }

        res.json({ success: true, message: `A verification code has been sent to ${requester.email}.` });

    } catch (err) { next(err); }
};

/** POST /api/auth/change-password-otp/confirm [Any authenticated role] Body: { otp } */
const confirmChangePasswordOtp = async (req, res, next) => {
    try {
        const { otp } = req.body;
        if (!otp) {
            return res.status(400).json({ success: false, message: 'Verification code is required.' });
        }

        const pending = ActionOtpStore.get(req.user.id);
        if (!pending || pending.action !== 'self_change_password') {
            return res.status(400).json({ success: false, message: 'No pending password change found. Please start again.' });
        }

        if (new Date(pending.expiresAt) < new Date()) {
            ActionOtpStore.clear(req.user.id);
            return res.status(400).json({ success: false, message: 'This code has expired. Please request a new one.' });
        }

        if (pending.attempts >= MAX_OTP_ATTEMPTS) {
            ActionOtpStore.clear(req.user.id);
            return res.status(429).json({ success: false, message: 'Too many incorrect attempts. Please request a new code.' });
        }

        const matches = await bcrypt.compare(otp, pending.otpHash);
        if (!matches) {
            ActionOtpStore.incrementAttempts(req.user.id);
            const remaining = MAX_OTP_ATTEMPTS - (pending.attempts + 1);
            return res.status(400).json({
                success: false,
                message: remaining > 0 ? `Incorrect code. ${remaining} attempt(s) left.` : 'Too many incorrect attempts. Please request a new code.'
            });
        }

        await User.updatePassword(req.user.id, pending.payload.newPassword);
        ActionOtpStore.clear(req.user.id);
        await logAudit(req.user.id, 'CHANGE_OWN_PASSWORD', 'users', req.user.id, {}, req.ip);

        // Changing the password ends every login made with the OLD one
        const refreshed = await User.findByEmail(req.user.email);

        res.json({
            success: true,
            message: 'Password updated successfully.',
            ...(refreshed ? { token: issueToken(refreshed) } : {})
        });

    } catch (err) { next(err); }
};

// Self-service email change (any authenticated role) Each person changes THEIR OWN...
// (the email format check is emailProblem() in utils/inputGuards.js)

/** POST /api/auth/change-email-otp/request [Any authenticated role] Body */
const requestChangeEmailOtp = async (req, res, next) => {
    try {
        const { newEmail } = req.body;
        if (!newEmail || typeof newEmail !== 'string') {
            return res.status(400).json({ success: false, message: 'New email is required.' });
        }

        const emailIssue = emailProblem(newEmail);
        if (emailIssue) {
            return res.status(400).json({ success: false, message: emailIssue });
        }
        const normalizedEmail = newEmail.toLowerCase().trim();

        const requester = await User.findById(req.user.id);
        if (!requester) return res.status(404).json({ success: false, message: 'User not found.' });

        if (normalizedEmail === requester.email.toLowerCase()) {
            return res.status(400).json({ success: false, message: 'That is already your email address.' });
        }

        const existing = await User.findByEmailIncludingInactive(normalizedEmail);
        if (existing && parseInt(existing.id) !== req.user.id) {
            return res.status(409).json({ success: false, message: 'That email is already used by another account.' });
        }

        const codes     = await makeCodePair();
        const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

        ActionOtpStore.set(req.user.id, {
            otpHash: codes.firstHash, otpHashNew: codes.secondHash, expiresAt,
            action: 'self_change_email', payload: { newEmail: normalizedEmail }
        });

        // Code 1 to your CURRENT email (proves it is you), code 2 to the NEW address (proves it is real)
        const sendProblem = await sendCodePair(requester.email, normalizedEmail, requester.name,
            'change your own account email', codes, 'requestChangeEmailOtp');
        if (sendProblem) {
            ActionOtpStore.clear(req.user.id);
            return res.status(500).json({ success: false, message: sendProblem });
        }

        res.json({
            success: true,
            requiresNewCode: true,
            sentTo: { current: requester.email, newEmail: normalizedEmail },
            message: 'Verification codes sent.'
        });

    } catch (err) { next(err); }
};

/** POST /api/auth/change-email-otp/confirm [Any authenticated role] Body: { otp } */
const confirmChangeEmailOtp = async (req, res, next) => {
    try {
        const { otp, otpNew } = req.body;
        if (!otp) {
            return res.status(400).json({ success: false, message: 'Verification code is required.' });
        }

        const pending = ActionOtpStore.get(req.user.id);
        if (!pending || pending.action !== 'self_change_email') {
            return res.status(400).json({ success: false, message: 'No pending email change found. Please start again.' });
        }

        if (new Date(pending.expiresAt) < new Date()) {
            ActionOtpStore.clear(req.user.id);
            return res.status(400).json({ success: false, message: 'This code has expired. Please request a new one.' });
        }

        if (pending.attempts >= MAX_OTP_ATTEMPTS) {
            ActionOtpStore.clear(req.user.id);
            return res.status(429).json({ success: false, message: 'Too many incorrect attempts. Please request a new code.' });
        }

        if (pending.otpHashNew && !otpNew) {
            return res.status(400).json({ success: false, message: 'Enter both verification codes.' });
        }

        const matches = await codesMatch(pending, otp, otpNew);
        if (!matches) {
            ActionOtpStore.incrementAttempts(req.user.id);
            const remaining = MAX_OTP_ATTEMPTS - (pending.attempts + 1);
            return res.status(400).json({ success: false, message: wrongCodeMessage(pending, remaining) });
        }

        const newEmail = pending.payload.newEmail;

        // Re-check at confirm time
        const existing = await User.findByEmailIncludingInactive(newEmail);
        if (existing && parseInt(existing.id) !== req.user.id) {
            ActionOtpStore.clear(req.user.id);
            return res.status(409).json({ success: false, message: 'That email was taken by another account while this code was pending. Please start again.' });
        }

        const current  = await User.findById(req.user.id);
        const oldEmail = current?.email || null;

        try {
            await User.updateEmail(req.user.id, newEmail);
        } catch (dbErr) {
            if (dbErr.code === 'ER_DUP_ENTRY') {
                ActionOtpStore.clear(req.user.id);
                return res.status(409).json({ success: false, message: 'That email is already used by another account.' });
            }
            throw dbErr;
        }

        ActionOtpStore.clear(req.user.id);
        await logAudit(req.user.id, 'CHANGE_OWN_EMAIL', 'users', req.user.id, { old_email: oldEmail, new_email: newEmail, new_email_verified: !!pending.otpHashNew }, req.ip);

        res.json({ success: true, message: 'Email updated successfully.', email: newEmail });

    } catch (err) { next(err); }
};

// SIGN OUT (with the register check) - A person with an OPEN register must close it...
const openRegisterReply = (session) => ({
    success: false,
    allowed: false,
    reason:  'register_open',
    message: 'Your register is still open. Close the register before signing out.',
    session: { opened_at: session.opened_at, opening_cash: session.opening_cash }
});

/** GET /api/auth/sign-out-check [any logged-in role] - "may this person sign out?" */
const signOutCheck = async (req, res, next) => {
    try {
        const open = await CashSession.findOpenByCashier(req.user.id);
        if (open) return res.status(409).json(openRegisterReply(open));
        res.json({ success: true, allowed: true });
    } catch (err) { next(err); }
};

/** POST /api/auth/logout [any logged-in role] */
const signOut = async (req, res, next) => {
    try {
        const open = await CashSession.findOpenByCashier(req.user.id);
        if (open) return res.status(409).json(openRegisterReply(open));

        res.json({ success: true, message: 'Signed out.' });
    } catch (err) { next(err); }
};

module.exports = {
    signOutCheck, signOut,
    login, getMe, getAllUsers, updateUser, getAuditLogs, exportAuditLogs,
    forgotPassword, verifyOtp, resetPassword, updateProfile,
    requestEmailChangeOtp, confirmEmailChangeOtp,
    requestActionOtp, confirmActionOtp,
    requestChangePasswordOtp, confirmChangePasswordOtp,
    requestChangeEmailOtp, confirmChangeEmailOtp
};
