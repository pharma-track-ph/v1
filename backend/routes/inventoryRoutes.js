const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const path    = require('path');
const {
    getProducts, getProduct, createProduct, updateProduct,
    deleteProduct, getAlertSummary, importCSV, getBarcode
} = require('../controllers/inventoryController');
const { exportExcel, exportPDF, exportWord } = require('../controllers/exportController');
const { verifyToken, requireRole } = require('../middleware/authMiddleware');

// Multer config for CSV uploads
const upload = multer({
    dest: 'uploads/',
    limits: { fileSize: 5 * 1024 * 1024 },  // 5MB
    fileFilter: (req, file, cb) => {
        if (path.extname(file.originalname).toLowerCase() !== '.csv') {
            return cb(new Error('Only CSV files are allowed.'));
        }
        cb(null, true);
    }
});

router.get('/',               verifyToken, getProducts);
router.get('/alerts/summary', verifyToken, getAlertSummary);

// Export routes MUST come before '/:id' — otherwise Express would try to
// match "export" itself as an :id parameter.
router.get('/export/excel', verifyToken, requireRole('admin'), exportExcel);
router.get('/export/pdf',   verifyToken, requireRole('admin'), exportPDF);
router.get('/export/word',  verifyToken, requireRole('admin'), exportWord);

router.get('/:id/barcode',    verifyToken, requireRole('admin'), getBarcode);
router.get('/:id',            verifyToken, getProduct);
router.post('/',              verifyToken, requireRole('admin'), createProduct);
router.put('/:id',            verifyToken, requireRole('admin'), updateProduct);
router.delete('/:id',         verifyToken, requireRole('admin'), deleteProduct);
router.post('/import/csv',    verifyToken, requireRole('admin'), upload.single('file'), importCSV);

module.exports = router;
