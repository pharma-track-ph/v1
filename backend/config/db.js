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

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: parseInt(process.env.DB_POOL_LIMIT || '10'),
    queueLimit: 0,
    timezone: '+08:00',
    multipleStatements: true,  // Required for running full schema
    ssl: {
        rejectUnauthorized: false  // Required for Aiven self-signed certificate chain
    }
});

pool.on('connection', (connection) => {
    connection.query("SET SESSION sql_mode = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'");
});

// Auto-initialize schema if tables don't exist
async function initSchema() {
    try {
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
            console.log('✅  Database schema is complete — skipping schema import.');
        }
    } catch (err) {
        console.error('❌  Schema init failed:', err.message);
        throw err;
    }
}

// Test connection and init schema on startup
async function initializeDatabase() {
    let connection = null;
    try {
        connection = await pool.getConnection();
        console.log(`✅  MySQL connected: ${process.env.DB_NAME || 'pharmatrack'}@${process.env.DB_HOST || 'localhost'}`);

        await connection.query('SELECT 1');
        console.log('✅  Database permissions verified');

        await initSchema();

        console.log('✅  Database initialization completed successfully');
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
