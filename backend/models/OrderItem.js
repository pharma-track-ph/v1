// ============================================================
// OrderItem Model
// ============================================================
const db = require('../config/db');

const OrderItem = {
    createBulk: async (orderId, items, connection) => {
        const executor = connection || db;

        if (!items || !items.length) return;

        // Build bulk INSERT. is_tax_exempt is a snapshot of the brand's flag at
        // the time of sale and discount_amount is this row's share of the
        // Senior/PWD reduction -- both default to 0 when a caller doesn't pass them.
        const placeholders = items.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
        const values = items.flatMap(item => [
            orderId,
            item.product_id,
            item.batch_number || '',
            item.product_name,
            item.quantity,
            item.unit_price,
            item.unit_cost,
            item.subtotal,
            item.is_tax_exempt ? 1 : 0,
            item.discount_amount || 0
        ]);

        await executor.query(
            `INSERT INTO order_items
             (order_id, product_id, batch_number, product_name, quantity, unit_price, unit_cost, subtotal,
              is_tax_exempt, discount_amount)
             VALUES ${placeholders}`,
            values
        );
    },

    findByOrderId: async (orderId) => {
        const [rows] = await db.query(
            'SELECT * FROM order_items WHERE order_id = ?',
            [orderId]
        );
        return rows;
    }
};

module.exports = OrderItem;
