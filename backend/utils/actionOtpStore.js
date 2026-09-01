// ============================================================
// Action OTP Store (in-memory)
//
// Generalized version of emailChangeOtpStore.js -- same "confirm it's
// really you" pattern (a code emailed to the OWNER PERFORMING the
// action, nothing written to the DB until confirmed), but reusable
// across several different sensitive User Management actions instead of
// being specific to email changes: Add User, Change Password,
// Delete/Deactivate.
//
// Keyed by the REQUESTER's user id, same actor the code is emailed to.
// Only ever holds ONE pending action per requester at a time -- starting
// a second action (e.g. clicking Delete while an Add User code is still
// pending) silently replaces whatever was pending before. Not addressed
// here by design; revisit if it becomes an actual problem in testing.
//
// `payload` holds whatever the action needs to actually execute once
// confirmed -- e.g. { name, email, role, password } for create_user, or
// { targetId, newPassword } for update_password. Never written to the
// database until confirmActionOtp succeeds (see authController.js).
// ============================================================
const store = new Map();

/**
 * @param {number} requesterId
 * @param {object} data
 * @param {string} data.otpHash
 * @param {Date}   data.expiresAt
 * @param {string} data.action  - 'create_user' | 'update_password' | 'delete_user'
 * @param {object} data.payload - action-specific data needed to execute it
 */
function set(requesterId, { otpHash, expiresAt, action, payload }) {
    store.set(requesterId, { otpHash, expiresAt, attempts: 0, action, payload });
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
