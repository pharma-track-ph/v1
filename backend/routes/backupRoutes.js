const express = require('express');
const router  = express.Router();
const { verifyToken, requireRole } = require('../middleware/authMiddleware');
const {
    getBackups, triggerBackup, restore, remove, download, getSchedule, updateSchedule
} = require('../controllers/backupController');

// Backup/restore — super_admin ("owner") only, same tier as Users/Audit Logs.
router.get('/schedule',            verifyToken, requireRole('super_admin'), getSchedule);
router.put('/schedule',            verifyToken, requireRole('super_admin'), updateSchedule);
router.get('/',                    verifyToken, requireRole('super_admin'), getBackups);
router.post('/run',                verifyToken, requireRole('super_admin'), triggerBackup);
router.post('/:filename/restore',  verifyToken, requireRole('super_admin'), restore);
router.delete('/:filename',        verifyToken, requireRole('super_admin'), remove);
router.get('/:filename/download',  verifyToken, requireRole('super_admin'), download);

module.exports = router;
