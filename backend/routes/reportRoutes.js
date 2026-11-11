const express = require('express');
const router  = express.Router();
const {
    getSalesReport, getExpiredReport, getDashboardKPIs, getVoidReport, getRegisterReport, getReportUsers, getPartialVoidDetails,
    exportSalesReport, exportExpiredReport, exportVoidReport, exportRegisterReport
} = require('../controllers/reportController');
const { verifyToken, requireRole } = require('../middleware/authMiddleware');

// Reports are open to every operational role.
const ALL_ROLES = ['cashier', 'admin', 'super_admin'];

router.get('/sales',         verifyToken, requireRole(...ALL_ROLES), getSalesReport);
router.get('/expired',       verifyToken, requireRole(...ALL_ROLES), getExpiredReport);
router.get('/void',          verifyToken, requireRole(...ALL_ROLES), getVoidReport);
router.get('/register',      verifyToken, requireRole(...ALL_ROLES), getRegisterReport);
router.get('/dashboard-kpis',verifyToken, getDashboardKPIs);

// The "View Partial Void" popup (Sales Report and Void Report).
router.get('/partial-void/:orderId', verifyToken, requireRole(...ALL_ROLES), getPartialVoidDetails);

// Feeds the "User" filter dropdown
router.get('/users',         verifyToken, requireRole('admin'), getReportUsers);

// Export routes - :format is excel|pdf|word.
router.get('/sales/export/:format',    verifyToken, requireRole(...ALL_ROLES), exportSalesReport);
router.get('/expired/export/:format',  verifyToken, requireRole(...ALL_ROLES), exportExpiredReport);
router.get('/void/export/:format',     verifyToken, requireRole(...ALL_ROLES), exportVoidReport);
router.get('/register/export/:format', verifyToken, requireRole(...ALL_ROLES), exportRegisterReport);

module.exports = router;
