// ============================================================
// Report Controller
// Sales summaries, expired inventory report, CSV export
// ============================================================
const Order   = require('../models/Order');
const db      = require('../config/db');

/**
 * GET /api/reports/sales
 * Returns sales data filtered by date range.
 */
const getSalesReport = async (req, res, next) => {
    try {
        const { start_date, end_date, limit = 200, offset = 0 } = req.query;

        const orders = await Order.findAll({ startDate: start_date, endDate: end_date, limit, offset });

        // Compute summary totals
        const totals = orders.reduce((acc, o) => ({
            total_sales:   acc.total_sales   + parseFloat(o.total),
            total_discount:acc.total_discount + parseFloat(o.discount),
            transaction_count: acc.transaction_count + 1
        }), { total_sales: 0, total_discount: 0, transaction_count: 0 });

        res.json({ success: true, data: orders, summary: totals });

    } catch (err) { next(err); }
};

/**
 * GET /api/reports/expired
 * Returns all expired products with estimated value lost.
 */
const getExpiredReport = async (req, res, next) => {
    try {
        const [rows] = await db.query(
            `SELECT *,
                    (cost * stock_quantity)           AS value_lost,
                    DATEDIFF(CURDATE(), expiry_date)  AS days_expired
             FROM products
             WHERE expiry_date < CURDATE()
               AND is_active = 1
             ORDER BY expiry_date ASC`
        );

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
                const Product = require('../models/Product');
                const [low, near] = await Promise.all([
                    Product.getLowStockCount(),
                    Product.getNearExpiryCount()
                ]);
                return { low_stock: low, near_expiry: near };
            })()
        ]);

        res.json({
            success: true,
            data: {
                today: todaySales,
                monthly_revenue: monthly,
                top_products: topProducts,
                recent_transactions: recent,
                alerts: alertData
            }
        });
    } catch (err) { next(err); }
};

module.exports = { getSalesReport, getExpiredReport, getDashboardKPIs };
