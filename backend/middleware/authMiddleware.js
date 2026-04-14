// ============================================================
// Authentication & Authorization Middleware
// Verifies JWT and enforces Role-Based Access Control (RBAC)
// Roles: super_admin > admin > cashier
// ============================================================
const jwt = require('jsonwebtoken');
const db  = require('../config/db');

// ── Role hierarchy ────────────────────────────────────────────
// Higher index = more permissions
const ROLE_HIERARCHY = { cashier: 0, admin: 1, super_admin: 2 };

/**
 * verifyToken
 * Validates the Bearer JWT in the Authorization header.
 * Attaches decoded user payload to req.user.
 */
const verifyToken = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                success: false,
                message: 'Access denied. No token provided.'
            });
        }

        const token = authHeader.split(' ')[1];

        // Decode and verify the token signature + expiry
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // Fetch fresh user data (catches deactivated accounts)
        const [rows] = await db.query(
            'SELECT id, name, email, role, is_active FROM users WHERE id = ?',
            [decoded.id]
        );

        if (!rows.length || !rows[0].is_active) {
            return res.status(401).json({
                success: false,
                message: 'Account not found or deactivated.'
            });
        }

        req.user = rows[0];  // Attach user to request
        next();

    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            return res.status(401).json({ success: false, message: 'Token expired. Please log in again.' });
        }
        if (err.name === 'JsonWebTokenError') {
            return res.status(401).json({ success: false, message: 'Invalid token.' });
        }
        next(err);
    }
};

/**
 * requireRole(...roles)
 * Factory that returns middleware enforcing minimum role level.
 * Usage: requireRole('admin') — allows admin and super_admin
 *        requireRole('super_admin') — allows only super_admin
 *        requireRole('cashier', 'admin') — allows specific roles
 *
 * When an array is passed, it checks for an exact role match (allowlist).
 * When a single role string is passed, it uses hierarchy (≥ that level).
 */
const requireRole = (...allowedRoles) => {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ success: false, message: 'Not authenticated.' });
        }

        const userRoleLevel = ROLE_HIERARCHY[req.user.role];

        // If a single role is passed, use hierarchical check (user must be >= that level)
        if (allowedRoles.length === 1 && !Array.isArray(allowedRoles[0])) {
            const requiredLevel = ROLE_HIERARCHY[allowedRoles[0]];
            if (userRoleLevel >= requiredLevel) return next();
        } else {
            // Exact allowlist check
            if (allowedRoles.includes(req.user.role)) return next();
        }

        return res.status(403).json({
            success: false,
            message: `Access denied. Required role: ${allowedRoles.join(' or ')}.`
        });
    };
};

/**
 * logAudit(userId, action, entity, entityId, details, ip)
 * Helper to write to audit_logs table.
 * Called from controllers for significant mutations.
 */
const logAudit = async (userId, action, entity = null, entityId = null, details = {}, ip = null) => {
    try {
        await db.query(
            `INSERT INTO audit_logs (user_id, action, entity, entity_id, details, ip_address)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [userId, action, entity, entityId, JSON.stringify(details), ip]
        );
    } catch (err) {
        // Audit failures should not crash the app — log and continue
        console.error('[AUDIT LOG FAILED]', err.message);
    }
};

module.exports = { verifyToken, requireRole, logAudit };
