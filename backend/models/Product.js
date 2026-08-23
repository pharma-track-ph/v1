// ============================================================
// Product Model
// Core inventory entity. Includes expiry, batch, supplier.
// ============================================================
const db = require('../config/db');

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
            sql += ' AND category = ?';
            params.push(category);
        }

        if (status) {
            switch (status) {
                case 'low_stock':
                    // Must mirror findAll's CASE priority: a batch that's ALSO
                    // expired/near-expiry/expiring-3mo/out-of-stock is
                    // categorized under that higher-priority status instead,
                    // so exclude those here too, or this filter would
                    // double-count rows that display under a different badge.
                    sql += ' AND stock_quantity > 0 AND stock_quantity <= low_stock_threshold AND expiry_date >= CURDATE() AND DATEDIFF(expiry_date, CURDATE()) > 90';
                    break;
                case 'expiring':
                    // A batch that's sold out (stock 0) is never "expiring soon"
                    // from a business standpoint — there's no stock left to lose.
                    sql += ' AND expiry_date >= CURDATE() AND DATEDIFF(expiry_date, CURDATE()) <= 30 AND stock_quantity > 0';
                    break;
                case 'expiring_3mo':
                    // Deliberately INCLUSIVE of the 1-month tier (0-90 days),
                    // not just the 31-90 day band the per-row badge shows —
                    // this is meant as a broader "anything needing attention
                    // in the next 3 months" net, not a mutually-exclusive
                    // badge match.
                    sql += ' AND expiry_date >= CURDATE() AND DATEDIFF(expiry_date, CURDATE()) <= 90 AND stock_quantity > 0';
                    break;
                case 'expired':
                    // Once a batch hits 0 stock it's "Sold Out", not "Expired" —
                    // there's nothing left that could still spoil/be wasted, so
                    // it should never show up in an expired-inventory view.
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

        // Out-of-stock items sort to the very bottom regardless of their
        // expiry_date -- otherwise a sold-out batch with a past expiry date
        // would sort as if it were the MOST urgently expiring item (since a
        // plain expiry_date ASC sort treats "in the past" as "earliest"),
        // when it's actually a Out of Stock status, not an expiry concern at
        // all. Everything else keeps the original expiry_date/name order.
        let orderBy = 'CASE WHEN stock_quantity <= 0 THEN 1 ELSE 0 END';

        if (search) {
            // Same relevance ranking as findAllForPOS — a short/common search
            // term shouldn't look like it barely filtered anything just
            // because it matches dozens of products somewhere in the middle
            // of their name/generic name.
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
            low_stock_threshold = 10, expiry_date
        } = data;

        const [result] = await db.query(
            `INSERT INTO products
             (batch_number, name, generic_name, category, supplier, description,
              barcode, price, cost, stock_quantity, low_stock_threshold, expiry_date)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [batch_number, name, generic_name, category, supplier, description,
             barcode, price, cost, stock_quantity, low_stock_threshold, expiry_date]
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
        // Must mirror the exact priority order used in findAll()'s CASE expression
        // (out_of_stock > expired > near_expiry > expiring_3mo > low_stock) so this
        // count always matches what Inventory shows when filtered to "Low Stock" —
        // otherwise a product that's both low-stock AND expiring soon would get
        // double-counted here while only showing up under a different badge in
        // the actual table.
        const [rows] = await db.query(
            `SELECT COUNT(*) AS count FROM products
             WHERE is_active = 1
               AND expiry_date >= CURDATE()
               AND DATEDIFF(expiry_date, CURDATE()) > 90
               AND stock_quantity > 0
               AND stock_quantity <= low_stock_threshold`
        );
        return rows[0].count;
    },

    getNearExpiryCount: async () => {
        // Excludes sold-out batches (stock 0) — see findAll's CASE priority:
        // out_of_stock now outranks near_expiry, so a 0-stock batch should
        // never be double-counted here too.
        const [rows] = await db.query(
            `SELECT COUNT(*) AS count FROM products
             WHERE is_active = 1
               AND expiry_date >= CURDATE()
               AND DATEDIFF(expiry_date, CURDATE()) <= 30
               AND stock_quantity > 0`
        );
        return rows[0].count;
    },

    // "Expiring in 3 Months" header alert / filter count — deliberately
    // INCLUSIVE of the 1-month tier (0-90 days), matching the filter's own
    // inclusive semantics in inventoryController.js's getProducts(), so
    // clicking this alert and seeing the resulting list always agree on
    // the same number.
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
        // Once a batch's stock hits 0 it's "Sold Out", not "Expired" — see
        // findAll's CASE priority (out_of_stock is checked before expired).
        // There's no remaining stock left to have gone to waste, so it
        // shouldn't count towards (or appear in) the expired-inventory view.
        const [rows] = await db.query(
            `SELECT COUNT(*) AS count FROM products
             WHERE is_active = 1 AND expiry_date < CURDATE() AND stock_quantity > 0`
        );
        return rows[0].count;
    },

    getOutOfStockCount: async () => {
        // Out of stock is now the TOP-priority status (see findAll's CASE) —
        // a 0-stock batch is "Sold Out" regardless of its expiry date, so no
        // expiry-related conditions apply here anymore.
        const [rows] = await db.query(
            `SELECT COUNT(*) AS count FROM products
             WHERE is_active = 1 AND stock_quantity <= 0`
        );
        return rows[0].count;
    },

    // ── POS-specific fetch: only active, non-expired batches ──
    // Used by /api/pos/products so the POS never has to know about
    // expired stock at all — filtering happens once, here.
    findAllForPOS: async (search = '') => {
        let sql = `
            SELECT *,
                   DATEDIFF(expiry_date, CURDATE()) AS days_until_expiry
            FROM products
            WHERE is_active = 1
              AND expiry_date >= CURDATE()
        `;
        const params = [];
        if (search) {
            sql += ' AND (name LIKE ? OR generic_name LIKE ? OR batch_number LIKE ? OR barcode = ?)';
            const like = `%${search}%`;
            params.push(like, like, like, search);

            // A short or common search term (e.g. just "a") can match
            // dozens of products via a substring buried in the middle of a
            // name or generic name, which makes the search look like it
            // barely filtered anything even though it technically did. This
            // ranks products whose name/generic name STARTS WITH the term
            // above everything else, so the most relevant matches always
            // surface first regardless of how short the search is.
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
    // Used to re-group a single barcode-scanned batch back into its
    // product family (so POS behaviour stays consistent either way).
    findActiveNonExpiredByName: async (name) => {
        const [rows] = await db.query(
            `SELECT *,
                    DATEDIFF(expiry_date, CURDATE()) AS days_until_expiry
             FROM products
             WHERE is_active = 1 AND expiry_date >= CURDATE() AND name = ?
             ORDER BY expiry_date ASC`,
            [name]
        );
        return rows;
    },

    getCategories: async () => {
        const [rows] = await db.query(
            'SELECT DISTINCT category FROM products WHERE is_active = 1 ORDER BY category'
        );
        return rows.map(r => r.category);
    },

    // Bulk upsert from CSV import.
    // Matches on BOTH batch_number AND expiry_date — a shared batch number
    // with a DIFFERENT expiry date is treated as a distinct physical batch
    // (e.g. a re-used or mistyped lot code from the supplier), not the same
    // stock. That case becomes a new row instead of silently overwriting the
    // expiry date on existing stock, which would misrepresent how soon the
    // OLDER units actually expire.
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
                    // Update by the specific row id (not by batch_number again)
                    // so this can never accidentally touch more than one row.
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

    // Auto-generates and PERSISTS a barcode for a product that doesn't have
    // one yet, so every product always has something scannable. Format:
    // "PT" + zero-padded product id (e.g. PT000042) — structurally distinct
    // from real manufacturer barcodes (which are numeric-only, e.g. EAN-13),
    // so there's no risk of ever colliding with a real, manually-entered one.
    // Since it's derived from the unique primary key, it can never collide
    // with another product's generated code either.
    ensureBarcode: async (id) => {
        const [rows] = await db.query('SELECT barcode FROM products WHERE id = ?', [id]);
        if (!rows.length) return null;

        if (rows[0].barcode) return rows[0].barcode;

        const generated = 'PT' + String(id).padStart(6, '0');
        await db.query('UPDATE products SET barcode = ? WHERE id = ?', [generated, id]);
        return generated;
    }
};

module.exports = Product;
