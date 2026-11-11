// Order Model
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
    /** generateOrderNumber - Format: ORD-YYYYMMDD-XXXX (sequential per day) */
    generateOrderNumber: async (saleDate = new Date(), executor = db, offset = 0) => {
        // The number carries the date the sale HAPPENED (Manila time)
        const dateStr = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit'
        }).format(saleDate).replace(/-/g, '');

        const prefix = `ORD-${dateStr}-`;
        const [rows] = await executor.query(
            `SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(order_number, '-', -1) AS UNSIGNED)), 0) AS last_seq
             FROM orders
             WHERE order_number LIKE ?`,
            [prefix + '%']
        );
        const seq = String(Number(rows[0].last_seq) + 1 + offset).padStart(4, '0');
        return `${prefix}${seq}`;
    },

    // The order already saved for an offline-sync duplicate guard key, if any
    findByClientRef: async (clientRef, connection) => {
        const executor = connection || db;
        const [rows] = await executor.query(
            'SELECT id, order_number, cashier_id, status FROM orders WHERE client_ref = ? LIMIT 1',
            [clientRef]
        );
        return rows[0] || null;
    },

    create: async (orderData, connection) => {
        const executor = connection || db;
        const {
            order_number, cashier_id, subtotal, discount = 0,
            tax = 0, total, payment_method, amount_tendered, change_amount,
            notes = null, cash_session_id = null,
            vatable_sales = 0, vat_exempt_sales = 0,
            created_at = null, client_ref = null, parent_order_id = null
        } = orderData;

        // created_at is only passed for an offline sale that keeps the time it...
        const [result] = await executor.query(
            `INSERT INTO orders
             (order_number, cashier_id, subtotal, discount, tax, total,
              payment_method, amount_tendered, change_amount, notes, cash_session_id,
              vatable_sales, vat_exempt_sales, client_ref, parent_order_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`,
            [order_number, cashier_id, subtotal, discount, tax, total,
             payment_method, amount_tendered, change_amount, notes, cash_session_id,
             vatable_sales, vat_exempt_sales, client_ref, parent_order_id, created_at]
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
                   ((o.total - o.tax) - COALESCE(SUM(oi.unit_cost * oi.quantity), 0)) AS profit
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
                COALESCE(SUM(total - tax - (
                    SELECT COALESCE(SUM(oi.unit_cost * oi.quantity), 0)
                    FROM order_items oi WHERE oi.order_id = o.id
                )), 0) AS total_profit,
                COUNT(*) AS transaction_count
             FROM orders o
             WHERE DATE(created_at) = CURDATE() AND status = 'completed'`
        );
        return rows[0];
    },

    // Always returns EXACTLY 12 entries: the 11 calendar months before the current one
    getMonthlySales: async () => {
        const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

        const nowParts = new Intl.DateTimeFormat('en-US', {
            timeZone: 'Asia/Manila', year: 'numeric', month: 'numeric'
        }).formatToParts(new Date());
        const curYear  = parseInt(nowParts.find(p => p.type === 'year').value, 10);
        const curMonth = parseInt(nowParts.find(p => p.type === 'month').value, 10); // 1-12

        const series = [];
        for (let back = 11; back >= 0; back--) {
            const idx = curYear * 12 + (curMonth - 1) - back;
            const y   = Math.floor(idx / 12);
            const m   = (idx % 12) + 1;
            series.push({
                month:        `${y}-${String(m).padStart(2, '0')}`,
                month_label:  `${MONTH_NAMES[m - 1]} ${y}`,
                revenue:      0,
                transactions: 0
            });
        }

        const [rows] = await db.query(
            `SELECT
                DATE_FORMAT(created_at, '%Y-%m') AS month,
                SUM(total)                        AS revenue,
                COUNT(*)                          AS transactions
             FROM orders
             WHERE status = 'completed'
               AND created_at >= ?
             GROUP BY DATE_FORMAT(created_at, '%Y-%m')`,
            [`${series[0].month}-01`]
        );

        const byMonth = new Map(rows.map(r => [r.month, r]));
        series.forEach(s => {
            const found = byMonth.get(s.month);
            if (found) {
                s.revenue      = parseFloat(found.revenue) || 0;
                s.transactions = parseInt(found.transactions, 10) || 0;
            }
        });

        return series;
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
             GROUP BY oi.product_name
             ORDER BY total_qty DESC, oi.product_name ASC
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

    // FIX: Added all non-aggregated columns to GROUP BY
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

    // Void support - Scoped to a rolling ONE CALENDAR MONTH window from right now
    findLastCompletedInSession: async () => {
        const [rows] = await db.query(
            `SELECT o.*, u.name AS cashier_name
             FROM orders o
             JOIN users u ON u.id = o.cashier_id
             WHERE o.status = 'completed'
               AND o.created_at >= DATE_SUB(NOW(), INTERVAL 1 MONTH)
             ORDER BY o.created_at DESC LIMIT 1`
        );
        return rows[0] || null;
    },

    // Same scoping as above, but returns up to `limit` recent transactions instead...
    findRecentCompletedInSession: async (limit = 50) => {
        const [rows] = await db.query(
            `SELECT o.*, u.name AS cashier_name
             FROM orders o
             JOIN users u ON u.id = o.cashier_id
             WHERE o.status = 'completed'
               AND o.created_at >= DATE_SUB(NOW(), INTERVAL 1 MONTH)
             ORDER BY o.created_at DESC LIMIT ?`,
            [limit]
        );
        return rows;
    },

    // Fetches ONE specific order by id, but only within the exact same scoping rules...
    findByIdInSession: async (orderId) => {
        const [rows] = await db.query(
            `SELECT o.*, u.name AS cashier_name
             FROM orders o
             JOIN users u ON u.id = o.cashier_id
             WHERE o.id = ?
               AND o.status = 'completed'
               AND o.created_at >= DATE_SUB(NOW(), INTERVAL 1 MONTH)
             LIMIT 1`,
            [orderId]
        );
        return rows[0] || null;
    },

    // Same scoping as findByIdInSession, but run INSIDE an open transaction...
    findByIdInSessionForUpdate: async (orderId, connection) => {
        const [rows] = await connection.query(
            `SELECT o.*, u.name AS cashier_name
             FROM orders o
             JOIN users u ON u.id = o.cashier_id
             WHERE o.id = ?
               AND o.status = 'completed'
               AND o.created_at >= DATE_SUB(NOW(), INTERVAL 1 MONTH)
             LIMIT 1
             FOR UPDATE OF o`,
            [orderId]
        );
        return rows[0] || null;
    }
};

module.exports = Order;
