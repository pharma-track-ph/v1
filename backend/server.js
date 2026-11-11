// PharmaTrack - Main Server Entry Point - Node.js + Express.js
require('dotenv').config();

// Render's containers only have IPv4 outbound routing
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

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
const { scheduleDailyBackup } = require('./utils/backupScheduler');
const { allowedOrigins }      = require('./utils/corsOrigins');

const app  = express();
const PORT = process.env.PORT || 5000;
const FRONTEND_DIR = path.resolve(__dirname, '../frontend');

// Trust proxy (required for Railway)
app.set('trust proxy', 1);

// Security middleware
app.use(helmet({
    contentSecurityPolicy: false
}));

// CORS - Only the real PharmaTrack addresses in production
app.use(cors({
    origin: allowedOrigins(),
    credentials: true,
    methods: ['GET','POST','PUT','DELETE','PATCH','OPTIONS'],
    allowedHeaders: ['Content-Type','Authorization']
}));

// Global rate limiter
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 500,
    standardHeaders: true,
    legacyHeaders: false
});
app.use(globalLimiter);

// Auth rate limiter (stricter for login) - The login / password-reset limits now sit...

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// HTTP request logging (dev only)
if (process.env.NODE_ENV === 'development') {
    app.use(morgan('dev'));
}

// Serve frontend static files
app.use(express.static(FRONTEND_DIR));

// Redirect root to login: a real redirect (not sendFile) keeps relative links working
app.get('/', (req, res) => {
    res.redirect('/pages/login.html');
});

// ...

// API Routes
app.use('/api/auth',        authRoutes);
app.use('/api/inventory',   inventoryRoutes);
app.use('/api/pos',         posRoutes);
app.use('/api/reports',     reportRoutes);
app.use('/api/forecasting', forecastingRoutes);
app.use('/api/backup',      backupRoutes);

// Health check
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

// 404 handler
app.use((req, res) => {
    res.status(404).json({ success: false, message: `Route ${req.originalUrl} not found` });
});

// Global error handler
app.use((err, req, res, next) => {
    console.error('[ERROR]', err.stack);

    const statusCode = err.statusCode || 500;

    // Only pass the real error message through to the client for errors that were...
    const reason = (statusCode >= 500 && typeof err.code === 'string' && /^[A-Z0-9_]{3,40}$/.test(err.code))
        ? err.code
        : null;

    const safeMessage = (statusCode < 500 && err.message)
        ? err.message
        : `Something went wrong. Please try again.${reason ? ` (${reason})` : ''}`;

    res.status(statusCode).json({
        success: false,
        message: safeMessage,
        ...(reason && { code: reason }),
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`✅  PharmaTrack API running on http://localhost:${PORT}`);
    console.log(`    Frontend:    http://localhost:${PORT}/pages/login.html`);
    console.log(`    Health:      http://localhost:${PORT}/api/health`);
    console.log(`    Environment: ${process.env.NODE_ENV}`);

    scheduleDailyBackup();
});

module.exports = app;
