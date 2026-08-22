// ============================================================
// Backup Service
// Full-database backup as one plain SQL dump, stored AS A ROW IN THE
// DATABASE ITSELF (table: `backups`) rather than a file on disk.
//
// This changed from filesystem storage after a real failure on Render:
// Render's disk is ephemeral — every deploy rebuilds the container from
// scratch, wiping anything written to the local filesystem during the
// previous run. Backups are the one thing that absolutely cannot be
// allowed to vanish on deploy, so they now live in the database, which
// is the one part of this stack that's actually persistent.
//
// The CONTENT is still a real, standard .sql dump (CREATE TABLE + INSERT
// statements, generated the same way mysqldump does it under the hood),
// so downloading a backup still gives you a plain file that works with
// MySQL Workbench, the `mysql` command line, phpMyAdmin, etc., completely
// independent of this app. Only WHERE it's stored between backup and
// download/restore changed, not what it is.
//
// Tables are introspected live via information_schema, so any table
// added later directly on Aiven (e.g. cash_sessions/cash_movements,
// which aren't even in database/schema.sql) is picked up automatically —
// nothing to keep in sync by hand.
// ============================================================
const mysql = require('mysql2/promise');
const db    = require('../config/db');

const FILENAME_PATTERN = /^backup-(manual|scheduled|pre-restore-safety)-[0-9T-]+Z\.sql$/;

// Every generated file starts with this exact line — a cheap sanity check
// before restoreBackup() ever executes stored content as SQL.
const FILE_HEADER = '-- PharmaTrack database backup';

// How many SCHEDULED backups to keep before the oldest ones are pruned
// automatically (see pruneOldScheduledBackups). Manual backups and
// pre-restore safety copies are never auto-pruned — only the
// once-a-day automatic ones, so the table doesn't grow forever.
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
// Rendering them naively (e.g. toISOString()) would produce UTC, which
// would silently shift every timestamp by 8 hours on restore (the DB
// connection itself runs in +08:00 — see config/db.js's DB_TIMEZONE).
// This renders the SAME wall-clock value that was actually stored.
function dateToSqlString(value) {
    const shifted = new Date(value.getTime() + 8 * 60 * 60 * 1000);
    return shifted.toISOString().slice(0, 19).replace('T', ' ');
}

// Converts one cell's JS value into a literal safe to embed directly in
// an INSERT statement's VALUES list. db.escape() (mysql2) handles the
// actual quoting/escaping for strings/numbers/booleans, so a value like
// an apostrophe in a product name can never break out of its literal or
// be mistaken for SQL syntax.
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

            // Batched in chunks rather than one giant statement, so a very
            // large table (audit_logs after months of real use, say)
            // can't hit MySQL's max_allowed_packet limit.
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

/**
 * Creates a full backup and stores it as a row in the `backups` table.
 * @param {string} triggeredBy - 'manual' | 'scheduled' | 'pre-restore-safety'
 */
async function runBackup(triggeredBy = 'manual') {
    const { sqlContent, tableCount } = await buildSqlDump(triggeredBy);

    const filename = `backup-${triggeredBy}-${new Date().toISOString().replace(/[:.]/g, '-')}.sql`;
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

// Keeps the table from growing forever on its own — only touches
// automatic daily backups, never manual ones or pre-restore safety
// copies, both of which a person deliberately created and might want to
// keep around indefinitely.
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

/**
 * Restores the database by executing a stored backup's SQL directly.
 * DESTRUCTIVE — every table covered by it is dropped and recreated from
 * scratch. A fresh safety backup of the CURRENT state is taken first, so
 * an accidental wrong-file restore is itself recoverable.
 *
 * Uses a DEDICATED connection with multipleStatements enabled, rather
 * than the app's shared pool (config/db.js), which deliberately disables
 * multipleStatements in production for security — every other query in
 * this app is a single parameterized statement, so that pool has no
 * business ever running a whole file of raw SQL. This one-off connection
 * is opened only for this operation and closed immediately after.
 */
async function restoreBackup(filename) {
    const sqlContent = await getBackupContent(filename);

    if (!sqlContent.startsWith(FILE_HEADER)) {
        const err = new Error('This backup does not look like a valid PharmaTrack backup.');
        err.statusCode = 400;
        throw err;
    }

    // Safety net: snapshot whatever is in the database RIGHT NOW before
    // touching anything, in case the wrong backup gets picked.
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
