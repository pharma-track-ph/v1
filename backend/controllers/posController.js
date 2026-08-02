// ============================================================
// POS Controller
// Checkout with transaction, stock deduction, expiry block
// ============================================================
const db           = require('../config/db');
const Product      = require('../models/Product');
const Order        = require('../models/Order');
const OrderItem    = require('../models/OrderItem');
const User         = require('../models/User');
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
 *   notes: ''
 * }
 *
 * Cart lines represent a *product family* (grouped across batches in the
 * UI), not a single exact batch row. Each line carries an ordered
 * `batch_ids` list (soonest-expiring first / FEFO) built by
 * /api/pos/products. Stock is consumed from the earliest-expiring batch
 * first, spilling into the next batch only if needed — this keeps
 * unit_cost accurate per batch actually sold, so profit reporting stays
 * correct even when a single sale spans multiple batches.
 *
 * ── Transaction flow ──────────────────────────────────────────
 * 1. Validate each item (resolve FEFO across batches, check stock)
 * 2. BEGIN TRANSACTION
 * 3. Create order header
 * 4. Create order items (snapshots of price/batch/cost, one per batch used)
 * 5. Decrement stock for each batch actually consumed
 * 6. COMMIT
 * 7. Return receipt data
 */
const checkout = async (req, res, next) => {
    const { items, payment_method = 'cash', amount_tendered, discount = 0, notes = '' } = req.body;

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
            notes
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
 * Returns the transaction that a Void click would target, so the frontend
 * can show a confirmation with real details before committing to anything.
 * Scoped to TODAY's shift only (Manila calendar day) — nothing from a
 * previous day is ever returned here, regardless of role.
 * Cashiers see only their own most recent completed sale from today;
 * admins/super_admins see the most recent completed sale system-wide, also
 * restricted to today.
 */
const getVoidCandidate = async (req, res, next) => {
    try {
        const isElevated = ['admin', 'super_admin'].includes(req.user.role);
        const today = getManilaDateString();
        const order = isElevated
            ? await Order.findLastCompleted(today)
            : await Order.findLastCompletedByCashier(req.user.id, today);

        if (!order) {
            return res.json({ success: true, data: null });
        }

        const items = await OrderItem.findByOrderId(order.id);

        res.json({ success: true, data: { ...order, items } });
    } catch (err) { next(err); }
};

/**
 * POST /api/pos/void
 * Voids the same transaction returned by /void-candidate, restoring stock
 * to the exact batches it was originally deducted from.
 *
 * ── Rules ──────────────────────────────────────────────────
 * - Only ever targets a transaction from TODAY's shift (Manila calendar
 *   day). A previous day's completed sale is never reachable via void,
 *   for any role — this is enforced at the query level, not just the UI.
 * - Cashiers can only void THEIR OWN most recent completed sale from today,
 *   and CANNOT do so on their own authority: an admin or super_admin
 *   ("owner") must approve by entering their own email + password in the
 *   request body (manager_email / manager_password). The void is then
 *   attributed to that approving admin/owner in the audit log — not the
 *   cashier — since they're the one who actually authorized it.
 * - Admins/super_admins can void the most recent completed sale from today,
 *   system-wide, on their own authority (no override needed).
 * - Stock is restored per batch (order_items.product_id is the exact batch
 *   row consumed at checkout time), not just added back to "the product"
 *   generically — so batch-level stock stays accurate.
 */
const voidLastOrder = async (req, res, next) => {
    const isCashier = req.user.role === 'cashier';
    let approverId   = req.user.id;
    let approverName = req.user.name;

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

        // The void is attributed to the APPROVING admin/owner, not the cashier
        // who requested it — they're the one who authorized it.
        approverId   = manager.id;
        approverName = manager.name;
    }

    const connection = await db.getConnection();
    try {
        const isElevated = ['admin', 'super_admin'].includes(req.user.role);
        const today = getManilaDateString();
        const order = isElevated
            ? await Order.findLastCompleted(today)
            : await Order.findLastCompletedByCashier(req.user.id, today);

        if (!order) {
            connection.release();
            return res.status(404).json({ success: false, message: "No transaction from today's shift available to void." });
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

        await logAudit(approverId, 'VOID_ORDER', 'orders', order.id,
            {
                order_number: order.order_number,
                total: order.total,
                ...(isCashier ? { requested_by: req.user.name, requested_by_id: req.user.id } : {})
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

module.exports = { searchProducts, checkout, aiSuggest, getVoidCandidate, voidLastOrder };
