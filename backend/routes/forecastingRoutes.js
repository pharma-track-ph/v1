const express = require('express');
const router  = express.Router();
const {
    getProductList,
    getForecastData,
    getTrendingProducts,
    getRestockSuggestions,
    compareForecasts
} = require('../controllers/forecastingController');
const { verifyToken, requireRole } = require('../middleware/authMiddleware');

router.get('/products',              verifyToken, requireRole('cashier', 'admin', 'super_admin'), getProductList);
router.get('/data/:productId',       verifyToken, requireRole('cashier', 'admin', 'super_admin'), getForecastData);
router.get('/trending',              verifyToken, requireRole('cashier', 'admin', 'super_admin'), getTrendingProducts);
router.get('/restock-suggestions',   verifyToken, requireRole('cashier', 'admin', 'super_admin'), getRestockSuggestions);
router.get('/compare/:productId',    verifyToken, requireRole('cashier', 'admin', 'super_admin'), compareForecasts);

module.exports = router;