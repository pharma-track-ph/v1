// CashSession Model - Tracks a cashier's drawer from Open Register to Close Register.
const db = require('../config/db');

const CashSession = {
    /** Returns the cashier's currently OPEN session, or null. */
    findOpenByCashier: async (cashierId, connection = null) => {
        const executor = connection || db;
        const [rows] = await executor.query(
            `SELECT * FROM cash_sessions WHERE cashier_id = ? AND status = 'OPEN' LIMIT 1`,
            [cashierId]
        );
        return rows[0] || null;
    },

    findById: async (id, connection = null) => {
        const executor = connection || db;
        const [rows] = await executor.query(
            `SELECT cs.*, u.name AS cashier_name
             FROM cash_sessions cs
             JOIN users u ON u.id = cs.cashier_id
             WHERE cs.id = ?`,
            [id]
        );
        return rows[0] || null;
    },

    /** this cashier opening their register, or null */
    create: async (cashierId, openingCash, openedApprovedBy, connection) => {
        const executor = connection || db;
        const [result] = await executor.query(
            `INSERT INTO cash_sessions (cashier_id, opening_cash, status, opened_approved_by)
             VALUES (?, ?, 'OPEN', ?)`,
            [cashierId, openingCash, openedApprovedBy]
        );
        return result.insertId;
    },

    /** Live totals for an OPEN session */
    getLiveTotals: async (sessionId, connection = null) => {
        const executor = connection || db;

        const [[salesRow]] = await executor.query(
            `SELECT COALESCE(SUM(total), 0) AS cash_sales, COUNT(*) AS transaction_count
             FROM orders WHERE cash_session_id = ? AND status = 'completed'`,
            [sessionId]
        );

        const [[movementRow]] = await executor.query(
            `SELECT
                COALESCE(SUM(CASE WHEN type = 'CASH_IN'  THEN amount ELSE 0 END), 0) AS cash_in,
                COALESCE(SUM(CASE WHEN type = 'CASH_OUT' THEN amount ELSE 0 END), 0) AS cash_out
             FROM cash_movements WHERE cash_session_id = ?`,
            [sessionId]
        );

        return {
            cash_sales:        parseFloat(salesRow.cash_sales),
            transaction_count: parseInt(salesRow.transaction_count),
            cash_in:           parseFloat(movementRow.cash_in),
            cash_out:          parseFloat(movementRow.cash_out)
        };
    },

    close: async (sessionId, { closingCashExpected, closingCashActual, variance, approvedBy }, connection) => {
        const executor = connection || db;
        const [result] = await executor.query(
            `UPDATE cash_sessions
             SET status = 'CLOSED',
                 closing_cash_expected = ?,
                 closing_cash_actual   = ?,
                 variance              = ?,
                 closed_approved_by    = ?,
                 closed_at             = NOW()
             WHERE id = ? AND status = 'OPEN'`,
            [closingCashExpected, closingCashActual, variance, approvedBy, sessionId]
        );
        return result.affectedRows; // 0 means it was already closed (race condition)
    },

    // Row-lock helper for the open/close race conditions
    lockOpenByCashier: async (cashierId, connection) => {
        const [rows] = await connection.query(
            `SELECT * FROM cash_sessions WHERE cashier_id = ? AND status = 'OPEN' LIMIT 1 FOR UPDATE`,
            [cashierId]
        );
        return rows[0] || null;
    },

    /** GET /api/reports/register */
    findAllForReport: async ({ startDate, endDate, cashierId = null, limit = 500, offset = 0 } = {}) => {
        let sql = `
            SELECT cs.*,
                   cashier.name  AS cashier_name,
                   opener.name   AS opened_approved_by_name,
                   closer.name   AS closed_approved_by_name
            FROM cash_sessions cs
            JOIN users cashier      ON cashier.id = cs.cashier_id
            LEFT JOIN users opener  ON opener.id  = cs.opened_approved_by
            LEFT JOIN users closer  ON closer.id  = cs.closed_approved_by
            WHERE 1=1
        `;
        const params = [];

        if (startDate) { sql += ' AND DATE(cs.opened_at) >= ?'; params.push(startDate); }
        if (endDate)   { sql += ' AND DATE(cs.opened_at) <= ?'; params.push(endDate);   }
        // Narrow to ONE person's register sessions
        if (cashierId) { sql += ' AND cs.cashier_id = ?';       params.push(cashierId); }

        sql += ' ORDER BY cs.opened_at DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limit), parseInt(offset));

        const [rows] = await db.query(sql, params);
        return rows;
    }
};

module.exports = CashSession;
