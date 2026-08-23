// ============================================================
// POS Controller
// Checkout with transaction, stock deduction, expiry block
// ============================================================
const db           = require('../config/db');
const Product      = require('../models/Product');
const Order        = require('../models/Order');
const OrderItem    = require('../models/OrderItem');
const User         = require('../models/User');
const CashSession  = require('../models/CashSession');
const { logAudit } = require('../middleware/authMiddleware');

function getManilaDateString() {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Manila',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(new Date());
}

/**
 * Groups raw batch rows (from Product.findAllForPOS) into one card per
 * product name. Assumes rows are already ordered name ASC, expiry ASC.
 * Expired batches are never passed in here — the model query excludes them.
 */
function groupBatchesForPOS(rows) {
    const map = new Map();

    for (const r of rows) {
        const key = r.name;
        if (!map.has(key)) {
            map.set(key, {
                id:                  r.id,           // primary/earliest-expiring batch id
                name:                r.name,
                generic_name:        r.generic_name,
                category:            r.category,
                barcode:             r.barcode,
                price:               r.price,        // price of the soonest-expiring batch (FEFO)
                low_stock_threshold: r.low_stock_threshold,
                stock_quantity:      0,
                batch_ids:           []              // ordered FEFO: soonest-expiring first
            });
        }
        const group = map.get(key);
        group.stock_quantity += r.stock_quantity;
        group.batch_ids.push(r.id);
    }

    return Array.from(map.values()).map(g => {
        let stock_status = 'in_stock';
        if (g.stock_quantity <= 0)                           stock_status = 'out_of_stock';
        else if (g.stock_quantity <= g.low_stock_threshold)  stock_status = 'low_stock';
        return { ...g, stock_status };
    });
}

/**
 * GET /api/pos/products
 * Search products available for sale.
 * Returns only non-expired, in-stock items, grouped one card per
 * product name (batches of the same product are combined and consumed
 * FEFO — first-expiry-first-out — at checkout time).
 */
const searchProducts = async (req, res, next) => {
    try {
        const { q = '', barcode = '' } = req.query;

        if (barcode) {
            const scanned = await Product.findByBarcode(barcode);
            const today   = getManilaDateString();

            if (!scanned || scanned.expiry_date <= today) {
                return res.status(404).json({ success: false, message: 'Product not found for barcode.' });
            }

            // Re-expand the scanned batch into its full product family so the
            // barcode-scan path behaves identically to the search/grid path.
            const familyRows = await Product.findActiveNonExpiredByName(scanned.name);
            const grouped     = groupBatchesForPOS(familyRows);
            return res.json({ success: true, data: grouped });
        }

        const rows    = await Product.findAllForPOS(q);
        const grouped = groupBatchesForPOS(rows);

        res.json({ success: true, data: grouped });

    } catch (err) { next(err); }
};

/**
 * POST /api/pos/checkout
 * Processes the POS transaction.
 *
 * Request body:
 * {
 *   items: [{ product_id, batch_ids, quantity }],
 *   payment_method: 'cash',
 *   amount_tendered: 500,
 *   discount: 0,
 *   notes: '',
 *   cash_session_id: 12   // the OPEN register this sale belongs to
 * }
 *
 * ── Cash register gating ──────────────────────────────────────
 * A sale can only be completed while the cashier has an OPEN cash
 * session ("register"). The frontend sends the `cash_session_id` it
 * had cached at the moment Checkout was clicked — this matters for
 * offline mode: if a sale is queued while offline and only syncs
 * later (possibly after that shift has since closed and a new one
 * opened), we must NOT silently attach it to whatever session happens
 * to be open at sync time. Instead we verify the *specific* session ID
 * the sale was originally meant for is still open, and reject cleanly
 * if not, rather than misattributing it to the wrong shift's totals.
 *
 * The check is done via SELECT ... FOR UPDATE inside this transaction,
 * so it's impossible for a concurrent "Close Register" request to slip
 * in between the check and the order being created — whichever request
 * (checkout or close) begins its transaction first, InnoDB makes the
 * other one wait until the first commits, so there's no window where
 * a sale can be silently lost from a shift's totals.
 *
 * Cart lines represent a *product family* (grouped across batches in the
 * UI), not a single exact batch row. Each line carries an ordered
 * `batch_ids` list (soonest-expiring first / FEFO) built by
 * /api/pos/products. Stock is consumed from the earliest-expiring batch
 * first, spilling into the next batch only if needed — this keeps
 * unit_cost accurate per batch actually sold, so profit reporting stays
 * correct even when a single sale spans multiple batches.
 */
const checkout = async (req, res, next) => {
    const { items, payment_method = 'cash', amount_tendered, discount = 0, notes = '', cash_session_id } = req.body;

    if (!items || !items.length) {
        return res.status(400).json({ success: false, message: 'Cart is empty.' });
    }

    // ── Step 1: Pre-validate & resolve all items across batches ──
    const resolvedItems = [];
    const today = getManilaDateString();

    for (const cartItem of items) {
        const batchIds = Array.isArray(cartItem.batch_ids) && cartItem.batch_ids.length
            ? cartItem.batch_ids
            : [cartItem.product_id]; // backward-compatible fallback: single batch

        let remainingQty  = parseInt(cartItem.quantity) || 0;
        let lastKnownName = null;

        for (const batchId of batchIds) {
            if (remainingQty <= 0) break;

            const product = await Product.findById(batchId);
            if (!product) continue;               // batch may have been removed since page load
            lastKnownName = product.name;

            // Skip (don't hard-fail) batches that expired since the cart was built —
            // the next batch in FEFO order will be tried instead.
            if (product.expiry_date <= today) continue;
            if (product.stock_quantity <= 0)  continue;

            const qtyFromThisBatch = Math.min(remainingQty, product.stock_quantity);

            resolvedItems.push({
                product_id:   product.id,
                batch_number: product.batch_number,
                product_name: product.name,
                quantity:     qtyFromThisBatch,
                unit_price:   product.price,
                unit_cost:    product.cost,
                subtotal:     product.price * qtyFromThisBatch
            });

            remainingQty -= qtyFromThisBatch;
        }

        if (remainingQty > 0) {
            return res.status(400).json({
                success: false,
                blocked: true,
                reason: 'insufficient_stock',
                message: `Insufficient combined stock for ${lastKnownName || 'item'}. Short by ${remainingQty} unit(s).`
            });
        }
    }

    // Calculate totals
    const subtotal       = resolvedItems.reduce((s, i) => s + i.subtotal, 0);
    const discountAmount = parseFloat(discount) || 0;
    const tenderedAmount = parseFloat(amount_tendered) || 0;
    const tax            = 0;  // Pharmacy items in PH are typically VAT-exempt or zero-rated

    if (discountAmount < 0) {
        return res.status(400).json({
            success: false,
            message: 'Discount cannot be negative.'
        });
    }

    if (discountAmount > subtotal) {
        return res.status(400).json({
            success: false,
            message: `Discount (${discountAmount.toFixed(2)}) cannot be greater than subtotal (${subtotal.toFixed(2)}).`
        });
    }

    const total  = subtotal - discountAmount + tax;
    const change = tenderedAmount - total;

    if (change < 0) {
        return res.status(400).json({
            success: false,
            message: `Amount tendered (₱${amount_tendered}) is less than total (₱${total.toFixed(2)}).`
        });
    }

    // ── Steps 2–6: Database transaction ──────────────────────
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        // Row-lock this cashier's open session for the duration of this
        // transaction. If a concurrent Close Register request is also in
        // flight, InnoDB serializes them — whichever started first wins,
        // the other waits, so a sale can never be silently dropped from a
        // shift's totals due to a timing coincidence.
        const openSession = await CashSession.lockOpenByCashier(req.user.id, connection);

        if (!openSession) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                blocked: true,
                reason: 'no_open_register',
                message: 'Please open your register before processing sales.'
            });
        }

        // If the frontend had a specific session cached (the normal case,
        // and the important case for offline-queued sales), it must match
        // the session that's ACTUALLY open right now. A mismatch means the
        // original shift this sale was meant for is no longer open — reject
        // cleanly rather than silently attaching it to a different shift.
        if (cash_session_id && parseInt(cash_session_id) !== openSession.id) {
            await connection.rollback();
            return res.status(409).json({
                success: false,
                blocked: true,
                reason: 'session_mismatch',
                message: 'Your register session has changed since this sale was started. Please refresh and try again.'
            });
        }

        const order_number = await Order.generateOrderNumber();

        // Create order header
        const orderId = await Order.create({
            order_number,
            cashier_id:     req.user.id,
            subtotal,
            discount:       discountAmount,
            tax,
            total,
            payment_method,
            amount_tendered: tenderedAmount,
            change_amount:  change,
            notes,
            cash_session_id: openSession.id
        }, connection);

        // Create order items
        await OrderItem.createBulk(orderId, resolvedItems, connection);

        // Decrement stock for each item
        for (const item of resolvedItems) {
            const affected = await Product.decrementStock(item.product_id, item.quantity, connection);
            if (!affected) {
                throw new Error(`Stock deduction failed for product ${item.product_name}. Possible race condition.`);
            }
        }

        await connection.commit();

        // ── Step 7: Return receipt ────────────────────────────
        await logAudit(req.user.id, 'CHECKOUT', 'orders', orderId, { order_number, total }, req.ip);

        res.status(201).json({
            success: true,
            message: 'Checkout successful.',
            receipt: {
                order_id:     orderId,
                order_number,
                cashier_name: req.user.name,
                items:        resolvedItems,
                subtotal,
                discount:     discountAmount,
                tax,
                total,
                payment_method,
                amount_tendered: tenderedAmount,
                change,
                created_at:   new Date().toISOString()
            }
        });

    } catch (err) {
        await connection.rollback();
        next(err);
    } finally {
        connection.release();
    }
};

/**
 * POST /api/pos/ai-suggest  [Mock endpoint for thesis demo]
 * Accepts a symptom string and returns a placeholder suggestion.
 * ── This is intentionally a mock. ──
 * In production, this would call an AI/ML model (e.g., a fine-tuned
 * classification model or RAG pipeline).
 */
const aiSuggest = async (req, res) => {
    const { symptoms = '' } = req.body;

    // Mock response map for demo purposes
    const mockMap = {
        'headache':      'Paracetamol 500mg',
        'fever':         'Paracetamol 500mg',
        'cough':         'Carbocisteine 500mg',
        'colds':         'Cetirizine 10mg',
        'allergy':       'Cetirizine 10mg',
        'pain':          'Ibuprofen 200mg',
        'hypertension':  'Losartan 50mg',
        'diabetes':      'Metformin 500mg',
        'infection':     'Amoxicillin 500mg',
        'heartburn':     'Omeprazole 20mg',
        'acidity':       'Omeprazole 20mg'
    };

    const lower   = symptoms.toLowerCase();
    let suggestion = null;

    for (const [keyword, medicine] of Object.entries(mockMap)) {
        if (lower.includes(keyword)) {
            suggestion = medicine;
            break;
        }
    }

    res.json({
        success: true,
        suggestion: suggestion || 'Consult pharmacist for proper medication advice.',
        disclaimer: 'This is an AI prototype suggestion only. Always consult a licensed pharmacist.',
        symptoms
    });
};

/**
 * GET /api/pos/void-candidate
 * Returns just the single MOST RECENT transaction (kept for backward
 * compatibility) — new code should use GET /api/pos/void-candidates
 * instead, which returns a list to choose from.
 */
const getVoidCandidate = async (req, res, next) => {
    try {
        const order = await Order.findLastCompletedInSession(req.user.id);

        if (!order) {
            return res.json({ success: true, data: null });
        }

        const items = await OrderItem.findByOrderId(order.id);

        res.json({ success: true, data: { ...order, items } });
    } catch (err) { next(err); }
};

/**
 * GET /api/pos/void-candidates
 * Returns up to the last 10 completed transactions from the last
 * VOID_WINDOW_DAYS days (see Order.js), regardless of login session or
 * whether that day's register has since closed, each with its item list
 * attached, so the cashier can pick which one to void instead of only
 * ever being able to void the very last sale. Useful when a wrong item
 * (e.g. the wrong medicine) wasn't caught until a sale, or a day, or two
 * later.
 */
const getVoidCandidates = async (req, res, next) => {
    try {
        const orders = await Order.findRecentCompletedInSession(req.user.id, 10);

        if (!orders.length) {
            return res.json({ success: true, data: [] });
        }

        const withItems = await Promise.all(
            orders.map(async (order) => ({
                ...order,
                items: await OrderItem.findByOrderId(order.id)
            }))
        );

        res.json({ success: true, data: withItems });
    } catch (err) { next(err); }
};

/**
 * POST /api/pos/void
 * Voids a specific transaction (body: { order_id }), restoring stock to
 * the exact batches it was originally deducted from. Falls back to "the
 * last transaction" if no order_id is given, for backward compatibility
 * with anything still calling this the old way.
 *
 * ── Rules ──────────────────────────────────────────────────
 * - Scoped to a rolling window (Order.VOID_WINDOW_DAYS, currently 10
 *   days) and to the requester's OWN transactions — not "any cashier
 *   system-wide". This is deliberately NOT limited to the current login
 *   session or to an still-open register anymore: a mistake noticed the
 *   next day, or after logging back in, can now be voided too, as long
 *   as it's within the window and it's your own transaction. Picking a
 *   SPECIFIC order_id doesn't relax this at all — it's checked with the
 *   exact same WHERE clause as "the last one" (see Order.findByIdInSession).
 * - Cashiers cannot void on their own authority: an admin or super_admin
 *   ("owner") must approve by entering their own email + password in the
 *   request body (manager_email / manager_password).
 * - The audit log entry is attributed to the CASHIER whose transaction it
 *   actually is (req.user.id) — not the approving admin/owner. This was a
 *   real bug found in testing: an earlier version logged it under the
 *   approver's id, so Audit Logs/reports showed the admin/owner as the
 *   "User" for a void that genuinely belongs to the cashier's shift. The
 *   approver authorized it, they didn't perform it — their name/id goes in
 *   `details` (approved_by / approved_by_id) instead, same pattern used for
 *   Cash In/Out/Open/Close in cashController.js.
 * - Admins/super_admins void on their own authority (no approval needed),
 *   but only their OWN transactions within the window — same rule as
 *   anyone else.
 * - Voiding a transaction whose cash register session has already been
 *   CLOSED (or from a previous day) is now ALLOWED — this used to be
 *   blocked, since it can make a variance report already generated for
 *   that day incorrect after the fact without anyone knowing. That
 *   tradeoff is accepted deliberately here in exchange for being able to
 *   fix a mistake noticed late; the frontend shows a stronger warning
 *   when voiding something from a closed/older session so it's a
 *   conscious choice, not a silent one.
 * - Stock is restored per batch (order_items.product_id is the exact batch
 *   row consumed at checkout time), not just added back to "the product"
 *   generically — so batch-level stock stays accurate.
 */
const voidLastOrder = async (req, res, next) => {
    const isCashier = req.user.role === 'cashier';
    const { order_id } = req.body;
    let approverId   = null;  // stays null unless a cashier's void needed manager approval
    let approverName = null;

    // ── Manager/owner override required for cashiers ──────────
    if (isCashier) {
        const { manager_email, manager_password } = req.body;

        if (!manager_email || !manager_password) {
            return res.status(400).json({
                success: false,
                message: 'Admin or owner approval is required to void a transaction.'
            });
        }

        const manager = await User.findByEmail(manager_email);

        if (!manager || !['admin', 'super_admin'].includes(manager.role)) {
            return res.status(401).json({ success: false, message: 'Invalid admin/owner credentials.' });
        }

        const passwordMatches = await User.comparePassword(manager_password, manager.password);
        if (!passwordMatches) {
            return res.status(401).json({ success: false, message: 'Invalid admin/owner credentials.' });
        }

        approverId   = manager.id;
        approverName = manager.name;
    }

    const connection = await db.getConnection();
    try {
        // A specific order_id picks exactly that transaction (still fully
        // scoped to the 10-day window + "is it yours" — see
        // Order.findByIdInSession); omitting it falls back to "the last
        // one", for anything still calling this the old way.
        const order = order_id
            ? await Order.findByIdInSession(order_id, req.user.id)
            : await Order.findLastCompletedInSession(req.user.id);

        if (!order) {
            connection.release();
            return res.status(404).json({ success: false, message: 'That transaction is not available to void.' });
        }

        const items = await OrderItem.findByOrderId(order.id);

        await connection.beginTransaction();

        // Restore stock to the exact batches originally consumed
        for (const item of items) {
            await connection.query(
                'UPDATE products SET stock_quantity = stock_quantity + ? WHERE id = ?',
                [item.quantity, item.product_id]
            );
        }

        const [result] = await connection.query(
            "UPDATE orders SET status = 'voided' WHERE id = ? AND status = 'completed'",
            [order.id]
        );

        if (result.affectedRows === 0) {
            // Someone else already voided/refunded it between our read and write
            await connection.rollback();
            connection.release();
            return res.status(409).json({ success: false, message: 'This transaction was already voided or refunded.' });
        }

        await connection.commit();

        // Attributed to the cashier whose transaction this is (req.user.id),
        // not the approver — see docstring above. Approver's name/id (when
        // there is one) lives in details instead.
        await logAudit(req.user.id, 'VOID_ORDER', 'orders', order.id,
            {
                order_number: order.order_number,
                total: order.total,
                ...(approverName ? { approved_by: approverName, approved_by_id: approverId } : {})
            },
            req.ip);

        res.json({
            success: true,
            message: isCashier
                ? `Order ${order.order_number} voided by ${approverName}. Stock has been restored.`
                : `Order ${order.order_number} voided. Stock has been restored.`
        });

    } catch (err) {
        await connection.rollback();
        next(err);
    } finally {
        connection.release();
    }
};

module.exports = { searchProducts, checkout, aiSuggest, getVoidCandidate, getVoidCandidates, voidLastOrder };
