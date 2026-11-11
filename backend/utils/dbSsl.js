// TLS settings for the database connection - The connection to Aiven is always...
const fs   = require('fs');
const path = require('path');

const DEFAULT_CA_FILE = path.join(__dirname, '../config/aiven-ca.pem');

function readCaCertificate(env, defaultFile) {
    const inline = String(env.DB_SSL_CA || '').trim();
    if (inline.includes('BEGIN CERTIFICATE')) return inline.replace(/\\n/g, '\n');

    const file = env.DB_SSL_CA_FILE ? path.resolve(env.DB_SSL_CA_FILE) : defaultFile;
    if (file && fs.existsSync(file)) {
        const pem = fs.readFileSync(file, 'utf8');
        if (pem.includes('BEGIN CERTIFICATE')) return pem;
    }
    return null;
}

// Returns { ssl, verified }: the options for mysql2's "ssl" setting
function buildSslOptions(env = process.env, defaultFile = DEFAULT_CA_FILE) {
    const ca = readCaCertificate(env, defaultFile);
    if (!ca) return { ssl: { rejectUnauthorized: false }, verified: false };

    const ssl = { ca, rejectUnauthorized: true };
    if (String(env.DB_SSL_VERIFY_HOSTNAME).toLowerCase() === 'false') {
        ssl.checkServerIdentity = () => undefined;
    }
    return { ssl, verified: true };
}

module.exports = { buildSslOptions, DEFAULT_CA_FILE };
