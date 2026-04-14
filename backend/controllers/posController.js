// ============================================================
// POS Controller
// Checkout with transaction, stock deduction, expiry block
// ============================================================
const db           = require('../config/db');
const Product      = require('../models/Product');
const Order        = require('../models/Order');
const OrderItem    = require('../models/OrderItem');
const { logAudit } = require('../middleware/authMiddleware');

/**
 * GET /api/pos/products
 * Search products available for sale.
 * Returns only non-expired, in-stock items.
 */
const searchProducts = async (req, res, next) => {
    try {
        const { q = '', barcode = '' } = req.query;

        if (barcode) {
            const product = await Product.findByBarcode(barcode);
            if (!product) {
                return res.status(404).json({ success: false, message: 'Product not found for barcode.' });
            }
            return res.json({ success: true, data: [product] });
        }

        const products = await Product.findAll({ search: q });

        // For POS, include stock_status so UI can warn on expired/low
        res.json({ success: true, data: products });

    } catch (err) { next(err); }
};

/**
 * POST /api/pos/checkout
 * Processes the POS transaction.
 *
 * Request body:
 * {
 *   items: [{ product_id, quantity }],
 *   payment_method: 'cash',
 *   amount_tendered: 500,
 *   discount: 0,
 *   notes: ''
 * }
 *
 * ── Transaction flow ──────────────────────────────────────────
 * 1. Validate each item (exists, not expired, sufficient stock)
 * 2. BEGIN TRANSACTION
 * 3. Create order header
 * 4. Create order items (snapshots of price/batch/cost)
 * 5. Decrement stock for each item (row-level lock)
 * 6. COMMIT
 * 7. Return receipt data
 */
const checkout = async (req, res, next) => {
    const { items, payment_method = 'cash', amount_tendered, discount = 0, notes = '' } = req.body;

    if (!items || !items.length) {
        return res.status(400).json({ success: false, message: 'Cart is empty.' });
    }

    // ── Step 1: Pre-validate all items ───────────────────────
    const resolvedItems = [];
    const today = new Date().toISOString().split('T')[0];

    for (const cartItem of items) {
        const product = await Product.findById(cartItem.product_id);

        if (!product) {
            return res.status(400).json({
                success: false,
                message: `Product ID ${cartItem.product_id} not found.`
            });
        }

        // ── EXPIRY BLOCK (Critical Thesis Requirement) ────────
        if (product.expiry_date <= today) {
            return res.status(400).json({
                success: false,
                blocked: true,
                reason: 'expired',
                message: `Cannot sell batch ${product.batch_number}: Item expired (${product.expiry_date}).`,
                product_name: product.name,
                batch_number: product.batch_number
            });
        }

        // ── STOCK CHECK ────────────────────────────────────────
        if (product.stock_quantity < cartItem.quantity) {
            return res.status(400).json({
                success: false,
                blocked: true,
                reason: 'insufficient_stock',
                message: `Insufficient stock for ${product.name}. Available: ${product.stock_quantity}.`
            });
        }

        resolvedItems.push({
            product_id:   product.id,
            batch_number: product.batch_number,
            product_name: product.name,
            quantity:     cartItem.quantity,
            unit_price:   product.price,
            unit_cost:    product.cost,
            subtotal:     product.price * cartItem.quantity
        });
    }

    // Calculate totals
    const subtotal    = resolvedItems.reduce((s, i) => s + i.subtotal, 0);
    const tax         = 0;  // Pharmacy items in PH are typically VAT-exempt or zero-rated
    const total       = subtotal - parseFloat(discount) + tax;
    const change      = parseFloat(amount_tendered) - total;

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
            discount:       parseFloat(discount),
            tax,
            total,
            payment_method,
            amount_tendered: parseFloat(amount_tendered),
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
                discount:     parseFloat(discount),
                tax,
                total,
                payment_method,
                amount_tendered: parseFloat(amount_tendered),
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

module.exports = { searchProducts, checkout, aiSuggest };
