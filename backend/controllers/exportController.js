// ============================================================
// Export Controller — Inventory
// Uses the shared engine in utils/reportExporter.js. Formatting specific
// to inventory data (status labels, short dates) stays here; layout
// (headers, widths, signature area) lives in the shared engine.
//
// Rows here are per-ITEM (one row per batch/Item No.), not per-brand --
// Product.findAllForInventoryExport() sorts brands alphabetically by
// Brand Name and, within each brand's block, puts its expired/out-of-
// stock items first, so this always reads as a proper audit-style list:
// every one of a brand's items sits together, in the same order the Edit
// modal shows them, with anything needing attention surfaced first.
// ============================================================
const Product  = require('../models/Product');
const { exportReport, formatShortDate } = require('../utils/reportExporter');

// Per-ITEM status (not the brand-level rollup Inventory's own table
// shows) -- makes sense for a report where every row IS one specific
// batch: showing the same rolled-up brand status identically across
// several rows of the same brand would misrepresent which particular
// item is actually expired/out of stock.
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
        p.name, p.generic_name || '—', p.category,
        String(p.stock_quantity), `₱${Number(p.price).toFixed(2)}`,
        formatShortDate(p.expiry_date), itemStatusLabel(p)
    ];
}

/**
 * GET /api/inventory/export/:format (excel|pdf|word)
 */
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
