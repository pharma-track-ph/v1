// ============================================================
// Backup Controller
// Manual/scheduled backup, restore, list, delete, download, schedule.
// All routes are super_admin ("owner") only — see routes/backupRoutes.js.
// ============================================================
const path            = require('path');
const backupService   = require('../services/backupService');
const AppSetting      = require('../models/AppSetting');
const { SETTING_KEY, DEFAULT_TIME, TIME_PATTERN, rescheduleNow } = require('../utils/backupScheduler');
const { logAudit }    = require('../middleware/authMiddleware');

/**
 * GET /api/backup
 * Lists existing backup files, newest first.
 */
const getBackups = async (req, res, next) => {
    try {
        const backups = await backupService.listBackups();
        res.json({ success: true, data: backups });
    } catch (err) { next(err); }
};

/**
 * POST /api/backup/run
 * Triggers a manual, on-demand backup.
 */
const triggerBackup = async (req, res, next) => {
    try {
        const result = await backupService.runBackup('manual');
        await logAudit(req.user.id, 'CREATE_BACKUP', 'backups', null, result, req.ip);
        res.json({ success: true, message: `Backup created: ${result.filename}`, data: result });
    } catch (err) { next(err); }
};

/**
 * POST /api/backup/:filename/restore
 * DESTRUCTIVE — truncates and replaces every table covered by the backup.
 * A safety snapshot of the pre-restore state is taken automatically
 * (see backupService.restoreBackup).
 */
const restore = async (req, res, next) => {
    try {
        const result = await backupService.restoreBackup(req.params.filename);
        await logAudit(req.user.id, 'RESTORE_BACKUP', 'backups', null,
            { filename: req.params.filename, ...result }, req.ip);
        res.json({ success: true, message: 'Database restored from backup.', data: result });
    } catch (err) { next(err); }
};

/**
 * DELETE /api/backup/:filename
 */
const remove = async (req, res, next) => {
    try {
        await backupService.deleteBackup(req.params.filename);
        await logAudit(req.user.id, 'DELETE_BACKUP', 'backups', null, { filename: req.params.filename }, req.ip);
        res.json({ success: true, message: 'Backup deleted.' });
    } catch (err) { next(err); }
};

/**
 * GET /api/backup/:filename/download
 */
const download = async (req, res, next) => {
    try {
        backupService.validateFilename(req.params.filename);
        const filepath = path.join(backupService.BACKUP_DIR, req.params.filename);
        res.type('application/sql');
        res.download(filepath, req.params.filename, (err) => {
            // res.download() may fail AFTER headers are already partially
            // sent (e.g. file deleted mid-request) — only forward to the
            // error handler if a response hasn't gone out yet.
            if (err && !res.headersSent) next(err);
        });
    } catch (err) { next(err); }
};

/**
 * GET /api/backup/schedule
 * Returns the currently configured daily auto-backup time (HH:MM, 24hr,
 * Asia/Manila).
 */
const getSchedule = async (req, res, next) => {
    try {
        const time = await AppSetting.get(SETTING_KEY, DEFAULT_TIME);
        res.json({ success: true, data: { time } });
    } catch (err) { next(err); }
};

/**
 * PUT /api/backup/schedule
 * Body: { time: "HH:MM" }
 * Takes effect immediately — rescheduleNow() cancels whatever timer is
 * currently counting down and re-arms it against the freshly saved time,
 * rather than waiting for the old timer to fire on its own schedule first.
 */
const updateSchedule = async (req, res, next) => {
    try {
        const { time } = req.body;

        if (!TIME_PATTERN.test(time || '')) {
            return res.status(400).json({ success: false, message: 'Time must be in HH:MM 24-hour format.' });
        }

        await AppSetting.set(SETTING_KEY, time);
        rescheduleNow();
        await logAudit(req.user.id, 'UPDATE_BACKUP_SCHEDULE', 'app_settings', null, { time }, req.ip);

        res.json({ success: true, message: `Auto-backup time updated to ${time}. Takes effect immediately.` });
    } catch (err) { next(err); }
};

module.exports = { getBackups, triggerBackup, restore, remove, download, getSchedule, updateSchedule };
