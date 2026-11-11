// Password "version": lets a password change end older logins A login token

const crypto = require('crypto');

function passwordVersion(passwordHash) {
    return crypto.createHash('sha256').update(String(passwordHash ?? '')).digest('hex').slice(0, 16);
}

// The same value, computed by MySQL (for the per-request check in verifyToken).
const PASSWORD_VERSION_SQL = 'LEFT(SHA2(password, 256), 16)';

module.exports = { passwordVersion, PASSWORD_VERSION_SQL };
