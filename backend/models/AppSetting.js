// AppSetting Model - Small key-value store for app-wide configurable settings
const db = require('../config/db');

const AppSetting = {
    get: async (key, fallback = null) => {
        const [rows] = await db.query(
            'SELECT setting_value FROM app_settings WHERE setting_key = ? LIMIT 1',
            [key]
        );
        return rows[0]?.setting_value ?? fallback;
    },

    set: async (key, value) => {
        await db.query(
            `INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?)
             ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
            [key, value]
        );
    }
};

module.exports = AppSetting;
