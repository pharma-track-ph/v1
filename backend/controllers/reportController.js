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

// -- Who a report is allowed to show ---------------------------------
const isCashier = req => req.user.role === 'cashier';

// The user id a report must be restricted to, or null for "everyone".
// A Pharmacy Assistant (cashier) is ALWAYS restricted to themselves, taken
// from their login token -- any user_id they put in the URL is ignored, so
// this can't be bypassed from the browser. Admin and Owner may narrow a
// report to one person with ?user_id=.
function scopedUserId(req) {
    if (isCashier(req)) return req.user.id;
    const id = parseInt(req.query.user_id, 10);
    return Number.isInteger(id) && id > 0 ? id : null;
}

// For export titles: the name of the person an Admin/Owner filtered by (null
// when nothing was filtered, or for a Pharmacy Assistant's own report).
async function filteredUserName(req, userId) {
    if (!userId || isCashier(req)) return null;
    const [rows] = await db.query('SELECT name FROM users WHERE id = ? LIMIT 1', [userId]);
    return rows[0]?.name || null;
}

const withUser = (title, name) => name ? `${title} (${name})` : title;

// Columns that reveal what the pharmacy pays for stock or earns. A Pharmacy
// Assistant never receives them -- not in the data and not in exports.
const COST_COLUMN_LABELS = ['Purchase Cost', 'Profit', 'Cost (₱)', 'Value Lost'];

function withoutCostColumns(columns, rows) {
    const keep = columns.map((c, i) => COST_COLUMN_LABELS.includes(c.label) ? -1 : i).filter(i => i >= 0);
    return {
        columns: keep.map(i => columns[i]),
        rows:    rows.map(r => keep.map(i => r[i]))
    };
}

/**
 * GET /api/reports/sales
 * Returns sales data filtered by date range, including items sold per order.
 */
const getSalesReport = async (req, res, next) => {
    try {
        const { start_date, end_date, limit = 500, offset = 0 } = req.query;
        const userId   = scopedUserId(req);
        const hideCost = isCashier(req);

        // ── Main orders query ─────────────────────────────────
        let sql = `
            SELECT o.id, o.order_number, o.cashier_id, o.subtotal, o.discount,
                   o.vatable_sales, o.vat_exempt_sales,
                   o.tax, o.total, o.payment_method, o.amount_tendered,
                   o.change_amount, o.status, o.notes, o.created_at,
                   u.name AS cashier_name,
                   parent.order_number AS parent_order_number,
                   COALESCE(SUM(oi.unit_cost * oi.quantity), 0) AS purchase_cost,
                   ((o.total - o.tax) - COALESCE(SUM(oi.unit_cost * oi.quantity), 0)) AS profit
            FROM orders o
            JOIN users u ON u.id = o.cashier_id
            LEFT JOIN orders parent ON parent.id = o.parent_order_id
            LEFT JOIN order_items oi ON oi.order_id = o.id
            WHERE o.status = 'completed'
        `;
        const params = [];

        if (start_date) { sql += ' AND DATE(o.created_at) >= ?'; params.push(start_date); }
        if (end_date)   { sql += ' AND DATE(o.created_at) <= ?'; params.push(end_date);   }
        if (userId)     { sql += ' AND o.cashier_id = ?'; params.push(userId); }

        sql += ` GROUP BY o.id, o.order_number, o.cashier_id, o.subtotal, o.discount,
                         o.vatable_sales, o.vat_exempt_sales,
                         o.tax, o.total, o.payment_method, o.amount_tendered,
                         o.change_amount, o.status, o.notes, o.created_at, u.name, parent.order_number
                 ORDER BY o.created_at DESC LIMIT ? OFFSET ?`;
        params.push(parseInt(limit), parseInt(offset));

        const [orders] = await db.query(sql, params);

        if (!orders.length) {
            return res.json({
                success: true,
                data: [],
                summary: hideCost
                    ? { total_sales: 0, total_discount: 0, transaction_count: 0 }
                    : { total_sales: 0, total_cost: 0, total_profit: 0, total_discount: 0, transaction_count: 0 }
            });
        }

        // ── Fetch items for all orders in one query ───────────
        const orderIds = orders.map(o => o.id);
        const placeholders = orderIds.map(() => '?').join(',');
        const [items] = await db.query(
            `SELECT order_id, product_name, quantity, unit_price, subtotal,
                    is_tax_exempt, discount_amount
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

        // A Pharmacy Assistant never receives purchase cost or profit -- they are
        // removed here on the server, not just hidden on the page.
        if (hideCost) {
            ordersWithItems.forEach(o => { delete o.purchase_cost; delete o.profit; });
            delete totals.total_cost;
            delete totals.total_profit;
        }

        res.json({ success: true, data: ordersWithItems, summary: totals });

    } catch (err) { next(err); }
};

// What every Sales export contains (PDF, Excel, Word, CSV): no Purchase Cost
// and no Profit, for any role. pdfWidth values are relative weights.
const SALES_EXPORT_COLUMNS = [
    { label: 'Order #',      excelWidth: 20, pdfWidth: 100 },
    { label: 'Date/Time',    excelWidth: 26, pdfWidth: 118 },
    { label: 'Processed By', excelWidth: 24, pdfWidth: 120 },
    { label: 'Subtotal',     excelWidth: 14, pdfWidth: 70  },
    { label: 'Discount',     excelWidth: 14, pdfWidth: 70  },
    { label: 'Total',        excelWidth: 14, pdfWidth: 70  }
];

const SALES_COLUMNS = [
    { label: 'Order #',            excelWidth: 20, pdfWidth: 100 },
    { label: 'Date/Time',          excelWidth: 26, pdfWidth: 108 },
    { label: 'Processed By',       excelWidth: 22, pdfWidth: 95  },
    { label: 'Subtotal',           excelWidth: 12, pdfWidth: 60  },
    { label: 'Purchase Cost',      excelWidth: 14, pdfWidth: 65  },
    { label: 'Discount',           excelWidth: 12, pdfWidth: 55  },
    { label: 'Total',              excelWidth: 12, pdfWidth: 60  },
    { label: 'Profit',             excelWidth: 12, pdfWidth: 60  }
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
        const userId = scopedUserId(req);

        let sql = `
            SELECT o.order_number, o.created_at, o.subtotal, o.discount, o.total,
                   o.payment_method, u.name AS cashier_name
            FROM orders o
            JOIN users u ON u.id = o.cashier_id
            WHERE o.status = 'completed'
        `;
        const params = [];
        if (start_date) { sql += ' AND DATE(o.created_at) >= ?'; params.push(start_date); }
        if (end_date)   { sql += ' AND DATE(o.created_at) <= ?'; params.push(end_date);   }
        if (userId)     { sql += ' AND o.cashier_id = ?'; params.push(userId); }
        sql += ' ORDER BY o.created_at DESC';

        const [orders] = await db.query(sql, params);

        // Purchase Cost and Profit are NOT part of any Sales export (PDF, Excel,
        // Word or CSV) -- for every role. The report screen still shows them to
        // Admin and Owner; the export is the document that gets handed around.
        const rows = orders.map(o => [
            o.order_number, formatShortDateTime(o.created_at), o.cashier_name,
            `₱${Number(o.subtotal).toFixed(2)}`,
            `₱${Number(o.discount).toFixed(2)}`,
            `₱${Number(o.total).toFixed(2)}`
        ]);

        const scopeName = await filteredUserName(req, userId);

        // The total sales amount sits alone under the Total column -- just the
        // figure, no "TOTAL" label -- the same way the old export put the
        // total profit under the Profit column.
        let totalsRow = null;
        if (orders.length) {
            const totalSales = orders.reduce((s, o) => s + parseFloat(o.total || 0), 0);
            totalsRow = ['', '', '', '', '', `₱${totalSales.toFixed(2)}`];
        }

        await exportReport(req.params.format, {
            res,
            title:       withUser('Sales Report', scopeName),
            generatedBy: req.user.name,
            filename:    'PharmaTrack_Sales_Report',
            columns:     SALES_EXPORT_COLUMNS,
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

        // A Pharmacy Assistant never receives what the stock cost or the value
        // lost -- those fields are removed from the data itself, not just hidden.
        const hideCost = isCashier(req);
        const data     = hideCost ? rows.map(({ cost, value_lost, ...rest }) => rest) : rows;
        const summary  = hideCost
            ? { total_products: rows.length }
            : { total_products: rows.length, total_value_lost: totalLoss };

        res.json({ success: true, data, summary });
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
            p.batch_number, p.name, String(p.category ?? '').split('|').join(', '), String(p.stock_quantity),
            `₱${Number(p.cost).toFixed(2)}`, formatShortDate(p.expiry_date),
            `${p.days_expired}d`, `₱${Number(p.value_lost).toFixed(2)}`
        ]);

        let periodLabel = buildPeriodLabel(start_date, end_date);
        if (!periodLabel && months && months !== 'all') periodLabel = `Last ${months} month(s)`;

        const out = isCashier(req)
            ? withoutCostColumns(EXPIRED_COLUMNS, exportRows)
            : { columns: EXPIRED_COLUMNS, rows: exportRows };

        await exportReport(req.params.format, {
            res,
            title:       'Expired Inventory Report',
            generatedBy: req.user.name,
            filename:    'PharmaTrack_Expired_Inventory_Report',
            columns:     out.columns,
            rows:        out.rows,
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
                // Profit is worked out from PURCHASE COST, which a Pharmacy Assistant never sees
                // (Reports already withholds it from them). It is left out here on the server for
                // that role, so it cannot be read from the page's data either.
                today: isCashier(req) ? (({ total_profit, ...rest }) => rest)(todaySales) : todaySales,
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
        const userId = scopedUserId(req);

        let sql = `
            SELECT o.id, o.order_number, o.created_at, o.total, o.subtotal, o.discount,
                   cashier.name AS cashier_name,
                   voider.name  AS voided_by_name,
                   al.created_at AS voided_at,
                   al.details   AS void_details,
                   child.order_number AS replaced_by_order_number
            FROM orders o
            JOIN users cashier ON cashier.id = o.cashier_id
            LEFT JOIN audit_logs al ON al.entity = 'orders'
                                   AND al.entity_id = o.id
                                   AND al.action = 'VOID_ORDER'
            LEFT JOIN users voider ON voider.id = al.user_id
            LEFT JOIN orders child ON child.parent_order_id = o.id
            WHERE o.status = 'voided'
        `;
        const params = [];

        if (start_date) { sql += ' AND DATE(o.created_at) >= ?'; params.push(start_date); }
        if (end_date)   { sql += ' AND DATE(o.created_at) <= ?'; params.push(end_date);   }
        // A person's void report = voids of sales they rang up OR voids they
        // performed themselves (the audit entry's user is whoever performed it)
        if (userId)     { sql += ' AND (o.cashier_id = ? OR al.user_id = ?)'; params.push(userId, userId); }

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

        // The audit entry written at void time says whether this was a PARTIAL
        // void (and what was voided, the refund, and the replacement receipt).
        const ordersWithItems = orders.map(o => {
            let details = o.void_details;
            if (typeof details === 'string') { try { details = JSON.parse(details); } catch { details = null; } }
            const isPartial = !!(details && details.partial) || !!o.replaced_by_order_number;
            return {
                ...o,
                items:                    itemsByOrder[o.id] || [],
                is_partial:               isPartial,
                refund_amount:            isPartial ? (details?.refund_amount ?? null) : null,
                voided_items:             isPartial ? (details?.voided_items || []) : [],
                replaced_by_order_number: o.replaced_by_order_number || details?.replacement_order_number || null
            };
        });

        res.json({ success: true, data: ordersWithItems });

    } catch (err) { next(err); }
};

const VOID_COLUMNS = [
    { label: 'Order #',            excelWidth: 20, pdfWidth: 90  },
    { label: 'Date/Time',           excelWidth: 26, pdfWidth: 108 },
    { label: 'Processed By',        excelWidth: 22, pdfWidth: 95  },
    { label: 'Voided By',           excelWidth: 18, pdfWidth: 90  },
    { label: 'Voided At',           excelWidth: 26, pdfWidth: 108 },
    { label: 'Total',               excelWidth: 12, pdfWidth: 60  },
    { label: 'Details',             excelWidth: 36, pdfWidth: 150 }
];

/**
 * GET /api/reports/void/export/:format (excel|pdf|word)
 */
const exportVoidReport = async (req, res, next) => {
    try {
        const { start_date, end_date } = req.query;
        const userId = scopedUserId(req);

        let sql = `
            SELECT o.order_number, o.created_at, o.total,
                   cashier.name AS cashier_name,
                   voider.name  AS voided_by_name,
                   al.created_at AS voided_at,
                   al.details    AS void_details,
                   child.order_number AS replaced_by_order_number
            FROM orders o
            JOIN users cashier ON cashier.id = o.cashier_id
            LEFT JOIN audit_logs al ON al.entity = 'orders'
                                   AND al.entity_id = o.id
                                   AND al.action = 'VOID_ORDER'
            LEFT JOIN users voider ON voider.id = al.user_id
            LEFT JOIN orders child ON child.parent_order_id = o.id
            WHERE o.status = 'voided'
        `;
        const params = [];
        if (start_date) { sql += ' AND DATE(o.created_at) >= ?'; params.push(start_date); }
        if (end_date)   { sql += ' AND DATE(o.created_at) <= ?'; params.push(end_date);   }
        if (userId)     { sql += ' AND (o.cashier_id = ? OR al.user_id = ?)'; params.push(userId, userId); }
        sql += ' ORDER BY o.created_at DESC';

        const [orders] = await db.query(sql, params);

        const rows = orders.map(o => {
            let details = o.void_details;
            if (typeof details === 'string') { try { details = JSON.parse(details); } catch { details = null; } }
            const replacedBy = o.replaced_by_order_number || details?.replacement_order_number || null;
            const detailText = (details && details.partial) || replacedBy
                ? `Partial void, replaced by ${replacedBy || 'a new receipt'}` +
                  (details?.refund_amount != null ? ` (refund ₱${Number(details.refund_amount).toFixed(2)})` : '')
                : 'Full void';
            return [
                o.order_number, formatShortDateTime(o.created_at), o.cashier_name,
                o.voided_by_name || '—', o.voided_at ? formatShortDateTime(o.voided_at) : '—',
                `₱${Number(o.total).toFixed(2)}`,
                detailText
            ];
        });

        const scopeName = await filteredUserName(req, userId);

        await exportReport(req.params.format, {
            res,
            title:       withUser('Void Report', scopeName),
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
        const userId = scopedUserId(req);

        const sessions = await CashSession.findAllForReport({
            startDate: start_date, endDate: end_date, cashierId: userId, limit, offset
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
    { label: 'Processed By',       excelWidth: 22, pdfWidth: 90  },
    { label: 'Opened At',           excelWidth: 26, pdfWidth: 108 },
    { label: 'Opening Cash',        excelWidth: 14, pdfWidth: 60  },
    { label: 'Opened Approved By',  excelWidth: 20, pdfWidth: 90  },
    { label: 'Status',              excelWidth: 10, pdfWidth: 45  },
    { label: 'Closed At',           excelWidth: 26, pdfWidth: 108 },
    { label: 'Variance',            excelWidth: 12, pdfWidth: 55  },
    { label: 'Closed Approved By',  excelWidth: 20, pdfWidth: 90  }
];

/**
 * GET /api/reports/register/export/:format (excel|pdf|word)
 */
const exportRegisterReport = async (req, res, next) => {
    try {
        const { start_date, end_date } = req.query;
        const userId = scopedUserId(req);

        const sessions = await CashSession.findAllForReport({
            startDate: start_date, endDate: end_date, cashierId: userId, limit: 500, offset: 0
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
            title:       withUser('Register Report', await filteredUserName(req, userId)),
            generatedBy: req.user.name,
            filename:    'PharmaTrack_Register_Report',
            columns:     REGISTER_COLUMNS,
            rows,
            periodLabel: buildPeriodLabel(start_date, end_date)
        });
    } catch (err) { next(err); }
};

/**
 * GET /api/reports/users  [Admin and Owner only -- see reportRoutes.js]
 * Feeds the "User" filter dropdown on the Reports page: every account that
 * could appear in a report, inactive ones included (their past sales still
 * show up). Names and roles only -- never emails or anything sensitive.
 */
const getReportUsers = async (req, res, next) => {
    try {
        const [rows] = await db.query(
            'SELECT id, name, role, is_active FROM users ORDER BY is_active DESC, name ASC'
        );
        res.json({ success: true, data: rows });
    } catch (err) { next(err); }
};

/**
 * GET /api/reports/partial-void/:orderId
 * The full story of ONE partial void, opened from either side: pass the
 * ORIGINAL (voided) sale's id or its REPLACEMENT receipt's id. Returns the
 * original sale, what was voided (per item: sold / voided / kept and the
 * voided amount), who voided it and when, and the replacement receipt with the
 * remaining total -- everything the "View Partial Void" popup shows.
 * A Pharmacy Assistant may only open one they rang up or performed
 * themselves (the same rule as the Void Report).
 */
const getPartialVoidDetails = async (req, res, next) => {
    try {
        const id = parseInt(req.params.orderId, 10);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid order.' });
        }

        const [[picked]] = await db.query('SELECT id, parent_order_id FROM orders WHERE id = ?', [id]);
        if (!picked) {
            return res.status(404).json({ success: false, message: 'Order not found.' });
        }

        // Which side was opened? A replacement receipt points at its original
        // (parent_order_id); an original is found by the receipt that points at it.
        let originalId, replacementId;
        if (picked.parent_order_id) {
            originalId = picked.parent_order_id;
            replacementId = picked.id;
        } else {
            const [[child]] = await db.query('SELECT id FROM orders WHERE parent_order_id = ? LIMIT 1', [picked.id]);
            if (!child) {
                return res.status(404).json({ success: false, message: 'This sale has no partial void.' });
            }
            originalId = picked.id;
            replacementId = child.id;
        }

        const orderSql = `SELECT o.id, o.order_number, o.created_at, o.subtotal, o.discount, o.tax, o.total,
                            o.status, o.cashier_id, u.name AS cashier_name
                     FROM orders o JOIN users u ON u.id = o.cashier_id
                     WHERE o.id = ?`;
        const [[original]]    = await db.query(orderSql, [originalId]);
        const [[replacement]] = await db.query(orderSql, [replacementId]);
        if (!original || !replacement) {
            return res.status(404).json({ success: false, message: 'Partial void not found.' });
        }

        // The audit entry written at void time: who did it, when, what was voided
        const [[audit]] = await db.query(
            `SELECT al.user_id, al.created_at, al.details, performer.name AS voided_by_name
             FROM audit_logs al
             LEFT JOIN users performer ON performer.id = al.user_id
             WHERE al.entity = 'orders' AND al.entity_id = ? AND al.action = 'VOID_ORDER'
             ORDER BY al.id DESC LIMIT 1`,
            [originalId]
        );

        if (isCashier(req) && original.cashier_id !== req.user.id && audit?.user_id !== req.user.id) {
            return res.status(404).json({ success: false, message: 'Partial void not found.' });
        }

        let details = audit?.details;
        if (typeof details === 'string') { try { details = JSON.parse(details); } catch { details = null; } }

        const [itemRows] = await db.query(
            `SELECT order_id, product_name, batch_number, quantity, unit_price, subtotal, discount_amount
             FROM order_items WHERE order_id IN (?, ?) ORDER BY id`,
            [originalId, replacementId]
        );
        const itemsOf = oid => itemRows.filter(i => i.order_id === oid).map(({ order_id, ...rest }) => rest);
        const originalItems = itemsOf(originalId);
        const keptItems     = itemsOf(replacementId);

        // Per item: how many were sold, how many voided, how many kept. Worked
        // out from the two receipts themselves, so it is right even if the audit
        // entry is missing; the voided AMOUNT prefers what the audit entry recorded.
        const byName = new Map();
        originalItems.forEach(i => {
            const e = byName.get(i.product_name) || { name: i.product_name, sold: 0, kept: 0, gross: 0 };
            e.sold += i.quantity;
            e.gross += Number(i.unit_price) * i.quantity;
            byName.set(i.product_name, e);
        });
        keptItems.forEach(i => {
            const e = byName.get(i.product_name);
            if (e) e.kept += i.quantity;
        });

        const auditAmount = new Map();
        (details?.voided_items || []).forEach(v => {
            auditAmount.set(v.name, (auditAmount.get(v.name) || 0) + Number(v.amount));
        });

        const items = [...byName.values()].map(e => {
            const voided = e.sold - e.kept;
            const amount = auditAmount.has(e.name)
                ? auditAmount.get(e.name)
                : (e.sold ? (e.gross / e.sold) * voided : 0);
            return { name: e.name, sold: e.sold, voided, kept: e.kept, amount: Math.round(amount * 100) / 100 };
        });

        const originalTotal = Number(original.total);
        const remaining     = Number(replacement.total);
        const refund = details?.refund_amount != null
            ? Number(details.refund_amount)
            : Math.round((originalTotal - remaining) * 100) / 100;

        res.json({
            success: true,
            data: {
                original:    { ...original,    total: originalTotal, subtotal: Number(original.subtotal), discount: Number(original.discount), items: originalItems },
                replacement: { ...replacement, total: remaining,     subtotal: Number(replacement.subtotal), discount: Number(replacement.discount), items: keptItems },
                items,
                refund_amount:   refund,
                remaining_total: remaining,
                voided_by_name:  audit?.voided_by_name || null,
                voided_at:       audit?.created_at || null,
                approved_by:     details?.approved_by || null
            }
        });
    } catch (err) { next(err); }
};

module.exports = {
    getSalesReport, getExpiredReport, getDashboardKPIs, getVoidReport, getRegisterReport, getReportUsers, getPartialVoidDetails,
    exportSalesReport, exportExpiredReport, exportVoidReport, exportRegisterReport
};
