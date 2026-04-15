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

router.get('/products',              verifyToken, requireRole('admin'), getProductList);
router.get('/data/:productId',       verifyToken, requireRole('admin'), getForecastData);
router.get('/trending',              verifyToken, requireRole('admin'), getTrendingProducts);
router.get('/restock-suggestions',   verifyToken, requireRole('admin'), getRestockSuggestions);
router.get('/compare/:productId',    verifyToken, requireRole('admin'), compareForecasts);

module.exports = router;