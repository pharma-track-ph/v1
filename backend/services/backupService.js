// Backup Service - Full-database backup as one plain SQL dump
const mysql = require('mysql2/promise');
const db    = require('../config/db');
const manilaTime = require('../utils/manilaTime');

// Two accepted shapes: the original UTC stamp
const FILENAME_PATTERN = /^backup-(manual|scheduled|pre-restore-safety)-(?:[0-9T-]+Z|\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3})\.sql$/;

// Every generated file starts with this exact line
const FILE_HEADER = '-- PharmaTrack database backup';

// How many SCHEDULED backups to keep before the oldest ones are pruned automatically
const MAX_SCHEDULED_BACKUPS = 30;

function validateFilename(filename) {
    if (typeof filename !== 'string' || !FILENAME_PATTERN.test(filename)) {
        const err = new Error('Invalid backup filename.');
        err.statusCode = 400;
        throw err;
    }
}

async function getAllTableNames() {
    const [rows] = await db.query(
        `SELECT table_name AS name FROM information_schema.tables
         WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'
           AND table_name != 'backups'`   // don't back up the backups table into itself
    );
    return rows.map(r => r.name);
}

// MySQL DATE/DATETIME columns come back from mysql2 as JS Date objects.
function dateToSqlString(value) {
    const shifted = new Date(value.getTime() + 8 * 60 * 60 * 1000);
    return shifted.toISOString().slice(0, 19).replace('T', ' ');
}

// Converts one cell's JS value into a literal safe to embed directly in an INSERT...
function escapeValue(value) {
    if (value === null || value === undefined) return 'NULL';
    if (value instanceof Date) return db.escape(dateToSqlString(value));
    if (typeof value === 'object') return db.escape(JSON.stringify(value));
    return db.escape(value);
}

async function buildSqlDump(triggeredBy) {
    const tables = await getAllTableNames();

    const lines = [
        FILE_HEADER,
        `-- Generated:     ${new Date().toISOString()}`,
        `-- Triggered by:  ${triggeredBy}`,
        `-- Tables:        ${tables.length}`,
        '--',
        '-- This is a plain SQL dump. To restore it WITHOUT the app:',
        '--   * MySQL Workbench: open this file and run it (or Server > Data Import).',
        '--   * Command line:    mysql -h HOST -P PORT -u USER -p DB_NAME < this_file.sql',
        '',
        'SET FOREIGN_KEY_CHECKS=0;',
        ''
    ];

    for (const table of tables) {
        const [[createRow]] = await db.query(`SHOW CREATE TABLE \`${table}\``);
        const createSql = createRow['Create Table'];

        lines.push(`-- ------------------------------------------------------------`);
        lines.push(`-- Table: ${table}`);
        lines.push(`-- ------------------------------------------------------------`);
        lines.push(`DROP TABLE IF EXISTS \`${table}\`;`);
        lines.push(`${createSql};`);
        lines.push('');

        const [rows] = await db.query(`SELECT * FROM \`${table}\``);
        if (rows.length) {
            const columns    = Object.keys(rows[0]);
            const columnList = columns.map(c => `\`${c}\``).join(', ');

            // Batched in chunks rather than one giant statement, so a very large table
            const CHUNK_SIZE = 500;
            for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
                const chunk = rows.slice(i, i + CHUNK_SIZE);
                const valuesList = chunk
                    .map(row => `(${columns.map(c => escapeValue(row[c])).join(', ')})`)
                    .join(',\n');
                lines.push(`INSERT INTO \`${table}\` (${columnList}) VALUES\n${valuesList};`);
            }
        }
        lines.push('');
    }

    lines.push('SET FOREIGN_KEY_CHECKS=1;');
    lines.push('');

    return { sqlContent: lines.join('\n'), tableCount: tables.length };
}

/** Creates a full backup and stores it as a row in the `backups` table. */
async function runBackup(triggeredBy = 'manual') {
    const { sqlContent, tableCount } = await buildSqlDump(triggeredBy);

    // Named in MANILA time (a UTC stamp looked 8 hours behind).
    const mp = manilaTime.parts();
    const two = (n) => String(n).padStart(2, '0');
    const stamp = `${mp.year}-${two(mp.month)}-${two(mp.day)}_${two(mp.hour)}-${two(mp.minute)}-${two(mp.second)}-${String(Date.now() % 1000).padStart(3, '0')}`;
    const filename = `backup-${triggeredBy}-${stamp}.sql`;
    const size = Buffer.byteLength(sqlContent);

    await db.query(
        `INSERT INTO backups (filename, triggered_by, content, size) VALUES (?, ?, ?, ?)`,
        [filename, triggeredBy, sqlContent, size]
    );

    if (triggeredBy === 'scheduled') {
        await pruneOldScheduledBackups();
    }

    return { filename, size, table_count: tableCount, triggered_by: triggeredBy };
}

// Keeps the table from growing forever on its own
async function pruneOldScheduledBackups() {
    await db.query(
        `DELETE FROM backups
         WHERE triggered_by = 'scheduled'
           AND id NOT IN (
               SELECT id FROM (
                   SELECT id FROM backups
                   WHERE triggered_by = 'scheduled'
                   ORDER BY created_at DESC
                   LIMIT ?
               ) AS keep_these
           )`,
        [MAX_SCHEDULED_BACKUPS]
    );
}

async function listBackups() {
    const [rows] = await db.query(
        `SELECT filename, size, triggered_by, created_at
         FROM backups ORDER BY created_at DESC`
    );
    return rows;
}

async function getBackupContent(filename) {
    validateFilename(filename);
    const [rows] = await db.query(
        `SELECT content FROM backups WHERE filename = ? LIMIT 1`,
        [filename]
    );
    if (!rows.length) {
        const err = new Error('Backup not found.');
        err.statusCode = 404;
        throw err;
    }
    return rows[0].content;
}

async function deleteBackup(filename) {
    validateFilename(filename);
    await db.query(`DELETE FROM backups WHERE filename = ?`, [filename]);
}

/** Restores the database by executing a stored backup's SQL directly. */
async function restoreBackup(filename) {
    const sqlContent = await getBackupContent(filename);

    if (!sqlContent.startsWith(FILE_HEADER)) {
        const err = new Error('This backup does not look like a valid PharmaTrack backup.');
        err.statusCode = 400;
        throw err;
    }

    // Safety net: snapshot whatever is in the database RIGHT NOW before touching...
    const safetySnapshot = await runBackup('pre-restore-safety');

    const restoreConnection = await mysql.createConnection({
        host:     process.env.DB_HOST,
        port:     parseInt(process.env.DB_PORT),
        user:     process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        timezone: '+08:00',
        multipleStatements: true,
        ssl: { rejectUnauthorized: false }
    });

    try {
        await restoreConnection.query(sqlContent);
    } finally {
        await restoreConnection.end();
    }

    return { safety_backup: safetySnapshot.filename };
}

module.exports = {
    validateFilename,
    runBackup,
    listBackups,
    getBackupContent,
    deleteBackup,
    restoreBackup
};
