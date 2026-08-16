const express = require('express');
const router  = express.Router();
const {
    getSalesReport, getExpiredReport, getDashboardKPIs, getVoidReport, getRegisterReport
} = require('../controllers/reportController');
const { verifyToken, requireRole } = require('../middleware/authMiddleware');

router.get('/sales',         verifyToken, requireRole('admin'), getSalesReport);
router.get('/expired',       verifyToken, requireRole('admin'), getExpiredReport);
router.get('/void',          verifyToken, requireRole('admin'), getVoidReport);
router.get('/register',      verifyToken, requireRole('admin'), getRegisterReport);
router.get('/dashboard-kpis',verifyToken, getDashboardKPIs);

module.exports = router;
