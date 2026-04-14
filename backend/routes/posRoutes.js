const express = require('express');
const router  = express.Router();
const { searchProducts, checkout, aiSuggest } = require('../controllers/posController');
const { verifyToken, requireRole } = require('../middleware/authMiddleware');

router.get('/products',    verifyToken, searchProducts);
router.post('/checkout',   verifyToken, requireRole('cashier'), checkout);
router.post('/ai-suggest', verifyToken, aiSuggest);

module.exports = router;
