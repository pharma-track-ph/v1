// ============================================================
// Inventory Controller
// Full CRUD for products (grouped by Brand Name) + Item No. management
// + CSV import + alert counts
//
// "Product" here means a BRAND (e.g. "Paracetamol 500mg"), rolled up
// from one or more underlying batch rows -- see Product.js's "Brand-level
// grouping" section for how that rollup works. Each brand's Item No.
// entries are the individual batch rows underneath it.
// ============================================================
const Product      = require('../models/Product');
const { logAudit } = require('../middleware/authMiddleware');
const fs           = require('fs');
const path         = require('path');
const ExcelJS      = require('exceljs');

/**
 * GET /api/inventory
 * Returns one summary row per Brand Name, with a rolled-up stock_status
 * (see Product._rollUpGroup) and has_item_expiring_this_month/3mo flags.
 * Query params: search, category, status
 */
const getProducts = async (req, res, next) => {
    try {
        const { search = '', category = '', status = '' } = req.query;
        const products = await Product.findAllGrouped({ search, category, status });
        res.json({ success: true, data: products, total: products.length });
    } catch (err) { next(err); }
};

/**
 * GET /api/inventory/:id
 * Full detail for the Edit modal: top-level (shared) fields plus every
 * Item No. entry for that brand. :id can be ANY row belonging to the
 * brand -- the group is always re-resolved by its current name.
 */
const getProduct = async (req, res, next) => {
    try {
        const group = await Product.findGroupById(req.params.id);
        if (!group) return res.status(404).json({ success: false, message: 'Product not found.' });
        res.json({ success: true, data: group });
    } catch (err) { next(err); }
};

/**
 * POST /api/inventory  [Admin+]
 * "Add Product" -- a brand-new medicine, captured once: its shared
 * details plus its very first Item No. (stock_quantity + expiry_date) in
 * the same request. If no barcode is supplied, one is auto-generated and
 * persisted immediately after insert, so every product always has a
 * scannable code from the moment it's created.
 */
const createProduct = async (req, res, next) => {
    try {
        const id = await Product.createGroup(req.body);

        if (!req.body.barcode) {
            await Product.ensureBarcode(id);
        }

        await logAudit(req.user.id, 'CREATE_PRODUCT', 'products', id, req.body, req.ip);
        res.status(201).json({ success: true, message: 'Product created.', id });
    } catch (err) {
        if (err.code === 'DUPLICATE_BRAND') {
            return res.status(409).json({ success: false, message: err.message });
        }
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ success: false, message: 'Barcode already exists.' });
        }
        next(err);
    }
};

/**
 * PUT /api/inventory/:id  [Admin+]
 * Edits the brand's SHARED/top-level fields -- cascades across every
 * Item No. row in the group (see Product.updateGroupFields for why).
 * Does not touch stock_quantity/expiry_date on any individual item --
 * those go through the addItem/updateItem/deleteItem endpoints below.
 */
const updateProduct = async (req, res, next) => {
    try {
        const before = await Product.findGroupById(req.params.id);
        if (!before) return res.status(404).json({ success: false, message: 'Product not found.' });

        const affected = await Product.updateGroupFields(req.params.id, req.body);
        if (!affected) return res.status(404).json({ success: false, message: 'Product not found.' });

        await logAudit(req.user.id, 'UPDATE_PRODUCT', 'products', req.params.id,
            { before, after: req.body }, req.ip);

        res.json({ success: true, message: 'Product updated.' });
    } catch (err) {
        if (err.code === 'DUPLICATE_BRAND') {
            return res.status(409).json({ success: false, message: err.message });
        }
        next(err);
    }
};

/**
 * DELETE /api/inventory/:id  [Admin+]
 * Soft-deletes the WHOLE brand -- every Item No. under it at once.
 * Preserves historical order records, same as before.
 */
const deleteProduct = async (req, res, next) => {
    try {
        const affected = await Product.softDeleteGroup(req.params.id);
        if (!affected) return res.status(404).json({ success: false, message: 'Product not found.' });

        await logAudit(req.user.id, 'DELETE_PRODUCT', 'products', req.params.id, {}, req.ip);
        res.json({ success: true, message: 'Product removed.' });
    } catch (err) { next(err); }
};

/**
 * POST /api/inventory/:id/items  [Admin+]
 * "Add Item No." -- logs a new restock shipment (quantity + expiry) for
 * an EXISTING brand, cloning its shared details automatically.
 */
const addItem = async (req, res, next) => {
    try {
        const { stock_quantity, expiry_date } = req.body;
        if (stock_quantity === undefined || stock_quantity === null || !expiry_date) {
            return res.status(400).json({ success: false, message: 'Stock quantity and expiry date are required.' });
        }

        const itemId = await Product.addItem(req.params.id, {
            stock_quantity: parseInt(stock_quantity),
            expiry_date
        });
        if (!itemId) return res.status(404).json({ success: false, message: 'Product not found.' });

        await logAudit(req.user.id, 'ADD_ITEM', 'products', itemId,
            { product_id: req.params.id, stock_quantity, expiry_date }, req.ip);

        res.status(201).json({ success: true, message: 'Item No. added.', id: itemId });
    } catch (err) { next(err); }
};

/**
 * PUT /api/inventory/items/:itemId  [Admin+]
 * Edits ONE Item No.'s stock_quantity/expiry_date.
 */
const updateItem = async (req, res, next) => {
    try {
        const { stock_quantity, expiry_date } = req.body;
        if (stock_quantity === undefined || stock_quantity === null || !expiry_date) {
            return res.status(400).json({ success: false, message: 'Stock quantity and expiry date are required.' });
        }

        const affected = await Product.updateItem(req.params.itemId, {
            stock_quantity: parseInt(stock_quantity),
            expiry_date
        });
        if (!affected) return res.status(404).json({ success: false, message: 'Item not found.' });

        await logAudit(req.user.id, 'UPDATE_ITEM', 'products', req.params.itemId,
            { stock_quantity, expiry_date }, req.ip);

        res.json({ success: true, message: 'Item updated.' });
    } catch (err) { next(err); }
};

/**
 * DELETE /api/inventory/items/:itemId  [Admin+]
 * Removes ONE Item No. Blocked if it's the last remaining active item
 * for its brand -- delete the whole product instead if it's no longer
 * carried at all.
 */
const deleteItem = async (req, res, next) => {
    try {
        const result = await Product.deleteItem(req.params.itemId);
        if (result.blocked) {
            return res.status(400).json({
                success: false,
                message: "Can't delete the last remaining Item No. -- delete the whole product instead if it's no longer carried."
            });
        }
        if (!result.affected) return res.status(404).json({ success: false, message: 'Item not found.' });

        await logAudit(req.user.id, 'DELETE_ITEM', 'products', req.params.itemId, {}, req.ip);
        res.json({ success: true, message: 'Item removed.' });
    } catch (err) { next(err); }
};

/**
 * GET /api/inventory/alerts/summary
 * Returns low stock/near-expiry/etc. counts (recomputed from the same
 * grouped rollup Inventory itself uses, so header badges never disagree
 * with what filtering Inventory actually returns) and the category list.
 */
const getAlertSummary = async (req, res, next) => {
    try {
        const [counts, categories] = await Promise.all([
            Product.getGroupedAlertCounts(),
            Product.getCategories()
        ]);
        res.json({ success: true, data: { ...counts, categories } });
    } catch (err) { next(err); }
};

// ============================================================
// Inventory Import (CSV or Excel)
// ============================================================
// Accepts EITHER a .csv or a .xlsx/.xls upload -- an Excel file is
// parsed directly (via ExcelJS, already a project dependency for
// exports) into the same row shape a CSV would produce, so everything
// below this point never needs to know which format the file actually
// was.
//
// Uses the CURRENT Brand Name / Item No. column format (matching the
// rest of the app since the Inventory restructure), not the old flat
// batch_number format this endpoint originally shipped with:
//   Brand Name, Generic Name, Category, Supplier, Selling Price, Cost,
//   Low Stock Threshold, Description, Stock Quantity, Expiry Date
// (see IMPORT_COLUMNS below, and GET /import/template for a ready-made
// file with these exact headers).
//
// Per row: Brand Name doesn't exist yet -> "Add Product" (create the
// brand + its first Item No.). Brand Name already exists -> "Add Item
// No." (just a restock -- the row's Stock Quantity/Expiry Date become a
// new Item No., the EXISTING product's shared fields are left alone). If
// a row's other fields (Category, Price, etc.) don't match what's
// already stored for that brand, that's reported back as a mismatch
// rather than silently overwritten -- a bulk import has no per-row
// confirmation step, so silently changing a live product's price because
// of a stale/typo'd spreadsheet cell would be too risky. Edit the
// product directly (or fix the file and re-import) if the shared
// fields genuinely need updating.
// ============================================================

const IMPORT_COLUMNS = [
    'Brand Name', 'Generic Name', 'Category', 'Supplier',
    'Selling Price', 'Cost', 'Low Stock Threshold', 'Description',
    'Stock Quantity', 'Expiry Date'
];

// "Brand Name", "brand_name", "BrandName", "Brand" all resolve to the
// same canonical key -- the uploaded file doesn't have to match the
// template's exact header wording/casing to be recognized.
function normalizeHeader(h) {
    return String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

const HEADER_ALIASES = {
    brandname: 'brand_name', brand: 'brand_name',
    genericname: 'generic_name', generic: 'generic_name',
    category: 'category',
    supplier: 'supplier',
    sellingprice: 'price', price: 'price', sellingpricephp: 'price',
    cost: 'cost', costphp: 'cost',
    lowstockthreshold: 'low_stock_threshold', threshold: 'low_stock_threshold',
    description: 'description', notes: 'description',
    stockquantity: 'stock_quantity', quantity: 'stock_quantity', stock: 'stock_quantity',
    expirydate: 'expiry_date', expiry: 'expiry_date'
};

// Parses either format into { header: [...], rows: [[...], ...] } --
// plain strings throughout (Excel dates included, normalized to
// YYYY-MM-DD), so the row-building logic in importCSV below is
// completely format-agnostic.
async function parseImportFile(filePath, originalName) {
    const ext = path.extname(originalName).toLowerCase();

    if (ext === '.xlsx' || ext === '.xls') {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(filePath);
        const sheet = workbook.worksheets[0];
        if (!sheet) return { header: [], rows: [] };

        const header = (sheet.getRow(1).values || []).slice(1).map(v => String(v ?? '').trim());
        const rows = [];
        for (let r = 2; r <= sheet.rowCount; r++) {
            const raw = (sheet.getRow(r).values || []).slice(1);
            if (raw.every(v => v == null || v === '')) continue; // skip fully blank rows
            rows.push(raw.map(v => {
                if (v instanceof Date) return v.toISOString().split('T')[0];
                if (v && typeof v === 'object' && 'result' in v) return String(v.result ?? ''); // formula cell
                return String(v ?? '').trim();
            }));
        }
        return { header, rows };
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) return { header: [], rows: [] };
    return {
        header: lines[0].split(',').map(h => h.trim()),
        rows:   lines.slice(1).map(l => l.split(',').map(v => v.trim()))
    };
}

/**
 * POST /api/inventory/import  [Admin+]
 * Accepts a .csv or .xlsx upload, see the section comment above for the
 * expected format and per-row Add Product / Add Item No. behavior.
 */
const importCSV = async (req, res, next) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No file uploaded.' });
        }

        const { header, rows } = await parseImportFile(req.file.path, req.file.originalname);
        fs.unlinkSync(req.file.path);

        const canonicalHeader = header.map(h => HEADER_ALIASES[normalizeHeader(h)] || null);

        const required = ['brand_name', 'category', 'stock_quantity', 'expiry_date'];
        const missing  = required.filter(col => !canonicalHeader.includes(col));
        if (missing.length) {
            return res.status(400).json({
                success: false,
                message: `File is missing required columns: ${missing.join(', ')}. Expected columns: ${IMPORT_COLUMNS.join(', ')}.`
            });
        }

        const results = { inserted: 0, restocked: 0, errors: [], field_mismatches: [] };

        for (let i = 0; i < rows.length; i++) {
            const values = rows[i];
            const row = {};
            canonicalHeader.forEach((col, idx) => { if (col) row[col] = values[idx] ?? ''; });

            const rowNum = i + 2; // +1 for the header row, +1 for 1-based row numbers

            if (!row.brand_name || !row.category || !row.expiry_date) {
                results.errors.push(`Row ${rowNum}: Brand Name, Category, and Expiry Date are required.`);
                continue;
            }

            const data = {
                name:                String(row.brand_name).trim(),
                generic_name:        row.generic_name || null,
                category:            String(row.category).trim(),
                supplier:            row.supplier || null,
                description:         row.description || null,
                price:               parseFloat(row.price) || 0,
                cost:                parseFloat(row.cost)  || 0,
                stock_quantity:      parseInt(row.stock_quantity)      || 0,
                low_stock_threshold: parseInt(row.low_stock_threshold) || 10,
                expiry_date:         row.expiry_date
            };

            try {
                const existingId = await Product.findGroupIdByName(data.name);

                if (existingId) {
                    const existingGroup = await Product.findGroupById(existingId);
                    const mismatches = [];
                    if (existingGroup) {
                        if (data.category !== existingGroup.category)                                mismatches.push('Category');
                        if ((data.supplier || '') !== (existingGroup.supplier || ''))                mismatches.push('Supplier');
                        if (Math.abs(data.price - parseFloat(existingGroup.price)) > 0.001)          mismatches.push('Selling Price');
                        if (Math.abs(data.cost  - parseFloat(existingGroup.cost))  > 0.001)          mismatches.push('Cost');
                        if (data.low_stock_threshold !== existingGroup.low_stock_threshold)          mismatches.push('Low Stock Threshold');
                        if ((data.description || '') !== (existingGroup.description || ''))          mismatches.push('Description');
                    }
                    if (mismatches.length) {
                        results.field_mismatches.push(
                            `Row ${rowNum} (${data.name}): ${mismatches.join(', ')} differ from the existing product and were left unchanged -- edit the product directly if these need updating.`
                        );
                    }

                    await Product.addItem(existingId, {
                        stock_quantity: data.stock_quantity,
                        expiry_date:    data.expiry_date
                    });
                    results.restocked++;
                } else {
                    const id = await Product.createGroup(data);
                    await Product.ensureBarcode(id);
                    results.inserted++;
                }
            } catch (err) {
                results.errors.push(`Row ${rowNum} (${row.brand_name}): ${err.message}`);
            }
        }

        await logAudit(req.user.id, 'IMPORT_INVENTORY', 'products', null, results, req.ip);

        res.json({
            success: true,
            message: `Import complete. New products: ${results.inserted}, Restocked: ${results.restocked}` +
                     (results.errors.length ? `, Errors: ${results.errors.length}` : '') +
                     (results.field_mismatches.length ? `, Field mismatches: ${results.field_mismatches.length}` : '') + '.',
            data: results
        });

    } catch (err) { next(err); }
};

/**
 * GET /api/inventory/import/template  [Admin+]
 * Downloadable .xlsx with the exact column headers importCSV expects,
 * plus one filled-in example row -- so a fresh import always starts from
 * the current, correct format instead of guessing column names.
 */
const getImportTemplate = async (req, res, next) => {
    try {
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Import Template');

        sheet.columns = IMPORT_COLUMNS.map(label => ({ header: label, width: Math.max(16, label.length + 4) }));

        sheet.getRow(1).eachCell(cell => {
            cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D6EFD' } };
        });

        sheet.addRow([
            'Paracetamol 500mg', 'Paracetamol', 'Analgesic', 'Unilab Inc.',
            6.50, 3.00, 20, 'Optional notes', 100, '2027-12-31'
        ]);

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="PharmaTrack_Inventory_Import_Template.xlsx"');
        await workbook.xlsx.write(res);
        res.end();
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
    getProducts, getProduct, createProduct, updateProduct, deleteProduct,
    addItem, updateItem, deleteItem,
    getAlertSummary, importCSV, getImportTemplate, getBarcode
};