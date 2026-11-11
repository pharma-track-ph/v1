// Product Model - Core inventory entity.
const db = require('../config/db');
const AppSetting = require('./AppSetting');
const manilaTime = require('../utils/manilaTime');
const { plainTextProblem } = require('../utils/inputGuards');

const Product = {
    findAll: async ({ search = '', category = '', status = '' } = {}) => {
        let sql = `
            SELECT *,
                   DATEDIFF(expiry_date, CURDATE()) AS days_until_expiry,
                   CASE
                       WHEN stock_quantity <= 0                                THEN 'out_of_stock'
                       WHEN expiry_date < CURDATE()                            THEN 'expired'
                       WHEN DATEDIFF(expiry_date, CURDATE()) <= 30             THEN 'near_expiry'
                       WHEN DATEDIFF(expiry_date, CURDATE()) <= 90             THEN 'expiring_3mo'
                       WHEN stock_quantity <= low_stock_threshold              THEN 'low_stock'
                       ELSE 'in_stock'
                   END AS stock_status
            FROM products
            WHERE is_active = 1
        `;
        const params = [];

        if (search) {
            sql += ' AND (name LIKE ? OR generic_name LIKE ? OR batch_number LIKE ? OR barcode = ?)';
            const like = `%${search}%`;
            params.push(like, like, like, search);
        }

        if (category) {
            sql += Product._categoryClause(category, params);
        }

        if (status) {
            switch (status) {
                case 'low_stock':
                    // Independent of expiry now
                    sql += ' AND stock_quantity > 0 AND stock_quantity <= low_stock_threshold';
                    break;
                case 'expiring':
                    // A batch that's sold out (stock 0) is never "expiring soon"...
                    sql += ' AND expiry_date >= CURDATE() AND DATEDIFF(expiry_date, CURDATE()) <= 30 AND stock_quantity > 0';
                    break;
                case 'expiring_3mo':
                    // Deliberately INCLUSIVE of the 1-month tier (0-90 days)
                    sql += ' AND expiry_date >= CURDATE() AND DATEDIFF(expiry_date, CURDATE()) <= 90 AND stock_quantity > 0';
                    break;
                case 'expired':
                    // Once a batch hits 0 stock it's "Sold Out", not "Expired"
                    sql += ' AND expiry_date < CURDATE() AND stock_quantity > 0';
                    break;
                case 'out_of_stock':
                    sql += ' AND stock_quantity <= 0';
                    break;
                case 'in_stock':
                    sql += ' AND stock_quantity > low_stock_threshold AND expiry_date >= CURDATE() AND DATEDIFF(expiry_date, CURDATE()) > 90';
                    break;
            }
        }

        // Out-of-stock items sort to the very bottom regardless of their expiry_date
        let orderBy = 'CASE WHEN stock_quantity <= 0 THEN 1 ELSE 0 END';

        if (search) {
            // Same relevance ranking as findAllForPOS
            orderBy += `,
                CASE
                    WHEN name LIKE ?         THEN 0
                    WHEN generic_name LIKE ? THEN 1
                    ELSE 2
                END`;
            const startsWith = `${search}%`;
            params.push(startsWith, startsWith);
        }

        sql += ` ORDER BY ${orderBy}, expiry_date ASC, name ASC`;
        const [rows] = await db.query(sql, params);
        return rows;
    },

    findById: async (id) => {
        const [rows] = await db.query(
            `SELECT *,
                    DATEDIFF(expiry_date, CURDATE()) AS days_until_expiry
             FROM products WHERE id = ? AND is_active = 1 LIMIT 1`,
            [id]
        );
        return rows[0] || null;
    },

    findByBarcode: async (barcode) => {
        const [rows] = await db.query(
            `SELECT *,
                    DATEDIFF(expiry_date, CURDATE()) AS days_until_expiry
             FROM products WHERE barcode = ? AND is_active = 1 LIMIT 1`,
            [barcode]
        );
        return rows[0] || null;
    },

    create: async (data) => {
        const {
            batch_number, name, generic_name = null, category, supplier = null,
            description = null, barcode = null, price, cost, stock_quantity,
            low_stock_threshold = 10, expiry_date, is_tax_exempt = 0
        } = data;

        const [result] = await db.query(
            `INSERT INTO products
             (batch_number, name, generic_name, category, supplier, description,
              barcode, price, cost, stock_quantity, low_stock_threshold, expiry_date, is_tax_exempt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            // batch_number is a legacy column (Item Nos. replaced it).
            [batch_number ?? '', name, generic_name, category, supplier, description,
             barcode, price, cost, stock_quantity, low_stock_threshold, expiry_date, is_tax_exempt ? 1 : 0]
        );
        return result.insertId;
    },

    update: async (id, data) => {
        const {
            batch_number, name, generic_name, category, supplier,
            description, barcode, price, cost, stock_quantity,
            low_stock_threshold, expiry_date
        } = data;

        const [result] = await db.query(
            `UPDATE products SET
                batch_number = ?, name = ?, generic_name = ?, category = ?,
                supplier = ?, description = ?, barcode = ?, price = ?, cost = ?,
                stock_quantity = ?, low_stock_threshold = ?, expiry_date = ?
             WHERE id = ? AND is_active = 1`,
            [batch_number, name, generic_name, category, supplier, description,
             barcode, price, cost, stock_quantity, low_stock_threshold, expiry_date, id]
        );
        return result.affectedRows;
    },

    decrementStock: async (id, quantity, connection = null) => {
        // Accepts an optional transaction connection for POS checkout
        const executor = connection || db;
        const [result] = await executor.query(
            `UPDATE products
             SET stock_quantity = stock_quantity - ?
             WHERE id = ? AND stock_quantity >= ? AND is_active = 1`,
            [quantity, id, quantity]
        );
        return result.affectedRows;  // 0 if insufficient stock
    },

    softDelete: async (id) => {
        const [result] = await db.query(
            'UPDATE products SET is_active = 0 WHERE id = ?',
            [id]
        );
        return result.affectedRows;
    },

    getLowStockCount: async () => {
        // Independent of expiry now...
        const [rows] = await db.query(
            `SELECT COUNT(*) AS count FROM products
             WHERE is_active = 1
               AND stock_quantity > 0
               AND stock_quantity <= low_stock_threshold`
        );
        return rows[0].count;
    },

    getNearExpiryCount: async () => {
        // Excludes sold-out batches (stock 0)
        const [rows] = await db.query(
            `SELECT COUNT(*) AS count FROM products
             WHERE is_active = 1
               AND expiry_date >= CURDATE()
               AND DATEDIFF(expiry_date, CURDATE()) <= 30
               AND stock_quantity > 0`
        );
        return rows[0].count;
    },

    // "Expiring in 3 Months" header alert / filter count
    getExpiring3MonthsCount: async () => {
        const [rows] = await db.query(
            `SELECT COUNT(*) AS count FROM products
             WHERE is_active = 1
               AND expiry_date >= CURDATE()
               AND DATEDIFF(expiry_date, CURDATE()) <= 90
               AND stock_quantity > 0`
        );
        return rows[0].count;
    },

    getExpiredCount: async () => {
        // Once a batch's stock hits 0 it's "Sold Out", not "Expired"
        const [rows] = await db.query(
            `SELECT COUNT(*) AS count FROM products
             WHERE is_active = 1 AND expiry_date < CURDATE() AND stock_quantity > 0`
        );
        return rows[0].count;
    },

    getOutOfStockCount: async () => {
        // Out of stock is now the TOP-priority status (see findAll's CASE)
        const [rows] = await db.query(
            `SELECT COUNT(*) AS count FROM products
             WHERE is_active = 1 AND stock_quantity <= 0`
        );
        return rows[0].count;
    },

    // POS-specific fetch: only active, non-expired batches Used by /api/pos/products
    findAllForPOS: async (search = '') => {
        let sql = `
            SELECT *,
                   DATEDIFF(expiry_date, CURDATE()) AS days_until_expiry
            FROM products
            WHERE is_active = 1
              AND expiry_date > CURDATE()
              AND stock_quantity > 0
        `;
        const params = [];
        if (search) {
            sql += ' AND (name LIKE ? OR generic_name LIKE ? OR batch_number LIKE ? OR barcode = ?)';
            const like = `%${search}%`;
            params.push(like, like, like, search);

            // A short or common search term (e.g. just "a") can match dozens...
            sql += ` ORDER BY
                        CASE
                            WHEN name LIKE ?         THEN 0
                            WHEN generic_name LIKE ? THEN 1
                            ELSE 2
                        END,
                        name ASC, expiry_date ASC`;
            const startsWith = `${search}%`;
            params.push(startsWith, startsWith);
        } else {
            sql += ' ORDER BY name ASC, expiry_date ASC';
        }
        const [rows] = await db.query(sql, params);
        return rows;
    },

    // All active, non-expired batches sharing an exact product name.
    findActiveNonExpiredByName: async (name) => {
        const [rows] = await db.query(
            `SELECT *,
                    DATEDIFF(expiry_date, CURDATE()) AS days_until_expiry
             FROM products
             WHERE is_active = 1 AND expiry_date > CURDATE() AND stock_quantity > 0 AND name = ?
             ORDER BY expiry_date ASC`,
            [name]
        );
        return rows;
    },

    // Categories (several per product) - A product's categories live in the SAME...
    MAX_CATEGORY_LENGTH: 80,
    _limitCheckedAt: 0,

    refreshCategoryLimit: async () => {
        if (Date.now() - Product._limitCheckedAt < 30000) return Product.MAX_CATEGORY_LENGTH;
        try {
            const [rows] = await db.query(
                `SELECT CHARACTER_MAXIMUM_LENGTH AS len FROM information_schema.columns
                 WHERE table_schema = DATABASE() AND table_name = 'products' AND column_name = 'category'`
            );
            const len = Number(rows[0]?.len);
            if (Number.isFinite(len) && len > 0) Product.MAX_CATEGORY_LENGTH = len;
            Product._limitCheckedAt = Date.now();
        } catch (e) { /* keep the last known limit */ }
        return Product.MAX_CATEGORY_LENGTH;
    },

    _invalid: (message) => {
        const err = new Error(message);
        err.code = 'INVALID_INPUT';
        return err;
    },

    // Brand names, generic names, suppliers and categories are plain words that show...
    _assertPlainText: (label, value) => {
        const problem = plainTextProblem(label, value);
        if (problem) throw Product._invalid(problem);
    },

    splitCategories: (value) =>
        String(value ?? '').split('|').map(s => s.trim()).filter(Boolean),

    // Accepts an array, or a string (one name, or an already-joined list)
    normalizeCategories: (input) => {
        const raw = Array.isArray(input) ? input : Product.splitCategories(input);
        const seen = new Set();
        const out  = [];
        for (const item of raw) {
            const name = String(item ?? '').trim().replace(/\s+/g, ' ');
            if (!name) continue;
            if (name.includes('|'))  throw Product._invalid('Category names cannot contain the | character.');
            Product._assertPlainText('Category names', name);
            if (name.length > 60)    throw Product._invalid(`"${name.slice(0, 20)}..." is too long for a category name (60 characters max).`);
            const key = name.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(name);
        }
        if (!out.length) throw Product._invalid('Choose at least one category.');
        const joined = out.join('|');
        if (joined.length > Product.MAX_CATEGORY_LENGTH) {
            throw Product._invalid(`Too many categories for one product: their names add up to ${joined.length} characters and the limit is ${Product.MAX_CATEGORY_LENGTH}. Remove one, or use shorter names.`);
        }
        return joined;
    },

    // SQL for "has this category"
    _categoryClause: (category, params) => {
        const escaped = String(category).replace(/[\\%_]/g, ch => '\\' + ch);
        params.push(`%|${escaped}|%`);
        return " AND CONCAT('|', category, '|') LIKE ? ESCAPE '\\\\'";
    },

    // The barcode is shared by every Item No. of ONE brand
    assertBarcodeFree: async (barcode, brandName) => {
        if (!barcode) return;
        const [rows] = await db.query(
            'SELECT name FROM products WHERE barcode = ? AND is_active = 1 AND LOWER(name) <> LOWER(?) LIMIT 1',
            [barcode, brandName]
        );
        if (rows.length) {
            const err = new Error(`Barcode "${barcode}" is already used by "${rows[0].name}". Each product needs its own barcode.`);
            err.code = 'DUPLICATE_BARCODE';
            throw err;
        }
    },

    // "Extra" categories: names added in Manage Categories BEFORE any product uses...
    EXTRA_CATEGORIES_KEY: 'inventory_extra_categories',

    getExtraCategories: async () => {
        const raw = await AppSetting.get(Product.EXTRA_CATEGORIES_KEY, '[]');
        try {
            const list = JSON.parse(raw);
            return Array.isArray(list) ? list.filter(x => typeof x === 'string' && x.trim()) : [];
        } catch (e) { return []; }
    },

    _saveExtraCategories: async (list) => {
        await AppSetting.set(Product.EXTRA_CATEGORIES_KEY, JSON.stringify(list));
    },

    // Every distinct category: each entry of each product's list, plus the extra
    getCategories: async () => {
        const [rows] = await db.query('SELECT DISTINCT category FROM products WHERE is_active = 1');
        const byKey = new Map();
        rows.forEach(r => Product.splitCategories(r.category).forEach(c => {
            if (!byKey.has(c.toLowerCase())) byKey.set(c.toLowerCase(), c);
        }));
        (await Product.getExtraCategories()).forEach(c => {
            if (!byKey.has(c.toLowerCase())) byKey.set(c.toLowerCase(), c);
        });
        return [...byKey.values()].sort((a, b) => a.localeCompare(b));
    },

    // For the Manage Categories window: each category with how many BRANDS use it
    getCategorySummary: async () => {
        const [rows] = await db.query('SELECT name, category FROM products WHERE is_active = 1 ORDER BY id ASC');
        const seenBrand = new Set();
        const byKey = new Map();
        rows.forEach(r => {
            const brandKey = r.name.toLowerCase();
            if (seenBrand.has(brandKey)) return;           // a brand's rows all share the same categories
            seenBrand.add(brandKey);
            Product.splitCategories(r.category).forEach(c => {
                const e = byKey.get(c.toLowerCase()) || { name: c, brands: 0 };
                e.brands++;
                byKey.set(c.toLowerCase(), e);
            });
        });
        (await Product.getExtraCategories()).forEach(c => {
            if (!byKey.has(c.toLowerCase())) byKey.set(c.toLowerCase(), { name: c, brands: 0 });
        });
        return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
    },

    // Adds a category name to the list without attaching it to any product yet
    addCategoryName: async (name) => {
        await Product.refreshCategoryLimit();
        const clean = Product.splitCategories(Product.normalizeCategories([name]))[0];   // validates: not...
        const existing = await Product.getCategories();
        if (existing.some(c => c.toLowerCase() === clean.toLowerCase())) {
            throw Product._invalid(`"${clean}" already exists.`);
        }
        const extras = await Product.getExtraCategories();
        extras.push(clean);
        await Product._saveExtraCategories(extras);
        return clean;
    },

    // Deletes categories: removes each from every product that has it
    deleteCategories: async (names) => {
        const keys = new Set(names.map(n => String(n).trim().toLowerCase()).filter(Boolean));
        if (!keys.size) throw Product._invalid('Choose the categories to delete.');

        const [rows] = await db.query('SELECT id, name, category FROM products WHERE is_active = 1');
        const changes = [];
        const blocked = new Map();      // product name -> the categories it has
        for (const r of rows) {
            const tokens = Product.splitCategories(r.category);
            if (!tokens.some(t => keys.has(t.toLowerCase()))) continue;
            const rest = tokens.filter(t => !keys.has(t.toLowerCase()));
            if (!rest.length) { blocked.set(r.name, tokens); continue; }
            changes.push({ id: r.id, category: rest.join('|') });
        }
        if (blocked.size) {
            const list = [...blocked.entries()].map(([product, categories]) => ({ product, categories }));
            const shown = list.slice(0, 5).map(b => b.product).join(', ') + (list.length > 5 ? ', ...' : '');
            const asked = names.map(n => String(n).trim()).filter(Boolean);
            const message = asked.length === 1
                ? `Cannot delete "${asked[0]}": ${list.length} product${list.length === 1 ? ' uses' : 's use'} it as ${list.length === 1 ? 'its' : 'their'} ONLY category (${shown}). ` +
                  `Give ${list.length === 1 ? 'that product' : 'those products'} another category first, or rename the category instead.`
                : `Cannot delete: ${list.length} product${list.length === 1 ? '' : 's'} would be left with no category (${shown}). ` +
                  `Give ${list.length === 1 ? 'it' : 'them'} another category first, or rename the category instead.`;
            const err = Product._invalid(message);
            err.details = { blocked: list };       // the page lists these in its warning window
            throw err;
        }

        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();
            for (const c of changes) {
                await connection.query('UPDATE products SET category = ? WHERE id = ?', [c.category, c.id]);
            }
            await connection.commit();
        } catch (e) {
            await connection.rollback();
            throw e;
        } finally {
            connection.release();
        }

        const extras = await Product.getExtraCategories();
        const kept = extras.filter(e => !keys.has(e.toLowerCase()));
        if (kept.length !== extras.length) await Product._saveExtraCategories(kept);

        return { rows: changes.length };
    },

    // Rename / Merge / Split in ONE operation: every active product that has any...
    replaceCategories: async (from, to) => {
        await Product.refreshCategoryLimit();
        const fromKeys = new Set(from.map(x => String(x).trim().toLowerCase()));
        const toList   = Product.splitCategories(Product.normalizeCategories(to));

        const [rows] = await db.query('SELECT id, category FROM products WHERE is_active = 1');
        const changes = [];
        for (const r of rows) {
            const tokens = Product.splitCategories(r.category);
            if (!tokens.some(t => fromKeys.has(t.toLowerCase()))) continue;

            const out = []; const seen = new Set(); let inserted = false;
            const push = (t) => { const k = t.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(t); } };
            for (const t of tokens) {
                if (fromKeys.has(t.toLowerCase())) {
                    if (!inserted) { toList.forEach(push); inserted = true; }
                } else {
                    push(t);
                }
            }
            const joined = out.join('|');
            if (joined.length > Product.MAX_CATEGORY_LENGTH) {
                throw Product._invalid(`That change would give a product too many categories (${joined.length} characters; the limit is ${Product.MAX_CATEGORY_LENGTH}).`);
            }
            if (joined !== r.category) changes.push({ id: r.id, category: joined });
        }

        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();
            for (const c of changes) {
                await connection.query('UPDATE products SET category = ? WHERE id = ?', [c.category, c.id]);
            }
            await connection.commit();
        } catch (e) {
            await connection.rollback();
            throw e;
        } finally {
            connection.release();
        }

        // A renamed category that was only on the extra list
        const extras = await Product.getExtraCategories();
        if (extras.some(e => fromKeys.has(e.toLowerCase()))) {
            const seen = new Set(); const next = []; let placed = false;
            const push = (n) => { const k = n.toLowerCase(); if (!seen.has(k)) { seen.add(k); next.push(n); } };
            extras.forEach(e => {
                if (fromKeys.has(e.toLowerCase())) { if (!placed) { toList.forEach(push); placed = true; } }
                else push(e);
            });
            await Product._saveExtraCategories(next);
        }
        return changes.length;
    },

    // Bulk upsert from CSV import.
    bulkUpsert: async (items) => {
        const results = { inserted: 0, updated: 0, errors: [] };

        for (const item of items) {
            try {
                const [existing] = await db.query(
                    'SELECT id FROM products WHERE batch_number = ? AND expiry_date = ? AND is_active = 1 LIMIT 1',
                    [item.batch_number, item.expiry_date]
                );

                if (existing.length) {
                    // True match on batch + expiry: safe to merge quantity.
                    await db.query(
                        `UPDATE products SET
                            stock_quantity = stock_quantity + ?,
                            price          = ?,
                            cost           = ?
                         WHERE id = ?`,
                        [item.stock_quantity, item.price, item.cost, existing[0].id]
                    );
                    results.updated++;
                } else {
                    await Product.create(item);
                    results.inserted++;
                }
            } catch (err) {
                results.errors.push({ item: item.batch_number, error: err.message });
            }
        }

        return results;
    },

    // Auto-generates and PERSISTS a barcode for a product that doesn't have one yet
    ensureBarcode: async (id) => {
        const [rows] = await db.query('SELECT barcode FROM products WHERE id = ?', [id]);
        if (!rows.length) return null;

        if (rows[0].barcode) return rows[0].barcode;

        const generated = 'PT' + String(id).padStart(6, '0');
        await db.query('UPDATE products SET barcode = ? WHERE id = ?', [generated, id]);
        return generated;
    },

    // Brand-level grouping (Inventory restructure - "Option B") The `products` table...

    // All active rows for a brand-name group, oldest-created first
    _fetchGroupRowsByName: async (name) => {
        const [rows] = await db.query(
            `SELECT *, DATEDIFF(expiry_date, CURDATE()) AS days_until_expiry
             FROM products
             WHERE name = ? AND is_active = 1
             ORDER BY id ASC`,
            [name]
        );
        return rows;
    },

    // Resolves a brand group from ANY one of its rows' ids
    _resolveGroupName: async (anyRowId) => {
        const [rows] = await db.query(
            'SELECT name FROM products WHERE id = ? AND is_active = 1 LIMIT 1',
            [anyRowId]
        );
        return rows.length ? rows[0].name : null;
    },

    // Reverse of _resolveGroupName
    findGroupIdByName: async (name) => {
        const [rows] = await db.query(
            'SELECT id FROM products WHERE LOWER(name) = LOWER(?) AND is_active = 1 ORDER BY id ASC LIMIT 1',
            [name]
        );
        return rows.length ? rows[0].id : null;
    },

    // Rolls a group of batch rows up into one Brand-Name-level summary.
    NO_ITEM_MARK:   '(no item)',
    NO_ITEM_EXPIRY: '2099-12-31',
    _isPlaceholder: (r) => r.batch_number === Product.NO_ITEM_MARK,

    // Expired = its date is before Manila's today
    _isExpired: (r) => new Date(r.expiry_date) < manilaTime.midnight(),

    // Earliest expiry first; the same date -> the older record first.
    _byExpiry: (a, b) => (new Date(a.expiry_date) - new Date(b.expiry_date)) || (a.id - b.id),

    // The two lists the Edit window shows, built the SAME way the screen builds them
    numberItems: (rows) => {
        const real    = rows.filter(r => !Product._isPlaceholder(r));
        const removed = (r) => Product._isExpired(r) || r.stock_quantity <= 0;
        const out = new Map();
        real.filter(r => !removed(r)).sort(Product._byExpiry).forEach((r, i) => out.set(r.id, { itemNo: i + 1, list: 'active' }));
        real.filter(removed).sort(Product._byExpiry).forEach((r, i) => out.set(r.id, { itemNo: i + 1, list: 'removed' }));
        return out;
    },

    _rollUpGroup: (allRows) => {
        // "Today" is Manila's today (its midnight), on ANY server
        const today = manilaTime.midnight();

        // The stand-in batch (if any) carries the product's details but is not a batch.
        const rows  = allRows.filter(r => !Product._isPlaceholder(r));
        const first = allRows[0]; // representative row for shared/top-level fields

        // A product with no Item No. at all (its last batch was removed)
        if (!rows.length) {
            return {
                id:                  first.id,
                name:                first.name,
                generic_name:        first.generic_name,
                category:            first.category,
                supplier:            first.supplier,
                barcode:             first.barcode,
                price:               first.price,
                cost:                first.cost,
                low_stock_threshold: first.low_stock_threshold,
                is_tax_exempt:       first.is_tax_exempt ? 1 : 0,
                description:         first.description,
                stock_quantity:      0,
                stock_status:        'out_of_stock',
                effective_status:    'out_of_stock',
                item_count:          0,
                all_items_expired:   false,
                earliest_expiry:           null,
                earliest_expiry_days_left: null,
                has_item_expiring_this_month: false,
                has_item_expiring_3mo:        false,
                has_expired_stock:   false,
                expired_units:       0
            };
        }

        const nonExpired = rows.filter(r => new Date(r.expiry_date) >= today);
        const allItemsExpired = nonExpired.length === 0;

        const combinedStock = nonExpired.reduce((s, r) => s + r.stock_quantity, 0);
        const threshold = first.low_stock_threshold;

        let stock_status;
        if (combinedStock <= 0)               stock_status = 'out_of_stock';
        else if (combinedStock <= threshold)   stock_status = 'low_stock';
        else                                    stock_status = 'in_stock';

        const hasItemExpiringThisMonth = rows.some(r => r.days_until_expiry >= 0 && r.days_until_expiry <= 30 && r.stock_quantity > 0);
        const hasItemExpiring3mo        = rows.some(r => r.days_until_expiry >= 0 && r.days_until_expiry <= 90 && r.stock_quantity > 0);

        // Single effective_status picked by STRICT priority
        let effective_status;
        if (allItemsExpired)                       effective_status = 'expired';
        else if (stock_status === 'out_of_stock')   effective_status = 'out_of_stock';
        else if (hasItemExpiringThisMonth)          effective_status = 'near_expiry';
        else if (hasItemExpiring3mo)                effective_status = 'expiring_3mo';
        else if (stock_status === 'low_stock')      effective_status = 'low_stock';
        else                                          effective_status = 'in_stock';

        // Earliest still-good expiry across the group
        const soonest = nonExpired.length
            ? nonExpired.reduce((a, b) => new Date(a.expiry_date) < new Date(b.expiry_date) ? a : b)
            : null;

        return {
            id:                  first.id, // representative row id - used for Edit/Delete actions
            name:                first.name,
            generic_name:        first.generic_name,
            category:            first.category,
            supplier:            first.supplier,
            barcode:             first.barcode,
            price:               first.price,
            cost:                first.cost,
            low_stock_threshold: threshold,
            is_tax_exempt:       first.is_tax_exempt ? 1 : 0,
            description:         first.description,
            stock_quantity:      combinedStock,
            stock_status,
            effective_status,
            item_count:          rows.length,
            all_items_expired:  allItemsExpired,
            earliest_expiry:           soonest ? soonest.expiry_date : null,
            earliest_expiry_days_left: soonest ? soonest.days_until_expiry : null,
            has_item_expiring_this_month: hasItemExpiringThisMonth,
            has_item_expiring_3mo:        hasItemExpiring3mo,
            // Expired units still sitting in the system
            has_expired_stock: rows.some(r => !(new Date(r.expiry_date) >= today) && r.stock_quantity > 0),
            expired_units:     rows.filter(r => !(new Date(r.expiry_date) >= today)).reduce((s, r) => s + r.stock_quantity, 0)
        };
    },

    _toItemSummary: (row) => {
        const daysLeft = row.days_until_expiry;
        const expired  = Product._isExpired(row);   // Manila's today, same rule as the roll-up
        return {
            id:                 row.id,
            stock_quantity:     row.stock_quantity,
            expiry_date:        row.expiry_date,
            days_until_expiry:  daysLeft,
            is_expired:         expired,
            expiring_this_month: !expired && daysLeft >= 0 && daysLeft <= 30,
            expiring_3mo:        !expired && daysLeft >= 0 && daysLeft <= 90
        };
    },

    // GET /api/inventory - one summary row per Brand Name.
    findAllGrouped: async ({ search = '', category = '', status = '' } = {}) => {
        let sql = `
            SELECT *, DATEDIFF(expiry_date, CURDATE()) AS days_until_expiry
            FROM products
            WHERE is_active = 1
        `;
        const params = [];
        if (search) {
            sql += ' AND (name LIKE ? OR generic_name LIKE ? OR barcode = ?)';
            const like = `%${search}%`;
            params.push(like, like, search);
        }
        if (category) { sql += Product._categoryClause(category, params); }
        sql += ' ORDER BY id ASC';

        const [rows] = await db.query(sql, params);

        const groups = new Map();
        rows.forEach(r => {
            if (!groups.has(r.name)) groups.set(r.name, []);
            groups.get(r.name).push(r);
        });

        let summaries = Array.from(groups.values()).map(Product._rollUpGroup);

        if (status) {
            const normalized = status === 'expiring' ? 'near_expiry' : status;
            // A product shows under EVERY filter that applies to any of its Item Nos
            summaries = summaries.filter(g => {
                switch (normalized) {
                    case 'expired':      return g.all_items_expired || g.has_expired_stock;
                    case 'out_of_stock': return g.stock_status === 'out_of_stock';
                    case 'low_stock':    return g.stock_status === 'low_stock';
                    case 'near_expiry':  return g.has_item_expiring_this_month;
                    case 'expiring_3mo': return g.has_item_expiring_3mo;
                    // "In Stock" stays the strict/exclusive one on purpose it's...
                    case 'in_stock':     return g.effective_status === 'in_stock' && !g.has_expired_stock;
                    default:             return true;
                }
            });
        }

        summaries.sort((a, b) => {
            // Expired/out of stock sink to the bottom
            const weight = s => (s === 'expired' || s === 'out_of_stock') ? 1 : 0;
            const wA = weight(a.effective_status), wB = weight(b.effective_status);
            if (wA !== wB) return wA - wB;
            if (a.earliest_expiry && b.earliest_expiry) {
                const d = new Date(a.earliest_expiry) - new Date(b.earliest_expiry);
                if (d) return d;
            } else if (a.earliest_expiry && !b.earliest_expiry) return -1;
            else if (!a.earliest_expiry && b.earliest_expiry) return 1;
            return a.name.localeCompare(b.name);
        });

        return summaries;
    },

    // GET /api/inventory/:id
    findGroupById: async (anyRowId) => {
        const name = await Product._resolveGroupName(anyRowId);
        if (!name) return null;
        const rows = await Product._fetchGroupRowsByName(name);
        if (!rows.length) return null;

        const summary = Product._rollUpGroup(rows);
        // The Item Nos the Edit window lists: real batches only
        const items = rows.filter(r => !Product._isPlaceholder(r)).sort(Product._byExpiry).map(Product._toItemSummary);
        return { ...summary, items };
    },

    // "Add Product" - a brand-new medicine: its full shared details
    createGroup: async (data) => {
        Product._assertPlainText('Brand name', data.name);
        Product._assertPlainText('Generic name', data.generic_name);
        Product._assertPlainText('Supplier', data.supplier);

        const [existing] = await db.query(
            'SELECT id FROM products WHERE LOWER(name) = LOWER(?) AND is_active = 1 LIMIT 1',
            [data.name]
        );
        if (existing.length) {
            const err = new Error(`"${data.name}" already exists. Use "Add Item No." on that product to restock it instead.`);
            err.code = 'DUPLICATE_BRAND';
            throw err;
        }

        // Several categories per product, validated here
        await Product.refreshCategoryLimit();
        const category = Product.normalizeCategories(data.categories ?? data.category);
        await Product.assertBarcodeFree(data.barcode, data.name);

        return Product.create({ batch_number: null, ...data, category });
    },

    // Cascades a shared/top-level field edit across EVERY row in the group
    updateGroupFields: async (anyRowId, data) => {
        const oldName = await Product._resolveGroupName(anyRowId);
        if (!oldName) return 0;

        const newName = data.name?.trim();
        Product._assertPlainText('Brand name', newName);
        Product._assertPlainText('Generic name', data.generic_name);
        Product._assertPlainText('Supplier', data.supplier);
        if (newName && newName.toLowerCase() !== oldName.toLowerCase()) {
            const [existing] = await db.query(
                'SELECT id FROM products WHERE LOWER(name) = LOWER(?) AND is_active = 1 LIMIT 1',
                [newName]
            );
            if (existing.length) {
                const err = new Error(`"${newName}" already exists as a separate product -- merging brands isn't supported here.`);
                err.code = 'DUPLICATE_BRAND';
                throw err;
            }
        }

        // The Edit modal's form no longer has a barcode field at all
        const rows = await Product._fetchGroupRowsByName(oldName);
        const currentBarcode = rows[0]?.barcode ?? null;

        const {
            name = oldName, generic_name = null, category: categoryInput, supplier = null,
            description = null, barcode = currentBarcode, price, cost, low_stock_threshold = 10,
            is_tax_exempt
        } = data;

        // Categories: validated when sent, left exactly as stored when not.
        await Product.refreshCategoryLimit();
        const category = (data.categories === undefined && categoryInput === undefined)
            ? rows[0].category
            : Product.normalizeCategories(data.categories ?? categoryInput);
        await Product.assertBarcodeFree(barcode, name);

        // Tax Exempt applies to EVERY Item No. row of the brand
        const taxExemptFlag = is_tax_exempt === undefined
            ? (rows[0]?.is_tax_exempt ? 1 : 0)
            : ((is_tax_exempt === true || is_tax_exempt === 1 || is_tax_exempt === '1') ? 1 : 0);

        const [result] = await db.query(
            `UPDATE products SET
                name = ?, generic_name = ?, category = ?, supplier = ?,
                description = ?, barcode = ?, price = ?, cost = ?, low_stock_threshold = ?, is_tax_exempt = ?
             WHERE name = ? AND is_active = 1`,
            [name, generic_name, category, supplier, description, barcode, price, cost, low_stock_threshold, taxExemptFlag, oldName]
        );
        return result.affectedRows;
    },

    // Soft-deletes the WHOLE brand - every row in its group at once.
    softDeleteGroup: async (anyRowId) => {
        const name = await Product._resolveGroupName(anyRowId);
        if (!name) return 0;
        const [result] = await db.query(
            'UPDATE products SET is_active = 0 WHERE name = ? AND is_active = 1',
            [name]
        );
        return result.affectedRows;
    },

    // "Add Item No." - a new restock row cloning the group's shared fields
    addItem: async (anyRowId, { stock_quantity, expiry_date }) => {
        const name = await Product._resolveGroupName(anyRowId);
        if (!name) return null;

        const rows  = await Product._fetchGroupRowsByName(name);
        const first = rows[0];

        const newId = await Product.create({
            batch_number:        null,
            name:                first.name,
            generic_name:        first.generic_name,
            category:            first.category,
            supplier:            first.supplier,
            description:         first.description,
            barcode:             first.barcode,
            price:               first.price,
            cost:                first.cost,
            stock_quantity,
            low_stock_threshold: first.low_stock_threshold,
            is_tax_exempt:       first.is_tax_exempt ? 1 : 0,
            expiry_date
        });

        // A real batch now exists, so the empty stand-in batch
        await db.query(
            'UPDATE products SET is_active = 0 WHERE name = ? AND is_active = 1 AND batch_number = ?',
            [first.name, Product.NO_ITEM_MARK]
        );
        return newId;
    },

    // The Item No. of a brand that already has EXACTLY this expiry date, if any.
    findItemByBrandAndExpiry: async (name, expiryDate, addQty = 0) => {
        const rows = (await Product._fetchGroupRowsByName(name)).filter(r => !Product._isPlaceholder(r));
        const target = Product._ymd(expiryDate);
        const hit = rows.find(r => Product._ymd(r.expiry_date) === target);
        if (!hit) return null;
        const after = rows.map(r => r.id === hit.id ? { ...r, stock_quantity: r.stock_quantity + addQty } : r);
        return { id: hit.id, itemNo: Product.numberItems(after).get(hit.id).itemNo, stock_quantity: hit.stock_quantity };
    },

    // yyyy-mm-dd of a DATE value, in Manila time
    _ymd: (d) => d instanceof Date
        ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
        : String(d).slice(0, 10),

    // Adds `quantity` to one Item No.'s current stock (a top-up, not a replace)
    addStockToItem: async (itemId, quantity) => {
        const [result] = await db.query(
            'UPDATE products SET stock_quantity = stock_quantity + ? WHERE id = ? AND is_active = 1',
            [quantity, itemId]
        );
        return result.affectedRows;
    },

    // Edits just the stock_quantity/expiry_date of ONE existing Item No. everything...
    updateItem: async (itemId, { stock_quantity, expiry_date }) => {
        const [result] = await db.query(
            'UPDATE products SET stock_quantity = ?, expiry_date = ? WHERE id = ? AND is_active = 1',
            [stock_quantity, expiry_date, itemId]
        );
        return result.affectedRows;
    },

    // Deletes ONE Item No.
    deleteItem: async (itemId) => {
        const name = await Product._resolveGroupName(itemId);
        if (!name) return { affected: 0, blocked: false };

        // The empty stand-in batch is not an Item No., so it does not count as one.
        const rows = (await Product._fetchGroupRowsByName(name)).filter(r => !Product._isPlaceholder(r));
        if (rows.length <= 1) return { affected: 0, blocked: true };

        const target = rows.find(r => String(r.id) === String(itemId));
        const info   = target ? Product.numberItems(rows).get(target.id) : null;

        const [result] = await db.query(
            'UPDATE products SET is_active = 0 WHERE id = ? AND is_active = 1',
            [itemId]
        );
        return {
            affected: result.affectedRows, blocked: false,
            // what the audit log records about the batch that was deleted
            name, itemNo: info?.itemNo ?? null, units: target?.stock_quantity ?? null,
            expiry_date: target ? Product._ymd(target.expiry_date) : null
        };
    },

    // Puts units of a VOIDED sale back.
    restoreVoidedStock: async (connection, productId, qty) => {
        const [rows] = await connection.query('SELECT * FROM products WHERE id = ? FOR UPDATE', [productId]);
        const row = rows[0];
        if (!row) return { status: 'missing', qty };

        if (Number(row.is_active) === 1) {
            await connection.query('UPDATE products SET stock_quantity = stock_quantity + ? WHERE id = ?', [qty, productId]);
            return { status: 'restored', name: row.name, qty };
        }

        const expiry = Product._ymd(row.expiry_date);
        const [live] = await connection.query(
            'SELECT * FROM products WHERE LOWER(name) = LOWER(?) AND is_active = 1 ORDER BY id ASC FOR UPDATE',
            [row.name]
        );
        if (!live.length) return { status: 'product_deleted', name: row.name, qty, expiry };

        const same = live.filter(r => !Product._isPlaceholder(r)).find(r => Product._ymd(r.expiry_date) === expiry);
        if (same) {
            await connection.query('UPDATE products SET stock_quantity = stock_quantity + ? WHERE id = ?', [qty, same.id]);
            return { status: 'merged', name: row.name, qty, expiry };
        }

        const base = live[0];
        await connection.query(
            `INSERT INTO products (batch_number, name, generic_name, category, supplier, description, barcode,
                                  price, cost, stock_quantity, low_stock_threshold, is_tax_exempt, expiry_date, is_active)
             VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
            [base.name, base.generic_name, base.category, base.supplier, base.description, base.barcode,
             base.price, base.cost, qty, base.low_stock_threshold, base.is_tax_exempt ? 1 : 0, row.expiry_date]
        );
        // a real batch exists again, so the empty stand-in
        await connection.query(
            'UPDATE products SET is_active = 0 WHERE LOWER(name) = LOWER(?) AND is_active = 1 AND batch_number = ?',
            [row.name, Product.NO_ITEM_MARK]
        );
        return { status: 'revived', name: row.name, qty, expiry };
    },

    // "Remove" on an expired or empty Item No...
    removeItem: async (itemId) => {
        const [found] = await db.query(
            `SELECT *, DATEDIFF(expiry_date, CURDATE()) AS days_until_expiry
             FROM products WHERE id = ? AND is_active = 1`,
            [itemId]
        );
        const row = found[0];
        if (!row || Product._isPlaceholder(row)) return { found: false };

        const group   = (await Product._fetchGroupRowsByName(row.name)).filter(r => !Product._isPlaceholder(r));
        const expired = Product._isExpired(row);
        const empty   = row.stock_quantity <= 0;
        if (!expired && !empty) return { found: true, removable: false };

        const info     = Product.numberItems(group).get(row.id);
        const lastItem = group.length === 1;

        const conn = await db.getConnection();
        try {
            await conn.beginTransaction();
            await conn.query('UPDATE products SET is_active = 2 WHERE id = ? AND is_active = 1', [row.id]);
            if (lastItem) {
                await conn.query(
                    `INSERT INTO products (batch_number, name, generic_name, category, supplier, description, barcode,
                                          price, cost, stock_quantity, low_stock_threshold, is_tax_exempt, expiry_date, is_active)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 1)`,
                    [Product.NO_ITEM_MARK, row.name, row.generic_name, row.category, row.supplier, row.description,
                     row.barcode, row.price, row.cost, row.low_stock_threshold, row.is_tax_exempt ? 1 : 0, Product.NO_ITEM_EXPIRY]
                );
            }
            await conn.commit();
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }

        return {
            found: true, removable: true, lastItem,
            name: row.name, itemNo: info.itemNo, units: row.stock_quantity,
            expiry_date: Product._ymd(row.expiry_date),
            reason: expired && empty ? 'expired and empty' : (expired ? 'expired' : 'empty')
        };
    },

    // Same counts as the individual getters above
    getGroupedAlertCounts: async () => {
        const summaries = await Product.findAllGrouped({});
        // Matches the same independent-check logic as findAllGrouped's own status...
        return {
            low_stock:    summaries.filter(g => g.stock_status === 'low_stock').length,
            near_expiry:  summaries.filter(g => g.has_item_expiring_this_month).length,
            expiring_3mo: summaries.filter(g => g.has_item_expiring_3mo).length,
            expired:      summaries.filter(g => g.all_items_expired || g.has_expired_stock).length,
            out_of_stock: summaries.filter(g => g.stock_status === 'out_of_stock').length
        };
    },

    // All active rows for the Inventory export, ordered: 1.
    findAllForInventoryExport: async () => {
        const [rows] = await db.query(
            `SELECT *, DATEDIFF(expiry_date, CURDATE()) AS days_until_expiry
             FROM products
             WHERE is_active = 1 AND batch_number <> ?
             ORDER BY name ASC, id ASC`,
            [Product.NO_ITEM_MARK]      // the empty stand-in batch is not an Item No.
        );

        const groups = new Map();
        rows.forEach(r => {
            if (!groups.has(r.name)) groups.set(r.name, []);
            groups.get(r.name).push(r);
        });

        const sortedNames = Array.from(groups.keys())
            .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

        const orderedRows = [];
        sortedNames.forEach(name => {
            const items = groups.get(name);
            const needsAttention = r => Product._isExpired(r) || r.stock_quantity <= 0;
            // each block earliest-expiry first, like the Edit window
            const flagged    = items.filter(needsAttention).sort(Product._byExpiry);
            const notFlagged = items.filter(r => !needsAttention(r)).sort(Product._byExpiry);
            orderedRows.push(...flagged, ...notFlagged);
        });

        return orderedRows;
    },

    // Broader search than the Inventory page's own findAllGrouped
    findAllGroupedBroadSearch: async (search) => {
        const like = `%${search}%`;
        const [rows] = await db.query(
            `SELECT *, DATEDIFF(expiry_date, CURDATE()) AS days_until_expiry
             FROM products
             WHERE is_active = 1
               AND (name LIKE ? OR generic_name LIKE ? OR category LIKE ? OR description LIKE ? OR barcode = ?)
             ORDER BY id ASC`,
            [like, like, like, like, search]
        );

        const groups = new Map();
        rows.forEach(r => {
            if (!groups.has(r.name)) groups.set(r.name, []);
            groups.get(r.name).push(r);
        });

        return Array.from(groups.values()).map(Product._rollUpGroup);
    }
};

module.exports = Product;
