// PharmaTrack - main.js
// Global utilities: Auth, Navigation, Sidebar, Toasts, API

// Configuration
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

// API Client
const API = {
    /** Generic fetch wrapper that attaches the JWT Authorization header... */
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

            // Parsed regardless of status
            let data = null;
            try { data = await res.json(); } catch (e) { /* not JSON - data stays null */ }

            if (res.status === 401) {
                // Token expired/invalid/deactivated
                Auth.logout(data?.message || 'Your session expired. Please log in again.');
                return null;
            }

            if (!res.ok) {
                // A real HTTP error, but WITH a parsed body
                return data || { success: false, message: `HTTP ${res.status}: ${res.statusText}` };
            }

            return data;

        } catch (err) {
            // A GENUINE network-level failure
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

    /** Upload a file (FormData). */
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

// Auth Module
const Auth = {
    getToken() { return localStorage.getItem(CONFIG.TOKEN_KEY); },
    getUser()  { return JSON.parse(localStorage.getItem(CONFIG.USER_KEY) || 'null'); },

    saveSession(token, user) {
        localStorage.setItem(CONFIG.TOKEN_KEY, token);
        localStorage.setItem(CONFIG.USER_KEY,  JSON.stringify(user));
    },

    // Merges a partial update (e.g. { name, avatar } after a profile edit)...
    updateStoredUser(patch) {
        const user = this.getUser();
        if (!user) return;
        const merged = { ...user, ...patch };
        localStorage.setItem(CONFIG.USER_KEY, JSON.stringify(merged));
        return merged;
    },

    logout(reason) {
        localStorage.removeItem(CONFIG.TOKEN_KEY);
        localStorage.removeItem(CONFIG.USER_KEY);
        // The POS category filter is remembered per browser tab
        try { sessionStorage.removeItem('pharmatrack_pos_category'); } catch (e) { /* nothing to clear */ }
        // sessionStorage (not a URL param) since this needs to survive exactly one...
        if (reason) sessionStorage.setItem('pharmatrack_logout_reason', reason);
        window.location.href = '../pages/login.html';
    },

    /** Guard function - call on every protected page. */
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

    /** Returns true if the current user has at least the given role level. */
    hasRole(minRole) {
        const hierarchy = { cashier: 0, admin: 1, super_admin: 2 };
        const user = this.getUser();
        if (!user) return false;
        return hierarchy[user.role] >= hierarchy[minRole];
    }
};

// Toast Notification System
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

    /** show(message, type, title) */
    show(message, type = 'info', title = '') {
        if (!this.container) this.init();

        const defaultTitles = { success: 'Success', error: 'Error', warning: 'Warning', info: 'Notice' };

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;

        // TEXT only, never HTML: a message can carry names typed by people
        const titleEl = document.createElement('div');
        titleEl.className   = 'toast-title';
        titleEl.textContent = title || defaultTitles[type];

        const messageEl = document.createElement('div');
        messageEl.className   = 'toast-message';
        messageEl.textContent = message == null ? '' : String(message);

        const body = document.createElement('div');
        body.append(titleEl, messageEl);
        toast.appendChild(body);

        this.container.appendChild(toast);

        // Auto-remove after animation completes (4 seconds)
        setTimeout(() => {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
        }, CONFIG.TOAST_TIMEOUT);
    }
};

// Philippine Peso Formatter
const Fmt = {
    /** currency(value) -> "₱1,234.50" */
    currency(value) {
        return '₱' + parseFloat(value || 0).toLocaleString('en-PH', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        });
    },

    /** date(dateStr) -> "Mar 15, 2024" - Accepts ISO date string or Date object. */
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

    /** datetime(dateStr) -> "Mar 15, 2024, 2:30 PM" - Always displays in... */
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

// Sidebar Navigation
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

        // Display-only label
        const roleLabelText = roleLabel(user.role);

        // Header user info
        const nameEl   = document.getElementById('header-user-name');
        const roleEl   = document.getElementById('header-user-role');

        if (nameEl) nameEl.textContent = user.name;
        if (roleEl) roleEl.textContent = roleLabelText;

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

    /** Hide/show sidebar links based on the logged-in user's role. nav-items use... */
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
            el.addEventListener('click', (e) => {
                e.preventDefault();
                handleSignOut();   // the whole flow is below...
            });
        });
    }
};

// Sign out (with the register check) - 1) ask the server "may this person sign out?"

// Talks to the server directly instead of through API.request, so a refusal
async function signOutRequest(method, path) {
    const token      = Auth.getToken();
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), 8000);
    try {
        const res = await fetch(`${CONFIG.API_BASE}${path}`, {
            method,
            headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            signal:  controller.signal
        });
        let data = null;
        try { data = await res.json(); } catch (e) { /* not JSON */ }
        return { reachable: true, status: res.status, data };
    } catch (e) {
        return { reachable: false };
    } finally {
        clearTimeout(timer);
    }
}

async function handleSignOut() {
    // a one-button notice (a refusal the person only needs to read)
    const notice = (title, content) => ConfirmDialog.show({
        title, ...content, confirmText: 'OK', severity: 'warning', hideCancel: true
    });

    const registerOpenContent = (data) => {
        const s = data?.session;
        return { html:
            `<div class="dlg-alert warn" style="margin-top:0">Your register is still open.</div>
             <p class="dlg-text" style="margin-top:12px">Close it before you sign out, so the cash drawer is counted and recorded. Open <strong>Point of Sale</strong> and press <strong>Close Register</strong>.</p>
             ${s ? `<div class="dlg-lead"><div><div class="dlg-label">Opened</div><div>${Fmt.datetime(s.opened_at)}</div></div><div style="text-align:right"><div class="dlg-label">Opening cash</div><div>${Fmt.currency(s.opening_cash)}</div></div></div>` : ''}` };
    };

    // Reads a server reply.
    const mayContinue = async (r) => {
        if (!r.reachable) {
            await notice('Cannot Sign Out Right Now', { message: "Can't check your register right now. Sign out is unavailable until the connection returns." });
            return false;
        }
        if (r.status === 401) { Auth.logout(r.data?.message || 'Your session expired. Please log in again.'); return false; }
        if (r.status === 409 && r.data?.reason === 'register_open') {
            await notice('Close Your Register First', registerOpenContent(r.data));
            return false;
        }
        if (r.status >= 200 && r.status < 300 && r.data?.success) return true;
        await notice('Cannot Sign Out Right Now', { message: r.data?.message || 'Something went wrong. Please try again.' });
        return false;
    };

    // 1) may they sign out?
    if (!(await mayContinue(await signOutRequest('GET', '/auth/sign-out-check')))) return;

    // 2) typed CONFIRM.
    const left   = await OfflineLeftovers.count(Auth.getUser()?.id);
    const unsent = left.sales + left.changes;
    let html = null;
    if (unsent > 0) {
        const parts = [];
        if (left.sales)   parts.push(`<strong>${left.sales} sale${left.sales === 1 ? '' : 's'}</strong>`);
        if (left.changes) parts.push(`<strong>${left.changes} change${left.changes === 1 ? '' : 's'}</strong>`);
        html = `<div class="dlg-alert warn" style="margin-top:0">You have ${parts.join(' and ')} that ${unsent === 1 ? 'has' : 'have'} <strong>not reached the server yet</strong>.</div>
                <p style="margin:12px 0">If you sign out now they stay on this computer and are only sent after <strong>you</strong> sign in here again, with an internet connection. Until then they are missing from the reports, and ${left.sales ? 'the register cannot be closed with sales still waiting.' : 'other computers will not see them.'}</p>
                <div class="dlg-alert info">Better: stay signed in, make sure you are online, and wait for the "waiting to sync" or "Pending Sales" note to disappear.</div>`;
    }
    const confirmed = await TypedConfirm.show({
        title:        unsent > 0 ? 'Unsent Work on This Computer' : 'Sign Out',
        message:      'Are you sure you want to sign out?',
        html,
        confirmText:  unsent > 0 ? 'Sign Out Anyway' : 'Sign Out',
        severity:     'warning',
        finalMessage: unsent > 0
            ? 'Your unsent work stays on this computer until you sign in here again.'
            : 'You will be signed out of this computer.'
    });
    if (!confirmed) return;

    // 3) the server checks the register AGAIN (it may have been opened in another...
    if (!(await mayContinue(await signOutRequest('POST', '/auth/logout')))) return;
    Auth.logout();
}

// What is still waiting on THIS computer - Offline sales and changes are kept...
const OfflineLeftovers = {
    async count(userId) {
        const none = { sales: 0, changes: 0 };
        if (typeof indexedDB === 'undefined') return none;
        return new Promise((resolve) => {
            let request;
            try { request = indexedDB.open('pharmatrack_offline'); } catch (e) { return resolve(none); }
            // never create the database just to look: if it does not exist yet, cancel
            request.onupgradeneeded = (ev) => { try { ev.target.transaction.abort(); } catch (e) { /* nothing to cancel */ } };
            request.onerror   = () => resolve(none);
            request.onblocked = () => resolve(none);
            request.onsuccess = () => {
                const db = request.result;
                const done = (value) => { try { db.close && db.close(); } catch (e) { /* ignore */ } resolve(value); };
                try {
                    if (!db.objectStoreNames.contains('sync_queue')) return done(none);
                    const getAll = db.transaction(['sync_queue'], 'readonly').objectStore('sync_queue').getAll();
                    getAll.onerror   = () => done(none);
                    getAll.onsuccess = () => {
                        let sales = 0, changes = 0;
                        for (const item of getAll.result || []) {
                            if (String(item.endpoint || '').startsWith('/pos/checkout')) {
                                // a sale belongs to whoever rang it up
                                const owner = item.meta?.cashier_id;
                                if (owner == null || owner === userId) sales++;
                            } else {
                                changes++;
                            }
                        }
                        done({ sales, changes });
                    };
                } catch (e) { done(none); }
            };
        });
    }
};

// Confirmation Dialog - Reusable Yes/No confirmation modal
const ConfirmDialog = {
    // The button for each severity: info = blue, success = green, warning = amber
    BUTTON_CLASS: {
        info:    'btn btn-primary',
        success: 'btn btn-success',
        warning: 'btn btn-warning',
        danger:  'btn btn-danger'
    },

    resolveSeverity(severity, danger = true) {
        return this.BUTTON_CLASS[severity] ? severity : (danger ? 'danger' : 'info');
    },

    applySeverity(box, severity) {
        if (!box) return;
        Object.keys(this.BUTTON_CLASS).forEach(s => box.classList.remove(`modal-sev-${s}`));
        box.classList.add(`modal-sev-${severity}`);
    },

    ensureModal() {
        if (document.getElementById('confirm-dialog-modal')) return;

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'confirm-dialog-modal';
        overlay.innerHTML = `
            <div class="modal modal-sev modal-dlg modal-sev-danger">
                <div class="modal-header">
                    <h3 id="confirm-dialog-title">Are you sure?</h3>
                </div>
                <div class="modal-body">
                    <div id="confirm-dialog-message"></div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-light" id="confirm-dialog-cancel">Cancel</button>
                    <button class="btn btn-danger" id="confirm-dialog-ok">Confirm</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);

        // Only the Cancel/Confirm buttons close this now
    },

    // Plain text -> readable paragraphs and bullet lists
    formatMessage(text) {
        const esc = (s) => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
        const isBullet = (l) => /^[\u2022*-]\s+/.test(l);
        const out = [];

        String(text ?? '').split(/\n\s*\n/).forEach(block => {
            let para = [], list = [];
            const flushPara = () => { if (para.length) { out.push(`<p class="dlg-text">${para.map(esc).join('<br>')}</p>`); para = []; } };
            const flushList = () => { if (list.length) { out.push(`<ul class="dlg-list">${list.map(l => `<li>${esc(l.replace(/^[\u2022*-]\s+/, ''))}</li>`).join('')}</ul>`); list = []; } };

            block.split('\n').map(l => l.trim()).filter(Boolean).forEach(line => {
                if (isBullet(line)) { flushPara(); list.push(line); }
                else                { flushList(); para.push(line); }
            });
            flushPara();
            flushList();
        });
        return out.join('');
    },

    // `html` (optional) replaces the plain-text message with prepared markup
    show({ title = 'Are you sure?', message = '', html = null, confirmText = 'Confirm', danger = true, severity = null, hideCancel = false } = {}) {
        this.ensureModal();
        const overlay = document.getElementById('confirm-dialog-modal');
        const sev     = this.resolveSeverity(severity, danger);

        document.getElementById('confirm-dialog-title').textContent = title;
        document.getElementById('confirm-dialog-message').innerHTML = html !== null ? html : this.formatMessage(message);
        this.applySeverity(overlay.querySelector('.modal'), sev);

        const okBtn     = document.getElementById('confirm-dialog-ok');
        const cancelBtn = document.getElementById('confirm-dialog-cancel');
        cancelBtn.style.display = hideCancel ? 'none' : '';
        okBtn.textContent = confirmText;
        okBtn.className   = this.BUTTON_CLASS[sev];

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

            Modal.bringToFront(overlay);
            overlay.classList.add('active');
        });
    }
};

// Typed Confirm (two steps) - ONE component for every destructive or sensitive action
const TypedConfirm = {
    WORD: 'CONFIRM',

    ensureModal() {
        if (document.getElementById('typed-confirm-modal')) return;

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'typed-confirm-modal';
        overlay.innerHTML = `
            <div class="modal modal-sev modal-dlg modal-sev-danger">
                <div class="modal-header">
                    <h3 id="typed-confirm-title">Are you sure?</h3>
                </div>
                <div class="modal-body">
                    <div id="typed-confirm-message"></div>
                    <div class="form-group" style="margin-top:14px;margin-bottom:0">
                        <label class="form-label" for="typed-confirm-input">Type <strong>CONFIRM</strong> in capital letters to continue</label>
                        <input type="text" id="typed-confirm-input" class="form-control" autocomplete="off"
                               autocapitalize="characters" spellcheck="false" placeholder="CONFIRM">
                        <p class="typed-hint" id="typed-confirm-hint"></p>
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-light" id="typed-confirm-cancel">Cancel</button>
                    <button class="btn btn-danger" id="typed-confirm-ok" disabled>Delete</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
    },

    async show({ title = 'Are you sure?', message = '', html = null, confirmText = 'Delete', danger = true,
                severity = null, finalMessage = 'This cannot be undone.' } = {}) {
        const sev = ConfirmDialog.resolveSeverity(severity, danger);

        // Step 1: the ordinary confirmation popup
        const first = await ConfirmDialog.show({ title, message, html, confirmText: 'Continue', danger, severity: sev });
        if (!first) return false;

        // Step 2: type the word to enable the final button
        this.ensureModal();
        const overlay   = document.getElementById('typed-confirm-modal');
        const input     = document.getElementById('typed-confirm-input');
        const okBtn     = document.getElementById('typed-confirm-ok');
        const cancelBtn = document.getElementById('typed-confirm-cancel');
        const hint      = document.getElementById('typed-confirm-hint');

        document.getElementById('typed-confirm-title').textContent = title;
        document.getElementById('typed-confirm-message').innerHTML = ConfirmDialog.formatMessage(finalMessage);
        ConfirmDialog.applySeverity(overlay.querySelector('.modal'), sev);
        okBtn.textContent = confirmText;
        okBtn.className   = ConfirmDialog.BUTTON_CLASS[sev];
        okBtn.disabled    = true;
        input.value       = '';
        hint.textContent  = '';

        return new Promise((resolve) => {
            // EXACT match: only the capitals count, spaces around the word are ignored
            const matches  = () => input.value.trim() === TypedConfirm.WORD;
            // right letters but wrong capitals ("confirm") -> say
            const nearMiss = () => !matches() && input.value.trim().toUpperCase() === TypedConfirm.WORD;

            function cleanup(result) {
                overlay.classList.remove('active');
                input.removeEventListener('input', onInput);
                input.removeEventListener('keydown', onKey);
                okBtn.removeEventListener('click', onOk);
                cancelBtn.removeEventListener('click', onCancel);
                input.value = '';
                hint.textContent = '';
                resolve(result);
            }
            function onInput()  {
                okBtn.disabled   = !matches();
                hint.textContent = nearMiss() ? 'Almost. It must be in capital letters: CONFIRM' : '';
            }
            function onKey(e)  { if (e.key === 'Enter' && matches()) { e.preventDefault(); cleanup(true); } }
            function onOk()    { if (matches()) cleanup(true); }
            function onCancel() { cleanup(false); }

            input.addEventListener('input', onInput);
            input.addEventListener('keydown', onKey);
            okBtn.addEventListener('click', onOk);
            cancelBtn.addEventListener('click', onCancel);

            Modal.bringToFront(overlay);
            overlay.classList.add('active');
            setTimeout(() => input.focus(), 50);
        });
    }
};

// Manager/Owner Approval Dialog - Collects an admin/owner's email + password...
const ManagerApprovalDialog = {
    ensureModal() {
        if (document.getElementById('manager-approval-modal')) return;

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'manager-approval-modal';
        overlay.innerHTML = `
            <div class="modal modal-sev modal-dlg modal-sev-warning">
                <div class="modal-header">
                    <h3>Manager Approval Required</h3>
                </div>
                <div class="modal-body">
                    <p id="manager-approval-message" class="dlg-text"></p>
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
                    <button class="btn btn-warning" id="manager-approval-ok">Approve</button>
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

            Modal.bringToFront(overlay);
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

// Alert Header Notification Dropdown - Replaces the old pair of static "Low Stock" /...
const AlertsNav = {
    INVENTORY_ROLES: ['admin', 'super_admin'],

    init() {
        const headerRight = document.querySelector('.header-right');
        if (!headerRight) return;

        // Remove the old static alert pills if present
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

// Profile Dropdown (avatar) - Wraps the existing .header-user block...
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

    // Shows the actual picture if the user has one
    renderAvatar(user) {
        const avatarEl = document.getElementById('header-avatar');
        if (!avatarEl) return;
        const avatarUrl = ProfileNav.safeAvatarUrl(user.avatar);
        if (avatarUrl) {
            avatarEl.style.backgroundImage    = `url(${avatarUrl})`;
            avatarEl.style.backgroundSize     = 'cover';
            avatarEl.style.backgroundPosition = 'center';
            avatarEl.textContent = '';
        } else {
            avatarEl.style.backgroundImage = '';
            avatarEl.textContent = (user.name || '?').charAt(0).toUpperCase();
        }
    },

    // A picture is only ever used when it is a small PNG / JPEG / WebP data URL
    safeAvatarUrl(src) {
        if (typeof src !== 'string' || src.length > 60000) return '';
        return /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(src) ? src : '';
    }
};

// Dark Mode - A real, working toggle over the shared building blocks
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

// Edit Profile Modal - Name + profile picture.
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
            <div class="modal modal-sev modal-sev-info" style="max-width:380px">
                <div class="modal-header">
                    <h3>Edit Profile</h3>
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

                    <hr style="margin:18px 0;border:none;border-top:1px solid var(--gray-200)">

                    <!-- The password and email fields stay hidden until their button is clicked. -->
                    <div class="profile-change-actions">
                        <button type="button" class="btn btn-outline btn-sm" id="btn-show-change-pw" aria-expanded="false">Change Password</button>
                        <button type="button" class="btn btn-outline btn-sm" id="btn-show-change-email" aria-expanded="false">Change Email</button>
                    </div>

                    <div id="profile-password-section" class="profile-change-section hidden">
                    <div class="form-group">
                        <label class="form-label">Current Password</label>
                        <input type="password" id="edit-profile-current-pw" class="form-control" autocomplete="current-password">
                        <p class="error-msg" id="edit-profile-current-pw-error" aria-live="polite" style="min-height:0;margin:4px 0 0;text-align:left;font-size:0.8rem"></p>
                    </div>
                    <div class="form-group">
                        <label class="form-label">New Password</label>
                        <input type="password" id="edit-profile-new-pw" class="form-control" autocomplete="new-password" placeholder="Min. 10 characters">
                        <p class="error-msg" id="edit-profile-new-pw-error" aria-live="polite" style="min-height:0;margin:4px 0 0;text-align:left;font-size:0.8rem"></p>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Confirm New Password</label>
                        <input type="password" id="edit-profile-confirm-pw" class="form-control" autocomplete="new-password">
                        <p class="error-msg" id="edit-profile-confirm-pw-error" aria-live="polite" style="min-height:0;margin:4px 0 0;text-align:left;font-size:0.8rem"></p>
                    </div>
                    </div>

                    <div id="profile-email-section" class="profile-change-section hidden">
                    <div class="form-group">
                        <label class="form-label">Current Email</label>
                        <input type="email" id="edit-profile-current-email" class="form-control" disabled>
                    </div>
                    <div class="form-group">
                        <label class="form-label">New Email</label>
                        <input type="email" id="edit-profile-new-email" class="form-control" autocomplete="off" placeholder="name@example.com">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Confirm New Email</label>
                        <input type="email" id="edit-profile-confirm-email" class="form-control" autocomplete="off">
                        <div style="font-size:0.72rem;color:var(--secondary);margin-top:4px">A verification code is sent to your current email before the change takes effect.</div>
                    </div>

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

        // "Change Password" / "Change Email" reveal their fields.
        const pwBtn       = document.getElementById('btn-show-change-pw');
        const emailBtn    = document.getElementById('btn-show-change-email');
        const pwSection   = document.getElementById('profile-password-section');
        const emailSection = document.getElementById('profile-email-section');

        this.showSection = (which) => {
            const showPw    = which === 'password';
            const showEmail = which === 'email';
            pwSection?.classList.toggle('hidden', !showPw);
            emailSection?.classList.toggle('hidden', !showEmail);
            pwBtn?.classList.toggle('active', showPw);
            emailBtn?.classList.toggle('active', showEmail);
            pwBtn?.setAttribute('aria-expanded', String(showPw));
            emailBtn?.setAttribute('aria-expanded', String(showEmail));

            if (!showPw) {
                ['edit-profile-current-pw', 'edit-profile-new-pw', 'edit-profile-confirm-pw']
                    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
            }
            if (!showEmail) {
                ['edit-profile-new-email', 'edit-profile-confirm-email']
                    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
            }
            const errEl = document.getElementById('edit-profile-error');
            if (errEl) errEl.textContent = '';
        };

        pwBtn?.addEventListener('click', () => this.showSection(pwSection.classList.contains('hidden') ? 'password' : null));
        emailBtn?.addEventListener('click', () => this.showSection(emailSection.classList.contains('hidden') ? 'email' : null));

        // The form now has Name, Password and Email sections
        const profileBody = overlay.querySelector('.modal-body');
        if (profileBody) {
            profileBody.style.maxHeight = 'calc(100dvh - 190px)';
            profileBody.style.overflowY = 'auto';
        }
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
            this.clearPasswordErrors();

            const body = {};
            const currentUser = Auth.getUser();
            if (currentUser?.role !== 'cashier') {
                const name = document.getElementById('edit-profile-name')?.value.trim();
                if (!name) { errEl.textContent = 'Name cannot be empty.'; return; }
                body.name = name;
            }
            if (this.pendingAvatar) body.avatar = this.pendingAvatar;

            // Password change goes through a SEPARATE OTP-gated flow
            const currentPw = document.getElementById('edit-profile-current-pw')?.value;
            const newPw     = document.getElementById('edit-profile-new-pw')?.value;
            const confirmPw = document.getElementById('edit-profile-confirm-pw')?.value;
            const wantsPasswordChange = !!(currentPw || newPw || confirmPw);

            // Email change is its own OTP-gated flow (see ChangeEmailOtpModal below)
            const newEmail     = (document.getElementById('edit-profile-new-email')?.value || '').trim().toLowerCase();
            const confirmEmail = (document.getElementById('edit-profile-confirm-email')?.value || '').trim().toLowerCase();
            const wantsEmailChange = !!(newEmail || confirmEmail);

            if (wantsEmailChange) {
                // Both flows share one pending-code slot per person on the server
                if (wantsPasswordChange) {
                    errEl.textContent = 'Change your email and your password one at a time. Clear one of them and save again.';
                    return;
                }
                if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) { errEl.textContent = 'Enter a valid new email address.'; return; }
                if (newEmail !== confirmEmail) { errEl.textContent = 'The new email addresses do not match.'; return; }
                if (newEmail === (Auth.getUser()?.email || '').toLowerCase()) { errEl.textContent = 'That is already your email address.'; return; }
            }

            if (wantsPasswordChange) {
                // Every problem is shown at once, each under its own field
                const problems = {};
                if (!currentPw) problems['edit-profile-current-pw'] = 'Enter your current password.';
                const newPwMissing = passwordMissing(newPw);
                if (newPwMissing) problems['edit-profile-new-pw'] = newPwMissing;
                if (newPw !== confirmPw) problems['edit-profile-confirm-pw'] = 'New passwords do not match.';

                // Only the server knows whether the current password is right (checkOnly: nothing is emailed or saved)
                if (currentPw) {
                    const check = await API.post('/auth/change-password-otp/request', { currentPassword: currentPw, newPassword: newPw || '', checkOnly: true });
                    if (check?.errors?.currentPassword) problems['edit-profile-current-pw'] = check.errors.currentPassword;
                }

                if (Object.keys(problems).length) {
                    Object.entries(problems).forEach(([id, message]) => this.setFieldError(id, message));
                    return;
                }
            }

            btn.disabled = true;
            btn.textContent = 'Saving…';

            // Name/avatar (if anything actually changed) save immediately
            let profileResult = { success: true };
            if (Object.keys(body).length) {
                profileResult = await API.put('/auth/profile', body);
            }

            btn.disabled = false;
            btn.textContent = 'Save Changes';

            if (!profileResult?.success) {
                errEl.textContent = profileResult?.message || 'Could not update profile.';
                return;
            }

            if (profileResult.user) {
                Auth.updateStoredUser(profileResult.user);
                Nav.buildUserInfo(); // re-render header/avatar immediately, no re-login needed
            }

            // Cleared regardless of what happens next
            const currentPwEl = document.getElementById('edit-profile-current-pw');
            const newPwEl     = document.getElementById('edit-profile-new-pw');
            const confirmPwEl = document.getElementById('edit-profile-confirm-pw');
            if (currentPwEl) currentPwEl.value = '';
            if (newPwEl)     newPwEl.value     = '';
            if (confirmPwEl) confirmPwEl.value = '';

            if (wantsPasswordChange) {
                // Request the code BEFORE closing this modal or touching the OTP one...
                const otpResult = await ChangePasswordOtpModal.open(currentPw, newPw);
                if (!otpResult.success) {
                    errEl.textContent = otpResult.message;
                    return;
                }
                // Other fields (if any) are already saved at this point only...
                Modal.close('edit-profile-modal');
                if (Object.keys(body).length) Toast.show('Other changes saved. Verify your password change to finish.', 'info');
            } else if (wantsEmailChange) {
                // Request the code BEFORE closing this modal
                const emailResult = await ChangeEmailOtpModal.open(newEmail);
                if (!emailResult.success) {
                    errEl.textContent = emailResult.message;
                    return;
                }
                Modal.close('edit-profile-modal');
                if (Object.keys(body).length) Toast.show('Other changes saved. Verify your email change to finish.', 'info');
            } else {
                Toast.show('Profile updated.', 'success');
                Modal.close('edit-profile-modal');
            }

            this.pendingAvatar = null;
        });
    },

    // One short red line under a password field ('' clears it)
    setFieldError(inputId, message) {
        const el = document.getElementById(inputId + '-error');
        if (el) el.textContent = message || '';
    },

    clearPasswordErrors() {
        ['edit-profile-current-pw', 'edit-profile-new-pw', 'edit-profile-confirm-pw'].forEach(id => this.setFieldError(id, ''));
    },

    setPreview(src) {
        const el = document.getElementById('edit-profile-avatar-preview');
        if (!el) return;
        const safeSrc = ProfileNav.safeAvatarUrl(src);
        if (safeSrc) {
            el.style.backgroundImage = `url(${safeSrc})`;
            el.textContent = '';
        } else {
            el.style.backgroundImage = '';
            el.textContent = (Auth.getUser()?.name || '?').charAt(0).toUpperCase();
        }
    },

    // Downscales an uploaded image to at most maxW x maxH via a canvas
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

        // Same reasoning as pendingAvatar above
        const currentPwEl = document.getElementById('edit-profile-current-pw');
        const newPwEl     = document.getElementById('edit-profile-new-pw');
        const confirmPwEl = document.getElementById('edit-profile-confirm-pw');
        if (currentPwEl) currentPwEl.value = '';
        if (newPwEl)     newPwEl.value     = '';
        if (confirmPwEl) confirmPwEl.value = '';
        const errEl = document.getElementById('edit-profile-error');
        if (errEl) errEl.textContent = '';
        this.clearPasswordErrors();

        const currentEmailEl = document.getElementById('edit-profile-current-email');
        const newEmailEl     = document.getElementById('edit-profile-new-email');
        const confirmEmailEl = document.getElementById('edit-profile-confirm-email');
        if (currentEmailEl) currentEmailEl.value = user?.email || '';
        if (newEmailEl)     newEmailEl.value     = '';
        if (confirmEmailEl) confirmEmailEl.value = '';

        // Opening Edit Profile must NOT show the password/email inputs
        this.showSection?.(null);

        Modal.open('edit-profile-modal');
    }
};

// Change Password Verification (OTP) - Second step of EditProfileModal's...
const ChangePasswordOtpModal = {
    pendingCurrentPassword: null,
    pendingNewPassword:     null,
    resendCooldown:         null,

    ensureModal() {
        if (document.getElementById('change-password-otp-modal')) return;

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'change-password-otp-modal';
        overlay.innerHTML = `
            <div class="modal modal-sev modal-sev-warning" style="max-width:380px">
                <div class="modal-header">
                    <h3>Verify Password Change</h3>
                    <button class="btn-close" id="btn-close-change-pw-otp">✕</button>
                </div>
                <div class="modal-body">
                    <p id="change-pw-otp-status" style="font-size:0.85rem;color:var(--secondary);margin-bottom:16px">Sending verification code…</p>
                    <div class="form-group">
                        <label class="form-label">6-Digit Code *</label>
                        <input type="text" id="change-pw-otp-code" class="form-control" inputmode="numeric" maxlength="6"
                               placeholder="000000" autocomplete="one-time-code" style="letter-spacing:6px;text-align:center;font-size:1.2rem">
                    </div>
                    <p style="font-size:0.78rem;color:var(--secondary);margin-top:10px">
                        Didn't get a code? <button type="button" id="btn-resend-change-pw-otp" style="background:none;border:none;color:var(--primary);cursor:pointer;padding:0;font-size:0.78rem;text-decoration:underline">Resend code</button>
                    </p>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-light" id="btn-close-change-pw-otp-2">Cancel</button>
                    <button class="btn btn-primary" id="btn-confirm-change-pw-otp">Confirm</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);

        document.getElementById('btn-close-change-pw-otp')?.addEventListener('click', () => this.close());
        document.getElementById('btn-close-change-pw-otp-2')?.addEventListener('click', () => this.close());

        document.getElementById('btn-resend-change-pw-otp')?.addEventListener('click', async () => {
            if (!this.pendingCurrentPassword || !this.pendingNewPassword) return;
            const result = await API.post('/auth/change-password-otp/request', {
                currentPassword: this.pendingCurrentPassword,
                newPassword:     this.pendingNewPassword
            });
            if (result?.success) {
                this.setStatus(result.message || 'A new code has been sent.');
                this.startResendCooldown();
            } else {
                this.setStatus(result?.message || 'Could not resend code.', true);
            }
        });

        document.getElementById('btn-confirm-change-pw-otp')?.addEventListener('click', () => this.confirm());
        document.getElementById('change-pw-otp-code')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.confirm();
        });
    },

    setStatus(message, isError = false) {
        const el = document.getElementById('change-pw-otp-status');
        if (!el) return;
        el.textContent = message;
        el.style.color = isError ? 'var(--danger)' : 'var(--secondary)';
    },

    startResendCooldown() {
        const btn = document.getElementById('btn-resend-change-pw-otp');
        if (!btn) return;
        let seconds = 30;
        btn.disabled    = true;
        btn.textContent = `Resend code (${seconds}s)`;
        if (this.resendCooldown) clearInterval(this.resendCooldown);
        this.resendCooldown = setInterval(() => {
            seconds--;
            if (seconds <= 0) {
                clearInterval(this.resendCooldown);
                btn.disabled    = false;
                btn.textContent = 'Resend code';
            } else {
                btn.textContent = `Resend code (${seconds}s)`;
            }
        }, 1000);
    },

    async open(currentPassword, newPassword) {
        this.ensureModal();

        // Sends the request FIRST, before the modal ever opens
        const result = await API.post('/auth/change-password-otp/request', { currentPassword, newPassword });

        if (!result?.success) {
            return { success: false, message: result?.message || 'Could not send the verification email.' };
        }

        this.pendingCurrentPassword = currentPassword;
        this.pendingNewPassword     = newPassword;

        const codeInput = document.getElementById('change-pw-otp-code');
        if (codeInput) codeInput.value = '';
        Modal.open('change-password-otp-modal');
        this.setStatus(result.message || 'A verification code has been sent.');
        this.startResendCooldown();
        codeInput?.focus();

        return { success: true };
    },

    // Closing without confirming just abandons the pending change entirely...
    close() {
        Modal.close('change-password-otp-modal');
        if (this.resendCooldown) clearInterval(this.resendCooldown);
        this.pendingCurrentPassword = null;
        this.pendingNewPassword     = null;
    },

    async confirm() {
        const otp = document.getElementById('change-pw-otp-code')?.value.trim();
        if (!/^\d{6}$/.test(otp)) {
            this.setStatus('Enter the 6-digit code.', true);
            return;
        }

        const btn = document.getElementById('btn-confirm-change-pw-otp');
        btn.disabled    = true;
        btn.textContent = 'Verifying…';
        const result = await API.post('/auth/change-password-otp/confirm', { otp });
        btn.disabled    = false;
        btn.textContent = 'Confirm';

        if (result?.success) {
            if (this.resendCooldown) clearInterval(this.resendCooldown);
            this.pendingCurrentPassword = null;
            this.pendingNewPassword     = null;
            // Changing the password ended every login made with the OLD one
            if (result.token) localStorage.setItem(CONFIG.TOKEN_KEY, result.token);
            Modal.close('change-password-otp-modal');
            Toast.show(result.message || 'Password updated.', 'success');
        } else {
            this.setStatus(result?.message || 'Incorrect code.', true);
        }
    }
};

// Alert Header Badges
async function loadHeaderAlerts() {
    const alertsClient = typeof OfflineAPI !== 'undefined' ? OfflineAPI : API;
    const data = await alertsClient.get('/inventory/alerts/summary');
    if (!data?.success) return;

    AlertsNav.setCounts(data.data);
}

// Modal Helpers
async function downloadAuthenticatedFile(url, fallbackFilename) {
    const token = Auth.getToken();
    try {
        const res = await fetch(url, { headers: token ? { 'Authorization': `Bearer ${token}` } : {} });

        if (!res.ok) {
            // A real endpoint failure sends a JSON error body
            let message = 'Download failed.';
            try {
                const errBody = await res.json();
                if (errBody?.message) message = errBody.message;
            } catch (e) { /* not JSON - keep the generic message */ }
            Toast.show(message, 'error');
            return false;
        }

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
        // Genuine network-level failure (fetch() itself rejected) distinct...
        Toast.show('Download failed. Check your connection.', 'error');
        return false;
    }
}

// Change Email Verification (OTP) - Second step of EditProfileModal's email-change...
const ChangeEmailOtpModal = {
    pendingNewEmail: null,
    resendCooldown:  null,

    ensureModal() {
        if (document.getElementById('change-email-otp-modal')) return;

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'change-email-otp-modal';
        overlay.innerHTML = `
            <div class="modal modal-sev modal-sev-warning" style="max-width:380px">
                <div class="modal-header">
                    <h3>Verify Email Change</h3>
                    <button class="btn-close" id="btn-close-change-email-otp">✕</button>
                </div>
                <div class="modal-body">
                    <p style="font-size:0.85rem;color:var(--secondary);margin-bottom:6px">
                        Changing your email to <strong id="change-email-otp-new">-</strong>.
                    </p>
                    <p id="change-email-otp-status" style="font-size:0.8rem;color:var(--secondary);margin-bottom:16px">Sending verification code...</p>
                    <div class="form-group">
                        <label class="form-label">Code 1: sent to your CURRENT email <strong id="change-email-otp-sent-current"></strong> *</label>
                        <input type="text" id="change-email-otp-code" class="form-control" inputmode="numeric" maxlength="6"
                               placeholder="000000" autocomplete="one-time-code" style="letter-spacing:6px;text-align:center;font-size:1.2rem">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Code 2: sent to your NEW email <strong id="change-email-otp-sent-new"></strong> *</label>
                        <input type="text" id="change-email-otp-code-new" class="form-control" inputmode="numeric" maxlength="6"
                               placeholder="000000" autocomplete="off" style="letter-spacing:6px;text-align:center;font-size:1.2rem">
                    </div>
                    <p style="font-size:0.78rem;color:var(--secondary);margin-top:10px">
                        Didn't get a code? <button type="button" id="btn-resend-change-email-otp" style="background:none;border:none;color:var(--primary);cursor:pointer;padding:0;font-size:0.78rem;text-decoration:underline">Resend code</button>
                    </p>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-light" id="btn-close-change-email-otp-2">Cancel</button>
                    <button class="btn btn-primary" id="btn-confirm-change-email-otp">Confirm</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);

        document.getElementById('btn-close-change-email-otp')?.addEventListener('click', () => this.close());
        document.getElementById('btn-close-change-email-otp-2')?.addEventListener('click', () => this.close());

        document.getElementById('btn-resend-change-email-otp')?.addEventListener('click', async () => {
            if (!this.pendingNewEmail) return;
            const result = await API.post('/auth/change-email-otp/request', { newEmail: this.pendingNewEmail });
            if (result?.success) {
                ['change-email-otp-code', 'change-email-otp-code-new'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
                this.setStatus('New codes sent.');
                this.startResendCooldown();
            } else {
                this.setStatus(result?.message || 'Could not resend code.', true);
            }
        });

        document.getElementById('btn-confirm-change-email-otp')?.addEventListener('click', () => this.confirm());
        ['change-email-otp-code', 'change-email-otp-code-new'].forEach(id => {
            document.getElementById(id)?.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') this.confirm();
            });
        });
    },

    setStatus(message, isError = false) {
        const el = document.getElementById('change-email-otp-status');
        if (!el) return;
        el.style.display = message ? '' : 'none';   // nothing to say = no empty gap
        el.textContent = message;
        el.style.color = isError ? 'var(--danger)' : 'var(--secondary)';
    },

    startResendCooldown() {
        const btn = document.getElementById('btn-resend-change-email-otp');
        if (!btn) return;
        let seconds = 30;
        btn.disabled    = true;
        btn.textContent = `Resend code (${seconds}s)`;
        if (this.resendCooldown) clearInterval(this.resendCooldown);
        this.resendCooldown = setInterval(() => {
            seconds--;
            if (seconds <= 0) {
                clearInterval(this.resendCooldown);
                btn.disabled    = false;
                btn.textContent = 'Resend code';
            } else {
                btn.textContent = `Resend code (${seconds}s)`;
            }
        }, 1000);
    },

    // Returns { success, message } so EditProfileModal can show a failure in place
    async open(newEmail) {
        this.ensureModal();

        const result = await API.post('/auth/change-email-otp/request', { newEmail });
        if (!result?.success) {
            return { success: false, message: result?.message || 'Could not send the verification email.' };
        }

        this.pendingNewEmail = newEmail;

        const newEl = document.getElementById('change-email-otp-new');
        if (newEl) newEl.textContent = newEmail;
        const codeInput = document.getElementById('change-email-otp-code');
        if (codeInput) codeInput.value = '';
        const newCodeInput = document.getElementById('change-email-otp-code-new');
        if (newCodeInput) newCodeInput.value = '';
        const sentCurrent = document.getElementById('change-email-otp-sent-current');
        if (sentCurrent) sentCurrent.textContent = result.sentTo?.current ? `(${result.sentTo.current})` : '';
        const sentNew = document.getElementById('change-email-otp-sent-new');
        if (sentNew) sentNew.textContent = `(${result.sentTo?.newEmail || newEmail})`;
        Modal.open('change-email-otp-modal');
        this.setStatus('');
        this.startResendCooldown();
        codeInput?.focus();

        return { success: true };
    },

    close() {
        Modal.close('change-email-otp-modal');
        if (this.resendCooldown) clearInterval(this.resendCooldown);
        this.pendingNewEmail = null;
    },

    async confirm() {
        const otp    = document.getElementById('change-email-otp-code')?.value.trim();
        const otpNew = document.getElementById('change-email-otp-code-new')?.value.trim();
        if (!/^\d{6}$/.test(otp) || !/^\d{6}$/.test(otpNew)) {
            this.setStatus('Enter both 6-digit codes.', true);
            return;
        }

        const btn = document.getElementById('btn-confirm-change-email-otp');
        btn.disabled    = true;
        btn.textContent = 'Verifying...';
        const result = await API.post('/auth/change-email-otp/confirm', { otp, otpNew });
        btn.disabled    = false;
        btn.textContent = 'Confirm';

        if (result?.success) {
            if (this.resendCooldown) clearInterval(this.resendCooldown);
            this.pendingNewEmail = null;
            Modal.close('change-email-otp-modal');
            // Keep the stored profile in step so Edit Profile shows the new address...
            if (result.email) Auth.updateStoredUser({ email: result.email });
            Toast.show(result.message || 'Email updated.', 'success');
        } else {
            this.setStatus(result?.message || 'Incorrect code.', true);
        }
    }
};

// A product's stored category list ("Analgesic|Antipyretic") as people read it
function fmtCategory(value) {
    return String(value ?? '').split('|').map(s => s.trim()).filter(Boolean).join(', ');
}

// The name people see for each stored role code.
const ROLE_LABELS = { super_admin: 'Owner', admin: 'Admin', cashier: 'Pharmacist' };
function roleLabel(role) {
    return ROLE_LABELS[role] || String(role ?? '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// Table header alignment - A header must sit over its data
const TableAlign = {
    syncTable(table) {
        const head = table.tHead;
        const body = table.tBodies[0];
        if (!head || !head.rows.length || !body) return;

        const headRow = head.rows[head.rows.length - 1];
        const cols    = headRow.cells.length;
        // only ordinary data rows (an empty-state or expanded detail row spans columns)
        const rows = [...body.rows].filter(r => r.cells.length === cols).slice(0, 15);
        if (!rows.length) return;

        for (let i = 0; i < cols; i++) {
            const th = headRow.cells[i];
            if (th.colSpan > 1) continue;
            const cells = rows.map(r => r.cells[i]);
            const right = cells.filter(td =>
                td.classList.contains('col-num') ||
                (!td.classList.contains('col-text') && getComputedStyle(td).textAlign === 'right')
            ).length;

            if (right > cells.length / 2) {
                th.classList.add('col-num');
                th.classList.remove('col-text');
            } else if (th.classList.contains('col-num') && !right) {
                th.classList.remove('col-num');       // the data is not numeric after all
            }
        }
    },

    syncAll() {
        document.querySelectorAll('table').forEach(t => this.syncTable(t));
    },

    start() {
        this.syncAll();
        let timer = null;
        // only watches for rows/tables being added or replaced (not class changes)
        new MutationObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(() => this.syncAll(), 60);
        }).observe(document.body, { childList: true, subtree: true });
    }
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => TableAlign.start());
} else {
    TableAlign.start();
}

const Modal = {
    // Every popup used to share one z-index, so which one painted on top depended...
    _z: 2000,

    bringToFront(el) {
        if (!el) return;
        if (this._z > 8000) this._z = 2000;
        el.style.zIndex = ++this._z;
    },

    open(id) {
        const el = document.getElementById(id);
        if (!el) return;
        this.bringToFront(el);
        el.classList.add('active');
    },
    close(id) {
        document.getElementById(id)?.classList.remove('active');
    },
    closeAll() {
        document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active'));
    }
};

// Search-as-you-type Suggestions - A small, reusable autocomplete dropdown
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

            // Same relevance idea used server-side elsewhere in this app a name...
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
                // mousedown (not click) fires BEFORE the input's blur event
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

// Escape helper shared by the table utilities below Several pages already define...
function escHtmlGlobal(str) {
    return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Generic Column Sort - Attaches click-to-sort to a table's .sortable-col <th>...
const TableSort = {
    attach(theadEl, { getData, data, getValue, onSorted, defaultKey = null, defaultDir = 'asc' }) {
        if (!theadEl) return null;
        // getData() (a function) is preferred over a plain `data` array pages...
        const resolveData = getData || (() => data);
        let currentKey = defaultKey;
        let currentDir = defaultDir;

        const cols = theadEl.querySelectorAll('.sortable-col');
        cols.forEach(th => {
            if (!th.querySelector('.sort-arrow')) {
                const arrow = document.createElement('span');
                arrow.className = 'sort-arrow';
                arrow.textContent = '▲';
                th.appendChild(arrow);
            }
            th.setAttribute('tabindex', '0'); // keyboard-focusable, so :focus-visible's hint arrow

            const activate = () => {
                const key = th.dataset.sortKey;
                if (currentKey === key) {
                    currentDir = currentDir === 'asc' ? 'desc' : 'asc';
                } else {
                    currentKey = key;
                    currentDir = 'asc';
                }
                sortAndRender();
            };
            th.addEventListener('click', activate);
            th.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
            });
        });

        function sortAndRender() {
            const currentData = resolveData() || [];
            if (currentKey) {
                currentData.sort((a, b) => {
                    const va = getValue(a, currentKey);
                    const vb = getValue(b, currentKey);
                    if (va == null && vb == null) return 0;
                    if (va == null) return 1;
                    if (vb == null) return -1;
                    if (typeof va === 'number' && typeof vb === 'number') {
                        return currentDir === 'asc' ? va - vb : vb - va;
                    }
                    return currentDir === 'asc'
                        ? String(va).localeCompare(String(vb))
                        : String(vb).localeCompare(String(va));
                });
            }

            cols.forEach(h => {
                h.classList.remove('sort-active', 'sort-col-tint');
                const a = h.querySelector('.sort-arrow');
                if (a) a.textContent = '▲';
            });
            if (currentKey) {
                const activeTh = theadEl.querySelector(`.sortable-col[data-sort-key="${currentKey}"]`);
                if (activeTh) {
                    activeTh.classList.add('sort-active', 'sort-col-tint');
                    const arrow = activeTh.querySelector('.sort-arrow');
                    if (arrow) arrow.textContent = currentDir === 'asc' ? '▲' : '▼';
                }
            }

            onSorted(currentKey, currentDir);
        }

        if (defaultKey) sortAndRender();

        // Exposed so a render function can re-tag the active column's BODY cells...
        return {
            getCurrentSort: () => ({ key: currentKey, dir: currentDir }),
            resort: () => sortAndRender()
        };
    }
};

// Kebab Row-Action Menu (touch devices) - Reusable trigger+dropdown for a row's...
function attachKebabMenu(triggerEl, actions) {
    if (!triggerEl) return;
    triggerEl.addEventListener('click', (e) => {
        e.stopPropagation();
        document.querySelectorAll('.kebab-menu').forEach(m => m.remove());

        const menu = document.createElement('div');
        menu.className = 'kebab-menu';
        menu.innerHTML = actions.map((a, i) =>
            `<button type="button" class="kebab-menu-item ${a.danger ? 'danger' : ''}" data-i="${i}">${escHtmlGlobal(a.label)}</button>`
        ).join('');
        triggerEl.parentElement.appendChild(menu);

        menu.querySelectorAll('.kebab-menu-item').forEach(btn => {
            btn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                menu.remove();
                actions[parseInt(btn.dataset.i)].onClick();
            });
        });

        const closeOnOutside = (ev) => {
            if (!menu.contains(ev.target) && ev.target !== triggerEl) {
                menu.remove();
                document.removeEventListener('click', closeOnOutside);
            }
        };
        setTimeout(() => document.addEventListener('click', closeOnOutside), 0);
    });
}

// Generic Pagination - Client-side pagination controls + slicing
const Paginate = {
    attach(containerEl, { getData, onRender, pageSize = 25 }) {
        let currentPage = 1;

        function render() {
            const data = getData() || [];
            const totalPages = Math.max(1, Math.ceil(data.length / pageSize));
            // Clamp - a filter/search change can shrink the dataset out from under...
            if (currentPage > totalPages) currentPage = totalPages;

            const start     = (currentPage - 1) * pageSize;
            const pageItems = data.slice(start, start + pageSize);
            onRender(pageItems, currentPage);
            renderControls(data.length, totalPages);
        }

        function renderControls(totalItems, totalPages) {
            if (!containerEl) return;

            // No pagination UI at all when everything already fits on one page
            if (totalPages <= 1) {
                containerEl.innerHTML = '';
                return;
            }

            const start = (currentPage - 1) * pageSize + 1;
            const end   = Math.min(currentPage * pageSize, totalItems);

            let html = `<button class="page-btn" id="pg-prev" ${currentPage === 1 ? 'disabled' : ''}>← Prev</button>`;

            // Up to 5 page buttons around the current page
            const range = 2;
            for (let p = 1; p <= totalPages; p++) {
                if (p === 1 || p === totalPages || (p >= currentPage - range && p <= currentPage + range)) {
                    html += `<button class="page-btn ${p === currentPage ? 'active' : ''}" data-page="${p}">${p}</button>`;
                } else if (p === currentPage - range - 1 || p === currentPage + range + 1) {
                    html += `<span class="page-info">…</span>`;
                }
            }

            html += `
                <button class="page-btn" id="pg-next" ${currentPage === totalPages ? 'disabled' : ''}>Next →</button>
                <span class="page-info">Showing ${start}–${end} of ${totalItems}</span>`;

            containerEl.innerHTML = html;

            containerEl.querySelector('#pg-prev')?.addEventListener('click', () => { currentPage--; render(); });
            containerEl.querySelector('#pg-next')?.addEventListener('click', () => { currentPage++; render(); });
            containerEl.querySelectorAll('[data-page]').forEach(btn => {
                btn.addEventListener('click', () => { currentPage = parseInt(btn.dataset.page); render(); });
            });
        }

        return {
            // Call whenever the underlying data actually changes
            render,
            // A NEW filter/search value (not just a re-sort of the same results)...
            resetToFirstPage: () => { currentPage = 1; render(); },
            getCurrentPage: () => currentPage
        };
    }
};

// DOM Ready: Initialise everything
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

    // Modals now only close via their own X/Cancel/Close buttons
});

// Repaint safety net for a known Chromium quirk - After certain window state changes
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
