// Manila time, independent of the server's own time zone PharmaTrack runs in Manila...

const TZ = 'Asia/Manila';

const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone:  TZ,
    hourCycle: 'h23',            // 0-23, never "24"
    year:      'numeric',
    month:     'numeric',
    day:       'numeric',
    hour:      'numeric',
    minute:    'numeric',
    second:    'numeric'
});

const pad = (n) => String(n).padStart(2, '0');

// { year, month (1-12), day, hour (0-23), minute, second } as read on a Manila clock
function parts(value = new Date()) {
    const d = value instanceof Date ? value : new Date(value);
    const p = {};
    for (const x of formatter.formatToParts(d)) {
        if (x.type !== 'literal') p[x.type] = parseInt(x.value, 10);
    }
    return { year: p.year, month: p.month, day: p.day, hour: p.hour % 24, minute: p.minute, second: p.second };
}

// "2026-10-25" - the calendar date in Manila
function dateString(value = new Date()) {
    const p = parts(value);
    return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

// The moment Manila's day began (00:00 Manila) for the given instant, as a Date
function midnight(value = new Date()) {
    return new Date(`${dateString(value)}T00:00:00+08:00`);
}

module.exports = { TZ, parts, dateString, midnight };
