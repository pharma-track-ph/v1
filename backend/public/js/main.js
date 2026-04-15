// ============================================================
// PharmaTrack – main.js
// Global utilities: Auth, Navigation, Sidebar, Toasts, API
// ============================================================

// ── Configuration ─────────────────────────────────────────────
const CONFIG = {
    API_BASE:      window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
        ? 'http://localhost:5000/api'
        : '/api',
    TOKEN_KEY: 'pharmatrack_token',
    USER_KEY: 'pharmatrack_user',
    TOAST_TIMEOUT: 4000
};

// ── API Client ─────────────────────────────────────────────────
const API = {
    /**
     * Generic fetch wrapper that attaches the JWT Authorization header
     * and handles common error responses.
     */
    async request(endpoint, options = {}) {
        const token = Auth.getToken();
        const defaultHeaders = { 'Content-Type': 'application/json' };

        if (token) {
            defaultHeaders['Authorization'] = `Bearer ${token}`;
        }

        const config = {
            ...options,
            headers: { ...defaultHeaders, ...options.headers }
        };

        try {
            const res = await fetch(`${CONFIG.API_BASE}${endpoint}`, config);
            const data = await res.json();

            if (res.status === 401) {
                // Token expired or invalid — force logout
                Auth.logout();
                return null;
            }

            return data;

        } catch (err) {
            console.error(`[API Error] ${endpoint}:`, err);
            Toast.show('Connection error. Check if the server is running.', 'error');
            return null;
        }
    },

    get(endpoint) { return this.request(endpoint); },
    post(endpoint, body) { return this.request(endpoint, { method: 'POST', body: JSON.stringify(body) }); },
    put(endpoint, body) { return this.request(endpoint, { method: 'PUT', body: JSON.stringify(body) }); },
    delete(endpoint) { return this.request(endpoint, { method: 'DELETE' }); },
    patch(endpoint, body) { return this.request(endpoint, { method: 'PATCH', body: JSON.stringify(body) }); },

    /**
     * Upload a file (FormData). Does NOT set Content-Type manually;
     * the browser sets it with the correct multipart boundary.
     */
    async upload(endpoint, formData) {
        const token = Auth.getToken();
        const headers = {};
        if (token) headers['Authorization'] = `Bearer ${token}`;

        try {
            const res = await fetch(`${CONFIG.API_BASE}${endpoint}`, { method: 'POST', headers, body: formData });
            return await res.json();
        } catch (err) {
            console.error('[Upload Error]:', err);
            Toast.show('Upload failed.', 'error');
            return null;
        }
    }
};

// ── Auth Module ────────────────────────────────────────────────
const Auth = {
    getToken() { return localStorage.getItem(CONFIG.TOKEN_KEY); },
    getUser() { return JSON.parse(localStorage.getItem(CONFIG.USER_KEY) || 'null'); },

    saveSession(token, user) {
        localStorage.setItem(CONFIG.TOKEN_KEY, token);
        localStorage.setItem(CONFIG.USER_KEY, JSON.stringify(user));
    },

    logout() {
        localStorage.removeItem(CONFIG.TOKEN_KEY);
        localStorage.removeItem(CONFIG.USER_KEY);
        window.location.href = '../pages/login.html';
    },

    /**
     * Guard function — call on every protected page.
     * Redirects to login if no token; enforces role constraints.
     *
     * @param {string[]} allowedRoles - roles permitted on this page
     */
    requireAuth(allowedRoles = []) {
        const token = this.getToken();
        const user = this.getUser();

        if (!token || !user) {
            window.location.href = '../pages/login.html';
            return false;
        }

        if (allowedRoles.length && !allowedRoles.includes(user.role)) {
            // Redirect cashiers trying to access admin pages
            if (user.role === 'cashier') {
                window.location.href = '../pages/pos.html';
            } else {
                window.location.href = '../pages/dashboard.html';
            }
            return false;
        }

        return true;
    },

    /**
     * Returns true if the current user has at least the given role level.
     * Hierarchy: cashier < admin < super_admin
     */
    hasRole(minRole) {
        const hierarchy = { cashier: 0, admin: 1, super_admin: 2 };
        const user = this.getUser();
        if (!user) return false;
        return hierarchy[user.role] >= hierarchy[minRole];
    }
};

// ── Toast Notification System ──────────────────────────────────
const Toast = {
    container: null,

    init() {
        this.container = document.getElementById('toast-container');
        if (!this.container) {
            this.container = document.createElement('div');
            this.container.id = 'toast-container';
            this.container.className = 'toast-container';
            document.body.appendChild(this.container);
        }
    },

    /**
     * show(message, type, title)
     * @param {string} message
     * @param {'success'|'error'|'warning'|'info'} type
     * @param {string} [title]
     */
    show(message, type = 'info', title = '') {
        if (!this.container) this.init();

        const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
        const defaultTitles = { success: 'Success', error: 'Error', warning: 'Warning', info: 'Notice' };

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.innerHTML = `
            <span class="toast-icon">${icons[type] || icons.info}</span>
            <div>
                <div class="toast-title">${title || defaultTitles[type]}</div>
                <div class="toast-message">${message}</div>
            </div>
        `;

        this.container.appendChild(toast);

        // Auto-remove after animation completes (4 seconds)
        setTimeout(() => {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
        }, CONFIG.TOAST_TIMEOUT);
    }
};

// ── Philippine Peso Formatter ──────────────────────────────────
const Fmt = {
    /**
     * currency(value) → "₱1,234.50"
     */
    currency(value) {
        return '₱' + parseFloat(value || 0).toLocaleString('en-PH', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        });
    },

    /**
     * date(dateStr) → "Mar 15, 2024"
     * Accepts ISO date string or Date object.
     * Always displays in Philippines timezone (UTC+8)
     */
    date(dateStr) {
        if (!dateStr) return '—';
        const d = new Date(dateStr);
        return d.toLocaleDateString('en-PH', {
            year: 'numeric',
            month: 'short',
            day: '2-digit',
            timeZone: 'Asia/Manila'
        });
    },

    /**
     * datetime(dateStr) → "Mar 15, 2024, 2:30 PM"
     * Always displays in Philippines timezone (UTC+8)
     */
    datetime(dateStr) {
        if (!dateStr) return '—';
        const d = new Date(dateStr);
        return d.toLocaleDateString('en-PH', {
            year: 'numeric',
            month: 'short',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: true,
            timeZone: 'Asia/Manila'
        });
    }
};

// ── Sidebar Navigation ─────────────────────────────────────────
const Nav = {
    init() {
        this.buildUserInfo();
        this.highlightActive();
        this.applyRoleVisibility();
        this.initMobileToggle();
        this.initLogout();
    },

    buildUserInfo() {
        const user = Auth.getUser();
        if (!user) return;

        // Header user info
        const nameEl = document.getElementById('header-user-name');
        const roleEl = document.getElementById('header-user-role');
        const avatarEl = document.getElementById('header-avatar');

        if (nameEl) nameEl.textContent = user.name;
        if (roleEl) roleEl.textContent = user.role.replace('_', ' ');
        if (avatarEl) avatarEl.textContent = user.name.charAt(0).toUpperCase();

        // Sidebar footer
        const sfName = document.getElementById('sidebar-user-name');
        const sfRole = document.getElementById('sidebar-user-role');
        if (sfName) sfName.textContent = user.name;
        if (sfRole) sfRole.textContent = user.role.replace('_', ' ');
    },

    highlightActive() {
        const currentFile = window.location.pathname.split('/').pop();
        document.querySelectorAll('.nav-item a').forEach(link => {
            const href = link.getAttribute('href') || '';
            const linkFile = href.split('/').pop();
            if (linkFile === currentFile) {
                link.closest('.nav-item').classList.add('active');
            }
        });
    },

    /**
     * Hide/show sidebar links based on the logged-in user's role.
     * nav-items use data-roles attribute: e.g. data-roles="admin,super_admin"
     */
    applyRoleVisibility() {
        const user = Auth.getUser();
        if (!user) return;

        document.querySelectorAll('.nav-item[data-roles]').forEach(item => {
            const roles = item.dataset.roles.split(',').map(r => r.trim());
            if (!roles.includes(user.role)) {
                item.classList.add('role-hidden');
            }
        });
    },

    initMobileToggle() {
        const toggleBtn = document.getElementById('btn-menu-toggle');
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('sidebar-overlay');

        if (!toggleBtn || !sidebar) return;

        toggleBtn.addEventListener('click', () => this.openSidebar());
        overlay?.addEventListener('click', () => this.closeSidebar());
    },

    openSidebar() {
        document.getElementById('sidebar')?.classList.add('open');
        document.getElementById('sidebar-overlay')?.classList.add('active');
    },

    closeSidebar() {
        document.getElementById('sidebar')?.classList.remove('open');
        document.getElementById('sidebar-overlay')?.classList.remove('active');
    },

    initLogout() {
        document.querySelectorAll('[data-action="logout"]').forEach(el => {
            el.addEventListener('click', (e) => {
                e.preventDefault();
                Auth.logout();
            });
        });
    }
};

// ── Alert Header Badges ────────────────────────────────────────
async function loadHeaderAlerts() {
    const data = await API.get('/inventory/alerts/summary');
    if (!data?.success) return;

    const { low_stock, near_expiry } = data.data;

    const lowBadge = document.getElementById('badge-low-stock');
    const exprBadge = document.getElementById('badge-near-expiry');

    if (lowBadge) {
        lowBadge.textContent = low_stock;
        lowBadge.style.display = low_stock > 0 ? 'flex' : 'none';
    }
    if (exprBadge) {
        exprBadge.textContent = near_expiry;
        exprBadge.style.display = near_expiry > 0 ? 'flex' : 'none';
    }
}

// ── Modal Helpers ──────────────────────────────────────────────
const Modal = {
    open(id) {
        document.getElementById(id)?.classList.add('active');
    },
    close(id) {
        document.getElementById(id)?.classList.remove('active');
    },
    closeAll() {
        document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active'));
    }
};

// ── DOM Ready: Initialise everything ──────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    Toast.init();

    // Only run Nav init on protected pages (pages with a sidebar)
    if (document.getElementById('sidebar')) {
        Nav.init();
        loadHeaderAlerts();
    }

    // Close modal when clicking overlay background
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) Modal.close(overlay.id);
        });
    });
});
