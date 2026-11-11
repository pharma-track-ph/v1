// Inventory Controller - Full CRUD for products (grouped by Brand Name) + Item No...
const Product      = require('../models/Product');
const { logAudit } = require('../middleware/authMiddleware');
const fs           = require('fs');
const path         = require('path');
const ExcelJS      = require('exceljs');

// Turns the model's known, user-facing errors into proper replies
function sendKnownError(res, err) {
    if (err.code === 'INVALID_INPUT') {
        res.status(400).json({ success: false, message: err.message, ...(err.details && { details: err.details }) });
        return true;
    }
    if (err.code === 'DUPLICATE_BRAND' || err.code === 'DUPLICATE_BARCODE') {
        res.status(409).json({ success: false, message: err.message });
        return true;
    }
    if (err.code === 'ER_DUP_ENTRY') {
        res.status(409).json({ success: false, message: 'That value is already in use by another record.' });
        return true;
    }
    return false;
}

/** GET /api/inventory - Returns one summary row per Brand Name */
const getProducts = async (req, res, next) => {
    try {
        const { search = '', category = '', status = '' } = req.query;
        const products = await Product.findAllGrouped({ search, category, status });
        res.json({ success: true, data: products, total: products.length });
    } catch (err) { next(err); }
};

/** GET /api/inventory/:id - Full detail for the Edit modal: top-level */
const getProduct = async (req, res, next) => {
    try {
        const group = await Product.findGroupById(req.params.id);
        if (!group) return res.status(404).json({ success: false, message: 'Product not found.' });
        res.json({ success: true, data: group });
    } catch (err) { next(err); }
};

/** POST /api/inventory [Admin+] - "Add Product" - a brand-new medicine */
const createProduct = async (req, res, next) => {
    try {
        const id = await Product.createGroup(req.body);

        if (!req.body.barcode) {
            await Product.ensureBarcode(id);
        }

        await logAudit(req.user.id, 'CREATE_PRODUCT', 'products', id, req.body, req.ip);
        res.status(201).json({ success: true, message: 'Product created.', id });
    } catch (err) {
        if (sendKnownError(res, err)) return;
        next(err);
    }
};

/** PUT /api/inventory/:id [Admin+] - Edits the brand's SHARED/top-level fields */
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
        if (sendKnownError(res, err)) return;
        next(err);
    }
};

/** DELETE /api/inventory/:id [Admin+] - Soft-deletes the WHOLE brand */
const deleteProduct = async (req, res, next) => {
    try {
        // Note what is being deleted BEFORE it is gone
        const before   = await Product.findGroupById(req.params.id);
        const affected = await Product.softDeleteGroup(req.params.id);
        if (!affected) return res.status(404).json({ success: false, message: 'Product not found.' });

        await logAudit(req.user.id, 'DELETE_PRODUCT', 'products', req.params.id,
            before ? { product: before.name, item_nos: before.item_count, units_in_stock: before.stock_quantity, expired_units: before.expired_units || 0 } : {},
            req.ip);
        res.json({ success: true, message: 'Product removed.' });
    } catch (err) { next(err); }
};

/** POST /api/inventory/:id/items [Admin+] - "Add Item No." - logs a new restock... */
const addItem = async (req, res, next) => {
    try {
        const { stock_quantity, expiry_date } = req.body;
        if (stock_quantity === undefined || stock_quantity === null || !expiry_date) {
            return res.status(400).json({ success: false, message: 'Stock quantity and expiry date are required.' });
        }

        const qty = parseInt(stock_quantity, 10);
        if (!Number.isInteger(qty) || qty < 0) {
            return res.status(400).json({ success: false, message: 'Stock quantity must be a whole number (0 or more).' });
        }

        const name = await Product._resolveGroupName(req.params.id);
        if (!name) return res.status(404).json({ success: false, message: 'Product not found.' });

        // A restock whose expiry date matches an existing Item No. of this brand...
        const sameDate = await Product.findItemByBrandAndExpiry(name, expiry_date, qty);
        if (sameDate) {
            await Product.addStockToItem(sameDate.id, qty);
            await logAudit(req.user.id, 'ADD_ITEM', 'products', sameDate.id,
                { product_id: req.params.id, stock_quantity: qty, expiry_date, topped_up: true }, req.ip);
            return res.json({
                success: true,
                message: `Added ${qty} to Item No. ${sameDate.itemNo} (it already had this expiry date). It now has ${sameDate.stock_quantity + qty}.`,
                id: sameDate.id, topped_up: true, item_no: sameDate.itemNo
            });
        }

        const itemId = await Product.addItem(req.params.id, {
            stock_quantity: qty,
            expiry_date
        });
        if (!itemId) return res.status(404).json({ success: false, message: 'Product not found.' });

        await logAudit(req.user.id, 'ADD_ITEM', 'products', itemId,
            { product_id: req.params.id, stock_quantity: qty, expiry_date }, req.ip);

        res.status(201).json({ success: true, message: 'Item No. added.', id: itemId });
    } catch (err) {
        if (sendKnownError(res, err)) return;
        next(err);
    }
};

/** PUT /api/inventory/items/:itemId [Admin+] - Edits ONE Item No.'s... */
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

/** DELETE /api/inventory/items/:itemId [Admin+] - Removes ONE Item No. Blocked... */
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

        await logAudit(req.user.id, 'DELETE_ITEM', 'products', req.params.itemId,
            { product: result.name, item_no: result.itemNo, units: result.units, expiry_date: result.expiry_date }, req.ip);
        // group_id: a row of this product that is still live, so the Edit window
        res.json({ success: true, message: 'Item removed.', group_id: await Product.findGroupIdByName(result.name) });
    } catch (err) { next(err); }
};

/** POST /api/inventory/items/:itemId/remove [Admin+] "Remove" on an EXPIRED Item... */
const removeItem = async (req, res, next) => {
    try {
        const r = await Product.removeItem(req.params.itemId);
        if (!r.found) return res.status(404).json({ success: false, message: 'Item not found.' });
        if (!r.removable) {
            return res.status(400).json({
                success: false,
                message: 'Only an expired Item No., or one with no units left, can be removed here. Use Delete for any other batch.'
            });
        }

        await logAudit(req.user.id, 'REMOVE_ITEM', 'products', req.params.itemId, {
            product:          r.name,
            item_no:          r.itemNo,
            units:            r.units,
            expiry_date:      r.expiry_date,
            reason:           r.reason,
            last_item:        r.lastItem,
            kept_in_database: true
        }, req.ip);

        res.json({
            success: true,
            last_item: r.lastItem,
            group_id: await Product.findGroupIdByName(r.name),   // a still-live row of this product
            message: r.lastItem
                ? `Item No. ${r.itemNo} removed. The product stays in Inventory with no Item No. -- use Add Item No. when new stock arrives.`
                : `Item No. ${r.itemNo} removed.`
        });
    } catch (err) { next(err); }
};

/** GET /api/inventory/alerts/summary - Returns low stock/near-expiry/etc. counts */
const getAlertSummary = async (req, res, next) => {
    try {
        const [counts, categories] = await Promise.all([
            Product.getGroupedAlertCounts(),
            Product.getCategories()
        ]);
        res.json({ success: true, data: { ...counts, categories } });
    } catch (err) { next(err); }
};

// Inventory Import (CSV or Excel) - Accepts EITHER a .csv or a .xlsx/.xls upload

const IMPORT_COLUMNS = [
    'Brand Name', 'Generic Name', 'Category', 'Supplier',
    'Selling Price', 'Cost', 'Low Stock Threshold', 'Description',
    'Stock Quantity', 'Expiry Date'
];

// "Brand Name", "brand_name", "BrandName", "Brand" all resolve to the same canonical...
function normalizeHeader(h) {
    return String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Expiry dates must be a real calendar date written YYYY-MM-DD.
function parseImportDate(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? '').trim());
    if (!m) return null;
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const check = new Date(Date.UTC(y, mo - 1, d));
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
    return `${m[1]}-${m[2]}-${m[3]}`;
}

// Two category lists are the same when they hold the same names
function sameCategoryList(a, b) {
    const key = (v) => Product.splitCategories(v).map(s => s.toLowerCase()).sort().join('|');
    return key(a) === key(b);
}

const HEADER_ALIASES = {
    brandname: 'brand_name', brand: 'brand_name',
    genericname: 'generic_name', generic: 'generic_name',
    category: 'category', categories: 'category',
    supplier: 'supplier',
    sellingprice: 'price', price: 'price', sellingpricephp: 'price',
    cost: 'cost', costphp: 'cost',
    lowstockthreshold: 'low_stock_threshold', threshold: 'low_stock_threshold',
    description: 'description', notes: 'description',
    stockquantity: 'stock_quantity', quantity: 'stock_quantity', stock: 'stock_quantity',
    expirydate: 'expiry_date', expiry: 'expiry_date'
};

// Parses either format into { header: [...], rows: [[...]
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
                if (v && typeof v === 'object' && 'result' in v) return String(v.result ?? '');
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

/** POST /api/inventory/import [Admin+] - Accepts a .csv or .xlsx upload */
const importCSV = async (req, res, next) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No file uploaded.' });
        }

        // The uploaded file is read once and then deleted
        let parsed;
        try {
            parsed = await parseImportFile(req.file.path, req.file.originalname);
        } finally {
            try { fs.unlinkSync(req.file.path); } catch (e) { /* already gone */ }
        }
        const { header, rows } = parsed;

        const canonicalHeader = header.map(h => HEADER_ALIASES[normalizeHeader(h)] || null);

        const required = ['brand_name', 'category', 'stock_quantity', 'expiry_date'];
        const missing  = required.filter(col => !canonicalHeader.includes(col));
        if (missing.length) {
            return res.status(400).json({
                success: false,
                message: `File is missing required columns: ${missing.join(', ')}. Expected columns: ${IMPORT_COLUMNS.join(', ')}.`
            });
        }

        // Template check, part 2: columns in the file that the importer does NOT...
        const ignoredColumns = header.filter((h, i) => String(h || '').trim() && !canonicalHeader[i]);

        if (!rows.length) {
            return res.status(400).json({ success: false, message: 'The file has a header row but no data rows.' });
        }

        await Product.refreshCategoryLimit();   // category-list limit = the column's real length

        const results = {
            inserted: 0,          // brand-new products
            restocked: 0,         // new Item Nos. for an existing product
            topped_up: 0,         // quantity ADDED to an existing Item No. (same expiry date)
            errors: [], field_mismatches: [], details: [], ignored_columns: ignoredColumns
        };

        for (let i = 0; i < rows.length; i++) {
            const values = rows[i];
            const row = {};
            canonicalHeader.forEach((col, idx) => { if (col) row[col] = values[idx] ?? ''; });

            const rowNum = i + 2; // +1 for the header row, +1 for 1-based row numbers
            const name   = String(row.brand_name || '').trim();
            const fail   = (msg) => results.errors.push(`Row ${rowNum}${name ? ` (${name})` : ''}: ${msg}`);

            // validate every field first, so a bad row is reported WITH the reason
            if (!name) { fail('Brand Name is required.'); continue; }

            let category;
            try {
                // several categories are separated with ; (or |)
                category = Product.normalizeCategories(String(row.category || '').split(/[;|]/));
            } catch (e) {
                fail(e.message === 'Choose at least one category.' ? 'Category is required (separate several with ;).' : e.message);
                continue;
            }

            const expiry = parseImportDate(row.expiry_date);
            if (!expiry) { fail('Expiry Date is required and must be written YYYY-MM-DD (for example 2027-06-30).'); continue; }

            const qtyText = String(row.stock_quantity ?? '').trim();
            const qty     = Number(qtyText);
            if (qtyText === '' || !Number.isInteger(qty) || qty < 0) {
                fail('Stock Quantity is required and must be a whole number (0 or more).');
                continue;
            }

            // blank -> null ("not given"), bad -> NaN
            const money = (v) => {
                const t = String(v ?? '').trim().replace(/,/g, '');
                if (t === '') return null;
                const n = Number(t);
                return Number.isFinite(n) && n >= 0 ? n : NaN;
            };
            const price = money(row.price);
            const cost  = money(row.cost);
            if (Number.isNaN(price)) { fail('Selling Price must be a number (0 or more).'); continue; }
            if (Number.isNaN(cost))  { fail('Cost must be a number (0 or more).'); continue; }

            const thresholdText = String(row.low_stock_threshold ?? '').trim();
            let threshold = 10;
            if (thresholdText !== '') {
                const t = Number(thresholdText);
                if (!Number.isInteger(t) || t < 0) { fail('Low Stock Threshold must be a whole number (0 or more).'); continue; }
                threshold = t;
            }

            const data = {
                name,
                generic_name:        row.generic_name || null,
                category,
                supplier:            row.supplier || null,
                description:         row.description || null,
                price:               price ?? 0,
                cost:                cost  ?? 0,
                stock_quantity:      qty,
                low_stock_threshold: threshold,
                expiry_date:         expiry
            };

            try {
                const existingId = await Product.findGroupIdByName(name);

                if (existingId) {
                    // The product exists: this row is a RESTOCK.
                    const existingGroup = await Product.findGroupById(existingId);
                    const mismatches = [];
                    if (existingGroup) {
                        if (!sameCategoryList(category, existingGroup.category))                          mismatches.push('Category');
                        if (row.supplier && (data.supplier || '') !== (existingGroup.supplier || ''))     mismatches.push('Supplier');
                        if (price !== null && Math.abs(price - parseFloat(existingGroup.price)) > 0.001)  mismatches.push('Selling Price');
                        if (cost  !== null && Math.abs(cost  - parseFloat(existingGroup.cost))  > 0.001)  mismatches.push('Cost');
                        if (thresholdText !== '' && threshold !== existingGroup.low_stock_threshold)      mismatches.push('Low Stock Threshold');
                        if (row.description && (data.description || '') !== (existingGroup.description || '')) mismatches.push('Description');
                    }
                    if (mismatches.length) {
                        results.field_mismatches.push(
                            `Row ${rowNum} (${name}): ${mismatches.join(', ')} differ from the existing product and were left unchanged -- edit the product directly if these need updating.`
                        );
                    }

                    // Same expiry date as an existing Item No. -> ADD to it
                    const sameDate = await Product.findItemByBrandAndExpiry(name, expiry);
                    if (sameDate) {
                        await Product.addStockToItem(sameDate.id, qty);
                        results.topped_up++;
                        results.details.push(`Row ${rowNum} (${name}): added ${qty} to Item No. ${sameDate.itemNo} (exp ${expiry}); it now has ${sameDate.stock_quantity + qty}.`);
                    } else {
                        await Product.addItem(existingId, { stock_quantity: qty, expiry_date: expiry });
                        const itemNo = (await Product._fetchGroupRowsByName(name)).length;
                        results.restocked++;
                        results.details.push(`Row ${rowNum} (${name}): new Item No. ${itemNo} with ${qty} (exp ${expiry}).`);
                    }
                } else {
                    if (price === null || cost === null) {
                        fail('Selling Price and Cost are required for a new product.');
                        continue;
                    }
                    const id = await Product.createGroup(data);
                    await Product.ensureBarcode(id);
                    results.inserted++;
                    results.details.push(`Row ${rowNum} (${name}): created as a new product, Item No. 1 with ${qty} (exp ${expiry}).`);
                }
            } catch (err) {
                fail(err.message);
            }
        }

        await logAudit(req.user.id, 'IMPORT_INVENTORY', 'products', null, results, req.ip);

        res.json({
            success: true,
            message: `Import complete. New products: ${results.inserted}, New Item Nos.: ${results.restocked}, Added to existing Item Nos.: ${results.topped_up}` +
                     (results.errors.length ? `, Errors: ${results.errors.length}` : '') +
                     (results.field_mismatches.length ? `, Field mismatches: ${results.field_mismatches.length}` : '') + '.',
            data: results
        });

    } catch (err) { next(err); }
};

/** GET /api/inventory/import/template [Admin+] - Downloadable .xlsx... */
const getImportTemplate = async (req, res, next) => {
    try {
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Import Template');

        sheet.columns = IMPORT_COLUMNS.map(label => ({ header: label, width: Math.max(16, label.length + 4) }));

        sheet.getRow(1).eachCell(cell => {
            cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D6EFD' } };
        });

        // Second sheet: how to fill it in.
        const help = workbook.addWorksheet('How to fill');
        help.columns = [{ header: 'Column', width: 24 }, { header: 'Required?', width: 18 }, { header: 'What to enter', width: 100 }];
        help.getRow(1).eachCell(cell => {
            cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D6EFD' } };
        });
        [
            ['Brand Name',          'Yes',                'The product name. If a product with this name already exists, the row is a RESTOCK of it; otherwise a new product is created.'],
            ['Generic Name',        'No',                 'The generic (medicine) name.'],
            ['Category',            'Yes',                'One or more categories. Separate several with a semicolon, for example: Analgesic; Antipyretic. Do not use commas.'],
            ['Supplier',            'No',                 ''],
            ['Selling Price',       'New products',       'Price per piece, in pesos. For an existing product it is only compared, never changed.'],
            ['Cost',                'New products',       'Cost per piece, in pesos. For an existing product it is only compared, never changed.'],
            ['Low Stock Threshold', 'No',                 'Whole number. Left blank = 10.'],
            ['Description',         'No',                 ''],
            ['Stock Quantity',      'Yes',                'Pieces received, as a whole number.'],
            ['Expiry Date',         'Yes',                'Written YYYY-MM-DD (for example 2027-06-30). If the product already has an Item No. with this exact expiry date, the quantity is ADDED to that Item No.; otherwise a new Item No. is created.']
        ].forEach(r => help.addRow(r));
        help.eachRow({ includeEmpty: false }, row => row.eachCell(cell => {
            cell.alignment = { vertical: 'top', wrapText: true };
        }));

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="PharmaTrack_Inventory_Import_Template.xlsx"');
        await workbook.xlsx.write(res);
        res.end();
    } catch (err) { next(err); }
};

/** GET /api/inventory/:id/barcode [Admin+] - Returns the product's barcode */
const getBarcode = async (req, res, next) => {
    try {
        const barcode = await Product.ensureBarcode(req.params.id);
        if (barcode === null) {
            return res.status(404).json({ success: false, message: 'Product not found.' });
        }
        res.json({ success: true, barcode });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            // Astronomically unlikely (see ensureBarcode comment)
            return res.status(409).json({ success: false, message: 'Could not generate a unique barcode. Please set one manually.' });
        }
        next(err);
    }
};

/** Manage Categories [Admin+] - GET /api/inventory/categories every category... */
const listCategories = async (req, res, next) => {
    try {
        res.json({ success: true, data: await Product.getCategorySummary() });
    } catch (err) { next(err); }
};

function cleanNames(value) {
    return (Array.isArray(value) ? value : [value]).map(v => String(v ?? '').trim()).filter(Boolean);
}

const renameCategory = async (req, res, next) => {
    try {
        const from = cleanNames(req.body.from);
        const to   = cleanNames(req.body.to);
        if (from.length !== 1 || to.length !== 1) {
            return res.status(400).json({ success: false, message: 'Choose the category to rename and give its new name.' });
        }
        const changed = await Product.replaceCategories(from, to);
        await logAudit(req.user.id, 'CHANGE_CATEGORIES', 'products', null, { kind: 'rename', from, to, rows_changed: changed }, req.ip);
        res.json({
            success: true,
            message: `Renamed "${from[0]}" to "${to[0]}" on ${changed} Item No. entr${changed === 1 ? 'y' : 'ies'}.`,
            changed
        });
    } catch (err) {
        if (sendKnownError(res, err)) return;
        next(err);
    }
};

// Add a category to the list without attaching it to any product yet
const addCategory = async (req, res, next) => {
    try {
        const name = await Product.addCategoryName(req.body.name);
        await logAudit(req.user.id, 'CHANGE_CATEGORIES', 'products', null, { kind: 'add', name }, req.ip);
        res.status(201).json({ success: true, message: `Category "${name}" added.`, name });
    } catch (err) {
        if (sendKnownError(res, err)) return;
        next(err);
    }
};

// Delete one or several categories at once.
const deleteCategories = async (req, res, next) => {
    try {
        const names = cleanNames(req.body.names);
        if (!names.length) {
            return res.status(400).json({ success: false, message: 'Choose the categories to delete.' });
        }
        const result = await Product.deleteCategories(names);
        await logAudit(req.user.id, 'CHANGE_CATEGORIES', 'products', null, { kind: 'delete', names, rows_changed: result.rows }, req.ip);
        res.json({
            success: true,
            message: `Deleted ${names.length} categor${names.length === 1 ? 'y' : 'ies'}` +
                     (result.rows ? ` (removed from ${result.rows} Item No. entr${result.rows === 1 ? 'y' : 'ies'}).` : '.'),
            changed: result.rows
        });
    } catch (err) {
        if (sendKnownError(res, err)) return;
        next(err);
    }
};

module.exports = {
    getProducts, getProduct, createProduct, updateProduct, deleteProduct,
    addItem, updateItem, deleteItem, removeItem,
    getAlertSummary, importCSV, getImportTemplate, getBarcode,
    listCategories, addCategory, renameCategory, deleteCategories
};