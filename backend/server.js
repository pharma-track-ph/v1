// ============================================================
// PharmaTrack – Main Server Entry Point
// Node.js + Express.js
// ============================================================
require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const morgan     = require('morgan');
const rateLimit  = require('express-rate-limit');
const path       = require('path');

// Route imports
const authRoutes        = require('./routes/authRoutes');
const inventoryRoutes   = require('./routes/inventoryRoutes');
const posRoutes         = require('./routes/posRoutes');
const reportRoutes      = require('./routes/reportRoutes');
const forecastingRoutes = require('./routes/forecastingRoutes');
const backupRoutes      = require('./routes/backupRoutes');
const publicRoutes      = require('./routes/publicRoutes');
const { scheduleDailyBackup } = require('./utils/backupScheduler');

const app  = express();
const PORT = process.env.PORT || 5000;
const FRONTEND_DIR = path.resolve(__dirname, '../frontend');

// ── Trust proxy (required for Railway) ───────────────────────
app.set('trust proxy', 1);

// ── Security middleware ──────────────────────────────────────
app.use(helmet({
    contentSecurityPolicy: false
}));

// ── CORS ─────────────────────────────────────────────────────
app.use(cors({
    origin: [
        'http://localhost:3000',
        'http://127.0.0.1:3000',
        'http://localhost:5000',
        'http://127.0.0.1:5000',
        'http://localhost:5500',
        'http://127.0.0.1:5500',
        'http://localhost',
        'https://pharma-track-v2.onrender.com',
        'https://pharma-track-ph.onrender.com',
        'null'
    ],
    credentials: true,
    methods: ['GET','POST','PUT','DELETE','PATCH','OPTIONS'],
    allowedHeaders: ['Content-Type','Authorization']
}));

// ── Global rate limiter ──────────────────────────────────────
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 500,
    standardHeaders: true,
    legacyHeaders: false
});
app.use(globalLimiter);

// ── Auth rate limiter (stricter for login) ───────────────────
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { success: false, message: 'Too many login attempts. Try again in 15 minutes.' }
});

// ── Body parsing ─────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── HTTP request logging (dev only) ──────────────────────────
if (process.env.NODE_ENV === 'development') {
    app.use(morgan('dev'));
}

// ── Serve frontend static files ───────────────────────────────
app.use(express.static(FRONTEND_DIR));

// Redirect root to login page.
// IMPORTANT: this must be a real HTTP redirect, not res.sendFile() —
// sendFile() would serve login.html's CONTENT while the browser's address
// bar stays at '/', which breaks every relative link/redirect inside the
// page (e.g. 'pos.html' resolves to '/pos.html' instead of '/pages/pos.html').
app.get('/', (req, res) => {
    res.redirect('/pages/login.html');
});

// ── Static files for uploaded CSVs ───────────────────────────
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ── API Routes ────────────────────────────────────────────────
app.use('/api/auth',        authLimiter, authRoutes);
app.use('/api/inventory',   inventoryRoutes);
app.use('/api/pos',         posRoutes);
app.use('/api/reports',     reportRoutes);
app.use('/api/forecasting', forecastingRoutes);
app.use('/api/backup',      backupRoutes);
app.use('/api/public',      publicRoutes);

// ── Health check ─────────────────────────────────────────────
app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        message: 'PharmaTrack API is running',
        timestamp: new Date().toISOString(),
        version: '1.0.0'
    });
});

// Handle requests for frontend pages (for direct access)
app.get('/pages/:page', (req, res) => {
    const requestedPage = path.basename(req.params.page);

    if (!requestedPage.endsWith('.html')) {
        return res.status(404).json({ success: false, message: 'Page not found.' });
    }

    res.sendFile(path.join('pages', requestedPage), { root: FRONTEND_DIR }, (err) => {
        if (err) res.status(404).json({ success: false, message: 'Page not found.' });
    });
});

// ── 404 handler ───────────────────────────────────────────────
app.use((req, res) => {
    res.status(404).json({ success: false, message: `Route ${req.originalUrl} not found` });
});

// ── Global error handler ──────────────────────────────────────
app.use((err, req, res, next) => {
    console.error('[ERROR]', err.stack);

    const statusCode = err.statusCode || 500;

    // Only pass the real error message through to the client for errors
    // that were deliberately thrown with a safe, user-facing message
    // (statusCode < 500 -- validation/business-rule errors like "Cannot
    // modify your own account here."). Anything else -- an unexpected
    // exception, a DB connection failure, etc. -- can contain internal
    // details (hostnames, SQL, stack info) that should never reach the
    // client. Those get a generic message instead; the real detail is
    // already in the server log line above for debugging.
    const safeMessage = (statusCode < 500 && err.message)
        ? err.message
        : 'Something went wrong. Please try again.';

    res.status(statusCode).json({
        success: false,
        message: safeMessage,
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    });
});

// ── Start server ──────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`✅  PharmaTrack API running on http://localhost:${PORT}`);
    console.log(`    Frontend:    http://localhost:${PORT}/pages/login.html`);
    console.log(`    Health:      http://localhost:${PORT}/api/health`);
    console.log(`    Environment: ${process.env.NODE_ENV}`);

    scheduleDailyBackup();
});

module.exports = app;
