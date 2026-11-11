// Action OTP Store (in-memory) - Generalized version of emailChangeOtpStore.js
const store = new Map();

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
