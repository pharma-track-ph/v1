const express = require('express');
const router  = express.Router();
const { getSalesReport, getExpiredReport, getDashboardKPIs } = require('../controllers/reportController');
const { verifyToken, requireRole } = require('../middleware/authMiddleware');

router.get('/sales',         verifyToken, requireRole('admin'), getSalesReport);
router.get('/expired',       verifyToken, requireRole('admin'), getExpiredReport);
router.get('/dashboard-kpis',verifyToken, getDashboardKPIs);

module.exports = router;
