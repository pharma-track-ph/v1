// ============================================================
// User Model
// Encapsulates all DB operations for the users table
// ============================================================
const db     = require('../config/db');
const bcrypt = require('bcryptjs');

const User = {
    /**
     * Find a user by email (used during login).
     * Returns the raw row including hashed password for comparison.
     */
    findByEmail: async (email) => {
        const [rows] = await db.query(
            'SELECT * FROM users WHERE email = ? AND is_active = 1 LIMIT 1',
            [email]
        );
        return rows[0] || null;
    },

    findById: async (id) => {
        const [rows] = await db.query(
            'SELECT id, name, email, role, is_active, avatar, created_at FROM users WHERE id = ? LIMIT 1',
            [id]
        );
        return rows[0] || null;
    },

    findAll: async () => {
        const [rows] = await db.query(
            'SELECT id, name, email, role, is_active, avatar, created_at FROM users ORDER BY created_at DESC'
        );
        return rows;
    },

    create: async ({ name, email, password, role }) => {
        const hash = await bcrypt.hash(password, 12);
        const [result] = await db.query(
            'INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)',
            [name, email, hash, role]
        );
        return result.insertId;
    },

    update: async (id, { name, email, role, is_active }) => {
        const [result] = await db.query(
            'UPDATE users SET name = ?, email = ?, role = ?, is_active = ? WHERE id = ?',
            [name, email, role, is_active, id]
        );
        return result.affectedRows;
    },

    updatePassword: async (id, newPassword) => {
        const hash = await bcrypt.hash(newPassword, 12);
        const [result] = await db.query(
            'UPDATE users SET password = ? WHERE id = ?',
            [hash, id]
        );
        return result.affectedRows;
    },

    softDelete: async (id) => {
        const [result] = await db.query(
            'UPDATE users SET is_active = 0 WHERE id = ?',
            [id]
        );
        return result.affectedRows;
    },

    comparePassword: async (plain, hash) => {
        return bcrypt.compare(plain, hash);
    },

    // ── Password reset (OTP) ──────────────────
    // The OTP itself is NEVER stored -- only a bcrypt hash of it, same as
    // a real password, so a database leak alone doesn't expose usable
    // codes. Attempts are tracked to rate-limit brute-forcing a 6-digit
    // code (only ~1 million possibilities); a fresh request resets the
    // counter since it's a new code.
    setResetOtp: async (id, otpHash, expiresAt) => {
        await db.query(
            'UPDATE users SET reset_otp_hash = ?, reset_otp_expires_at = ?, reset_otp_attempts = 0 WHERE id = ?',
            [otpHash, expiresAt, id]
        );
    },

    incrementOtpAttempts: async (id) => {
        await db.query('UPDATE users SET reset_otp_attempts = reset_otp_attempts + 1 WHERE id = ?', [id]);
    },

    clearResetOtp: async (id) => {
        await db.query(
            'UPDATE users SET reset_otp_hash = NULL, reset_otp_expires_at = NULL, reset_otp_attempts = 0 WHERE id = ?',
            [id]
        );
    },

    // ── Self-service profile update (name + avatar) ────
    // Cashiers are only ever allowed to change `avatar` here -- the
    // controller enforces that by simply not passing a new `name` for
    // them, reusing their existing one instead, same pattern as the
    // role/is_active self-edit lock on the Users page.
    updateProfile: async (id, { name, avatar }) => {
        const [result] = await db.query(
            'UPDATE users SET name = ?, avatar = ? WHERE id = ?',
            [name, avatar, id]
        );
        return result.affectedRows;
    }
};

module.exports = User;
