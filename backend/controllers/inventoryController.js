// ============================================================
// Inventory Controller
// Full CRUD for products + CSV import + alert counts
// ============================================================
const Product      = require('../models/Product');
const { logAudit } = require('../middleware/authMiddleware');
const fs           = require('fs');

/**
 * GET /api/inventory
 * Returns filtered product list with computed stock_status.
 * Query params: search, category, status
 *
 * Filtering: every "concern" status (low_stock, near_expiry, expiring_3mo,
 * expired, out_of_stock) checks its OWN real condition independently here,
 * rather than matching the single stock_status column Product.findAll()
 * computes. That column is still just ONE label per product (picked by
 * priority: out_of_stock > expired > near_expiry > expiring_3mo >
 * low_stock > in_stock) for the row's own badge -- but a product can
 * genuinely be both low on stock AND expiring soon at the same time, and
 * it needs to show up when filtering by EITHER concern, not just
 * whichever one "won" the priority order for its badge. This was a real
 * bug: a product with 3 units left and an expiry 42 days out was
 * invisible under BOTH the Low Stock filter and the In Stock filter,
 * simply because its single badge had been assigned to "Expiring in 3
 * Months" instead.
 *
 * in_stock is the one deliberate exception and stays exclusive -- it's
 * meant to mean "nothing here needs attention at all", so it only matches
 * when none of the other conditions apply, same as the badge itself.
 */
const getProducts = async (req, res, next) => {
    try {
        const { search = '', category = '', status = '' } = req.query;

        // 'expiring' in the status dropdown maps to near_expiry in stock_status
        const normalizedStatus = status === 'expiring' ? 'near_expiry' : status;

        let products = await Product.findAll({ search, category });

        if (normalizedStatus) {
            products = products.filter(p => {
                const daysLeft  = parseInt(p.days_until_expiry);
                const stock     = parseInt(p.stock_quantity);
                const threshold = parseInt(p.low_stock_threshold);

                switch (normalizedStatus) {
                    case 'out_of_stock':
                        return stock <= 0;
                    case 'expired':
                        return stock > 0 && daysLeft < 0;
                    case 'near_expiry':
                        // "Expiring This Month"
                        return stock > 0 && daysLeft >= 0 && daysLeft <= 30;
                    case 'expiring_3mo':
                        // "Expiring in 3 Months" -- deliberately INCLUSIVE of the
                        // 1-month tier (0-90 days), a broader "anything needing
                        // attention soon" net, same as before -- now also
                        // independent of stock level.
                        return stock > 0 && daysLeft >= 0 && daysLeft <= 90;
                    case 'low_stock':
                        // Independent of expiry now -- shows up here even if
                        // the row's own badge displays a different, more
                        // urgent concern.
                        return stock > 0 && stock <= threshold;
                    case 'in_stock':
                        // The one exception: stays exclusive on purpose (see
                        // docstring above).
                        return p.stock_status === 'in_stock';
                    default:
                        return true;
                }
            });
        }

        res.json({ success: true, data: products, total: products.length });
    } catch (err) { next(err); }
};

/**
 * GET /api/inventory/:id
 */
const getProduct = async (req, res, next) => {
    try {
        const product = await Product.findById(req.params.id);
        if (!product) return res.status(404).json({ success: false, message: 'Product not found.' });
        res.json({ success: true, data: product });
    } catch (err) { next(err); }
};

/**
 * POST /api/inventory  [Admin+]
 * If no barcode is supplied, one is auto-generated and persisted
 * immediately after insert, so every product always has a scannable code
 * from the moment it's created — never left blank.
 */
const createProduct = async (req, res, next) => {
    try {
        const id = await Product.create(req.body);

        if (!req.body.barcode) {
            await Product.ensureBarcode(id);
        }

        await logAudit(req.user.id, 'CREATE_PRODUCT', 'products', id, req.body, req.ip);
        res.status(201).json({ success: true, message: 'Product created.', id });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ success: false, message: 'Barcode already exists.' });
        }
        next(err);
    }
};

/**
 * PUT /api/inventory/:id  [Admin+]
 * Only super_admin ("the owner") may change an existing product's
 * batch_number — enforced here regardless of what the client sends, since
 * the edit form itself disables the field for non-super_admin users.
 */
const updateProduct = async (req, res, next) => {
    try {
        const before = await Product.findById(req.params.id);
        if (!before) return res.status(404).json({ success: false, message: 'Product not found.' });

        const body = { ...req.body };
        if (req.user.role !== 'super_admin') {
            body.batch_number = before.batch_number;
        }

        await Product.update(req.params.id, body);
        await logAudit(req.user.id, 'UPDATE_PRODUCT', 'products', req.params.id,
            { before, after: body }, req.ip);

        res.json({ success: true, message: 'Product updated.' });
    } catch (err) { next(err); }
};

/**
 * DELETE /api/inventory/:id  [Admin+]
 * Soft delete only — preserves historical order records.
 */
const deleteProduct = async (req, res, next) => {
    try {
        const affected = await Product.softDelete(req.params.id);
        if (!affected) return res.status(404).json({ success: false, message: 'Product not found.' });

        await logAudit(req.user.id, 'DELETE_PRODUCT', 'products', req.params.id, {}, req.ip);
        res.json({ success: true, message: 'Product removed.' });
    } catch (err) { next(err); }
};

/**
 * GET /api/inventory/alerts/summary
 * Returns low stock count, near-expiry count, and category list.
 */
const getAlertSummary = async (req, res, next) => {
    try {
        const [lowStock, nearExpiry, expiring3mo, expiredCount, outOfStockCount, categories] = await Promise.all([
            Product.getLowStockCount(),
            Product.getNearExpiryCount(),
            Product.getExpiring3MonthsCount(),
            Product.getExpiredCount(),
            Product.getOutOfStockCount(),
            Product.getCategories()
        ]);
        res.json({
            success: true,
            data: {
                low_stock:     lowStock,
                near_expiry:   nearExpiry,
                expiring_3mo:  expiring3mo,
                expired:       expiredCount,
                out_of_stock:  outOfStockCount,
                categories
            }
        });
    } catch (err) { next(err); }
};

/**
 * POST /api/inventory/import  [Admin+]
 * Parses an uploaded CSV and bulk-upserts products.
 *
 * Expected CSV columns (header row required):
 * batch_number,name,generic_name,category,supplier,barcode,
 * price,cost,stock_quantity,low_stock_threshold,expiry_date
 */
const importCSV = async (req, res, next) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No CSV file uploaded.' });
        }

        const content = fs.readFileSync(req.file.path, 'utf8');
        fs.unlinkSync(req.file.path);

        const lines  = content.split('\n').map(l => l.trim()).filter(Boolean);
        const header = lines[0].split(',').map(h => h.trim().toLowerCase());

        const required = ['batch_number','name','category','price','cost','stock_quantity','expiry_date'];
        const missing  = required.filter(col => !header.includes(col));

        if (missing.length) {
            return res.status(400).json({
                success: false,
                message: `CSV missing required columns: ${missing.join(', ')}`
            });
        }

        const items       = [];
        const parseErrors = [];

        for (let i = 1; i < lines.length; i++) {
            const values = lines[i].split(',').map(v => v.trim());
            const row    = {};
            header.forEach((col, idx) => { row[col] = values[idx] || ''; });

            if (!row.batch_number || !row.name || !row.expiry_date) {
                parseErrors.push(`Row ${i + 1}: batch_number, name, expiry_date are required.`);
                continue;
            }

            items.push({
                batch_number:        row.batch_number,
                name:                row.name,
                generic_name:        row.generic_name          || null,
                category:            row.category,
                supplier:            row.supplier              || null,
                barcode:             row.barcode               || null,
                price:               parseFloat(row.price)     || 0,
                cost:                parseFloat(row.cost)      || 0,
                stock_quantity:      parseInt(row.stock_quantity)      || 0,
                low_stock_threshold: parseInt(row.low_stock_threshold) || 10,
                expiry_date:         row.expiry_date
            });
        }

        const results = await Product.bulkUpsert(items);
        await logAudit(req.user.id, 'IMPORT_INVENTORY', 'products', null, results, req.ip);

        res.json({
            success: true,
            message: `Import complete. Inserted: ${results.inserted}, Updated: ${results.updated}`,
            data: { ...results, parse_errors: parseErrors }
        });

    } catch (err) { next(err); }
};

/**
 * GET /api/inventory/:id/barcode  [Admin+]
 * Returns the product's barcode, auto-generating and persisting one
 * first if it doesn't already have one (see Product.ensureBarcode).
 * Used by the Edit Product modal to guarantee a real, scannable value
 * always exists before rendering the barcode image.
 */
const getBarcode = async (req, res, next) => {
    try {
        const barcode = await Product.ensureBarcode(req.params.id);
        if (barcode === null) {
            return res.status(404).json({ success: false, message: 'Product not found.' });
        }
        res.json({ success: true, barcode });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            // Astronomically unlikely (see ensureBarcode comment), but handled
            // cleanly rather than surfacing a raw SQL error.
            return res.status(409).json({ success: false, message: 'Could not generate a unique barcode. Please set one manually.' });
        }
        next(err);
    }
};

module.exports = {
    getProducts, getProduct, createProduct, updateProduct,
    deleteProduct, getAlertSummary, importCSV, getBarcode
};