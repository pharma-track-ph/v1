// ============================================================
// Report Controller
// Sales summaries, expired inventory report, CSV export
// ============================================================
const Order   = require('../models/Order');
const Product = require('../models/Product');
const db      = require('../config/db');

/**
 * GET /api/reports/sales
 * Returns sales data filtered by date range, including items sold per order.
 */
const getSalesReport = async (req, res, next) => {
    try {
        const { start_date, end_date, limit = 500, offset = 0 } = req.query;

        // ── Main orders query ─────────────────────────────────
        let sql = `
            SELECT o.id, o.order_number, o.cashier_id, o.subtotal, o.discount,
                   o.tax, o.total, o.payment_method, o.amount_tendered,
                   o.change_amount, o.status, o.notes, o.created_at,
                   u.name AS cashier_name,
                   COALESCE(SUM(oi.unit_cost * oi.quantity), 0) AS purchase_cost,
                   ((o.subtotal - o.discount) - COALESCE(SUM(oi.unit_cost * oi.quantity), 0)) AS profit
            FROM orders o
            JOIN users u ON u.id = o.cashier_id
            LEFT JOIN order_items oi ON oi.order_id = o.id
            WHERE o.status = 'completed'
        `;
        const params = [];

        if (start_date) { sql += ' AND DATE(o.created_at) >= ?'; params.push(start_date); }
        if (end_date)   { sql += ' AND DATE(o.created_at) <= ?'; params.push(end_date);   }

        sql += ` GROUP BY o.id, o.order_number, o.cashier_id, o.subtotal, o.discount,
                         o.tax, o.total, o.payment_method, o.amount_tendered,
                         o.change_amount, o.status, o.notes, o.created_at, u.name
                 ORDER BY o.created_at DESC LIMIT ? OFFSET ?`;
        params.push(parseInt(limit), parseInt(offset));

        const [orders] = await db.query(sql, params);

        if (!orders.length) {
            return res.json({
                success: true,
                data: [],
                summary: { total_sales: 0, total_cost: 0, total_profit: 0, total_discount: 0, transaction_count: 0 }
            });
        }

        // ── Fetch items for all orders in one query ───────────
        const orderIds = orders.map(o => o.id);
        const placeholders = orderIds.map(() => '?').join(',');
        const [items] = await db.query(
            `SELECT order_id, product_name, quantity, unit_price, subtotal
             FROM order_items
             WHERE order_id IN (${placeholders})
             ORDER BY order_id, id`,
            orderIds
        );

        // Group items by order_id
        const itemsByOrder = {};
        items.forEach(item => {
            if (!itemsByOrder[item.order_id]) itemsByOrder[item.order_id] = [];
            itemsByOrder[item.order_id].push(item);
        });

        // Attach items to each order
        const ordersWithItems = orders.map(o => ({
            ...o,
            items: itemsByOrder[o.id] || []
        }));

        // Compute summary totals
        const totals = ordersWithItems.reduce((acc, o) => ({
            total_sales:       acc.total_sales    + parseFloat(o.total),
            total_cost:        acc.total_cost     + parseFloat(o.purchase_cost || 0),
            total_profit:      acc.total_profit   + parseFloat(o.profit || 0),
            total_discount:    acc.total_discount + parseFloat(o.discount),
            transaction_count: acc.transaction_count + 1
        }), { total_sales: 0, total_cost: 0, total_profit: 0, total_discount: 0, transaction_count: 0 });

        res.json({ success: true, data: ordersWithItems, summary: totals });

    } catch (err) { next(err); }
};

/**
 * GET /api/reports/expired
 * Returns all expired products with estimated value lost.
 * Query params (optional):
 *   months=1|3|6   — only products that expired within the last N*30 days
 *   start_date/end_date — custom range, filtered on the actual expiry_date
 * With no params, returns everything expired (all time) — same as before.
 */
const getExpiredReport = async (req, res, next) => {
    try {
        const { months, start_date, end_date } = req.query;

        let sql = `
            SELECT *,
                    (cost * stock_quantity)           AS value_lost,
                    DATEDIFF(CURDATE(), expiry_date)  AS days_expired
             FROM products
             WHERE expiry_date < CURDATE()
               AND is_active = 1
        `;
        const params = [];

        if (start_date) { sql += ' AND expiry_date >= ?'; params.push(start_date); }
        if (end_date)   { sql += ' AND expiry_date <= ?'; params.push(end_date);   }
        else if (months && months !== 'all') {
            sql += ' AND DATEDIFF(CURDATE(), expiry_date) <= ?';
            params.push(parseInt(months) * 30);
        }

        sql += ' ORDER BY expiry_date ASC';

        const [rows] = await db.query(sql, params);

        const totalLoss = rows.reduce((s, r) => s + parseFloat(r.value_lost), 0);

        res.json({
            success: true,
            data: rows,
            summary: {
                total_products: rows.length,
                total_value_lost: totalLoss
            }
        });
    } catch (err) { next(err); }
};

/**
 * GET /api/reports/dashboard-kpis
 * Returns all KPI values for the dashboard in a single call.
 */
const getDashboardKPIs = async (req, res, next) => {
    try {
        const [todaySales, monthly, topProducts, recent, alertData] = await Promise.all([
            Order.getTodaySales(),
            Order.getMonthlySales(),
            Order.getTopProducts(5),
            Order.getRecentTransactions(5),
            (async () => {
                const [low, near] = await Promise.all([
                    Product.getLowStockCount(),
                    Product.getNearExpiryCount()
                ]);
                return { low_stock: low, near_expiry: near };
            })()
        ]);

        // Attach item-level detail to each recent transaction so the
        // dashboard can show the same expandable row pattern as Reports.
        let recentWithItems = recent;
        if (recent.length) {
            const orderIds = recent.map(o => o.id);
            const placeholders = orderIds.map(() => '?').join(',');
            const [items] = await db.query(
                `SELECT order_id, product_name, quantity, unit_price, subtotal
                 FROM order_items
                 WHERE order_id IN (${placeholders})
                 ORDER BY order_id, id`,
                orderIds
            );
            const itemsByOrder = {};
            items.forEach(item => {
                if (!itemsByOrder[item.order_id]) itemsByOrder[item.order_id] = [];
                itemsByOrder[item.order_id].push(item);
            });
            recentWithItems = recent.map(o => ({ ...o, items: itemsByOrder[o.id] || [] }));
        }

        res.json({
            success: true,
            data: {
                today: todaySales,
                monthly_revenue: monthly,
                top_products: topProducts,
                recent_transactions: recentWithItems,
                alerts: alertData
            }
        });
    } catch (err) { next(err); }
};

/**
 * GET /api/reports/void
 * Returns all voided transactions, with who voided them and when
 * (from audit_logs), plus items sold per order (same expand pattern
 * as the Sales Report).
 */
const getVoidReport = async (req, res, next) => {
    try {
        const { start_date, end_date, limit = 500, offset = 0 } = req.query;

        let sql = `
            SELECT o.id, o.order_number, o.created_at, o.total, o.subtotal, o.discount,
                   cashier.name AS cashier_name,
                   voider.name  AS voided_by_name,
                   al.created_at AS voided_at
            FROM orders o
            JOIN users cashier ON cashier.id = o.cashier_id
            LEFT JOIN audit_logs al ON al.entity = 'orders'
                                   AND al.entity_id = o.id
                                   AND al.action = 'VOID_ORDER'
            LEFT JOIN users voider ON voider.id = al.user_id
            WHERE o.status = 'voided'
        `;
        const params = [];

        if (start_date) { sql += ' AND DATE(o.created_at) >= ?'; params.push(start_date); }
        if (end_date)   { sql += ' AND DATE(o.created_at) <= ?'; params.push(end_date);   }

        sql += ' ORDER BY o.created_at DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limit), parseInt(offset));

        const [orders] = await db.query(sql, params);

        if (!orders.length) {
            return res.json({ success: true, data: [] });
        }

        const orderIds = orders.map(o => o.id);
        const placeholders = orderIds.map(() => '?').join(',');
        const [items] = await db.query(
            `SELECT order_id, product_name, quantity, unit_price, subtotal
             FROM order_items
             WHERE order_id IN (${placeholders})
             ORDER BY order_id, id`,
            orderIds
        );

        const itemsByOrder = {};
        items.forEach(item => {
            if (!itemsByOrder[item.order_id]) itemsByOrder[item.order_id] = [];
            itemsByOrder[item.order_id].push(item);
        });

        const ordersWithItems = orders.map(o => ({ ...o, items: itemsByOrder[o.id] || [] }));

        res.json({ success: true, data: ordersWithItems });

    } catch (err) { next(err); }
};

module.exports = { getSalesReport, getExpiredReport, getDashboardKPIs, getVoidReport };
