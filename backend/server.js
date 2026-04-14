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

const app  = express();
const PORT = process.env.PORT || 5000;

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
// 'public' folder = copy of frontend/ inside backend/ for Railway
app.use(express.static(path.join(__dirname, 'public')));

// Redirect root to login page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/pages/login.html'));
});

// ── Static files for uploaded CSVs ───────────────────────────
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ── API Routes ────────────────────────────────────────────────
app.use('/api/auth',        authLimiter, authRoutes);
app.use('/api/inventory',   inventoryRoutes);
app.use('/api/pos',         posRoutes);
app.use('/api/reports',     reportRoutes);
app.use('/api/forecasting', forecastingRoutes);

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
    const filePath = path.join(__dirname, 'public', 'pages', req.params.page);
    res.sendFile(filePath, (err) => {
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
    res.status(err.statusCode || 500).json({
        success: false,
        message: err.message || 'Internal server error',
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    });
});

// ── Start server ──────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`✅  PharmaTrack API running on http://localhost:${PORT}`);
    console.log(`    Frontend:    http://localhost:${PORT}/pages/login.html`);
    console.log(`    Health:      http://localhost:${PORT}/api/health`);
    console.log(`    Environment: ${process.env.NODE_ENV}`);
});

module.exports = app;
