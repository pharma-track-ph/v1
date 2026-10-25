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
const { computeOrder, toCents, centsToPesos } = require('../utils/vat');

// The reply for a sale whose reference was already saved: success, pointing at
// the original order (a lost reply or a manual re-sync must never double-record
// a sale). A reference belonging to a DIFFERENT cashier can't legitimately
// happen with random references, so it is refused rather than answered.
function duplicateSaleResponse(res, existing, requesterId) {
    if (Number(existing.cashier_id) !== Number(requesterId)) {
        return res.status(409).json({
            success: false,
            blocked: true,
            reason: 'reference_conflict',
            message: 'This sale reference belongs to another account.'
        });
    }
    return res.status(200).json({
        success:      true,
        duplicate:    true,
        message:      'This sale was already recorded.',
        order_id:     existing.id,
        order_number: existing.order_number
    });
}

// mysql2 hands DATE columns back as JS Date objects. Comparing a Date to a
// 'YYYY-MM-DD' string with <= is ALWAYS false (the string becomes NaN), so
// the old expiry checks below never actually blocked anything. This turns a
// DATE value into the pharmacy's own (Manila) calendar date as a string, so
// two dates can be compared safely.
function toManilaDateString(value) {
    const d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return String(value);
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Manila',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(d);
}

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
                is_tax_exempt:       r.is_tax_exempt ? 1 : 0,
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
            if (!scanned) {
                return res.status(404).json({ success: false, message: 'Product not found for barcode.' });
            }

            // Re-expand the scanned batch into its full product family so the
            // barcode-scan path behaves identically to the search/grid path.
            const familyRows = await Product.findActiveNonExpiredByName(scanned.name);
            const grouped     = groupBatchesForPOS(familyRows);

            // findByBarcode returns ONE row, which can be an expired or sold-out
            // batch even when the brand has sellable ones -- so sellability is
            // decided by the family query above, not by that single row.
            if (!grouped.length) {
                return res.status(404).json({
                    success: false,
                    message: `${scanned.name} is out of stock or expired.`
                });
            }
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
    const { items, payment_method = 'cash', amount_tendered, senior_pwd_all, discount = 0, notes = '', cash_session_id, client_ref, client_created_at } = req.body;

    if (!items || !items.length) {
        return res.status(400).json({ success: false, message: 'Cart is empty.' });
    }

    // -- Offline-sync duplicate guard --
    // Every checkout carries a random reference (orders.client_ref is UNIQUE).
    // If this exact sale was already saved -- typically because the first
    // attempt reached the server but its reply was lost, so the browser queued
    // and re-sent it -- answer with the ORIGINAL order instead of creating a
    // second one. This runs before any stock check on purpose: the stock was
    // already deducted the first time, so re-validating it could wrongly fail.
    let clientRef = null;
    if (client_ref !== undefined && client_ref !== null && client_ref !== '') {
        if (typeof client_ref !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(client_ref)) {
            return res.status(400).json({ success: false, message: 'Invalid sale reference.' });
        }
        clientRef = client_ref;
        const alreadySaved = await Order.findByClientRef(clientRef);
        if (alreadySaved) return duplicateSaleResponse(res, alreadySaved, req.user.id);
    }

    // ── Step 1: Pre-validate & resolve all items across batches ──
    const resolvedItems = [];
    const lineRows      = []; // one entry per cart line: the resolved batch rows that fill it
    const lineSeniorFlags = []; // parallel to lineRows: was Senior/PWD ticked on that cart line?
    const today = getManilaDateString();

    for (const cartItem of items) {
        const batchIds = Array.isArray(cartItem.batch_ids) && cartItem.batch_ids.length
            ? cartItem.batch_ids
            : [cartItem.product_id]; // backward-compatible fallback: single batch

        let remainingQty  = parseInt(cartItem.quantity) || 0;
        let lastKnownName = null;
        const thisLineRows = [];

        for (const batchId of batchIds) {
            if (remainingQty <= 0) break;

            const product = await Product.findById(batchId);
            if (!product) continue;               // batch may have been removed since page load
            lastKnownName = product.name;

            // Skip (don't hard-fail) batches that expired since the cart was built —
            // the next batch in FEFO order will be tried instead.
            if (toManilaDateString(product.expiry_date) <= today) continue;
            if (product.stock_quantity <= 0)  continue;

            const qtyFromThisBatch = Math.min(remainingQty, product.stock_quantity);

            const resolvedRow = {
                product_id:   product.id,
                batch_number: product.batch_number,
                product_name: product.name,
                quantity:     qtyFromThisBatch,
                unit_price:   product.price,
                unit_cost:    product.cost,
                subtotal:     centsToPesos(toCents(product.price) * qtyFromThisBatch),
                is_tax_exempt: product.is_tax_exempt ? 1 : 0
            };
            resolvedItems.push(resolvedRow);
            thisLineRows.push(resolvedRow);

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

        if (thisLineRows.length) {
            lineRows.push(thisLineRows);
            lineSeniorFlags.push(cartItem.senior_pwd === true);
        }
    }

    // Calculate totals
    if (!lineRows.length) {
        return res.status(400).json({ success: false, message: 'Cart is empty.' });
    }

    // Totals come from the shared VAT/Senior-PWD math (utils/vat.js). The
    // server never trusts a discount AMOUNT from the client -- only whether
    // the Senior/PWD (20%) toggle was on. An older offline-queued sale that
    // still carries a plain discount amount is treated as "toggle on".
    const seniorPwdAll = senior_pwd_all === true
        || (senior_pwd_all === undefined && (parseFloat(discount) || 0) > 0);

    // Senior/PWD applies to a line when the 20% toggle covers the whole cart
    // OR that line was ticked individually in the cart.
    const vat = computeOrder(lineRows.map((rows, i) => ({
        rowGrossCents: rows.map(r => toCents(r.unit_price) * r.quantity),
        taxExempt:     rows[0].is_tax_exempt === 1,
        seniorPwd:     seniorPwdAll || lineSeniorFlags[i] === true
    })));

    // Each stored order_items row keeps its own share of the discount
    vat.lines.forEach((lineResult, i) => {
        lineRows[i].forEach((row, j) => {
            row.discount_amount = centsToPesos(lineResult.rowDiscountCents[j]);
        });
    });

    const subtotal       = centsToPesos(vat.totals.grossCents);
    const discountAmount = centsToPesos(vat.totals.discountCents);
    const tax            = centsToPesos(vat.totals.vatCents);
    const tenderedAmount = parseFloat(amount_tendered) || 0;

    const total          = centsToPesos(vat.totals.totalCents);
    const vatableSales   = centsToPesos(vat.totals.vatableSalesCents);
    const vatExemptSales = centsToPesos(vat.totals.vatExemptSalesCents);
    const tenderedCents  = toCents(tenderedAmount);
    const change         = centsToPesos(tenderedCents - vat.totals.totalCents);

    if (tenderedCents < vat.totals.totalCents) {
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

        // Offline sales keep the time they were actually made, but only when
        // that time is plausible: not before this register session opened, and
        // not in the future (2 minutes of clock drift allowed). Anything else
        // falls back to the time of syncing. Online sales never send a time.
        let saleDate = new Date();
        let usedClientTime = false;
        const clientTime = client_created_at ? new Date(client_created_at) : null;
        if (clientTime && !isNaN(clientTime.getTime())) {
            const nowMs    = Date.now();
            const openedMs = new Date(openSession.opened_at).getTime();
            if (clientTime.getTime() >= openedMs && clientTime.getTime() <= nowMs + 2 * 60 * 1000) {
                saleDate = new Date(Math.min(clientTime.getTime(), nowMs));
                usedClientTime = true;
            }
        }

        // Re-check inside the locked transaction: a second request carrying
        // the same reference may have committed while this one was waiting.
        if (clientRef) {
            const savedMeanwhile = await Order.findByClientRef(clientRef, connection);
            if (savedMeanwhile) {
                await connection.rollback();
                return duplicateSaleResponse(res, savedMeanwhile, req.user.id);
            }
        }

        // Create order header (the number is added below)
        const orderHeader = {
            cashier_id:     req.user.id,
            subtotal,
            discount:       discountAmount,
            tax,
            total,
            vatable_sales:    vatableSales,
            vat_exempt_sales: vatExemptSales,
            payment_method,
            amount_tendered: tenderedAmount,
            change_amount:  change,
            notes,
            cash_session_id: openSession.id,
            created_at:     usedClientTime ? saleDate : null,
            client_ref:     clientRef
        };

        // The number is built from the sale's own date and sequence; if another
        // cashier took the same number a moment ago, step past it and retry.
        let order_number, orderId;
        for (let attempt = 0; ; attempt++) {
            order_number = await Order.generateOrderNumber(saleDate, connection, attempt);
            try {
                orderId = await Order.create({ ...orderHeader, order_number }, connection);
                break;
            } catch (insertErr) {
                const msg = insertErr.sqlMessage || insertErr.message || '';
                if (insertErr.code === 'ER_DUP_ENTRY' && /client_ref/.test(msg)) {
                    // Lost a race to another request with the same sale reference
                    await connection.rollback();
                    const winner = await Order.findByClientRef(clientRef);
                    if (winner) return duplicateSaleResponse(res, winner, req.user.id);
                    throw insertErr;
                }
                if (insertErr.code === 'ER_DUP_ENTRY' && /order_number/.test(msg) && attempt < 4) continue;
                throw insertErr;
            }
        }

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
        await logAudit(req.user.id, 'CHECKOUT', 'orders', orderId, { order_number, total, tax, client_ref: clientRef, offline_sale_time: usedClientTime }, req.ip);

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
                vat_exemption_discount: centsToPesos(vat.totals.vatExemptionDiscountCents),
                senior_pwd_discount:    centsToPesos(vat.totals.seniorDiscountCents),
                tax,
                vatable_sales:    vatableSales,
                vat_exempt_sales: vatExemptSales,
                total,
                payment_method,
                amount_tendered: tenderedAmount,
                change,
                created_at:   saleDate.toISOString()
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
        const order = await Order.findLastCompletedInSession();

        if (!order) {
            return res.json({ success: true, data: null });
        }

        const items = await OrderItem.findByOrderId(order.id);

        res.json({ success: true, data: { ...order, items } });
    } catch (err) { next(err); }
};

/**
 * GET /api/pos/void-candidates
 * Returns up to the last 50 completed transactions from the last
 * CALENDAR MONTH (see Order.js), from ANY cashier -- not just the
 * requester's own -- each with its item list attached, so someone with
 * void access can pick which one to void instead of only ever being able
 * to void the very last sale. Useful when a wrong item (e.g. the wrong
 * medicine) wasn't caught until later, possibly by a different cashier
 * than the one who made the sale.
 */
const getVoidCandidates = async (req, res, next) => {
    try {
        const orders = await Order.findRecentCompletedInSession(50);

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
 * - Scoped to a rolling ONE CALENDAR MONTH window, system-wide -- no
 *   longer restricted to "your own" transactions. Anyone with void access
 *   can void ANY cashier's completed sale from within that window, not
 *   just their own. Picking a SPECIFIC order_id doesn't relax the window
 *   at all -- it's checked with the exact same WHERE clause as "the last
 *   one" (see Order.findByIdInSession).
 * - Cashiers still cannot void on their own authority: an admin or
 *   super_admin ("owner") must approve by entering their own email +
 *   password in the request body (manager_email / manager_password),
 *   regardless of whose sale is being voided.
 * - Audit attribution: logged under req.user.id -- the person who actually
 *   PERFORMED the void -- not the order's original cashier, since those
 *   can now be different people. The order's original cashier name/id is
 *   recorded in `details` (original_cashier / original_cashier_id) so the
 *   trail still clearly shows whose sale it was, alongside approved_by
 *   when a cashier needed manager sign-off.
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
            // 403, NOT 401: the browser treats any 401 as "your login expired" and
            // signs you out, which is wrong for a mistyped MANAGER password.
            return res.status(403).json({ success: false, message: 'Invalid admin/owner credentials.' });
        }

        const passwordMatches = await User.comparePassword(manager_password, manager.password);
        if (!passwordMatches) {
            return res.status(403).json({ success: false, message: 'Invalid admin/owner credentials.' });
        }

        approverId   = manager.id;
        approverName = manager.name;
    }

    const connection = await db.getConnection();
    try {
        // A specific order_id picks exactly that transaction (still fully
        // scoped to the 1-month window — see Order.findByIdInSession);
        // omitting it falls back to "the last one", for anything still
        // calling this the old way.
        const order = order_id
            ? await Order.findByIdInSession(order_id)
            : await Order.findLastCompletedInSession();

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

        // Attributed to whoever actually PERFORMED the void (req.user.id) --
        // the order's original cashier is recorded separately in details,
        // since the two can now be different people (see docstring above).
        await logAudit(req.user.id, 'VOID_ORDER', 'orders', order.id,
            {
                order_number: order.order_number,
                total: order.total,
                original_cashier: order.cashier_name,
                original_cashier_id: order.cashier_id,
                ...(approverName ? { approved_by: approverName, approved_by_id: approverId } : {})
            },
            req.ip);

        const originalCashierNote = order.cashier_id !== req.user.id ? ` (originally rung up by ${order.cashier_name})` : '';

        res.json({
            success: true,
            message: isCashier
                ? `Order ${order.order_number}${originalCashierNote} voided by ${approverName}. Stock has been restored.`
                : `Order ${order.order_number}${originalCashierNote} voided. Stock has been restored.`
        });

    } catch (err) {
        await connection.rollback();
        next(err);
    } finally {
        connection.release();
    }
};

// -- Partial Void ---------------------------------------------------
// Same approval rule as a full void: a Pharmacy Assistant (cashier) cannot do
// it on their own authority, an admin or owner must enter their own email and
// password. Returns { approverId, approverName } (both null for admin/owner),
// or null after sending the error response itself.
async function requireVoidApproval(req, res) {
    if (req.user.role !== 'cashier') return { approverId: null, approverName: null };

    const { manager_email, manager_password } = req.body;
    if (!manager_email || !manager_password) {
        res.status(400).json({ success: false, message: 'Admin or owner approval is required to void a transaction.' });
        return null;
    }

    const manager = await User.findByEmail(manager_email);
    if (!manager || !['admin', 'super_admin'].includes(manager.role)) {
        // 403, NOT 401: the browser treats any 401 as "your login expired" and
        // signs you out, which is wrong for a mistyped MANAGER password.
        res.status(403).json({ success: false, message: 'Invalid admin/owner credentials.' });
        return null;
    }
    const passwordMatches = await User.comparePassword(manager_password, manager.password);
    if (!passwordMatches) {
        res.status(403).json({ success: false, message: 'Invalid admin/owner credentials.' });
        return null;
    }
    return { approverId: manager.id, approverName: manager.name };
}

/**
 * POST /api/pos/partial-void
 * Body: { order_id, items: [{ order_item_id, quantity }], manager_email?, manager_password? }
 *
 * Voids PART of a completed sale:
 *   - the ORIGINAL receipt becomes 'voided' (so it leaves sales and cash
 *     totals), exactly as a full void does;
 *   - only the voided quantities go back into stock, to the exact batch each
 *     was sold from;
 *   - a NEW receipt is issued for what remains, linked to the original through
 *     orders.parent_order_id. It keeps the original's date/time, cashier,
 *     payment method and register session, so that day's report and that
 *     session's totals stay right; its number continues that day's sequence;
 *   - VAT and Senior/PWD discounts are recomputed for the remaining quantities
 *     with the same math as checkout (utils/vat.js);
 *   - the voided amount is treated as an immediate refund: the new receipt
 *     shows tendered = its total and change = 0.00, and the refund amount is
 *     recorded in the audit log.
 * Same window as a full void (the last calendar month, any cashier's sale)
 * and the same approval rules. The original row is locked for the whole
 * transaction, so a full Void and a Partial Void of the same sale can never
 * both succeed.
 */
const partialVoidOrder = async (req, res, next) => {
    const isCashier = req.user.role === 'cashier';
    const { order_id, items: selections } = req.body;

    const orderId = parseInt(order_id, 10);
    if (!Number.isInteger(orderId) || orderId <= 0) {
        return res.status(400).json({ success: false, message: 'Choose the transaction to void.' });
    }
    if (!Array.isArray(selections) || !selections.length) {
        return res.status(400).json({ success: false, message: 'Choose at least one item to void.' });
    }

    const approval = await requireVoidApproval(req, res);
    if (!approval) return;
    const { approverId, approverName } = approval;

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        const order = await Order.findByIdInSessionForUpdate(orderId, connection);
        if (!order) {
            await connection.rollback();
            return res.status(404).json({ success: false, message: 'That transaction is not available to void.' });
        }

        const [itemRows] = await connection.query(
            'SELECT * FROM order_items WHERE order_id = ? ORDER BY id', [order.id]
        );
        const byId = new Map(itemRows.map(i => [i.id, i]));

        // -- Validate what was chosen --
        const voidQty = new Map();   // order_items.id -> quantity being voided
        for (const sel of selections) {
            const item = byId.get(Number(sel.order_item_id));
            const qty  = Number(sel.quantity);
            if (!item) {
                await connection.rollback();
                return res.status(400).json({ success: false, message: 'One of the chosen items is not part of this sale.' });
            }
            if (!Number.isInteger(qty) || qty < 1 || qty > item.quantity) {
                await connection.rollback();
                return res.status(400).json({ success: false, message: `Quantity for ${item.product_name} must be between 1 and ${item.quantity}.` });
            }
            if (voidQty.has(item.id)) {
                await connection.rollback();
                return res.status(400).json({ success: false, message: 'The same item was chosen twice.' });
            }
            voidQty.set(item.id, qty);
        }

        const soldUnits = itemRows.reduce((s, i) => s + i.quantity, 0);
        const voidUnits = [...voidQty.values()].reduce((s, q) => s + q, 0);
        if (voidUnits >= soldUnits) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: 'That voids the whole sale. Use "Void This Transaction" for that instead.'
            });
        }

        // -- What stays on the new receipt --
        // Rows are grouped back into the cart lines they came from (one brand =
        // one line; a line that was filled from several batches has several rows)
        // so the discount is recomputed once per line, exactly as at checkout.
        const keptRows = itemRows
            .map(i => ({ ...i, keepQty: i.quantity - (voidQty.get(i.id) || 0) }))
            .filter(i => i.keepQty > 0);

        const groups = new Map();
        for (const row of itemRows) {                       // original rows decide whether the line was discounted
            const key = `${row.product_name}|${row.is_tax_exempt ? 1 : 0}`;
            const g = groups.get(key) || { taxExempt: !!row.is_tax_exempt, discounted: false, kept: [] };
            if (toCents(row.discount_amount) > 0) g.discounted = true;
            groups.set(key, g);
        }
        for (const row of keptRows) {
            groups.get(`${row.product_name}|${row.is_tax_exempt ? 1 : 0}`).kept.push(row);
        }

        const lineList = [...groups.values()].filter(g => g.kept.length);
        const vat = computeOrder(lineList.map(g => ({
            rowGrossCents: g.kept.map(r => toCents(r.unit_price) * r.keepQty),
            taxExempt:     g.taxExempt,
            seniorPwd:     g.discounted
        })));

        const newItems = [];
        lineList.forEach((g, li) => {
            g.kept.forEach((r, ri) => {
                newItems.push({
                    product_id:      r.product_id,
                    batch_number:    r.batch_number,
                    product_name:    r.product_name,
                    quantity:        r.keepQty,
                    unit_price:      r.unit_price,
                    unit_cost:       r.unit_cost,
                    subtotal:        centsToPesos(toCents(r.unit_price) * r.keepQty),
                    is_tax_exempt:   r.is_tax_exempt ? 1 : 0,
                    discount_amount: centsToPesos(vat.lines[li].rowDiscountCents[ri])
                });
            });
        });

        const subtotal       = centsToPesos(vat.totals.grossCents);
        const discountAmount = centsToPesos(vat.totals.discountCents);
        const tax            = centsToPesos(vat.totals.vatCents);
        const vatableSales   = centsToPesos(vat.totals.vatableSalesCents);
        const vatExemptSales = centsToPesos(vat.totals.vatExemptSalesCents);
        const newTotal       = centsToPesos(vat.totals.totalCents);
        const refundCents     = Math.max(0, toCents(order.total) - vat.totals.totalCents);
        const refundAmount    = centsToPesos(refundCents);

        // -- Stock: only the voided quantities go back, to their exact batch --
        for (const [itemId, qty] of voidQty) {
            await connection.query(
                'UPDATE products SET stock_quantity = stock_quantity + ? WHERE id = ?',
                [qty, byId.get(itemId).product_id]
            );
        }

        // -- The original leaves sales and cash totals --
        const [voided] = await connection.query(
            "UPDATE orders SET status = 'voided' WHERE id = ? AND status = 'completed'",
            [order.id]
        );
        if (voided.affectedRows === 0) {
            await connection.rollback();
            return res.status(409).json({ success: false, message: 'This transaction was already voided or refunded.' });
        }

        // -- The new receipt: original date/time, cashier, payment and session --
        const saleDate = new Date(order.created_at);
        const header = {
            cashier_id:       order.cashier_id,
            subtotal,
            discount:         discountAmount,
            tax,
            total:            newTotal,
            vatable_sales:    vatableSales,
            vat_exempt_sales: vatExemptSales,
            payment_method:   order.payment_method,
            amount_tendered:  newTotal,      // the voided amount is refunded on the spot
            change_amount:    0,
            notes:            `Replaces ${order.order_number} (partial void)`,
            cash_session_id:  order.cash_session_id,
            parent_order_id:  order.id,
            created_at:       saleDate
        };

        let newOrderNumber, newOrderId;
        for (let attempt = 0; ; attempt++) {
            newOrderNumber = await Order.generateOrderNumber(saleDate, connection, attempt);
            try {
                newOrderId = await Order.create({ ...header, order_number: newOrderNumber }, connection);
                break;
            } catch (insertErr) {
                const msg = insertErr.sqlMessage || insertErr.message || '';
                if (insertErr.code === 'ER_DUP_ENTRY' && /order_number/.test(msg) && attempt < 4) continue;
                throw insertErr;
            }
        }

        await OrderItem.createBulk(newOrderId, newItems, connection);
        await connection.commit();

        // -- Audit trail: one entry on each receipt, pointing at the other --
        const voidedItems = [...voidQty].map(([itemId, qty]) => {
            const it = byId.get(itemId);
            return { name: it.product_name, quantity: qty, amount: centsToPesos(toCents(it.unit_price) * qty) };
        });

        await logAudit(req.user.id, 'VOID_ORDER', 'orders', order.id, {
            order_number:               order.order_number,
            total:                      order.total,
            original_cashier:           order.cashier_name,
            original_cashier_id:        order.cashier_id,
            partial:                    true,
            voided_items:               voidedItems,
            refund_amount:              refundAmount,
            replacement_order_number:   newOrderNumber,
            replacement_order_id:       newOrderId,
            ...(approverName ? { approved_by: approverName, approved_by_id: approverId } : {})
        }, req.ip);

        await logAudit(req.user.id, 'PARTIAL_VOID_RECEIPT', 'orders', newOrderId, {
            order_number:     newOrderNumber,
            replaces:         order.order_number,
            replaces_id:      order.id,
            total:            newTotal,
            refund_amount:    refundAmount
        }, req.ip);

        res.status(201).json({
            success: true,
            message: `Order ${order.order_number} partially voided${isCashier ? ` (approved by ${approverName})` : ''}. ` +
                     `New receipt ${newOrderNumber} issued. Refund: ${Fmt2(refundAmount)}. Stock has been restored for the voided items.`,
            refund_amount:         refundAmount,
            original_order_number: order.order_number,
            receipt: {
                order_id:     newOrderId,
                order_number: newOrderNumber,
                cashier_name: order.cashier_name,
                items:        newItems,
                subtotal,
                discount:     discountAmount,
                vat_exemption_discount: centsToPesos(vat.totals.vatExemptionDiscountCents),
                senior_pwd_discount:    centsToPesos(vat.totals.seniorDiscountCents),
                tax,
                vatable_sales:    vatableSales,
                vat_exempt_sales: vatExemptSales,
                total:            newTotal,
                payment_method:   order.payment_method,
                amount_tendered:  newTotal,
                change:           0,
                created_at:       saleDate.toISOString(),
                replaces_order_number: order.order_number
            }
        });

    } catch (err) {
        await connection.rollback();
        next(err);
    } finally {
        connection.release();
    }
};

// peso formatting for the response message (the controller has no Fmt)
function Fmt2(amount) {
    return '\u20b1' + Number(amount).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

module.exports = { searchProducts, checkout, aiSuggest, getVoidCandidate, getVoidCandidates, voidLastOrder, partialVoidOrder };
