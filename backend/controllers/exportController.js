// ============================================================
// Export Controller — Inventory
// Uses the shared engine in utils/reportExporter.js. Formatting specific
// to inventory data (status labels, short dates) stays here; layout
// (headers, widths, signature area) lives in the shared engine.
// ============================================================
const Product  = require('../models/Product');
const { exportReport, formatShortDate } = require('../utils/reportExporter');

function statusLabel(status) {
    const labels = {
        in_stock: 'In Stock', low_stock: 'Low Stock',
        near_expiry: 'Expiring This Month', expiring_3mo: 'Expiring in 3 Months',
        expired: 'Expired', out_of_stock: 'Out of Stock'
    };
    return labels[status] || status;
}

const COLUMNS = [
    { label: 'Batch No.',    excelWidth: 18, pdfWidth: 92  },
    { label: 'Product Name', excelWidth: 28, pdfWidth: 148 },
    { label: 'Generic Name', excelWidth: 24, pdfWidth: 118 },
    { label: 'Category',     excelWidth: 22, pdfWidth: 118 },
    { label: 'Stock',        excelWidth: 9,  pdfWidth: 40  },
    { label: 'Price (₱)',    excelWidth: 12, pdfWidth: 58  },
    { label: 'Expiry Date',  excelWidth: 13, pdfWidth: 58  },
    { label: 'Status',       excelWidth: 14, pdfWidth: 68  }
];

function toRow(p) {
    return [
        p.batch_number, p.name, p.generic_name || '—', p.category,
        String(p.stock_quantity), `₱${Number(p.price).toFixed(2)}`,
        formatShortDate(p.expiry_date), statusLabel(p.stock_status)
    ];
}

/**
 * GET /api/inventory/export/:format (excel|pdf|word)
 */
const exportInventory = async (req, res, next) => {
    try {
        const products = await Product.findAll({});
        await exportReport(req.params.format, {
            res,
            title:       'Inventory Report',
            generatedBy: req.user.name,
            filename:    'PharmaTrack_Inventory_Report',
            columns:     COLUMNS,
            rows:        products.map(toRow)
        });
    } catch (err) { next(err); }
};

module.exports = { exportInventory };
