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
            'SELECT id, name, email, role, is_active, created_at FROM users WHERE id = ? LIMIT 1',
            [id]
        );
        return rows[0] || null;
    },

    findAll: async () => {
        const [rows] = await db.query(
            'SELECT id, name, email, role, is_active, created_at FROM users ORDER BY created_at DESC'
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
    }
};

module.exports = User;
