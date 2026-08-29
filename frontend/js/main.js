// ============================================================
// PharmaTrack – main.js
// Global utilities: Auth, Navigation, Sidebar, Toasts, API
// ============================================================

// ── Configuration ─────────────────────────────────────────────
const CONFIG = {
    API_BASE: (() => {
        const host = window.location.hostname;
        // Opened as a local file (file://) or via Live Server
        if (host === 'localhost' || host === '127.0.0.1' || host === '') {
            return 'http://localhost:5000/api';
        }
        // Deployed version
        return '/api';
    })(),
    TOKEN_KEY:     'pharmatrack_token',
    USER_KEY:      'pharmatrack_user',
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
            // Add timeout: abort after 10 seconds
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000);
            config.signal = controller.signal;

            const res  = await fetch(`${CONFIG.API_BASE}${endpoint}`, config);
            clearTimeout(timeoutId);

            if (!res.ok) {
                if (res.status === 401) {
                    // Token expired or invalid — force logout
                    Auth.logout();
                    return null;
                }
                throw new Error(`HTTP ${res.status}: ${res.statusText}`);
            }

            const data = await res.json();
            return data;

        } catch (err) {
            if (err.name === 'AbortError') {
                console.error(`[API Timeout] ${endpoint}: Request took too long`);
                Toast.show('Server not responding. Check your connection.', 'error');
            } else {
                console.error(`[API Error] ${endpoint}:`, err.message);
                Toast.show('Connection error. Check if the server is running.', 'error');
            }
            return null;
        }
    },

    get(endpoint)              { return this.request(endpoint); },
    post(endpoint, body)       { return this.request(endpoint, { method: 'POST',   body: JSON.stringify(body) }); },
    put(endpoint, body)        { return this.request(endpoint, { method: 'PUT',    body: JSON.stringify(body) }); },
    delete(endpoint)           { return this.request(endpoint, { method: 'DELETE' }); },
    patch(endpoint, body)      { return this.request(endpoint, { method: 'PATCH',  body: JSON.stringify(body) }); },

    /**
     * Upload a file (FormData). Does NOT set Content-Type manually;
     * the browser sets it with the correct multipart boundary.
     */
    async upload(endpoint, formData) {
        const token = Auth.getToken();
        const headers = {};
        if (token) headers['Authorization'] = `Bearer ${token}`;

        try {
            const res  = await fetch(`${CONFIG.API_BASE}${endpoint}`, { method: 'POST', headers, body: formData });
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
    getUser()  { return JSON.parse(localStorage.getItem(CONFIG.USER_KEY) || 'null'); },

    saveSession(token, user) {
        localStorage.setItem(CONFIG.TOKEN_KEY, token);
        localStorage.setItem(CONFIG.USER_KEY,  JSON.stringify(user));
    },

    // Merges a partial update (e.g. { name, avatar } after a profile edit)
    // into the locally-stored user object, so the header/sidebar reflect
    // the change immediately without needing to log out and back in --
    // the JWT itself is untouched (still valid, still has the OLD name
    // baked in, which is fine since nothing server-side trusts the JWT's
    // name for anything beyond display convenience).
    updateStoredUser(patch) {
        const user = this.getUser();
        if (!user) return;
        const merged = { ...user, ...patch };
        localStorage.setItem(CONFIG.USER_KEY, JSON.stringify(merged));
        return merged;
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
        const user  = this.getUser();

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

        // Display-only label — the underlying role value stays 'super_admin'
        // everywhere in code/DB/JWT; this only changes what's shown on screen.
        const roleLabel = user.role === 'super_admin' ? 'Owner' : user.role.replace('_', ' ');

        // Header user info
        const nameEl   = document.getElementById('header-user-name');
        const roleEl   = document.getElementById('header-user-role');

        if (nameEl) nameEl.textContent = user.name;
        if (roleEl) roleEl.textContent = roleLabel;

        ProfileNav.renderAvatar(user);
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
     * Also hides an entire section label (e.g. "Management", "Admin") when
     * every role-gated item under it ends up hidden — so a cashier never
     * sees an empty "Admin" heading with nothing accessible underneath.
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

        // Hide section labels whose entire group of role-gated items is hidden.
        // Items with NO data-roles (like "Sign Out") are ignored for this check
        // since they're always visible and shouldn't keep an empty label alive.
        document.querySelectorAll('.nav-section-label').forEach(label => {
            const ul = label.nextElementSibling;
            if (!ul || ul.tagName !== 'UL') return;

            const roleGatedItems = Array.from(ul.children)
                .filter(li => li.classList.contains('nav-item') && li.dataset.roles);

            if (!roleGatedItems.length) return; // nothing role-gated in this group

            const anyVisible = roleGatedItems.some(li => !li.classList.contains('role-hidden'));
            label.style.display = anyVisible ? '' : 'none';
        });
    },

    initMobileToggle() {
        const toggleBtn = document.getElementById('btn-menu-toggle');
        const sidebar   = document.getElementById('sidebar');
        const overlay   = document.getElementById('sidebar-overlay');

        if (!toggleBtn || !sidebar) return;

        toggleBtn.addEventListener('click', () => this.openSidebar());
        overlay?.addEventListener('click',   () => this.closeSidebar());

        sidebar.querySelectorAll('.nav-item a[href]').forEach(link => {
            const href = link.getAttribute('href');
            if (!href || href === '#') return;
            link.addEventListener('click', () => {
                if (window.matchMedia('(max-width: 768px)').matches) {
                    this.closeSidebar();
                }
            });
        });
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
            el.addEventListener('click', async (e) => {
                e.preventDefault();
                const confirmed = await ConfirmDialog.show({
                    title:       'Sign Out',
                    message:     'Are you sure you want to sign out?',
                    confirmText: 'Sign Out'
                });
                if (confirmed) Auth.logout();
            });
        });
    }
};

// ── Confirmation Dialog ──────────────────────────────
// Reusable Yes/No confirmation modal (progressive enhancement — injected
// on first use, so no per-page HTML is needed). Returns a Promise<boolean>.
const ConfirmDialog = {
    ensureModal() {
        if (document.getElementById('confirm-dialog-modal')) return;

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'confirm-dialog-modal';
        overlay.innerHTML = `
            <div class="modal" style="max-width:380px">
                <div class="modal-header">
                    <h3 id="confirm-dialog-title">Are you sure?</h3>
                </div>
                <div class="modal-body">
                    <p id="confirm-dialog-message" style="font-size:0.9rem;color:var(--gray-700);white-space:pre-line"></p>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-light" id="confirm-dialog-cancel">Cancel</button>
                    <button class="btn btn-danger" id="confirm-dialog-ok">Confirm</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);

        // Only the Cancel/Confirm buttons close this now -- see the
        // DOMContentLoaded handler's comment for why backdrop-click was
        // removed everywhere.
    },

    show({ title = 'Are you sure?', message = '', confirmText = 'Confirm', danger = true } = {}) {
        this.ensureModal();
        const overlay = document.getElementById('confirm-dialog-modal');

        document.getElementById('confirm-dialog-title').textContent   = title;
        document.getElementById('confirm-dialog-message').textContent = message;

        const okBtn     = document.getElementById('confirm-dialog-ok');
        const cancelBtn = document.getElementById('confirm-dialog-cancel');
        okBtn.textContent = confirmText;
        okBtn.className   = danger ? 'btn btn-danger' : 'btn btn-primary';

        return new Promise((resolve) => {
            function cleanup(result) {
                overlay.classList.remove('active');
                okBtn.removeEventListener('click', onOk);
                cancelBtn.removeEventListener('click', onCancel);
                resolve(result);
            }
            function onOk()     { cleanup(true); }
            function onCancel() { cleanup(false); }

            okBtn.addEventListener('click', onOk);
            cancelBtn.addEventListener('click', onCancel);

            overlay.classList.add('active');
        });
    }
};

// ── Manager/Owner Approval Dialog ──────────────────────
// Collects an admin/owner's email + password for actions a cashier can't
// authorize alone (e.g. voiding a sale). Returns { email, password } on
// submit, or null if cancelled. Does NOT change the logged-in session —
// it's a one-off approval check, verified server-side per use.
const ManagerApprovalDialog = {
    ensureModal() {
        if (document.getElementById('manager-approval-modal')) return;

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'manager-approval-modal';
        overlay.innerHTML = `
            <div class="modal" style="max-width:380px">
                <div class="modal-header">
                    <h3>🔒 Manager Approval Required</h3>
                </div>
                <div class="modal-body">
                    <p id="manager-approval-message" style="font-size:0.85rem;color:var(--gray-700);margin-bottom:14px"></p>
                    <div class="form-group">
                        <label class="form-label">Admin/Owner Email</label>
                        <input type="email" id="manager-approval-email" class="form-control" autocomplete="off">
                    </div>
                    <div class="form-group" style="margin-top:10px">
                        <label class="form-label">Password</label>
                        <input type="password" id="manager-approval-password" class="form-control" autocomplete="off">
                    </div>
                    <p id="manager-approval-error" style="color:var(--danger);font-size:0.8rem;margin-top:8px;display:none"></p>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-light" id="manager-approval-cancel">Cancel</button>
                    <button class="btn btn-danger" id="manager-approval-ok">Approve</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);

        // Enter key on either field submits
        overlay.querySelectorAll('input').forEach(input => {
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') document.getElementById('manager-approval-ok')?.click();
            });
        });
    },

    show(message = 'This action requires an admin or owner to approve.') {
        this.ensureModal();
        const overlay  = document.getElementById('manager-approval-modal');
        const emailEl  = document.getElementById('manager-approval-email');
        const pwEl     = document.getElementById('manager-approval-password');
        const errEl    = document.getElementById('manager-approval-error');

        document.getElementById('manager-approval-message').textContent = message;
        emailEl.value = '';
        pwEl.value    = '';
        errEl.style.display = 'none';

        return new Promise((resolve) => {
            const okBtn     = document.getElementById('manager-approval-ok');
            const cancelBtn = document.getElementById('manager-approval-cancel');

            function cleanup(result) {
                overlay.classList.remove('active');
                okBtn.removeEventListener('click', onOk);
                cancelBtn.removeEventListener('click', onCancel);
                resolve(result);
            }
            function onOk() {
                const email    = emailEl.value.trim();
                const password = pwEl.value;
                if (!email || !password) {
                    errEl.textContent   = 'Enter both email and password.';
                    errEl.style.display = 'block';
                    return;
                }
                cleanup({ email, password });
            }
            function onCancel() { cleanup(null); }

            okBtn.addEventListener('click', onOk);
            cancelBtn.addEventListener('click', onCancel);

            overlay.classList.add('active');
            setTimeout(() => emailEl.focus(), 50);
        });
    },

    showError(msg) {
        const errEl = document.getElementById('manager-approval-error');
        if (errEl) {
            errEl.textContent   = msg;
            errEl.style.display = 'block';
        }
    }
};

// ── Alert Header Notification Dropdown ──────────────────────────
// Replaces the old pair of static "Low Stock" / "Near Expiry" pills with a
// single bell-style notification button (progressive enhancement — works
// on every page without needing per-page HTML changes). Clicking a category
// navigates to Inventory filtered by that status, but only for roles that
// can actually access Inventory; other roles still see the counts.
const AlertsNav = {
    INVENTORY_ROLES: ['admin', 'super_admin'],

    init() {
        const headerRight = document.querySelector('.header-right');
        if (!headerRight) return;

        // Remove the old static alert pills if present (any page that still
        // has the legacy markup) — we replace them with the dropdown below.
        headerRight.querySelectorAll('.header-alert-btn').forEach(el => el.remove());

        const wrap = document.createElement('div');
        wrap.className = 'notif-wrap';
        wrap.id = 'notif-wrap';
        wrap.innerHTML = `
            <button class="notif-bell-btn" id="notif-bell-btn" type="button" title="Alerts">
                🔔
                <span class="alert-badge" id="notif-total-badge" style="display:none">0</span>
            </button>
            <div class="notif-dropdown hidden" id="notif-dropdown">
                <div class="notif-dropdown-header">Inventory Alerts</div>
                <button class="notif-item" data-status="low_stock">
                    <span>📦 Low Stock</span>
                    <span class="notif-count" id="notif-count-low_stock">0</span>
                </button>
                <button class="notif-item" data-status="expiring">
                    <span>📅 Expiring This Month</span>
                    <span class="notif-count" id="notif-count-expiring">0</span>
                </button>
                <button class="notif-item" data-status="expiring_3mo">
                    <span>🗓️ Expiring in 3 Months</span>
                    <span class="notif-count" id="notif-count-expiring_3mo">0</span>
                </button>
                <button class="notif-item" data-status="expired">
                    <span>🚫 Expired</span>
                    <span class="notif-count" id="notif-count-expired">0</span>
                </button>
                <button class="notif-item" data-status="out_of_stock">
                    <span>❌ Out of Stock</span>
                    <span class="notif-count" id="notif-count-out_of_stock">0</span>
                </button>
            </div>`;

        // Insert before the user info block so it sits to the left of the avatar
        const userBlock = headerRight.querySelector('.header-user');
        headerRight.insertBefore(wrap, userBlock || null);

        // Toggle open/close
        const bellBtn  = document.getElementById('notif-bell-btn');
        const dropdown = document.getElementById('notif-dropdown');
        bellBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            dropdown?.classList.toggle('hidden');
        });
        document.addEventListener('click', (e) => {
            if (!wrap.contains(e.target)) dropdown?.classList.add('hidden');
        });

        // Role-gated navigation on each category item
        const user  = Auth.getUser();
        const canGo = user && this.INVENTORY_ROLES.includes(user.role);
        wrap.querySelectorAll('.notif-item').forEach(item => {
            item.addEventListener('click', () => {
                if (canGo) {
                    window.location.href = `inventory.html?status=${item.dataset.status}`;
                } else {
                    Toast.show("You don't have access to Inventory.", 'warning');
                    dropdown?.classList.add('hidden');
                }
            });
        });
    },

    setCounts({ low_stock = 0, near_expiry = 0, expiring_3mo = 0, expired = 0, out_of_stock = 0 }) {
        const set = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = val;
        };
        set('notif-count-low_stock',    low_stock);
        set('notif-count-expiring',     near_expiry);
        set('notif-count-expiring_3mo', expiring_3mo);
        set('notif-count-expired',      expired);
        set('notif-count-out_of_stock', out_of_stock);

        const total = low_stock + near_expiry + expiring_3mo + expired + out_of_stock;
        const badge = document.getElementById('notif-total-badge');
        if (badge) {
            badge.textContent   = total;
            badge.style.display = total > 0 ? 'flex' : 'none';
        }
    }
};

// ── Profile Dropdown (avatar) ───────────────────
// Wraps the existing .header-user block with a click-to-open dropdown
// (same interaction pattern as the notification bell) containing a dark
// mode toggle and Edit Profile. Progressive enhancement -- works on every
// page without per-page HTML changes.
const ProfileNav = {
    init() {
        const headerRight = document.querySelector('.header-right');
        const userBlock    = document.querySelector('.header-user');
        if (!headerRight || !userBlock || document.getElementById('profile-wrap')) return;

        const wrap = document.createElement('div');
        wrap.className = 'profile-wrap';
        wrap.id = 'profile-wrap';
        userBlock.parentNode.insertBefore(wrap, userBlock);
        wrap.appendChild(userBlock);

        const dropdown = document.createElement('div');
        dropdown.className = 'profile-dropdown hidden';
        dropdown.id = 'profile-dropdown';
        dropdown.innerHTML = `
            <button class="profile-dropdown-item" id="btn-toggle-dark-mode" type="button">
                <span>🌙 <span id="dark-mode-label">Dark Mode</span></span>
                <span class="profile-toggle-track" id="dark-mode-track"><span class="profile-toggle-thumb"></span></span>
            </button>
            <button class="profile-dropdown-item" id="btn-open-edit-profile" type="button">
                ✏️ Edit Profile
            </button>`;
        wrap.appendChild(dropdown);

        userBlock.style.cursor = 'pointer';
        userBlock.addEventListener('click', (e) => {
            e.stopPropagation();
            dropdown.classList.toggle('hidden');
        });
        document.addEventListener('click', (e) => {
            if (!wrap.contains(e.target)) dropdown.classList.add('hidden');
        });

        document.getElementById('btn-toggle-dark-mode')?.addEventListener('click', () => DarkMode.toggle());
        document.getElementById('btn-open-edit-profile')?.addEventListener('click', () => {
            dropdown.classList.add('hidden');
            EditProfileModal.open();
        });

        DarkMode.syncToggleUI();
    },

    // Shows the actual picture if the user has one; otherwise falls back
    // to the original colored-circle-with-initial look.
    renderAvatar(user) {
        const avatarEl = document.getElementById('header-avatar');
        if (!avatarEl) return;
        if (user.avatar) {
            avatarEl.style.backgroundImage    = `url(${user.avatar})`;
            avatarEl.style.backgroundSize     = 'cover';
            avatarEl.style.backgroundPosition = 'center';
            avatarEl.textContent = '';
        } else {
            avatarEl.style.backgroundImage = '';
            avatarEl.textContent = (user.name || '?').charAt(0).toUpperCase();
        }
    }
};

// ── Dark Mode ──────────────────────────────────
// A real, working toggle over the shared building blocks (cards, tables,
// forms, modals, the header) since those are all built from the same
// CSS custom properties -- but this is explicitly a nice-to-have, not an
// exhaustive per-page audit, so a few page-specific hardcoded colors
// (charts, some POS-specific styling) may not fully adapt. Preference
// persists across pages/sessions via localStorage.
const DarkMode = {
    KEY: 'pharmatrack_dark_mode',

    init() {
        const enabled = localStorage.getItem(this.KEY) === '1';
        document.body.classList.toggle('dark-mode', enabled);
    },

    toggle() {
        const enabled = !document.body.classList.contains('dark-mode');
        document.body.classList.toggle('dark-mode', enabled);
        localStorage.setItem(this.KEY, enabled ? '1' : '0');
        this.syncToggleUI();
    },

    syncToggleUI() {
        const track = document.getElementById('dark-mode-track');
        const label = document.getElementById('dark-mode-label');
        const enabled = document.body.classList.contains('dark-mode');
        track?.classList.toggle('active', enabled);
        if (label) label.textContent = enabled ? 'Dark Mode: On' : 'Dark Mode';
    }
};

// ── Edit Profile Modal ──────────────────────
// Name + profile picture. Cashiers can change their picture but not their
// name (field is disabled here, AND enforced again server-side regardless
// of what gets sent -- see authController.js's updateProfile). The picture
// is resized client-side to a small thumbnail via canvas before it's ever
// sent, so the request stays small and the database column doesn't bloat.
const EditProfileModal = {
    pendingAvatar: null,

    ensureModal() {
        if (document.getElementById('edit-profile-modal')) return;

        const user = Auth.getUser();
        const isCashier = user?.role === 'cashier';

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'edit-profile-modal';
        overlay.innerHTML = `
            <div class="modal" style="max-width:380px">
                <div class="modal-header">
                    <h3>✏️ Edit Profile</h3>
                    <button class="btn-close" id="btn-close-edit-profile">✕</button>
                </div>
                <div class="modal-body">
                    <div style="text-align:center;margin-bottom:16px">
                        <div class="edit-profile-avatar-preview" id="edit-profile-avatar-preview"></div>
                        <input type="file" id="edit-profile-avatar-input" accept="image/*" style="display:none">
                        <button class="btn btn-light btn-sm" id="btn-choose-avatar" style="margin-top:10px">Change Picture</button>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Name</label>
                        <input type="text" id="edit-profile-name" class="form-control" ${isCashier ? 'disabled' : ''}>
                        ${isCashier ? '<div style="font-size:0.72rem;color:var(--secondary);margin-top:4px">Only an admin or owner can change your name.</div>' : ''}
                    </div>
                    <p class="error-msg" id="edit-profile-error" aria-live="polite" style="min-height:20px"></p>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-light" id="btn-close-edit-profile-2">Cancel</button>
                    <button class="btn btn-primary" id="btn-save-profile">Save Changes</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);

        document.getElementById('btn-close-edit-profile')?.addEventListener('click', () => Modal.close('edit-profile-modal'));
        document.getElementById('btn-close-edit-profile-2')?.addEventListener('click', () => Modal.close('edit-profile-modal'));

        document.getElementById('btn-choose-avatar')?.addEventListener('click', () => {
            document.getElementById('edit-profile-avatar-input')?.click();
        });

        document.getElementById('edit-profile-avatar-input')?.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            try {
                this.pendingAvatar = await this.resizeImage(file, 200, 200);
                this.setPreview(this.pendingAvatar);
            } catch (err) {
                Toast.show('Could not read that image. Try a different file.', 'error');
            }
        });

        document.getElementById('btn-save-profile')?.addEventListener('click', async () => {
            const btn   = document.getElementById('btn-save-profile');
            const errEl = document.getElementById('edit-profile-error');
            errEl.textContent = '';

            const body = {};
            const currentUser = Auth.getUser();
            if (currentUser?.role !== 'cashier') {
                const name = document.getElementById('edit-profile-name')?.value.trim();
                if (!name) { errEl.textContent = 'Name cannot be empty.'; return; }
                body.name = name;
            }
            if (this.pendingAvatar) body.avatar = this.pendingAvatar;

            btn.disabled = true;
            btn.textContent = 'Saving…';
            const result = await API.put('/auth/profile', body);
            btn.disabled = false;
            btn.textContent = 'Save Changes';

            if (result?.success) {
                Auth.updateStoredUser(result.user);
                Nav.buildUserInfo(); // re-render header/avatar immediately, no re-login needed
                Toast.show('Profile updated.', 'success');
                Modal.close('edit-profile-modal');
                this.pendingAvatar = null;
            } else {
                errEl.textContent = result?.message || 'Could not update profile.';
            }
        });
    },

    setPreview(src) {
        const el = document.getElementById('edit-profile-avatar-preview');
        if (!el) return;
        if (src) {
            el.style.backgroundImage = `url(${src})`;
            el.textContent = '';
        } else {
            el.style.backgroundImage = '';
            el.textContent = (Auth.getUser()?.name || '?').charAt(0).toUpperCase();
        }
    },

    // Downscales an uploaded image to at most maxW x maxH via a canvas,
    // returning a compact JPEG data-URL string -- keeps the request (and
    // the database column) small regardless of how large the original
    // photo was.
    resizeImage(file, maxW, maxH) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(reader.error);
            reader.onload = () => {
                const img = new Image();
                img.onerror = () => reject(new Error('Invalid image'));
                img.onload = () => {
                    let { width, height } = img;
                    const ratio = Math.min(maxW / width, maxH / height, 1);
                    width  = Math.round(width * ratio);
                    height = Math.round(height * ratio);

                    const canvas = document.createElement('canvas');
                    canvas.width  = width;
                    canvas.height = height;
                    canvas.getContext('2d').drawImage(img, 0, 0, width, height);
                    resolve(canvas.toDataURL('image/jpeg', 0.85));
                };
                img.src = reader.result;
            };
            reader.readAsDataURL(file);
        });
    },

    open() {
        this.ensureModal();
        this.pendingAvatar = null; // reset any leftover pick from a previous cancelled visit

        const user = Auth.getUser();
        const nameInput = document.getElementById('edit-profile-name');
        if (nameInput) nameInput.value = user?.name || '';
        this.setPreview(user?.avatar || '');

        Modal.open('edit-profile-modal');
    }
};

// ── Alert Header Badges ──────────────────────────────────────────────────────
async function loadHeaderAlerts() {
    const alertsClient = typeof OfflineAPI !== 'undefined' ? OfflineAPI : API;
    const data = await alertsClient.get('/inventory/alerts/summary');
    if (!data?.success) return;

    AlertsNav.setCounts(data.data);
}

// ── Modal Helpers ──────────────────────────────────────────────
async function downloadAuthenticatedFile(url, fallbackFilename) {
    const token = Auth.getToken();
    try {
        const res = await fetch(url, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
        if (!res.ok) throw new Error('Download failed.');

        const disposition = res.headers.get('Content-Disposition') || '';
        const match = disposition.match(/filename="?([^"]+)"?/);
        const filename = match ? match[1] : fallbackFilename;

        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(objectUrl);
        return true;
    } catch (err) {
        Toast.show('Download failed. Check your connection.', 'error');
        return false;
    }
}

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

// ── Search-as-you-type Suggestions ─────────────────
// A small, reusable autocomplete dropdown -- attach it to any search box
// on a page that already has its full dataset loaded in memory (products,
// users, logs), and it suggests matching items as you type, the same way
// a search engine suggests queries, except scoped to whatever's actually
// on that page instead of the web. Selecting a suggestion just fills the
// box and re-fires its normal 'input' event, so it works with whatever
// filtering logic that page already has -- no page needs to duplicate any
// matching logic here.
const SearchSuggest = {
    attach(inputEl, { getItems, getLabel, getSubLabel = null, maxResults = 8, onSelect = null }) {
        if (!inputEl) return;

        const wrap = document.createElement('div');
        wrap.className = 'search-suggest-wrap';
        inputEl.parentNode.insertBefore(wrap, inputEl);
        wrap.appendChild(inputEl);

        const dropdown = document.createElement('div');
        dropdown.className = 'search-suggest-dropdown hidden';
        wrap.appendChild(dropdown);

        let activeIndex     = -1;
        let currentMatches  = [];

        function esc(str) {
            return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }

        function renderSuggestions(query) {
            const items = getItems() || [];
            const q = query.trim().toLowerCase();

            if (!q) {
                dropdown.classList.add('hidden');
                currentMatches = [];
                return;
            }

            // Same relevance idea used server-side elsewhere in this app --
            // a name that STARTS WITH the typed text ranks above one where
            // it's merely buried in the middle somewhere.
            const starts = [];
            const contains = [];
            items.forEach(item => {
                const label = String(getLabel(item) || '').toLowerCase();
                if (!label) return;
                if (label.startsWith(q)) starts.push(item);
                else if (label.includes(q)) contains.push(item);
            });

            currentMatches = [...starts, ...contains].slice(0, maxResults);
            activeIndex = -1;

            if (!currentMatches.length) {
                dropdown.classList.add('hidden');
                return;
            }

            dropdown.innerHTML = currentMatches.map((item, i) => `
                <button type="button" class="search-suggest-item" data-index="${i}">
                    <span class="search-suggest-label">${esc(getLabel(item))}</span>
                    ${getSubLabel ? `<span class="search-suggest-sub">${esc(getSubLabel(item))}</span>` : ''}
                </button>
            `).join('');

            dropdown.querySelectorAll('.search-suggest-item').forEach(btn => {
                // mousedown (not click) fires BEFORE the input's blur event,
                // so picking a suggestion doesn't get lost to blur closing
                // the dropdown first.
                btn.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    selectItem(currentMatches[parseInt(btn.dataset.index)]);
                });
            });

            dropdown.classList.remove('hidden');
        }

        function selectItem(item) {
            inputEl.value = getLabel(item);
            dropdown.classList.add('hidden');
            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
            if (onSelect) onSelect(item);
        }

        function updateActiveHighlight() {
            dropdown.querySelectorAll('.search-suggest-item').forEach((el, i) => {
                el.classList.toggle('active', i === activeIndex);
            });
        }

        inputEl.addEventListener('input', () => renderSuggestions(inputEl.value));
        inputEl.addEventListener('focus', () => { if (inputEl.value.trim()) renderSuggestions(inputEl.value); });
        inputEl.addEventListener('blur', () => {
            setTimeout(() => dropdown.classList.add('hidden'), 100);
        });

        inputEl.addEventListener('keydown', (e) => {
            if (dropdown.classList.contains('hidden') || !currentMatches.length) return;

            if (e.key === 'ArrowDown') {
                e.preventDefault();
                activeIndex = Math.min(activeIndex + 1, currentMatches.length - 1);
                updateActiveHighlight();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                activeIndex = Math.max(activeIndex - 1, 0);
                updateActiveHighlight();
            } else if (e.key === 'Enter' && activeIndex >= 0) {
                e.preventDefault();
                selectItem(currentMatches[activeIndex]);
            } else if (e.key === 'Escape') {
                dropdown.classList.add('hidden');
            }
        });
    }
};

// ── DOM Ready: Initialise everything ──────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    Toast.init();

    // Only run Nav init on protected pages (pages with a sidebar)
    if (document.getElementById('sidebar')) {
        DarkMode.init();
        Nav.init();
        AlertsNav.init();
        ProfileNav.init();
        loadHeaderAlerts();
    }

    // Modals now only close via their own X/Cancel/Close buttons -- an
    // accidental click on the dimmed background used to close them too,
    // which was easy to trigger by mistake mid-form and lose progress.
});

// ── Repaint safety net for a known Chromium quirk ──────────
// After certain window state changes (minimize → restore), Chromium can
// leave a page's GPU-COMPOSITED layers stale — the underlying layout box
// sizes are actually correct, but the rasterized pixels on screen aren't
// refreshed to match. A layout reflow (recalculating element positions/
// sizes) does NOT fix this, because it's a compositor-level staleness, not
// a layout-level one — only a full page refresh reliably forces Chromium
// to rebuild its composited layers from scratch. This nudges the same
// effect without a reload: a near-invisible opacity change is a well-known
// trick that forces Chromium to recomposite the whole page.
function nudgeRepaint() {
    const body = document.body;
    const prevOpacity = body.style.opacity;
    body.style.opacity = '0.999';
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            body.style.opacity = prevOpacity || '';
        });
    });
}

window.addEventListener('resize', nudgeRepaint);
window.addEventListener('focus', nudgeRepaint);
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') nudgeRepaint();
});
