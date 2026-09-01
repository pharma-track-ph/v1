// ============================================================
// Email Change OTP Store (in-memory)
//
// Deliberately NOT persisted to the `users` table -- this replaces an
// earlier design that needed 5 new columns (email_change_otp_hash,
// email_change_expires_at, email_change_attempts, email_change_target_id,
// email_change_new_email) on a live production database. A code that's
// only ever valid for 10 minutes doesn't need to survive a server
// restart -- if the server does restart mid-flow, the requester just
// asks for a new code, which is a fine tradeoff for not touching the
// database schema at all.
//
// Keyed by the REQUESTER's user id (the admin/owner performing the
// change) -- same actor the code is emailed to (see authController.js's
// requestEmailChangeOtp/confirmEmailChangeOtp). Only ever holds one
// pending change per requester at a time; a fresh request simply
// overwrites whatever was pending before.
//
// Same bcrypt-hash-only storage as the password-reset OTP columns --
// never the plain code itself, only its hash, in memory or otherwise.
// ============================================================
const store = new Map();

/**
 * @param {number} requesterId
 * @param {object} data
 * @param {string} data.otpHash
 * @param {Date}   data.expiresAt
 * @param {number|string} data.targetId - the account whose email is being changed
 * @param {string} data.newEmail        - the email address being changed TO
 */
function set(requesterId, { otpHash, expiresAt, targetId, newEmail }) {
    store.set(requesterId, { otpHash, expiresAt, attempts: 0, targetId, newEmail });
}

function get(requesterId) {
    return store.get(requesterId) || null;
}

function incrementAttempts(requesterId) {
    const entry = store.get(requesterId);
    if (entry) entry.attempts++;
}

function clear(requesterId) {
    store.delete(requesterId);
}

module.exports = { set, get, incrementAttempts, clear };
