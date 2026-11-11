// Authentication & Authorization Middleware - Verifies JWT and enforces Role-Based...
const jwt = require('jsonwebtoken');
const { PASSWORD_VERSION_SQL } = require('../utils/passwordVersion');
const db  = require('../config/db');

// Role hierarchy - Higher index = more permissions
const ROLE_HIERARCHY = { cashier: 0, admin: 1, super_admin: 2 };

/** verifyToken - Validates the Bearer JWT in the Authorization header. */
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
            'SELECT id, name, email, role, is_active, ' + PASSWORD_VERSION_SQL + ' AS pw_version FROM users WHERE id = ?',
            [decoded.id]
        );

        if (!rows.length || !rows[0].is_active) {
            return res.status(401).json({
                success: false,
                message: 'Account not found or deactivated.'
            });
        }

        // A token carries a fingerprint ("pwv") of the password it was issued under.
        if (decoded.pwv && decoded.pwv !== rows[0].pw_version) {
            return res.status(401).json({
                success: false,
                message: 'Your password was changed. Please log in again.'
            });
        }

        const { pw_version, ...currentUser } = rows[0];   // the fingerprint is for this check only
        req.user = currentUser;  // Attach user to request
        // Session start time (JWT 'iat', seconds since epoch)
        req.user.session_iat = decoded.iat;
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

/** requireRole(...roles) - Factory that returns middleware enforcing minimum role... */
const requireRole = (...allowedRoles) => {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ success: false, message: 'Not authenticated.' });
        }

        const userRoleLevel = ROLE_HIERARCHY[req.user.role];

        // If a single role is passed, use hierarchical check
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

/** logAudit(userId, action, entity, entityId, details, ip) Helper to write... */
const logAudit = async (userId, action, entity = null, entityId = null, details = {}, ip = null) => {
    try {
        await db.query(
            `INSERT INTO audit_logs (user_id, action, entity, entity_id, details, ip_address)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [userId, action, entity, entityId, JSON.stringify(details), ip]
        );
    } catch (err) {
        // Audit failures should not crash the app - log and continue
        console.error('[AUDIT LOG FAILED]', err.message);
    }
};

module.exports = { verifyToken, requireRole, logAudit };
