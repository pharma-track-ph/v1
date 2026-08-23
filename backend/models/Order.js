// ============================================================
// Order Model
// ============================================================
const db = require('../config/db');

function getManilaDateString() {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Manila',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(new Date());
}

const Order = {
    /**
     * generateOrderNumber
     * Format: ORD-YYYYMMDD-XXXX (sequential per day)
     */
    generateOrderNumber: async () => {
        const dateStr = getManilaDateString().replace(/-/g, '');
        const [rows] = await db.query(
            `SELECT COUNT(*) AS cnt FROM orders
             WHERE DATE(created_at) = CURDATE()`
        );
        const seq = String(rows[0].cnt + 1).padStart(4, '0');
        return `ORD-${dateStr}-${seq}`;
    },

    create: async (orderData, connection) => {
        const executor = connection || db;
        const {
            order_number, cashier_id, subtotal, discount = 0,
            tax = 0, total, payment_method, amount_tendered, change_amount,
            notes = null, cash_session_id = null
        } = orderData;

        const [result] = await executor.query(
            `INSERT INTO orders
             (order_number, cashier_id, subtotal, discount, tax, total,
              payment_method, amount_tendered, change_amount, notes, cash_session_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [order_number, cashier_id, subtotal, discount, tax, total,
             payment_method, amount_tendered, change_amount, notes, cash_session_id]
        );
        return result.insertId;
    },

    findById: async (id) => {
        const [rows] = await db.query(
            `SELECT o.*, u.name AS cashier_name
             FROM orders o
             JOIN users u ON u.id = o.cashier_id
             WHERE o.id = ?`,
            [id]
        );
        return rows[0] || null;
    },

    findAll: async ({ startDate, endDate, limit = 50, offset = 0 } = {}) => {
        let sql = `
            SELECT o.*, u.name AS cashier_name,
                   COALESCE(SUM(oi.unit_cost * oi.quantity), 0) AS purchase_cost,
                   ((o.subtotal - o.discount) - COALESCE(SUM(oi.unit_cost * oi.quantity), 0)) AS profit
            FROM orders o
            JOIN users u ON u.id = o.cashier_id
            LEFT JOIN order_items oi ON oi.order_id = o.id
            WHERE o.status = 'completed'
        `;
        const params = [];

        if (startDate) { sql += ' AND DATE(o.created_at) >= ?'; params.push(startDate); }
        if (endDate)   { sql += ' AND DATE(o.created_at) <= ?'; params.push(endDate);   }

        sql += ` GROUP BY o.id, o.order_number, o.cashier_id, o.subtotal, o.discount,
                         o.tax, o.total, o.payment_method, o.amount_tendered,
                         o.change_amount, o.status, o.notes, o.created_at, u.name
                 ORDER BY o.created_at DESC LIMIT ? OFFSET ?`;
        params.push(parseInt(limit), parseInt(offset));

        const [rows] = await db.query(sql, params);
        return rows;
    },

    getItems: async (orderId) => {
        const [rows] = await db.query(
            'SELECT * FROM order_items WHERE order_id = ?',
            [orderId]
        );
        return rows;
    },

    getTodaySales: async () => {
        const [rows] = await db.query(
            `SELECT
                COALESCE(SUM(total), 0)   AS total_sales,
                COALESCE(SUM(subtotal - (
                    SELECT COALESCE(SUM(oi.unit_cost * oi.quantity), 0)
                    FROM order_items oi WHERE oi.order_id = o.id
                )), 0) AS total_profit,
                COUNT(*) AS transaction_count
             FROM orders o
             WHERE DATE(created_at) = CURDATE() AND status = 'completed'`
        );
        return rows[0];
    },

    getMonthlySales: async () => {
        const [rows] = await db.query(
            `SELECT
                DATE_FORMAT(created_at, '%Y-%m') AS month,
                DATE_FORMAT(created_at, '%b %Y') AS month_label,
                SUM(total)                        AS revenue,
                COUNT(*)                          AS transactions
             FROM orders
             WHERE status = 'completed'
               AND created_at >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)
             GROUP BY DATE_FORMAT(created_at, '%Y-%m'), DATE_FORMAT(created_at, '%b %Y')
             ORDER BY month ASC`
        );
        return rows;
    },

    getTopProducts: async (limit = 5) => {
        const [rows] = await db.query(
            `SELECT
                oi.product_name,
                SUM(oi.quantity)  AS total_qty,
                SUM(oi.subtotal)  AS total_revenue
             FROM order_items oi
             JOIN orders o ON o.id = oi.order_id
             WHERE o.status = 'completed'
             GROUP BY oi.product_id, oi.product_name
             ORDER BY total_qty DESC
             LIMIT ?`,
            [limit]
        );
        return rows;
    },

    getWeeklySalesByProduct: async (productId, weeks = 12) => {
        const [rows] = await db.query(
            `SELECT
                YEARWEEK(o.created_at, 1)       AS year_week,
                MIN(DATE(o.created_at))          AS week_start,
                SUM(oi.quantity)                 AS total_qty,
                SUM(oi.subtotal)                 AS total_revenue
             FROM order_items oi
             JOIN orders o ON o.id = oi.order_id
             WHERE oi.product_id = ?
               AND o.status = 'completed'
               AND o.created_at >= DATE_SUB(CURDATE(), INTERVAL ? WEEK)
             GROUP BY YEARWEEK(o.created_at, 1)
             ORDER BY year_week ASC`,
            [productId, weeks]
        );
        return rows;
    },

    // ── FIX: Added all non-aggregated columns to GROUP BY ────
    getRecentTransactions: async (limit = 5) => {
        const [rows] = await db.query(
            `SELECT o.id, o.order_number, o.total, o.payment_method,
                    o.created_at, u.name AS cashier_name,
                    COUNT(oi.id) AS item_count
             FROM orders o
             JOIN users u ON u.id = o.cashier_id
             LEFT JOIN order_items oi ON oi.order_id = o.id
             WHERE o.status = 'completed'
             GROUP BY o.id, o.order_number, o.total, o.payment_method,
                      o.created_at, u.name
             ORDER BY o.created_at DESC
             LIMIT ?`,
            [limit]
        );
        return rows;
    },

    // -- Void support --------------------------------------------
    // Scoped to a rolling window (VOID_WINDOW_DAYS below) and to the
    // cashier's OWN transactions -- not "any cashier system-wide". This
    // used to also require the transaction be from the CURRENT login
    // session, which meant a mistake noticed the next day (or after
    // logging back in) could never be voided at all. That restriction is
    // gone now on purpose: this only checks "is it yours" and "is it
    // recent enough", regardless of which login session it happened in or
    // whether that day's register has since been closed.
    VOID_WINDOW_DAYS: 10,

    findLastCompletedInSession: async (userId) => {
        const [rows] = await db.query(
            `SELECT o.*, u.name AS cashier_name
             FROM orders o
             JOIN users u ON u.id = o.cashier_id
             WHERE o.cashier_id = ?
               AND o.status = 'completed'
               AND o.created_at >= DATE_SUB(NOW(), INTERVAL ${Order.VOID_WINDOW_DAYS} DAY)
             ORDER BY o.created_at DESC LIMIT 1`,
            [userId]
        );
        return rows[0] || null;
    },

    // Same scoping as above, but returns up to `limit` recent transactions
    // instead of only the single most recent one -- lets the cashier pick
    // WHICH one to void (e.g. a wrong medicine rung up a sale or two, or a
    // day or two, back that wasn't caught right away).
    findRecentCompletedInSession: async (userId, limit = 10) => {
        const [rows] = await db.query(
            `SELECT o.*, u.name AS cashier_name
             FROM orders o
             JOIN users u ON u.id = o.cashier_id
             WHERE o.cashier_id = ?
               AND o.status = 'completed'
               AND o.created_at >= DATE_SUB(NOW(), INTERVAL ${Order.VOID_WINDOW_DAYS} DAY)
             ORDER BY o.created_at DESC LIMIT ?`,
            [userId, limit]
        );
        return rows;
    },

    // Fetches ONE specific order by id, but only within the exact same
    // scoping rules as above -- used when voiding a SPECIFIC chosen
    // transaction rather than just "the last one", so the security
    // boundary is identical either way: still your own order, still
    // within the window, regardless of which one in the list gets picked.
    findByIdInSession: async (orderId, userId) => {
        const [rows] = await db.query(
            `SELECT o.*, u.name AS cashier_name
             FROM orders o
             JOIN users u ON u.id = o.cashier_id
             WHERE o.id = ?
               AND o.cashier_id = ?
               AND o.status = 'completed'
               AND o.created_at >= DATE_SUB(NOW(), INTERVAL ${Order.VOID_WINDOW_DAYS} DAY)
             LIMIT 1`,
            [orderId, userId]
        );
        return rows[0] || null;
    }
};

module.exports = Order;
