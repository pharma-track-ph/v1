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
                    // Independent of expiry now -- a product can be both
                    // low-stock AND expiring soon at once; this matches
                    // regardless of what its single row badge shows.
                    sql += ' AND stock_quantity > 0 AND stock_quantity <= low_stock_threshold';
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
        // Independent of expiry now (see inventoryController.js's getProducts
        // for the full explanation) -- a product can be both low-stock AND
        // expiring soon at the same time, and should count here regardless
        // of what its single row badge happens to show.
        const [rows] = await db.query(
            `SELECT COUNT(*) AS count FROM products
             WHERE is_active = 1
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
    },

    // ============================================================
    // Brand-level grouping (Inventory restructure -- "Option B")
    // ============================================================
    // The `products` table itself is UNCHANGED -- still one row per
    // physical batch, own stock_quantity/expiry_date, same as POS's
    // groupBatchesForPOS() (posController.js) already treats it. Nothing
    // below adds a new table; it groups these same rows by `name` for the
    // Inventory page's "Brand Name -> Item No. list" view, using the
    // exact grouping key POS already relies on for FEFO.
    //
    // A brand's shared/top-level fields (generic_name, category, supplier,
    // barcode, price, cost, low_stock_threshold, description) are expected
    // to be IDENTICAL across every row in its group -- editing them from
    // the UI writes to every row in the group at once (updateGroupFields),
    // so they can never legitimately drift apart. Everywhere below that
    // needs to read them back uses the group's lowest-id (earliest-
    // created) row as the representative -- which, conveniently, is also
    // "Item No. 1".
    //
    // batch_number is no longer set on new rows created through any of
    // these (Item No. is a purely computed row-order index now, never
    // typed by a user) -- see the Inventory Restructure section in the
    // handoff doc for what's intentionally NOT covered here yet (the
    // rename of "Batch No./Product Name" elsewhere in the app, and the
    // CSV import rewrite), both deferred on purpose.
    // ============================================================

    // All active rows for a brand-name group, oldest-created first, so
    // "Item No. 1" stays stable/consistent across calls rather than being
    // re-numbered by an unrelated sort like expiry_date.
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

    // Resolves a brand group from ANY one of its rows' ids -- the id acts
    // as a stable "pointer" into the group without needing a new brand-
    // level id column; whichever row is passed in, the group is always
    // re-derived from its CURRENT name, never a client-supplied one.
    _resolveGroupName: async (anyRowId) => {
        const [rows] = await db.query(
            'SELECT name FROM products WHERE id = ? AND is_active = 1 LIMIT 1',
            [anyRowId]
        );
        return rows.length ? rows[0].name : null;
    },

    // Reverse of _resolveGroupName -- given a Brand Name, returns the
    // group's representative row id (lowest id, i.e. "Item No. 1"), or
    // null if no active brand with that exact name (case-insensitive)
    // exists. Used by CSV/Excel import to decide "Add Product" (brand-new)
    // vs "Add Item No." (restock an existing brand) per row.
    findGroupIdByName: async (name) => {
        const [rows] = await db.query(
            'SELECT id FROM products WHERE LOWER(name) = LOWER(?) AND is_active = 1 ORDER BY id ASC LIMIT 1',
            [name]
        );
        return rows.length ? rows[0].id : null;
    },

    // Rolls a group of batch rows up into one Brand-Name-level summary.
    //   - Out of Stock / Low Stock / In Stock is computed from the COMBINED
    //     stock of the non-expired rows only -- an expired row's leftover
    //     stock_quantity was never sellable, so it shouldn't count toward
    //     "do we have enough to sell". This also means a brand where every
    //     single Item No. is expired (so there are zero non-expired rows to
    //     sum) naturally comes out to combinedStock=0 and shows "Out of
    //     Stock" -- there's no separate "Expired" BRAND-level status
    //     anymore. From a "can I sell this right now" standpoint an
    //     entirely-expired brand and a genuinely sold-out one are the same
    //     thing to a cashier; the distinction between "expired" and
    //     "depleted" only matters at the INDIVIDUAL ITEM level (for
    //     deciding what to physically discard vs reorder), which is
    //     exactly what all_items_expired and _toItemSummary's is_expired
    //     flag are for -- the Status FILTER dropdown's "Expired" option
    //     still works, just checks all_items_expired instead of a
    //     stock_status value that no longer exists.
    //   - "Expiring this month / in 3 months" is deliberately NOT part of
    //     this rollup either -- it's tagged per Item No. instead (see
    //     _toItemSummary), so a brand can show fully "In Stock" overall
    //     while one specific item is individually flagged for FEFO
    //     attention, exactly as specified.
    _rollUpGroup: (rows) => {
        const today = new Date(); today.setHours(0, 0, 0, 0);

        const nonExpired = rows.filter(r => new Date(r.expiry_date) >= today);
        const allItemsExpired = nonExpired.length === 0;

        const combinedStock = nonExpired.reduce((s, r) => s + r.stock_quantity, 0);
        const first     = rows[0]; // representative row for shared/top-level fields
        const threshold = first.low_stock_threshold;

        let stock_status;
        if (combinedStock <= 0)               stock_status = 'out_of_stock';
        else if (combinedStock <= threshold)   stock_status = 'low_stock';
        else                                    stock_status = 'in_stock';

        const hasItemExpiringThisMonth = rows.some(r => r.days_until_expiry >= 0 && r.days_until_expiry <= 30 && r.stock_quantity > 0);
        const hasItemExpiring3mo        = rows.some(r => r.days_until_expiry >= 0 && r.days_until_expiry <= 90 && r.stock_quantity > 0);

        // Single effective_status picked by STRICT priority, so a brand
        // never simultaneously qualifies for two different filter
        // categories -- e.g. a brand that's fully expired used to also
        // match "Out of Stock" (since its combined non-expired stock IS
        // 0), so it showed up under either filter. Expired now outranks
        // Out of Stock, so it's Expired only. Hierarchy, highest first:
        // expired > out_of_stock > near_expiry > expiring_3mo > low_stock
        // > in_stock (the pure fallback -- only reached once nothing above
        // applies, which is what keeps "In Stock" from also catching
        // brands that are actually Low Stock/Expiring/etc.)
        let effective_status;
        if (allItemsExpired)                       effective_status = 'expired';
        else if (stock_status === 'out_of_stock')   effective_status = 'out_of_stock';
        else if (hasItemExpiringThisMonth)          effective_status = 'near_expiry';
        else if (hasItemExpiring3mo)                effective_status = 'expiring_3mo';
        else if (stock_status === 'low_stock')      effective_status = 'low_stock';
        else                                          effective_status = 'in_stock';

        // Earliest still-good expiry across the group -- a quick at-a-
        // glance FEFO signal on the main table row, separate from (and in
        // addition to) the per-item flags shown in the Edit modal.
        const soonest = nonExpired.length
            ? nonExpired.reduce((a, b) => new Date(a.expiry_date) < new Date(b.expiry_date) ? a : b)
            : null;

        return {
            id:                  first.id, // representative row id -- used for Edit/Delete actions
            name:                first.name,
            generic_name:        first.generic_name,
            category:            first.category,
            supplier:            first.supplier,
            barcode:             first.barcode,
            price:               first.price,
            cost:                first.cost,
            low_stock_threshold: threshold,
            description:         first.description,
            stock_quantity:      combinedStock,
            stock_status,
            effective_status,
            item_count:          rows.length,
            all_items_expired:  allItemsExpired,
            earliest_expiry:           soonest ? soonest.expiry_date : null,
            earliest_expiry_days_left: soonest ? soonest.days_until_expiry : null,
            has_item_expiring_this_month: hasItemExpiringThisMonth,
            has_item_expiring_3mo:        hasItemExpiring3mo
        };
    },

    _toItemSummary: (row) => {
        const daysLeft = row.days_until_expiry;
        return {
            id:                 row.id,
            stock_quantity:     row.stock_quantity,
            expiry_date:        row.expiry_date,
            days_until_expiry:  daysLeft,
            is_expired:         daysLeft < 0,
            expiring_this_month: daysLeft >= 0 && daysLeft <= 30,
            expiring_3mo:        daysLeft >= 0 && daysLeft <= 90
        };
    },

    // GET /api/inventory -- one summary row per Brand Name.
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
        if (category) { sql += ' AND category = ?'; params.push(category); }
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
            // Only Expired and Out of Stock genuinely need mutual exclusion
            // -- a brand where every Item No. is expired ALSO always has 0
            // sellable stock by construction (see stock_status above), so
            // without excluding that case here it would show up under both
            // filters at once. Low Stock, Expiring This Month, and
            // Expiring in 3 Months are NOT like that -- they're genuinely
            // independent conditions (a brand can legitimately be low on
            // stock AND separately have an item expiring soon), so those
            // stay as their own real checks rather than being folded into
            // effective_status's single-pick hierarchy. effective_status is
            // still what the single visible BADGE shows (see inventory.js's
            // getStatusBadge) -- this is deliberately not the same question
            // as "does this brand belong in the Low Stock list", which is
            // why the two use different logic here.
            summaries = summaries.filter(g => {
                switch (normalized) {
                    case 'expired':      return g.all_items_expired;
                    case 'out_of_stock': return g.stock_status === 'out_of_stock' && !g.all_items_expired;
                    case 'low_stock':    return g.stock_status === 'low_stock';
                    case 'near_expiry':  return g.has_item_expiring_this_month;
                    case 'expiring_3mo': return g.has_item_expiring_3mo;
                    // "In Stock" stays the strict/exclusive one on purpose --
                    // it's meant as "nothing here needs any attention at
                    // all", so it should NOT match a brand that also has an
                    // item expiring soon just because its raw stock level
                    // happens to be fine.
                    case 'in_stock':     return g.effective_status === 'in_stock';
                    default:             return true;
                }
            });
        }

        summaries.sort((a, b) => {
            // Expired/out of stock sink to the bottom, same spirit as the
            // old per-row sort -- then soonest-still-good-expiry first,
            // then name.
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

    // GET /api/inventory/:id -- full detail for the Edit modal: top-level
    // fields + every Item No. in the group, oldest-created first.
    findGroupById: async (anyRowId) => {
        const name = await Product._resolveGroupName(anyRowId);
        if (!name) return null;
        const rows = await Product._fetchGroupRowsByName(name);
        if (!rows.length) return null;

        const summary = Product._rollUpGroup(rows);
        return { ...summary, items: rows.map(Product._toItemSummary) };
    },

    // "Add Product" -- a brand-new medicine: its full shared details, plus
    // its very first Item No. (stock_quantity + expiry_date) in one row.
    // Blocked on a Brand Name that already exists (case-insensitive) among
    // active products, rather than silently creating a same-named sibling
    // row whose shared fields would be free to drift from the rest of
    // that group until the next edit re-syncs them -- restocking an
    // EXISTING brand should go through addItem below instead.
    createGroup: async (data) => {
        const [existing] = await db.query(
            'SELECT id FROM products WHERE LOWER(name) = LOWER(?) AND is_active = 1 LIMIT 1',
            [data.name]
        );
        if (existing.length) {
            const err = new Error(`"${data.name}" already exists. Use "Add Item No." on that product to restock it instead.`);
            err.code = 'DUPLICATE_BRAND';
            throw err;
        }

        return Product.create({ batch_number: null, ...data });
    },

    // Cascades a shared/top-level field edit across EVERY row in the
    // group (see the section-level comment above for why this always
    // writes ALL rows, not just the representative one). Resolves the
    // group by the representative row's CURRENT name server-side, rather
    // than trusting whatever name the client sends, so a rename is always
    // keyed off what the group is ACTUALLY called right now.
    updateGroupFields: async (anyRowId, data) => {
        const oldName = await Product._resolveGroupName(anyRowId);
        if (!oldName) return 0;

        const newName = data.name?.trim();
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

        // The Edit modal's form no longer has a barcode field at all (it's
        // a read-only preview now) -- data.barcode is simply never sent.
        // Falling back to `null` as the default here would silently WIPE
        // the group's existing auto-generated barcode on every save, so
        // the fallback is the group's CURRENT barcode instead, preserving
        // it whenever the caller doesn't explicitly provide a new one.
        const rows = await Product._fetchGroupRowsByName(oldName);
        const currentBarcode = rows[0]?.barcode ?? null;

        const {
            name = oldName, generic_name = null, category, supplier = null,
            description = null, barcode = currentBarcode, price, cost, low_stock_threshold = 10
        } = data;

        const [result] = await db.query(
            `UPDATE products SET
                name = ?, generic_name = ?, category = ?, supplier = ?,
                description = ?, barcode = ?, price = ?, cost = ?, low_stock_threshold = ?
             WHERE name = ? AND is_active = 1`,
            [name, generic_name, category, supplier, description, barcode, price, cost, low_stock_threshold, oldName]
        );
        return result.affectedRows;
    },

    // Soft-deletes the WHOLE brand -- every row in its group at once. The
    // per-row softDelete() above is untouched and still used elsewhere;
    // this is the group-level equivalent for the main table's Delete
    // button, distinct from deleteItem below (which removes ONE Item No.
    // and refuses to remove the last one).
    softDeleteGroup: async (anyRowId) => {
        const name = await Product._resolveGroupName(anyRowId);
        if (!name) return 0;
        const [result] = await db.query(
            'UPDATE products SET is_active = 0 WHERE name = ? AND is_active = 1',
            [name]
        );
        return result.affectedRows;
    },

    // "Add Item No." -- a new restock row cloning the group's shared
    // fields (read from the representative row) plus a fresh
    // stock_quantity/expiry_date. Quantity and expiry are the ONLY things
    // that change between restocks -- nothing about the product's own
    // details needs re-entering.
    addItem: async (anyRowId, { stock_quantity, expiry_date }) => {
        const name = await Product._resolveGroupName(anyRowId);
        if (!name) return null;

        const rows  = await Product._fetchGroupRowsByName(name);
        const first = rows[0];

        return Product.create({
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
            expiry_date
        });
    },

    // Edits just the stock_quantity/expiry_date of ONE existing Item No.
    // -- everything else about the product lives on every sibling row,
    // not this one specifically, so nothing else is touched here.
    updateItem: async (itemId, { stock_quantity, expiry_date }) => {
        const [result] = await db.query(
            'UPDATE products SET stock_quantity = ?, expiry_date = ? WHERE id = ? AND is_active = 1',
            [stock_quantity, expiry_date, itemId]
        );
        return result.affectedRows;
    },

    // Deletes ONE Item No. -- blocked if it's the last remaining active
    // item for its brand, so a brand's shared details (category, price,
    // etc.) never end up orphaned with zero items under them. Deleting
    // the WHOLE brand is a separate, explicit action (softDeleteGroup,
    // via the main table's own Delete button).
    deleteItem: async (itemId) => {
        const name = await Product._resolveGroupName(itemId);
        if (!name) return { affected: 0, blocked: false };

        const rows = await Product._fetchGroupRowsByName(name);
        if (rows.length <= 1) return { affected: 0, blocked: true };

        const [result] = await db.query(
            'UPDATE products SET is_active = 0 WHERE id = ? AND is_active = 1',
            [itemId]
        );
        return { affected: result.affectedRows, blocked: false };
    },

    // Same counts as the individual getters above, recomputed from the
    // grouped rollup so the header alert badges (shown across the whole
    // app) always agree with what the Inventory page itself now shows --
    // e.g. "Low Stock: 3" means 3 BRANDS are low, matching what filtering
    // Inventory by Low Stock returns, not 3 individual batches.
    getGroupedAlertCounts: async () => {
        const summaries = await Product.findAllGrouped({});
        // Matches the same independent-check logic as findAllGrouped's own
        // status filter above (not effective_status) -- so "Low Stock: N"
        // here always equals what clicking through to that filter actually
        // returns, even for a brand that also has an item expiring soon.
        return {
            low_stock:    summaries.filter(g => g.stock_status === 'low_stock').length,
            near_expiry:  summaries.filter(g => g.has_item_expiring_this_month).length,
            expiring_3mo: summaries.filter(g => g.has_item_expiring_3mo).length,
            expired:      summaries.filter(g => g.all_items_expired).length,
            out_of_stock: summaries.filter(g => g.stock_status === 'out_of_stock' && !g.all_items_expired).length
        };
    },

    // All active rows for the Inventory export, ordered:
    //   1. Alphabetically by Brand Name (case-insensitive)
    //   2. Within each brand's block, its expired/out-of-stock Item No.
    //      entries FIRST (they need attention), then the rest in their
    //      normal Item No. order (creation order) -- so a brand's rows
    //      always appear consecutively in the report, in the same order
    //      they're listed in the Edit modal, exactly matching how
    //      exportController.js's inventory export needs them.
    findAllForInventoryExport: async () => {
        const [rows] = await db.query(
            `SELECT *, DATEDIFF(expiry_date, CURDATE()) AS days_until_expiry
             FROM products
             WHERE is_active = 1
             ORDER BY name ASC, id ASC`
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
            const items = groups.get(name); // already id ASC from the query above
            const needsAttention = r => new Date(r.expiry_date) < new Date() || r.stock_quantity <= 0;
            const flagged    = items.filter(needsAttention);
            const notFlagged = items.filter(r => !needsAttention(r));
            orderedRows.push(...flagged, ...notFlagged);
        });

        return orderedRows;
    },

    // Broader search than the Inventory page's own findAllGrouped -- also
    // checks Category and Description, not just Brand/Generic Name/
    // Barcode. Used ONLY by the public JotForm agent endpoint
    // (publicController.js), deliberately kept separate from
    // findAllGrouped rather than widening that one, since the search
    // TERM here is very different in nature: JotForm translates a
    // symptom/condition into a medical term first (e.g. "headache" ->
    // "pain relief"), which is far more likely to match a CATEGORY
    // ("Fever and Pain Relief") than a specific product's brand or
    // generic name -- the Inventory page's own search box doesn't have
    // that same need, and widening it too could surface unexpected
    // results for a staff member typing a normal product search.
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
