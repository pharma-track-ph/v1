// Export Controller - Inventory - Uses the shared engine in utils/reportExporter.js.
const Product  = require('../models/Product');
const { exportReport, formatShortDate } = require('../utils/reportExporter');

// Per-ITEM status (not the brand-level rollup Inventory's own table shows)
function itemStatusLabel(p) {
    const daysLeft = p.days_until_expiry;
    if (daysLeft < 0)          return 'Expired';
    if (p.stock_quantity <= 0) return 'Out of Stock';
    if (daysLeft <= 30)        return 'Expiring This Month';
    if (daysLeft <= 90)        return 'Expiring in 3 Months';
    return 'In Stock';
}

const COLUMNS = [
    { label: 'Brand Name',   excelWidth: 32, pdfWidth: 175 },
    { label: 'Generic Name', excelWidth: 26, pdfWidth: 130 },
    { label: 'Category',     excelWidth: 24, pdfWidth: 130 },
    { label: 'Stock',        excelWidth: 9,  pdfWidth: 45  },
    { label: 'Price (₱)',    excelWidth: 13, pdfWidth: 65  },
    { label: 'Expiry Date',  excelWidth: 15, pdfWidth: 68  },
    { label: 'Status',       excelWidth: 16, pdfWidth: 87  }
];

function toRow(p) {
    return [
        p.name, p.generic_name || '—', String(p.category ?? '').split('|').join(', '),
        String(p.stock_quantity), `₱${Number(p.price).toFixed(2)}`,
        formatShortDate(p.expiry_date), itemStatusLabel(p)
    ];
}

/** GET /api/inventory/export/:format (excel|pdf|word) */
const exportInventory = async (req, res, next) => {
    try {
        const products = await Product.findAllForInventoryExport();
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
