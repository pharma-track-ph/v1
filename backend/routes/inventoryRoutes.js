const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const path    = require('path');
const {
    getProducts, getProduct, createProduct, updateProduct, deleteProduct,
    addItem, updateItem, deleteItem,
    getAlertSummary, importCSV, getImportTemplate, getBarcode
} = require('../controllers/inventoryController');
const { exportInventory } = require('../controllers/exportController');
const { verifyToken, requireRole } = require('../middleware/authMiddleware');

// Multer config for inventory import uploads -- accepts CSV or Excel now
// (see inventoryController.js's parseImportFile), not CSV only.
const upload = multer({
    dest: 'uploads/',
    limits: { fileSize: 5 * 1024 * 1024 },  // 5MB
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (!['.csv', '.xlsx', '.xls'].includes(ext)) {
            return cb(new Error('Only CSV or Excel (.xlsx/.xls) files are allowed.'));
        }
        cb(null, true);
    }
});

router.get('/',               verifyToken, getProducts);
router.get('/alerts/summary', verifyToken, getAlertSummary);

// Export route MUST come before '/:id' — otherwise Express would try to
// match "export" itself as an :id parameter. :format is excel|pdf|word.
router.get('/export/:format', verifyToken, requireRole('admin'), exportInventory);

// Item No. management (restocking) — registered before '/:id' for the
// same reason as /export above, though these specific paths (two path
// segments) wouldn't actually collide with the one-segment '/:id' route
// regardless of order; kept up here anyway to stay next to that same
// ordering note.
router.post('/:id/items',       verifyToken, requireRole('admin'), addItem);
router.put('/items/:itemId',    verifyToken, requireRole('admin'), updateItem);
router.delete('/items/:itemId', verifyToken, requireRole('admin'), deleteItem);

router.get('/:id/barcode',    verifyToken, requireRole('admin'), getBarcode);
router.get('/import/template', verifyToken, requireRole('admin'), getImportTemplate);
router.get('/:id',            verifyToken, getProduct);
router.post('/',              verifyToken, requireRole('admin'), createProduct);
router.put('/:id',            verifyToken, requireRole('admin'), updateProduct);
router.delete('/:id',         verifyToken, requireRole('admin'), deleteProduct);
router.post('/import/csv',    verifyToken, requireRole('admin'), upload.single('file'), importCSV);

module.exports = router;
