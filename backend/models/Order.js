// ============================================================
// Order Model
// ============================================================
const db = require('../config/db');

const Order = {
    /**
     * generateOrderNumber
     * Format: ORD-YYYYMMDD-XXXX (sequential per day)
     */
    generateOrderNumber: async () => {
        const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
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
            notes = null
        } = orderData;

        const [result] = await executor.query(
            `INSERT INTO orders
             (order_number, cashier_id, subtotal, discount, tax, total,
              payment_method, amount_tendered, change_amount, notes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [order_number, cashier_id, subtotal, discount, tax, total,
             payment_method, amount_tendered, change_amount, notes]
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
            SELECT o.*, u.name AS cashier_name
            FROM orders o
            JOIN users u ON u.id = o.cashier_id
            WHERE o.status = 'completed'
        `;
        const params = [];

        if (startDate) { sql += ' AND DATE(o.created_at) >= ?'; params.push(startDate); }
        if (endDate)   { sql += ' AND DATE(o.created_at) <= ?'; params.push(endDate);   }

        sql += ' ORDER BY o.created_at DESC LIMIT ? OFFSET ?';
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
    }
};

module.exports = Order;