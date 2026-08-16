// ============================================================
// Backup Service
// Full-database backup as one plain .sql dump per file — real SQL
// (CREATE TABLE + INSERT statements), not a PharmaTrack-specific format.
//
// Deliberately NOT using the `mysqldump` binary — Render's managed Node
// environment doesn't reliably have it installed. Instead this builds the
// dump itself via SHOW CREATE TABLE + SELECT, using the same approach
// mysqldump uses under the hood, which keeps the OUTPUT format completely
// standard: importable via MySQL Workbench (Server > Data Import, or just
// opening the file and running it), the `mysql` command line, phpMyAdmin,
// or any other MySQL client — independent of the PharmaTrack app itself.
// That matters specifically for disaster recovery: if the app or the
// owner account is ever inaccessible, this file alone is enough to
// rebuild the database from scratch on any MySQL server.
//
// Tables are introspected live via information_schema, so any table
// added later directly on Aiven (e.g. cash_sessions/cash_movements,
// which aren't even in database/schema.sql) is picked up automatically —
// nothing to keep in sync by hand.
// ============================================================
const fs    = require('fs').promises;
const path  = require('path');
const mysql = require('mysql2/promise');
const db    = require('../config/db');

const BACKUP_DIR = path.join(__dirname, '../backups');
// Trigger type is encoded right in the filename (manual/scheduled/
// pre-restore-safety) so listBackups() can report it cheaply, without
// having to read every backup file's contents just to list them.
const FILENAME_PATTERN = /^backup-(manual|scheduled|pre-restore-safety)-[0-9T-]+Z\.sql$/;

// Every generated file starts with this exact line — a cheap sanity check
// before restoreBackup() ever executes a file's contents as SQL, in case
// something with a matching filename but unrelated content ever ended up
// in the backups folder.
const FILE_HEADER = '-- PharmaTrack database backup';

async function ensureBackupDir() {
    await fs.mkdir(BACKUP_DIR, { recursive: true });
}

// Path-traversal guard — only ever accept exactly the naming pattern this
// module itself generates below, never an arbitrary filename from a request.
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
         WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'`
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
    // JSON columns (e.g. audit_logs.details) come back as parsed
    // objects/arrays from mysql2 — re-serialize before quoting, since a
    // JSON column's INSERT value is just a quoted JSON string.
    if (typeof value === 'object') return db.escape(JSON.stringify(value));
    return db.escape(value);
}

/**
 * Creates a full backup of every table in the database as one .sql file.
 * @param {string} triggeredBy - 'manual' | 'scheduled' | 'pre-restore-safety'
 */
async function runBackup(triggeredBy = 'manual') {
    await ensureBackupDir();
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

    const sqlContent = lines.join('\n');

    // Filename doubles as the sort key and the path-traversal allowlist
    // pattern above, so it has to be exactly this shape.
    const filename = `backup-${triggeredBy}-${new Date().toISOString().replace(/[:.]/g, '-')}.sql`;
    const filepath = path.join(BACKUP_DIR, filename);

    await fs.writeFile(filepath, sqlContent, 'utf8');

    return {
        filename,
        size:         Buffer.byteLength(sqlContent),
        table_count:  tables.length,
        triggered_by: triggeredBy
    };
}

async function listBackups() {
    await ensureBackupDir();
    const files = (await fs.readdir(BACKUP_DIR)).filter(f => FILENAME_PATTERN.test(f));

    const results = await Promise.all(files.map(async (f) => {
        const stat  = await fs.stat(path.join(BACKUP_DIR, f));
        const match = f.match(FILENAME_PATTERN);
        return {
            filename:     f,
            size:         stat.size,
            created_at:   stat.mtime,
            triggered_by: match ? match[1] : 'manual'
        };
    }));

    return results.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

async function deleteBackup(filename) {
    validateFilename(filename);
    await fs.unlink(path.join(BACKUP_DIR, filename));
}

/**
 * Restores the database by executing a backup .sql file directly.
 * DESTRUCTIVE — every table covered by the file is dropped and recreated
 * from scratch. A fresh safety backup of the CURRENT state is taken
 * first, so an accidental wrong-file restore is itself recoverable.
 *
 * Uses a DEDICATED connection with multipleStatements enabled, rather
 * than the app's shared pool (config/db.js), which deliberately disables
 * multipleStatements in production for security — every other query in
 * this app is a single parameterized statement, so that pool has no
 * business ever running a whole file of raw SQL. This one-off connection
 * is opened only for this operation and closed immediately after.
 */
async function restoreBackup(filename) {
    validateFilename(filename);

    const filepath = path.join(BACKUP_DIR, filename);
    const sqlContent = await fs.readFile(filepath, 'utf8');

    if (!sqlContent.startsWith(FILE_HEADER)) {
        const err = new Error('This file does not look like a PharmaTrack backup.');
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
    BACKUP_DIR,
    validateFilename,
    runBackup,
    listBackups,
    deleteBackup,
    restoreBackup
};
