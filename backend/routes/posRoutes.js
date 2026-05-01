const express = require('express');
const router  = express.Router();
const { searchProducts, checkout, aiSuggest } = require('../controllers/posController');
const { verifyToken, requireRole } = require('../middleware/authMiddleware');

router.get('/products',    verifyToken, searchProducts);

// FIX: was requireRole('cashier') which uses hierarchy check — meaning only cashier-level
// could checkout (admins are ABOVE cashier, so they failed the check).
// Use an explicit allowlist so all three operational roles can process sales.
router.post('/checkout',   verifyToken, requireRole('cashier', 'admin', 'super_admin'), checkout);

router.post('/ai-suggest', verifyToken, aiSuggest);

module.exports = router;