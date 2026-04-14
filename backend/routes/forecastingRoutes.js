const express = require('express');
const router  = express.Router();
const { getProductList, getForecastData } = require('../controllers/forecastingController');
const { verifyToken, requireRole } = require('../middleware/authMiddleware');

router.get('/products',      verifyToken, requireRole('admin'), getProductList);
router.get('/data/:productId', verifyToken, requireRole('admin'), getForecastData);

module.exports = router;
