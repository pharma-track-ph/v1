// Backup Scheduler - Runs a full database backup automatically every day...
const { runBackup } = require('../services/backupService');
const AppSetting     = require('../models/AppSetting');

const SETTING_KEY     = 'backup_schedule_time';
const DEFAULT_TIME    = '23:59';
const TIME_PATTERN    = /^([01]\d|2[0-3]):([0-5]\d)$/;

let currentTimer = null; // reference to the live setTimeout

async function getScheduledHourMinute() {
    const raw = await AppSetting.get(SETTING_KEY, DEFAULT_TIME);
    const match = TIME_PATTERN.exec(raw);
    if (!match) return { hour: 23, minute: 59 }; // corrupted/invalid setting - fall back safely
    return { hour: parseInt(match[1], 10), minute: parseInt(match[2], 10) };
}

async function msUntilNextScheduledTime() {
    const { hour, minute } = await getScheduledHourMinute();
    const now = new Date();

    // Reads the current moment AS IT WOULD DISPLAY in Asia/Manila...
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
            scheduleNext(); // always reschedule, success or failure
        }, delay);
    }).catch((err) => {
        // Couldn't even read the schedule setting
        console.error('❌  Could not read backup schedule, retrying in 60s:', err.message);
        currentTimer = setTimeout(scheduleNext, 60000);
    });
}

function scheduleDailyBackup() {
    scheduleNext();
}

/** Cancels whatever timer is currently counting down and immediately arms a new... */
function rescheduleNow() {
    if (currentTimer) {
        clearTimeout(currentTimer);
        currentTimer = null;
    }
    scheduleNext();
}

module.exports = { scheduleDailyBackup, rescheduleNow, SETTING_KEY, DEFAULT_TIME, TIME_PATTERN };
