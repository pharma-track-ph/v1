// ============================================================
// PharmaTrack – Database Connection + Auto Schema Init
// Version: 2.0.0
// Author: PharmaTrack Development Team
// Last Modified: April 14, 2026
// Description: Handles MySQL database connections and automatic schema initialization
// ============================================================
const mysql = require('mysql2/promise');
const fs = require('fs').promises;
const path = require('path');

// ============================================================
// SECURITY: Disable multipleStatements in production
// ============================================================
const isProduction = process.env.NODE_ENV === 'production';
const DB_TIMEZONE = '+08:00';

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: parseInt(process.env.DB_POOL_LIMIT || '10'),
    queueLimit: 0,
    timezone: DB_TIMEZONE,
    multipleStatements: !isProduction,  // DISABLED in production for safety
    ssl: {
        rejectUnauthorized: false  // Required for Aiven self-signed certificate chain
    },
    // Keep-alive prevents Aiven (and most managed MySQL free tiers) from silently
    // closing idle TCP connections, which otherwise surface as ECONNRESET on the
    // next query using that pooled connection.
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    connectTimeout: 20000
});

// Pool-level errors (e.g. a connection reset by the server while idle) must be
// handled here — otherwise Node treats them as unhandled 'error' events and the
// process can crash, or the dead connection can linger in the pool.
pool.on('error', (err) => {
    console.error('[DB POOL ERROR]', err.code || err.message);
});

pool.on('connection', (connection) => {
    connection.query(`SET time_zone = '${DB_TIMEZONE}'`);
    connection.query("SET SESSION sql_mode = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'");
});

// Auto-initialize schema if tables don't exist
async function initSchema() {
    try {
        // PRODUCTION SAFETY: Skip auto-init if explicitly disabled
        if (isProduction && process.env.SKIP_SCHEMA_INIT === 'true') {
            console.log('🔐 [PRODUCTION] Schema initialization DISABLED — using existing database');
            return;
        }

        // Check for multiple critical tables to ensure schema completeness
        const criticalTables = ['users', 'products', 'orders', 'order_items'];
        const placeholders = criticalTables.map(() => '?').join(',');
        const [rows] = await pool.query(
            `SELECT table_name FROM information_schema.tables
             WHERE table_schema = DATABASE() AND table_name IN (${placeholders})`,
            criticalTables
        );

        const existingTables = rows.map(row => row.table_name);
        const missingTables = criticalTables.filter(table => !existingTables.includes(table));

        if (missingTables.length > 0) {
            // PRODUCTION SAFETY: Prevent schema init in production without explicit permission
            if (isProduction) {
                console.error('❌ [PRODUCTION] CRITICAL: Missing tables detected in production database!');
                console.error('   Missing tables:', missingTables.join(', '));
                console.error('   To initialize schema in production, set: SKIP_SCHEMA_INIT=false');
                throw new Error('Cannot auto-initialize schema in production without explicit permission');
            }

            console.log(`📦  Missing tables detected: ${missingTables.join(', ')} — importing schema...`);

            const schemaPaths = [
                path.join(__dirname, '../../database/schema.sql'),
                path.join(__dirname, '../database/schema.sql'),
                path.join(__dirname, 'schema.sql')
            ];

            const accessPromises = schemaPaths.map(async (p) => {
                await fs.access(p);
                return p;
            });

            let schemaPath = null;
            try {
                schemaPath = await Promise.any(accessPromises);
            } catch (err) {
                // All paths failed
            }

            if (schemaPath) {
                const schemaSQL = await fs.readFile(schemaPath, 'utf8');
                console.log(`    Found schema at: ${schemaPath}`);

                // Remove CREATE DATABASE and USE statements for Railway/Render
                const cleanedSchemaSQL = schemaSQL
                    .replace(/CREATE DATABASE.*?;/gi, '')
                    .replace(/USE.*?;/gi, '');

                await pool.query(cleanedSchemaSQL);
                console.log('✅  Schema imported successfully!');
            } else {
                console.warn('⚠️  Schema file not found — skipping auto-init.');
            }
        } else {
            if (isProduction) {
                console.log('✅ [PRODUCTION] Database schema is complete — Aiven data is PROTECTED');
            } else {
                console.log('✅  Database schema is complete — skipping schema import.');
            }
        }
    } catch (err) {
        console.error('❌  Schema init failed:', err.message);
        throw err;
    }
}

// Adds the columns needed for the email-change OTP flow (User Management
// -> changing a user's email now requires the ADMIN/OWNER performing the
// change to confirm a code sent to their OWN email, mirroring the
// forgot-password flow). Purely additive (ADD COLUMN, never DROP/ALTER
// existing data) so it's safe to run in any environment, unlike the full
// schema import above which only ever runs when tables are missing.
async function ensureEmailChangeOtpColumns() {
    try {
        const requiredColumns = [
            { name: 'email_change_otp_hash',   ddl: 'VARCHAR(255) NULL' },
            { name: 'email_change_expires_at', ddl: 'DATETIME NULL' },
            { name: 'email_change_attempts',   ddl: 'INT NOT NULL DEFAULT 0' },
            { name: 'email_change_target_id',  ddl: 'INT NULL' },
            { name: 'email_change_new_email',  ddl: 'VARCHAR(150) NULL' }
        ];

        const [existingCols] = await pool.query(
            `SELECT COLUMN_NAME FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'users'`
        );
        const existingNames = existingCols.map(r => r.COLUMN_NAME);

        for (const col of requiredColumns) {
            if (!existingNames.includes(col.name)) {
                console.log(`📦  Adding missing column users.${col.name} ...`);
                await pool.query(`ALTER TABLE users ADD COLUMN ${col.name} ${col.ddl}`);
            }
        }
    } catch (err) {
        console.error('⚠️  Could not verify/add email-change-OTP columns:', err.message);
    }
}

// Test connection and init schema on startup
async function initializeDatabase() {
    let connection = null;
    try {
        connection = await pool.getConnection();
        const envLabel = isProduction ? '[PRODUCTION]' : '[DEVELOPMENT]';
        console.log(`${envLabel} ✅ MySQL connected: ${process.env.DB_NAME || 'pharmatrack'}@${process.env.DB_HOST || 'localhost'}`);

        // Verify database connectivity and permissions
        await connection.query('SELECT 1');
        await connection.query(`SET time_zone = '${DB_TIMEZONE}'`);
        console.log(`${envLabel} ✅ Database permissions verified`);

        // For production, verify critical tables exist BEFORE initialization
        if (isProduction) {
            const criticalTables = ['users', 'products', 'orders', 'order_items'];
            const [tableCheck] = await connection.query(
                `SELECT COUNT(*) as count FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN (${criticalTables.map(() => '?').join(',')})`
                , criticalTables
            );
            const existingTableCount = tableCheck[0].count;
            if (existingTableCount < criticalTables.length) {
                throw new Error(`PRODUCTION SAFETY: Only ${existingTableCount}/${criticalTables.length} critical tables found. Missing tables will NOT be auto-created to protect existing data.`);
            }
            console.log(`${envLabel} 🔐 All ${criticalTables.length} critical tables verified — data is SAFE`);
        }

        await initSchema();
        await ensureEmailChangeOtpColumns();

        const completionMsg = isProduction
            ? '✅ [PRODUCTION] Database initialization completed — Aiven data is PROTECTED'
            : '✅  Database initialization completed successfully';
        console.log(completionMsg);
    } catch (err) {
        if (err.code === 'ECONNREFUSED') {
            console.error('❌  MySQL connection failed: Database server is not running');
            console.error('    Make sure MySQL is running and check your DB_HOST/DB_PORT settings');
        } else if (err.code === 'ER_ACCESS_DENIED_ERROR') {
            console.error('❌  MySQL connection failed: Access denied');
            console.error('    Check your DB_USER and DB_PASSWORD settings');
        } else if (err.code === 'ER_BAD_DB_ERROR') {
            console.error('❌  MySQL connection failed: Database does not exist');
            console.error('    Check your DB_NAME setting or create the database manually');
        } else {
            console.error('❌  Database initialization failed:', err.message);
        }
        throw err;
    } finally {
        if (connection) {
            connection.release();
        }
    }
}

// Initialize database on module load
initializeDatabase().catch(err => {
    console.error('❌  Critical database initialization error:', err.message);
    process.exit(1);
});

module.exports = pool;
