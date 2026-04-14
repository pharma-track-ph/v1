// ============================================================
// Product Model
// Core inventory entity. Includes expiry, batch, supplier.
// ============================================================
const db = require('../config/db');

const Product = {
    findAll: async ({ search = '', category = '', expiringOnly = false } = {}) => {
        let sql = `
            SELECT *,
                   DATEDIFF(expiry_date, CURDATE()) AS days_until_expiry,
                   CASE
                       WHEN expiry_date < CURDATE()                            THEN 'expired'
                       WHEN DATEDIFF(expiry_date, CURDATE()) <= 30             THEN 'near_expiry'
                       WHEN stock_quantity <= 0                                THEN 'out_of_stock'
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

        if (expiringOnly) {
            // Items expiring within the next 30 days (but not yet expired)
            sql += ' AND expiry_date >= CURDATE() AND DATEDIFF(expiry_date, CURDATE()) <= 30';
        }

        sql += ' ORDER BY expiry_date ASC, name ASC';
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
        const [rows] = await db.query(
            `SELECT COUNT(*) AS count FROM products
             WHERE is_active = 1 AND stock_quantity <= low_stock_threshold AND stock_quantity > 0`
        );
        return rows[0].count;
    },

    getNearExpiryCount: async () => {
        const [rows] = await db.query(
            `SELECT COUNT(*) AS count FROM products
             WHERE is_active = 1
               AND expiry_date >= CURDATE()
               AND DATEDIFF(expiry_date, CURDATE()) <= 30`
        );
        return rows[0].count;
    },

    getCategories: async () => {
        const [rows] = await db.query(
            'SELECT DISTINCT category FROM products WHERE is_active = 1 ORDER BY category'
        );
        return rows.map(r => r.category);
    },

    // Bulk upsert from CSV import
    // If batch_number matches an existing active product, update stock; otherwise insert.
    bulkUpsert: async (items) => {
        const results = { inserted: 0, updated: 0, errors: [] };

        for (const item of items) {
            try {
                const [existing] = await db.query(
                    'SELECT id FROM products WHERE batch_number = ? AND is_active = 1 LIMIT 1',
                    [item.batch_number]
                );

                if (existing.length) {
                    await db.query(
                        `UPDATE products SET
                            stock_quantity = stock_quantity + ?,
                            expiry_date    = ?,
                            price          = ?,
                            cost           = ?
                         WHERE batch_number = ? AND is_active = 1`,
                        [item.stock_quantity, item.expiry_date, item.price, item.cost, item.batch_number]
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
    }
};

module.exports = Product;
