const express = require('express');
const router  = express.Router();
const { login, getMe, getAllUsers, createUser, updateUser, deleteUser, getAuditLogs } = require('../controllers/authController');
const { verifyToken, requireRole } = require('../middleware/authMiddleware');

router.post('/login', login);
router.get('/me',     verifyToken, getMe);

// User management routes
router.get('/users',      verifyToken, requireRole('admin'), getAllUsers);
router.post('/users',     verifyToken, requireRole('admin'), createUser);
router.put('/users/:id',  verifyToken, requireRole('admin'), updateUser);
router.delete('/users/:id', verifyToken, requireRole('super_admin'), deleteUser);

// Audit logs – Super Admin only
router.get('/audit-logs', verifyToken, requireRole('super_admin'), getAuditLogs);

module.exports = router;
