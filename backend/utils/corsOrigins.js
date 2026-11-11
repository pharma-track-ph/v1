// Which websites may call the API from a browser (CORS) Two situations

const PRODUCTION_ORIGINS = [
    'https://pharma-track-ph.onrender.com',
    'https://pharma-track-v2.onrender.com'
];

const LOCAL_ORIGINS = [
    'http://localhost:3000', 'http://127.0.0.1:3000',
    'http://localhost:5000', 'http://127.0.0.1:5000',
    'http://localhost:5500', 'http://127.0.0.1:5500',
    'http://localhost'
];

function localOriginsAllowed(env) {
    const forced = String(env.ALLOW_LOCAL_ORIGINS || '').trim().toLowerCase();
    if (forced === 'true')  return true;
    if (forced === 'false') return false;
    return String(env.RENDER).toLowerCase() !== 'true';   // on Render: no. On your own computer: yes.
}

function allowedOrigins(env = process.env) {
    const extra = String(env.ALLOWED_ORIGINS || '')
        .split(',').map(s => s.trim()).filter(s => s && s !== 'null');
    const list = [...PRODUCTION_ORIGINS, ...extra];
    if (localOriginsAllowed(env)) list.push(...LOCAL_ORIGINS);
    return list;
}

module.exports = { allowedOrigins, localOriginsAllowed, PRODUCTION_ORIGINS, LOCAL_ORIGINS };
