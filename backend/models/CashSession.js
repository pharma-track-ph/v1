// ============================================================
// CashSession Model
// Tracks a cashier's drawer from Open Register to Close Register.
// Cash-only (no GCash/Card — those were never actually wired up
// in this system, so there's nothing to track for them).
// ============================================================
const db = require('../config/db');

const CashSession = {
    /**
     * Returns the cashier's currently OPEN session, or null.
     * A cashier should only ever have at most one OPEN session at a time —
     * enforced in the controller (transaction + row lock) before insert,
     * not by a database constraint, since MySQL can't easily express
     * "unique while status = OPEN" as a plain UNIQUE key.
     */
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

    create: async (cashierId, openingCash, connection) => {
        const executor = connection || db;
        const [result] = await executor.query(
            `INSERT INTO cash_sessions (cashier_id, opening_cash, status)
             VALUES (?, ?, 'OPEN')`,
            [cashierId, openingCash]
        );
        return result.insertId;
    },

    /**
     * Live totals for an OPEN session — computed on demand from the actual
     * orders/cash_movements rows, never from a running counter. This means
     * a void automatically and correctly drops out of "cash sales" with no
     * extra bookkeeping (voided orders simply don't match status='completed'
     * in the SUM below), and Cash In/Out are always reflected immediately.
     */
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

    // Row-lock helper for the open/close race conditions — call inside a
    // transaction to safely check-then-act without a second concurrent
    // request sneaking in between the check and the write.
    lockOpenByCashier: async (cashierId, connection) => {
        const [rows] = await connection.query(
            `SELECT * FROM cash_sessions WHERE cashier_id = ? AND status = 'OPEN' LIMIT 1 FOR UPDATE`,
            [cashierId]
        );
        return rows[0] || null;
    }
};

module.exports = CashSession;
