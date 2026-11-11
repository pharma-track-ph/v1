const express = require('express');
const router  = express.Router();
const {
    searchProducts, checkout, aiSuggest, getVoidCandidate, getVoidCandidates, voidLastOrder, partialVoidOrder
} = require('../controllers/posController');
const { getCurrentSession, openSession, cashIn, cashOut, closeSession } = require('../controllers/cashController');
const { verifyToken, requireRole } = require('../middleware/authMiddleware');

router.get('/products',    verifyToken, searchProducts);

// FIX: was requireRole('cashier') which uses hierarchy check
router.post('/checkout',   verifyToken, requireRole('cashier', 'admin', 'super_admin'), checkout);

router.get('/void-candidate',  verifyToken, requireRole('cashier', 'admin', 'super_admin'), getVoidCandidate);
router.get('/void-candidates', verifyToken, requireRole('cashier', 'admin', 'super_admin'), getVoidCandidates);
router.post('/void',           verifyToken, requireRole('cashier', 'admin', 'super_admin'), voidLastOrder);
// Void part of a sale: the original is voided and a NEW receipt for what remains...
router.post('/partial-void',   verifyToken, requireRole('cashier', 'admin', 'super_admin'), partialVoidOrder);

router.post('/ai-suggest', verifyToken, aiSuggest);

// Cash Session (Opening Cash / Cash In / Cash Out / Close)
router.get('/cash-session/current',  verifyToken, requireRole('cashier', 'admin', 'super_admin'), getCurrentSession);
router.post('/cash-session/open',    verifyToken, requireRole('cashier', 'admin', 'super_admin'), openSession);
router.post('/cash-session/cash-in', verifyToken, requireRole('cashier', 'admin', 'super_admin'), cashIn);
router.post('/cash-session/cash-out',verifyToken, requireRole('cashier', 'admin', 'super_admin'), cashOut);
router.post('/cash-session/close',   verifyToken, requireRole('cashier', 'admin', 'super_admin'), closeSession);

module.exports = router;
