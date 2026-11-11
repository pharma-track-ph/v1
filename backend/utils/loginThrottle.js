// Per-account login throttle - The IP-based limit alone cannot stop someone guessing...

function createThrottle({
    maxFailures = 5,
    windowMs    = 15 * 60 * 1000,
    lockMs      = 15 * 60 * 1000,
    maxEntries  = 5000,            // keeps memory bounded if someone floods it with made-up...
    now         = () => Date.now()
} = {}) {
    const entries = new Map();     // email -> { failures: [timestamps], lockedUntil }

    function prune(t) {
        if (entries.size <= maxEntries) return;
        for (const [key, e] of entries) {
            if ((e.lockedUntil || 0) <= t && e.failures.every(f => f <= t - windowMs)) entries.delete(key);
        }
        while (entries.size > maxEntries) entries.delete(entries.keys().next().value);   // oldest first
    }

    return {
        // Is this email locked right now?
        check(key) {
            const t = now();
            const e = entries.get(key);
            if (e && e.lockedUntil > t) return { locked: true, retryAfterSeconds: Math.ceil((e.lockedUntil - t) / 1000) };
            return { locked: false, retryAfterSeconds: 0 };
        },

        // Record one wrong password. justLocked is true only for the attempt...
        fail(key) {
            const t = now();
            let e = entries.get(key);
            if (!e) { e = { failures: [], lockedUntil: 0 }; entries.set(key, e); }

            if (e.lockedUntil > t) {                                   // already locked: never extend it
                return { justLocked: false, locked: true, retryAfterSeconds: Math.ceil((e.lockedUntil - t) / 1000) };
            }
            if (e.lockedUntil) { e.failures = []; e.lockedUntil = 0; } // the lock has run out: fresh start

            e.failures = e.failures.filter(f => f > t - windowMs);
            e.failures.push(t);

            if (e.failures.length >= maxFailures) {
                e.lockedUntil = t + lockMs;
                e.failures = [];
                prune(t);
                return { justLocked: true, locked: true, retryAfterSeconds: Math.ceil(lockMs / 1000) };
            }
            prune(t);
            return { justLocked: false, locked: false, retryAfterSeconds: 0, failuresLeft: maxFailures - e.failures.length };
        },

        // A correct password: forget the failures.
        clear(key) { entries.delete(key); },

        size() { return entries.size; }
    };
}

const instance = createThrottle({
    maxFailures: Number(process.env.LOGIN_MAX_FAILURES) || 5,
    lockMs:      (Number(process.env.LOGIN_LOCK_MINUTES) || 15) * 60 * 1000
});

module.exports = Object.assign(instance, { createThrottle });
