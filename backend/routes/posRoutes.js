const express = require('express');
const router  = express.Router();
const { searchProducts, checkout, aiSuggest, getVoidCandidate, voidLastOrder } = require('../controllers/posController');
const { getCurrentSession, openSession, cashIn, cashOut, closeSession } = require('../controllers/cashController');
const { verifyToken, requireRole } = require('../middleware/authMiddleware');

router.get('/products',    verifyToken, searchProducts);

// FIX: was requireRole('cashier') which uses hierarchy check — meaning only cashier-level
// could checkout (admins are ABOVE cashier, so they failed the check).
// Use an explicit allowlist so all three operational roles can process sales.
router.post('/checkout',   verifyToken, requireRole('cashier', 'admin', 'super_admin'), checkout);

router.get('/void-candidate', verifyToken, requireRole('cashier', 'admin', 'super_admin'), getVoidCandidate);
router.post('/void',          verifyToken, requireRole('cashier', 'admin', 'super_admin'), voidLastOrder);

router.post('/ai-suggest', verifyToken, aiSuggest);

// ── Cash Session (Opening Cash / Cash In / Cash Out / Close) ──
router.get('/cash-session/current',  verifyToken, requireRole('cashier', 'admin', 'super_admin'), getCurrentSession);
router.post('/cash-session/open',    verifyToken, requireRole('cashier', 'admin', 'super_admin'), openSession);
router.post('/cash-session/cash-in', verifyToken, requireRole('cashier', 'admin', 'super_admin'), cashIn);
router.post('/cash-session/cash-out',verifyToken, requireRole('cashier', 'admin', 'super_admin'), cashOut);
router.post('/cash-session/close',   verifyToken, requireRole('cashier', 'admin', 'super_admin'), closeSession);

module.exports = router;
