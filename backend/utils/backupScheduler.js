// ============================================================
// Backup Scheduler
// Runs a full database backup automatically every day at a configurable
// time (default 11:59 PM Asia/Manila -- same timezone the DB connection
// itself uses, see config/db.js's DB_TIMEZONE), regardless of what
// timezone the actual host server is running in.
//
// The time itself is stored in app_settings (key: backup_schedule_time,
// format "HH:MM" 24-hour) so it's editable from the Backup & Restore page
// without a redeploy -- see backupController.js's getSchedule/
// updateSchedule.
//
// No external dependency (no node-cron) -- a single setTimeout is used
// instead of a cron library for one daily job. rescheduleNow() lets
// updateSchedule() cancel whatever timer is currently counting down and
// immediately arm a new one against the freshly saved time -- without
// this, saving a new time only ever took effect after the OLD timer
// finished counting down to its original target and rescheduled itself,
// which could be many hours away and made testing a new time look like
// it silently did nothing.
// ============================================================
const { runBackup } = require('../services/backupService');
const AppSetting     = require('../models/AppSetting');

const SETTING_KEY     = 'backup_schedule_time';
const DEFAULT_TIME    = '23:59';
const TIME_PATTERN    = /^([01]\d|2[0-3]):([0-5]\d)$/;

let currentTimer = null; // reference to the live setTimeout, so it can be cancelled and re-armed on demand

async function getScheduledHourMinute() {
    const raw = await AppSetting.get(SETTING_KEY, DEFAULT_TIME);
    const match = TIME_PATTERN.exec(raw);
    if (!match) return { hour: 23, minute: 59 }; // corrupted/invalid setting -- fall back safely
    return { hour: parseInt(match[1], 10), minute: parseInt(match[2], 10) };
}

async function msUntilNextScheduledTime() {
    const { hour, minute } = await getScheduledHourMinute();
    const now = new Date();

    // Reads the current moment AS IT WOULD DISPLAY in Asia/Manila via the
    // Intl-backed toLocaleString, then treats that string as if it were
    // local time -- this works regardless of the host machine's own
    // timezone (important since Render's servers aren't necessarily
    // running in +08:00).
    const manilaNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Manila' }));

    const target = new Date(manilaNow);
    target.setHours(hour, minute, 0, 0);
    if (target <= manilaNow) target.setDate(target.getDate() + 1);

    return target.getTime() - manilaNow.getTime();
}

function scheduleNext() {
    msUntilNextScheduledTime().then((delay) => {
        const minutes = Math.round(delay / 60000);
        console.log(`🗄️  Next scheduled backup in ~${minutes} minute(s).`);

        currentTimer = setTimeout(async () => {
            try {
                const result = await runBackup('scheduled');
                console.log(`✅  Scheduled backup completed: ${result.filename} (${result.table_count} tables)`);
            } catch (err) {
                console.error('❌  Scheduled backup failed:', err.message);
            }
            scheduleNext(); // always reschedule, success or failure -- re-reads the saved time fresh
        }, delay);
    }).catch((err) => {
        // Couldn't even read the schedule setting (e.g. DB briefly
        // unreachable at startup) -- retry in a minute rather than
        // never scheduling anything at all.
        console.error('❌  Could not read backup schedule, retrying in 60s:', err.message);
        currentTimer = setTimeout(scheduleNext, 60000);
    });
}

function scheduleDailyBackup() {
    scheduleNext();
}

/**
 * Cancels whatever timer is currently counting down and immediately arms
 * a new one against the just-saved schedule time. Call this right after
 * writing a new time to app_settings (see backupController.updateSchedule)
 * so the change is actually live right away, not just "next time the old
 * timer happens to fire."
 */
function rescheduleNow() {
    if (currentTimer) {
        clearTimeout(currentTimer);
        currentTimer = null;
    }
    scheduleNext();
}

module.exports = { scheduleDailyBackup, rescheduleNow, SETTING_KEY, DEFAULT_TIME, TIME_PATTERN };
