const express = require('express');
const router  = express.Router();
const {
    getSalesReport, getExpiredReport, getDashboardKPIs, getVoidReport, getRegisterReport,
    exportSalesReport, exportExpiredReport, exportVoidReport, exportRegisterReport
} = require('../controllers/reportController');
const { verifyToken, requireRole } = require('../middleware/authMiddleware');

router.get('/sales',         verifyToken, requireRole('admin'), getSalesReport);
router.get('/expired',       verifyToken, requireRole('admin'), getExpiredReport);
router.get('/void',          verifyToken, requireRole('admin'), getVoidReport);
router.get('/register',      verifyToken, requireRole('admin'), getRegisterReport);
router.get('/dashboard-kpis',verifyToken, getDashboardKPIs);

// Export routes -- :format is excel|pdf|word. Each mirrors the same date-
// range query params as its display counterpart above, so the export
// matches whatever's currently on screen.
router.get('/sales/export/:format',    verifyToken, requireRole('admin'), exportSalesReport);
router.get('/expired/export/:format',  verifyToken, requireRole('admin'), exportExpiredReport);
router.get('/void/export/:format',     verifyToken, requireRole('admin'), exportVoidReport);
router.get('/register/export/:format', verifyToken, requireRole('admin'), exportRegisterReport);

module.exports = router;
