// Forecasting Controller - Endpoints: GET /api/forecasting/products
const db      = require('../config/db');
const Order   = require('../models/Order');
const Product = require('../models/Product');

// GET /api/forecasting/products - Returns all active products for the dropdown selector
const getProductList = async (req, res, next) => {
    try {
        const [rows] = await db.query(
            `SELECT id, name, category, stock_quantity, low_stock_threshold,
                    DATEDIFF(expiry_date, CURDATE()) AS days_to_expiry
             FROM products
             WHERE is_active = 1
             ORDER BY name`
        );
        res.json({ success: true, data: rows });
    } catch (err) {
        next(err);
    }
};

// GET /api/forecasting/data/:productId - Returns weekly sales history for Holt-Winters
const getForecastData = async (req, res, next) => {
    try {
        const { productId } = req.params;
        const weeks = parseInt(req.query.weeks) || 24;

        const product = await Product.findById(productId);
        if (!product) {
            return res.status(404).json({ success: false, message: 'Product not found.' });
        }

        const history    = await Order.getWeeklySalesByProduct(productId, weeks);
        const filled     = fillMissingWeeks(history, weeks);

        // How far back does this product's actual sales history go?
        const [[spanRow]] = await db.query(
            `SELECT DATEDIFF(CURDATE(), MIN(o.created_at)) AS span_days
             FROM order_items oi
             JOIN orders o ON o.id = oi.order_id AND o.status = 'completed'
             WHERE oi.product_id = ?`,
            [productId]
        );
        const data_span_days = spanRow?.span_days ?? null;

        res.json({
            success: true,
            product: {
                id:             product.id,
                name:           product.name,
                category:       product.category,
                stock_quantity: product.stock_quantity,
                reorder_level:  product.low_stock_threshold,
                price:          product.price
            },
            history:          filled,
            weeks_of_history: filled.length,
            data_span_days,
            note: 'Holt-Winters forecasting is performed client-side for transparency and auditability.'
        });
    } catch (err) {
        next(err);
    }
};

// GET /api/forecasting/trending - Top 4 products by sales velocity
const getTrendingProducts = async (req, res, next) => {
    try {
        // Current 4-week window vs previous 4-week window
        const [rows] = await db.query(
            `SELECT
                p.id,
                p.name,
                p.category,
                p.stock_quantity,
                p.low_stock_threshold,

                -- Current 4 weeks
                COALESCE(SUM(CASE
                    WHEN o.created_at >= DATE_SUB(CURDATE(), INTERVAL 4 WEEK)
                    THEN oi.quantity ELSE 0
                END), 0) AS current_qty,

                -- Previous 4 weeks
                COALESCE(SUM(CASE
                    WHEN o.created_at >= DATE_SUB(CURDATE(), INTERVAL 8 WEEK)
                     AND o.created_at <  DATE_SUB(CURDATE(), INTERVAL 4 WEEK)
                    THEN oi.quantity ELSE 0
                END), 0) AS prev_qty

             FROM products p
             JOIN order_items oi ON oi.product_id = p.id
             JOIN orders o       ON o.id = oi.order_id AND o.status = 'completed'
             WHERE p.is_active = 1
               AND o.created_at >= DATE_SUB(CURDATE(), INTERVAL 8 WEEK)
             GROUP BY p.id, p.name, p.category, p.stock_quantity, p.low_stock_threshold
             HAVING current_qty > 0
             ORDER BY current_qty DESC
             LIMIT 8`
        );

        const trending = rows.map(r => {
            const curr      = parseInt(r.current_qty) || 0;
            const prev      = parseInt(r.prev_qty)    || curr; // avoid div/0
            const trendPct  = prev === 0
                ? 0
                : Math.round(((curr - prev) / prev) * 100);
            const weeklyAvg = Math.round(curr / 4);

            return {
                id:          r.id,
                name:        r.name,
                category:    r.category,
                weekly_avg:  weeklyAvg,
                trend:       trendPct,        // +% or -% vs prior 4 weeks
                current_qty: curr,
                prev_qty:    parseInt(r.prev_qty) || 0
            };
        });

        res.json({ success: true, data: trending });
    } catch (err) {
        next(err);
    }
};

// GET /api/forecasting/restock-suggestions - Products that are low-stock OR will run...
const getRestockSuggestions = async (req, res, next) => {
    try {
        // PER PRODUCT (all the batches of one brand together)
        const [rows] = await db.query(
            `SELECT
                MIN(p.id)                                                                               AS id,
                MIN(p.name)                                                                             AS name,
                MIN(p.category)                                                                         AS category,
                COALESCE(SUM(CASE WHEN p.expiry_date >= CURDATE() THEN p.stock_quantity ELSE 0 END), 0) AS sellable_stock,
                COALESCE(SUM(CASE WHEN p.expiry_date <  CURDATE() THEN p.stock_quantity ELSE 0 END), 0) AS expired_units,
                MAX(p.low_stock_threshold)                                                              AS low_stock_threshold,
                MIN(CASE WHEN p.expiry_date >= CURDATE() AND p.stock_quantity > 0
                         THEN DATEDIFF(p.expiry_date, CURDATE()) END)                                   AS days_to_expiry,
                COALESCE(MAX(s.sold_30d), 0)                                                            AS sold_30d

             FROM products p
             LEFT JOIN (
                 SELECT LOWER(sp.name) AS brand, SUM(oi.quantity) AS sold_30d
                 FROM order_items oi
                 JOIN orders   o  ON o.id = oi.order_id
                                 AND o.status = 'completed'
                                 AND o.created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
                 JOIN products sp ON sp.id = oi.product_id
                 GROUP BY LOWER(sp.name)
             ) s ON s.brand = LOWER(p.name)
             WHERE p.is_active = 1
             GROUP BY LOWER(p.name)`
        );

        const suggestions = [];

        for (const r of rows) {
            const stock      = parseInt(r.sellable_stock)      || 0;   // units that can still be sold
            const expired    = parseInt(r.expired_units)       || 0;
            const threshold  = parseInt(r.low_stock_threshold) || 10;
            const dailyAvg   = (parseFloat(r.sold_30d) || 0) / 30;      // units sold per day over the last 30...
            const daysLeft   = dailyAvg > 0 ? Math.floor(stock / dailyAvg) : 999;   // 999 = no recent sales
            const daysExpiry = (r.days_to_expiry === null || r.days_to_expiry === undefined) ? 999 : parseInt(r.days_to_expiry);

            // Determine if this product needs attention
            let reason = null;
            let urgency = 0; // higher = more urgent, used for sorting

            if (stock <= 0) {
                reason  = expired > 0
                    ? `Out of stock (${expired} expired unit${expired !== 1 ? 's' : ''} cannot be sold)`
                    : 'Out of stock';
                urgency = 100;
            } else if (stock <= threshold) {
                reason  = `Below reorder level (${threshold} units)`;
                urgency = 80;
            } else if (dailyAvg > 0 && daysLeft <= 14) {
                reason  = `Will run out in ~${daysLeft} day${daysLeft !== 1 ? 's' : ''} at current rate`;
                urgency = 60;
            } else if (daysExpiry <= 30 && stock > threshold) {
                reason  = `A batch expires in ${daysExpiry} day${daysExpiry !== 1 ? 's' : ''}`;
                urgency = 40;
            }

            if (!reason) continue; // product is fine, skip

            // Recommend enough stock to cover 30 days + 20 % safety buffer
            const recommended_qty = Math.ceil(Math.max(dailyAvg * 30 * 1.2, threshold * 1.5));

            suggestions.push({
                id:               r.id,           // a live batch of the product: the Restock button opens...
                name:             r.name,
                category:         r.category,
                stock_quantity:   stock,          // sellable units across all its batches
                expired_units:    expired,
                reorder_level:    threshold,
                daily_avg:        Math.round(dailyAvg * 100) / 100,
                days_until_empty: daysLeft,
                days_to_expiry:   daysExpiry,
                reason,
                recommended_qty,
                urgency
            });
        }

        // Sort most urgent first, limit to top 10
        suggestions.sort((a, b) => b.urgency - a.urgency);

        res.json({ success: true, data: suggestions.slice(0, 10) });
    } catch (err) {
        next(err);
    }
};

// GET /api/forecasting/compare/:productId - Server-side Moving Average + Simple...
const compareForecasts = async (req, res, next) => {
    try {
        const { productId } = req.params;

        const product = await Product.findById(productId);
        if (!product) {
            return res.status(404).json({ success: false, message: 'Product not found.' });
        }

        const history = await Order.getWeeklySalesByProduct(productId, 24);
        const filled  = fillMissingWeeks(history, 24);
        const sales   = filled.map(w => w.total_qty);

        // Moving Average (4-week)
        const maPredictions = movingAverageForecast(sales, 4, 4);
        const maFitted      = movingAverageFitted(sales, 4);
        const maMAPE        = calcMAPE(sales.slice(4), maFitted.slice(4));

        // Simple Exponential Smoothing (α = 0.3)
        const alpha          = 0.3;
        const sesFitted      = sesFittedValues(sales, alpha);
        const sesPredictions = sesForecast(sales, alpha, 4);
        const sesMAPE        = calcMAPE(sales, sesFitted);

        // Holt-Winters (client-side - we give MAPE placeholder) The frontend runs...
        const hwNote = 'Holt-Winters runs client-side — MAPE shown after forecast generation.';

        const methods = [
            {
                name:          'Recent Average',
                totalForecast: maPredictions.reduce((s, v) => s + v, 0),
                predictions:   maPredictions,
                mape:          maMAPE === null ? null : maMAPE.toFixed(1),
                bestFor:       'Stable products with no trend or seasonality'
            },
            {
                name:          'Trend-Focused',
                totalForecast: sesPredictions.reduce((s, v) => s + v, 0),
                predictions:   sesPredictions,
                mape:          sesMAPE === null ? null : sesMAPE.toFixed(1),
                bestFor:       'Slowly changing demand, no strong seasonality'
            },
            {
                name:          'Seasonal Expert',
                totalForecast: null,  // calculated on frontend
                predictions:   null,
                mape:          'Calculated on-demand',
                bestFor:       'Recommended for seasonal pharmaceutical demand'
            }
        ];

        // Pick recommendation: lowest MAPE wins, but only among methods...
        let best;
        if (maMAPE === null && sesMAPE === null) {
            best = null;
        } else if (maMAPE === null) {
            best = methods[1];
        } else if (sesMAPE === null) {
            best = methods[0];
        } else {
            best = maMAPE <= sesMAPE ? methods[0] : methods[1];
        }

        res.json({
            success: true,
            product: { id: product.id, name: product.name },
            history: filled,
            methods,
            recommendation: best
                ? `Based on historical data, <strong>${best.name}</strong> has the lowest server-calculated error (MAPE ${best.mape}%). However, if this product shows seasonal patterns, Holt-Winters (generated client-side) will typically outperform both.`
                : `This product has no recorded sales history yet, so neither method can be scored for accuracy. Predictions are still shown, but treat them as rough starting estimates.`
        });
    } catch (err) {
        next(err);
    }
};

// HELPERS

const manilaTime = require('../utils/manilaTime');

/** Fill missing weeks so the time series is continuous. */
function fillMissingWeeks(dbRows, totalWeeks, now = new Date()) {
    const result = [];
    const [y, m, d] = manilaTime.dateString(now).split('-').map(Number);
    const todayDay   = Date.UTC(y, m - 1, d);                 // Manila's date, as a UTC calendar day
    const dayOfWeek = new Date(todayDay).getUTCDay() || 7;    // Mon=1 - Sun=7

    for (let i = totalWeeks - 1; i >= 0; i--) {
        const weekStart = new Date(todayDay + (1 - dayOfWeek - i * 7) * 86400000);   // that week's Monday

        // Includes the YEAR, so it is always clear which year a week belongs to
        const label    = `Week of ${weekStart.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`;
        const yearWeek = getYearWeek(weekStart);
        const found    = dbRows.find(r => r.year_week == yearWeek);

        result.push({
            week_label:    label,
            year_week:     yearWeek,
            total_qty:     found ? parseInt(found.total_qty)       : 0,
            total_revenue: found ? parseFloat(found.total_revenue) : 0
        });
    }

    return result;
}

/** ISO week number -> YYYYWW integer. */
function getYearWeek(date) {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    d.setUTCDate(d.getUTCDate() + 3 - (d.getUTCDay() + 6) % 7);
    const week1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    return d.getUTCFullYear() * 100 +
        Math.round(((d - week1) / 86400000 - 3 + (week1.getUTCDay() + 6) % 7) / 7) + 1;
}

/** Simple Moving Average - fitted values */
function movingAverageFitted(sales, window) {
    return sales.map((_, i) => {
        if (i < window) return null;
        const slice = sales.slice(i - window, i);
        return Math.round(slice.reduce((s, v) => s + v, 0) / window);
    });
}

/** Simple Moving Average - future forecast */
function movingAverageForecast(sales, window, periods) {
    const last   = sales.slice(-window);
    const avg    = Math.round(last.reduce((s, v) => s + v, 0) / window);
    return Array(periods).fill(avg);
}

/** Simple Exponential Smoothing - fitted values */
function sesFittedValues(sales, alpha) {
    const fitted = [sales[0]];
    for (let i = 1; i < sales.length; i++) {
        fitted.push(Math.round(alpha * sales[i - 1] + (1 - alpha) * fitted[i - 1]));
    }
    return fitted;
}

/** Simple Exponential Smoothing - future forecast */
function sesForecast(sales, alpha, periods) {
    const fitted = sesFittedValues(sales, alpha);
    // The forecast for the NEXT week also uses the latest actual sales
    const n      = sales.length;
    const last   = Math.round(alpha * sales[n - 1] + (1 - alpha) * fitted[n - 1]);
    // SES gives flat forecast (no trend captured)
    return Array(periods).fill(last);
}

/** Mean Absolute Percentage Error - ignores zero-actual weeks */
function calcMAPE(actual, fitted) {
    let sum = 0, count = 0;
    for (let i = 0; i < actual.length; i++) {
        if (actual[i] > 0 && fitted[i] != null) {
            sum += Math.abs((actual[i] - fitted[i]) / actual[i]);
            count++;
        }
    }
    // No comparable weeks means accuracy genuinely cannot be measured
    return count === 0 ? null : (sum / count) * 100;
}

module.exports = {
    getProductList,
    getForecastData,
    getTrendingProducts,
    getRestockSuggestions,
    compareForecasts
};