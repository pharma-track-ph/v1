// ============================================================
// Report Controller
// Sales summaries, expired inventory report, void report,
// register report, CSV export
// ============================================================
const Order       = require('../models/Order');
const Product     = require('../models/Product');
const CashSession  = require('../models/CashSession');
const db          = require('../config/db');
const { exportReport, formatShortDate, formatShortDateTime } = require('../utils/reportExporter');

function buildPeriodLabel(start_date, end_date) {
    if (!start_date && !end_date) return null;
    if (start_date && end_date)   return `${start_date} to ${end_date}`;
    return start_date ? `From ${start_date}` : `Until ${end_date}`;
}

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

const SALES_COLUMNS = [
    { label: 'Order #',       excelWidth: 20, pdfWidth: 100 },
    { label: 'Date/Time',     excelWidth: 20, pdfWidth: 95  },
    { label: 'Cashier',       excelWidth: 18, pdfWidth: 80  },
    { label: 'Subtotal',      excelWidth: 12, pdfWidth: 60  },
    { label: 'Purchase Cost', excelWidth: 14, pdfWidth: 65  },
    { label: 'Discount',      excelWidth: 12, pdfWidth: 55  },
    { label: 'Total',         excelWidth: 12, pdfWidth: 60  },
    { label: 'Profit',        excelWidth: 12, pdfWidth: 60  }
];

/**
 * GET /api/reports/sales/export/:format (excel|pdf|word)
 * Exports the same date range currently applied on screen. Purchase Cost
 * and Profit are computed the same way as the on-screen Sales Report
 * (getSalesReport above) — cost is summed from each line item's snapshot
 * unit_cost and is NEVER discounted, since a discount reduces revenue,
 * not what the pharmacy actually paid for the stock. A bold "TOTAL
 * PROFIT" row is appended under the Profit column once all rows are in.
 */
const exportSalesReport = async (req, res, next) => {
    try {
        const { start_date, end_date } = req.query;

        let sql = `
            SELECT o.order_number, o.created_at, o.subtotal, o.discount, o.total,
                   o.payment_method, u.name AS cashier_name,
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
        sql += ` GROUP BY o.id, o.order_number, o.created_at, o.subtotal, o.discount,
                          o.total, o.payment_method, u.name
                 ORDER BY o.created_at DESC`;

        const [orders] = await db.query(sql, params);

        const rows = orders.map(o => [
            o.order_number, formatShortDateTime(o.created_at), o.cashier_name,
            `₱${Number(o.subtotal).toFixed(2)}`, `₱${Number(o.purchase_cost).toFixed(2)}`,
            `₱${Number(o.discount).toFixed(2)}`, `₱${Number(o.total).toFixed(2)}`,
            `₱${Number(o.profit).toFixed(2)}`
        ]);

        let totalsRow = null;
        if (orders.length) {
            const totalProfit = orders.reduce((s, o) => s + parseFloat(o.profit || 0), 0);
            // Label sits under Order # (leftmost column) rather than
            // buried mid-row, so it reads the same way a spreadsheet total
            // normally does -- the actual figure still sits under Profit,
            // the column it's summarizing.
            totalsRow = ['TOTAL PROFIT', '', '', '', '', '', `₱${totalProfit.toFixed(2)}`];
        }

        await exportReport(req.params.format, {
            res,
            title:       'Sales Report',
            generatedBy: req.user.name,
            filename:    'PharmaTrack_Sales_Report',
            columns:     SALES_COLUMNS,
            rows,
            totalsRow,
            periodLabel: buildPeriodLabel(start_date, end_date)
        });
    } catch (err) { next(err); }
};

/**
 * GET /api/reports/expired
 * Returns all expired products with estimated value lost.
 * Excludes batches that have hit 0 stock — once a batch is fully sold out
 * there's no remaining stock to have gone to waste, so it's shown as
 * "Out of Stock" elsewhere in the app instead of counting as an expiry
 * loss here.
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
               AND stock_quantity > 0
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

const EXPIRED_COLUMNS = [
    { label: 'Batch No.',     excelWidth: 16, pdfWidth: 80 },
    { label: 'Product Name',  excelWidth: 26, pdfWidth: 140 },
    { label: 'Category',      excelWidth: 20, pdfWidth: 110 },
    { label: 'Qty',           excelWidth: 8,  pdfWidth: 40 },
    { label: 'Cost (₱)',      excelWidth: 12, pdfWidth: 60 },
    { label: 'Expiry Date',   excelWidth: 13, pdfWidth: 65 },
    { label: 'Days Expired',  excelWidth: 13, pdfWidth: 65 },
    { label: 'Value Lost',    excelWidth: 13, pdfWidth: 70 }
];

/**
 * GET /api/reports/expired/export/:format (excel|pdf|word)
 */
const exportExpiredReport = async (req, res, next) => {
    try {
        const { months, start_date, end_date } = req.query;

        let sql = `
            SELECT *,
                    (cost * stock_quantity)           AS value_lost,
                    DATEDIFF(CURDATE(), expiry_date)  AS days_expired
             FROM products
             WHERE expiry_date < CURDATE()
               AND is_active = 1
               AND stock_quantity > 0
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

        const exportRows = rows.map(p => [
            p.batch_number, p.name, p.category, String(p.stock_quantity),
            `₱${Number(p.cost).toFixed(2)}`, formatShortDate(p.expiry_date),
            `${p.days_expired}d`, `₱${Number(p.value_lost).toFixed(2)}`
        ]);

        let periodLabel = buildPeriodLabel(start_date, end_date);
        if (!periodLabel && months && months !== 'all') periodLabel = `Last ${months} month(s)`;

        await exportReport(req.params.format, {
            res,
            title:       'Expired Inventory Report',
            generatedBy: req.user.name,
            filename:    'PharmaTrack_Expired_Inventory_Report',
            columns:     EXPIRED_COLUMNS,
            rows:        exportRows,
            periodLabel
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
 * `voided_by_name` now correctly reflects the CASHIER whose transaction
 * it was (see posController.js's voidLastOrder) rather than the approving
 * admin/owner — the approver's name lives inside audit_logs.details as
 * `approved_by` instead, for a cashier-requested void.
 */
const getVoidReport = async (req, res, next) => {
    try {
        const { start_date, end_date, limit = 500, offset = 0 } = req.query;

        let sql = `
            SELECT o.id, o.order_number, o.created_at, o.total, o.subtotal, o.discount,
                   cashier.name AS cashier_name,
                   voider.name  AS voided_by_name,
                   al.created_at AS voided_at,
                   al.details   AS void_details
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

const VOID_COLUMNS = [
    { label: 'Order #',    excelWidth: 20, pdfWidth: 100 },
    { label: 'Date/Time',   excelWidth: 20, pdfWidth: 95  },
    { label: 'Cashier',     excelWidth: 18, pdfWidth: 95  },
    { label: 'Voided By',   excelWidth: 18, pdfWidth: 95  },
    { label: 'Voided At',   excelWidth: 20, pdfWidth: 95  },
    { label: 'Total',       excelWidth: 12, pdfWidth: 65  }
];

/**
 * GET /api/reports/void/export/:format (excel|pdf|word)
 */
const exportVoidReport = async (req, res, next) => {
    try {
        const { start_date, end_date } = req.query;

        let sql = `
            SELECT o.order_number, o.created_at, o.total,
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
        sql += ' ORDER BY o.created_at DESC';

        const [orders] = await db.query(sql, params);

        const rows = orders.map(o => [
            o.order_number, formatShortDateTime(o.created_at), o.cashier_name,
            o.voided_by_name || '—', o.voided_at ? formatShortDateTime(o.voided_at) : '—',
            `₱${Number(o.total).toFixed(2)}`
        ]);

        await exportReport(req.params.format, {
            res,
            title:       'Void Report',
            generatedBy: req.user.name,
            filename:    'PharmaTrack_Void_Report',
            columns:     VOID_COLUMNS,
            rows,
            periodLabel: buildPeriodLabel(start_date, end_date)
        });
    } catch (err) { next(err); }
};

/**
 * GET /api/reports/register
 * Every cash register session (open or closed), newest first: who opened
 * it, who approved the open (if a cashier needed approval — null for
 * historical sessions from before that feature existed, or when an
 * admin/owner opened it on their own authority), the opening amount, and
 * the same for the close side (expected/actual/variance/approver).
 */
const getRegisterReport = async (req, res, next) => {
    try {
        const { start_date, end_date, limit = 500, offset = 0 } = req.query;

        const sessions = await CashSession.findAllForReport({
            startDate: start_date, endDate: end_date, limit, offset
        });

        const summary = sessions.reduce((acc, s) => ({
            total_sessions: acc.total_sessions + 1,
            total_opened:   acc.total_opened + parseFloat(s.opening_cash || 0),
            total_variance: acc.total_variance + parseFloat(s.variance || 0),
            open_count:     acc.open_count + (s.status === 'OPEN' ? 1 : 0)
        }), { total_sessions: 0, total_opened: 0, total_variance: 0, open_count: 0 });

        res.json({ success: true, data: sessions, summary });

    } catch (err) { next(err); }
};

const REGISTER_COLUMNS = [
    { label: 'Cashier',            excelWidth: 18, pdfWidth: 80  },
    { label: 'Opened At',           excelWidth: 20, pdfWidth: 90  },
    { label: 'Opening Cash',        excelWidth: 14, pdfWidth: 65  },
    { label: 'Opened Approved By',  excelWidth: 20, pdfWidth: 95  },
    { label: 'Status',              excelWidth: 10, pdfWidth: 50  },
    { label: 'Closed At',           excelWidth: 20, pdfWidth: 90  },
    { label: 'Variance',            excelWidth: 12, pdfWidth: 60  },
    { label: 'Closed Approved By',  excelWidth: 20, pdfWidth: 95  }
];

/**
 * GET /api/reports/register/export/:format (excel|pdf|word)
 */
const exportRegisterReport = async (req, res, next) => {
    try {
        const { start_date, end_date } = req.query;

        const sessions = await CashSession.findAllForReport({
            startDate: start_date, endDate: end_date, limit: 500, offset: 0
        });

        const rows = sessions.map(s => {
            const isOpen = s.status === 'OPEN';
            const varianceVal = parseFloat(s.variance);
            const varianceText = s.status === 'CLOSED' && !isNaN(varianceVal)
                ? `${varianceVal >= 0 ? '+' : ''}₱${varianceVal.toFixed(2)}`
                : '—';
            return [
                s.cashier_name, formatShortDateTime(s.opened_at),
                `₱${Number(s.opening_cash).toFixed(2)}`, s.opened_approved_by_name || '—',
                isOpen ? 'Open' : 'Closed', s.closed_at ? formatShortDateTime(s.closed_at) : '—',
                varianceText, s.closed_approved_by_name || '—'
            ];
        });

        await exportReport(req.params.format, {
            res,
            title:       'Register Report',
            generatedBy: req.user.name,
            filename:    'PharmaTrack_Register_Report',
            columns:     REGISTER_COLUMNS,
            rows,
            periodLabel: buildPeriodLabel(start_date, end_date)
        });
    } catch (err) { next(err); }
};

module.exports = {
    getSalesReport, getExpiredReport, getDashboardKPIs, getVoidReport, getRegisterReport,
    exportSalesReport, exportExpiredReport, exportVoidReport, exportRegisterReport
};
