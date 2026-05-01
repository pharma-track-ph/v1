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
 * FIX Bug 4: The original code passed 'status' to Product.findAll() but
 * that method only accepts { search, category, expiringOnly }. Status was
 * silently ignored, returning all products regardless of the filter.
 * Fix: run findAll() normally, then filter the JS array by stock_status.
 * This works because Product.findAll() already computes stock_status via
 * a SQL CASE expression, so no extra DB query is needed.
 */
const getProducts = async (req, res, next) => {
    try {
        const { search = '', category = '', status = '' } = req.query;

        // 'expiring' in the status dropdown maps to near_expiry in stock_status
        const normalizedStatus = status === 'expiring' ? 'near_expiry' : status;

        let products = await Product.findAll({ search, category });

        // Apply status filter post-fetch if one was requested
        if (normalizedStatus) {
            products = products.filter(p => p.stock_status === normalizedStatus);
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
 */
const createProduct = async (req, res, next) => {
    try {
        const id = await Product.create(req.body);
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
 */
const updateProduct = async (req, res, next) => {
    try {
        const before = await Product.findById(req.params.id);
        if (!before) return res.status(404).json({ success: false, message: 'Product not found.' });

        await Product.update(req.params.id, req.body);
        await logAudit(req.user.id, 'UPDATE_PRODUCT', 'products', req.params.id,
            { before, after: req.body }, req.ip);

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
        const [lowStock, nearExpiry, categories] = await Promise.all([
            Product.getLowStockCount(),
            Product.getNearExpiryCount(),
            Product.getCategories()
        ]);
        res.json({
            success: true,
            data: { low_stock: lowStock, near_expiry: nearExpiry, categories }
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

module.exports = {
    getProducts, getProduct, createProduct, updateProduct,
    deleteProduct, getAlertSummary, importCSV
};