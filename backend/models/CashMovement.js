// ============================================================
// CashMovement Model
// Cash In / Cash Out records against an open cash session.
// Every movement records WHO requested it and WHO approved it —
// for a cashier these are two different people (manager approval
// required); for admin/owner they're the same person (self-authority).
// ============================================================
const db = require('../config/db');

const CashMovement = {
    create: async ({ cashSessionId, type, amount, reason, requestedBy, approvedBy }, connection) => {
        const executor = connection || db;
        const [result] = await executor.query(
            `INSERT INTO cash_movements
             (cash_session_id, type, amount, reason, requested_by, approved_by)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [cashSessionId, type, amount, reason, requestedBy, approvedBy]
        );
        return result.insertId;
    },

    getBySession: async (sessionId) => {
        const [rows] = await db.query(
            `SELECT cm.*, req.name AS requested_by_name, appr.name AS approved_by_name
             FROM cash_movements cm
             JOIN users req  ON req.id  = cm.requested_by
             JOIN users appr ON appr.id = cm.approved_by
             WHERE cm.cash_session_id = ?
             ORDER BY cm.created_at ASC`,
            [sessionId]
        );
        return rows;
    }
};

module.exports = CashMovement;
