// ============================================================
// Public Routes
// No verifyToken here on purpose -- these are called by external
// services (the JotForm AI agent) that can't hold a PharmaTrack user's
// JWT. Each endpoint gates itself with its own shared-secret check
// instead (see publicController.js).
// ============================================================
const express = require('express');
const router  = express.Router();
const { searchInventoryForAgent } = require('../controllers/publicController');

router.get('/inventory-search', searchInventoryForAgent);

module.exports = router;
