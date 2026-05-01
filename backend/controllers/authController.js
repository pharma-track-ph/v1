// ============================================================
// Auth Controller
// Handles login, token refresh, user management (Admin+)
// ============================================================
const jwt     = require('jsonwebtoken');
const User    = require('../models/User');
const { logAudit } = require('../middleware/authMiddleware');

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
            // Log failed attempt
            await logAudit(user.id, 'LOGIN_FAILED', 'users', user.id, { email }, req.ip);
            return res.status(401).json({ success: false, message: 'Invalid email or password.' });
        }

        // Sign JWT with user id and role
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
                id:    user.id,
                name:  user.name,
                email: user.email,
                role:  user.role
            }
        });

    } catch (err) {
        next(err);
    }
};

/**
 * GET /api/auth/me
 * Returns currently authenticated user profile.
 */
const getMe = async (req, res) => {
    res.json({ success: true, user: req.user });
};

/**
 * GET /api/auth/users  [Admin+]
 * Returns all users for user management screen.
 */
const getAllUsers = async (req, res, next) => {
    try {
        const users = await User.findAll();
        res.json({ success: true, data: users });
    } catch (err) { next(err); }
};

/**
 * POST /api/auth/users  [Admin+]
 * Creates a new user. Super Admin can create any role;
 * Admin can only create Cashier accounts.
 */
const createUser = async (req, res, next) => {
    try {
        const { name, email, password, role } = req.body;

        if (!name || !email || !password || !role) {
            return res.status(400).json({ success: false, message: 'All fields are required.' });
        }

        // Admin can only create cashiers; super_admin can create any
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
 */
const updateUser = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { name, email, role, is_active } = req.body;

        // Prevent demoting/disabling own account
        if (parseInt(id) === req.user.id) {
            return res.status(400).json({ success: false, message: 'Cannot modify your own account here.' });
        }

        const affected = await User.update(id, { name, email, role, is_active });

        if (!affected) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }

        await logAudit(req.user.id, 'UPDATE_USER', 'users', id, { name, email, role, is_active }, req.ip);
        res.json({ success: true, message: 'User updated.' });

    } catch (err) { next(err); }
};

/**
 * DELETE /api/auth/users/:id  [Super Admin only]
 * Soft deletes a user account.
 */
const deleteUser = async (req, res, next) => {
    try {
        const { id } = req.params;

        if (parseInt(id) === req.user.id) {
            return res.status(400).json({ success: false, message: 'Cannot delete your own account.' });
        }

        await User.softDelete(id);
        await logAudit(req.user.id, 'DELETE_USER', 'users', id, {}, req.ip);

        res.json({ success: true, message: 'User deactivated.' });

    } catch (err) { next(err); }
};

/**
 * GET /api/auth/audit-logs  [Super Admin only]
 * Returns audit log records with filtering support.
 * Query params: limit, offset, action, user, date_start, date_end
 */
const getAuditLogs = async (req, res, next) => {
    try {
        const { 
            limit = 100, 
            offset = 0,
            action = '',
            user = '',
            date_start = '',
            date_end = ''
        } = req.query;

        let sql = `
            SELECT al.*, u.name AS user_name, u.role AS user_role
            FROM audit_logs al
            JOIN users u ON u.id = al.user_id
            WHERE 1=1
        `;
        const params = [];

        // Filter by action type
        if (action) {
            sql += ' AND al.action = ?';
            params.push(action);
        }

        // Filter by user name or email
        if (user) {
            sql += ' AND (u.name LIKE ? OR u.email LIKE ?)';
            const searchPattern = `%${user}%`;
            params.push(searchPattern, searchPattern);
        }

        // Filter by date range
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

module.exports = { login, getMe, getAllUsers, createUser, updateUser, deleteUser, getAuditLogs };
