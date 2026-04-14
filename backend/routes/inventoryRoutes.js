const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const path    = require('path');
const {
    getProducts, getProduct, createProduct, updateProduct,
    deleteProduct, getAlertSummary, importCSV
} = require('../controllers/inventoryController');
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
router.get('/:id',            verifyToken, getProduct);
router.post('/',              verifyToken, requireRole('admin'), createProduct);
router.put('/:id',            verifyToken, requireRole('admin'), updateProduct);
router.delete('/:id',         verifyToken, requireRole('admin'), deleteProduct);
router.post('/import/csv',    verifyToken, requireRole('admin'), upload.single('file'), importCSV);

module.exports = router;
