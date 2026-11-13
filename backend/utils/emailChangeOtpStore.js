// Email Change OTP Store (in-memory) - Deliberately NOT persisted to the `users` table.
// otpHashNew is the hash of the SECOND code, sent to the NEW address to prove it is real.
const store = new Map();

function set(requesterId, { otpHash, otpHashNew = null, expiresAt, targetId, newEmail }) {
    store.set(requesterId, { otpHash, otpHashNew, expiresAt, attempts: 0, targetId, newEmail });
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
