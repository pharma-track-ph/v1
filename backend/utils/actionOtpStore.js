// Action OTP Store (in-memory) - Generalized version of emailChangeOtpStore.js
// otpHashNew is the hash of the SECOND code, sent to a NEW email address that must be proven real (null when only one code is used).
const store = new Map();

function set(requesterId, { otpHash, otpHashNew = null, expiresAt, action, payload }) {
    store.set(requesterId, { otpHash, otpHashNew, expiresAt, attempts: 0, action, payload });
}

function get(requesterId) {
    const entry = store.get(requesterId);
    return entry ? { ...entry } : null;   // a copy: callers count attempts from the value they read
}

function incrementAttempts(requesterId) {
    const entry = store.get(requesterId);
    if (entry) entry.attempts++;
}

function clear(requesterId) {
    store.delete(requesterId);
}

module.exports = { set, get, incrementAttempts, clear };
