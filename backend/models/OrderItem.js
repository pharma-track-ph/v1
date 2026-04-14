// ============================================================
// OrderItem Model
// ============================================================
const db = require('../config/db');

const OrderItem = {
    createBulk: async (orderId, items, connection) => {
        const executor = connection || db;

        if (!items || !items.length) return;

        // Build bulk INSERT
        const placeholders = items.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
        const values = items.flatMap(item => [
            orderId,
            item.product_id,
            item.batch_number,
            item.product_name,
            item.quantity,
            item.unit_price,
            item.unit_cost,
            item.subtotal
        ]);

        await executor.query(
            `INSERT INTO order_items
             (order_id, product_id, batch_number, product_name, quantity, unit_price, unit_cost, subtotal)
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
