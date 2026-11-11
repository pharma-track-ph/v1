// Email Change OTP Store (in-memory) - Deliberately NOT persisted to the `users`...
const store = new Map();

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
