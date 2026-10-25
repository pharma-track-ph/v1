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

// Turns the model's known, user-facing errors into proper replies (400 for bad
// input, 409 for a clash such as a duplicate brand or a barcode already used by
// another brand). Returns true if it answered. Before this, Add Item No. simply
// passed a database refusal on as a vague server error.
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
        if (sendKnownError(res, err)) return;
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
        if (sendKnownError(res, err)) return;
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

        const qty = parseInt(stock_quantity, 10);
        if (!Number.isInteger(qty) || qty < 0) {
            return res.status(400).json({ success: false, message: 'Stock quantity must be a whole number (0 or more).' });
        }

        const name = await Product._resolveGroupName(req.params.id);
        if (!name) return res.status(404).json({ success: false, message: 'Product not found.' });

        // A restock whose expiry date matches an existing Item No. of this brand
        // tops THAT Item No. up, instead of creating a second one for the same date.
        const sameDate = await Product.findItemByBrandAndExpiry(name, expiry_date);
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

// Expiry dates must be a real calendar date written YYYY-MM-DD. (An Excel date
// cell is already turned into that form by parseImportFile.) Returns the
// normalized string, or null if it is missing / not a real date.
function parseImportDate(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? '').trim());
    if (!m) return null;
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const check = new Date(Date.UTC(y, mo - 1, d));
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
    return `${m[1]}-${m[2]}-${m[3]}`;
}

// Two category lists are the same when they hold the same names, ignoring
// order and capitals (so "Analgesic; Antipyretic" equals "antipyretic|Analgesic").
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

        // Template check, part 2: columns in the file that the importer does NOT
        // recognize (a stray "Unit" column, a misspelled header) are listed in
        // the result instead of being silently ignored.
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

            // ---- validate every field first, so a bad row is reported WITH the reason ----
            if (!name) { fail('Brand Name is required.'); continue; }

            let category;
            try {
                // several categories are separated with ; (or |) -- never a comma, which would split the CSV cell
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
                    // The product exists: this row is a RESTOCK. Its other fields are never
                    // written over the live product -- a difference is reported instead.
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

                    // Same expiry date as an existing Item No. -> ADD to it; otherwise a new Item No.
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

/**
 * GET /api/inventory/import/template  [Admin+]
 * Downloadable .xlsx with the exact column headers importCSV expects --
 * header row only, no example data, so it's a genuinely clean starting
 * point to fill in rather than something that needs a placeholder row
 * deleted first.
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

        // Second sheet: how to fill it in. The FIRST sheet stays header-only (that
        // is the one the importer reads), so it can be filled in straight away.
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

/**
 * Manage Categories  [Admin+]
 * GET  /api/inventory/categories           every category with how many brands use it
 * POST /api/inventory/categories           { name }             add a category (not used by any product yet)
 * POST /api/inventory/categories/rename    { from, to }
 * POST /api/inventory/categories/delete    { names: [a, b, ...] }
 * Each change rewrites the category list of every product that has the old
 * name(s), in ONE transaction (see Product.replaceCategories), and is audited.
 */
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

// Delete one or several categories at once. Refused (changing nothing) if a
// product would be left with no category -- see Product.deleteCategories.
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
    addItem, updateItem, deleteItem,
    getAlertSummary, importCSV, getImportTemplate, getBarcode,
    listCategories, addCategory, renameCategory, deleteCategories
};