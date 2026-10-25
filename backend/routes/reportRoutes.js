const express = require('express');
const router  = express.Router();
const {
    getSalesReport, getExpiredReport, getDashboardKPIs, getVoidReport, getRegisterReport, getReportUsers, getPartialVoidDetails,
    exportSalesReport, exportExpiredReport, exportVoidReport, exportRegisterReport
} = require('../controllers/reportController');
const { verifyToken, requireRole } = require('../middleware/authMiddleware');

// Reports are open to every operational role. WHAT each role gets back is
// decided inside the controllers: a Pharmacy Assistant (cashier) is always
// restricted to their OWN data by their logged-in user id (a user_id sent
// in the query string is ignored for them), and never receives cost/profit
// figures. Admin and Owner see everything and can narrow it with ?user_id=.
const ALL_ROLES = ['cashier', 'admin', 'super_admin'];

router.get('/sales',         verifyToken, requireRole(...ALL_ROLES), getSalesReport);
router.get('/expired',       verifyToken, requireRole(...ALL_ROLES), getExpiredReport);
router.get('/void',          verifyToken, requireRole(...ALL_ROLES), getVoidReport);
router.get('/register',      verifyToken, requireRole(...ALL_ROLES), getRegisterReport);
router.get('/dashboard-kpis',verifyToken, getDashboardKPIs);

// The "View Partial Void" popup (Sales Report and Void Report). Open to every
// role; a Pharmacy Assistant only gets partial voids they rang up or performed
// (enforced in the controller).
router.get('/partial-void/:orderId', verifyToken, requireRole(...ALL_ROLES), getPartialVoidDetails);

// Feeds the "User" filter dropdown -- Admin and Owner only (a cashier is
// never offered other people's data, so they have no use for this list).
router.get('/users',         verifyToken, requireRole('admin'), getReportUsers);

// Export routes -- :format is excel|pdf|word. Each mirrors the same date-
// range query params as its display counterpart above, so the export
// matches whatever's currently on screen.
router.get('/sales/export/:format',    verifyToken, requireRole(...ALL_ROLES), exportSalesReport);
router.get('/expired/export/:format',  verifyToken, requireRole(...ALL_ROLES), exportExpiredReport);
router.get('/void/export/:format',     verifyToken, requireRole(...ALL_ROLES), exportVoidReport);
router.get('/register/export/:format', verifyToken, requireRole(...ALL_ROLES), exportRegisterReport);

module.exports = router;
