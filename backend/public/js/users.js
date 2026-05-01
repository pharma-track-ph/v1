// ============================================================
// PharmaTrack – users.js
// User management: CRUD, role assignment, password reset
// Accessible by: admin (cashier accounts only), super_admin (all)
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    if (!Auth.requireAuth(['admin', 'super_admin'])) return;

    const currentUser = Auth.getUser();
    const isSuperAdmin = currentUser?.role === 'super_admin';

    // ── State ────────────────────────────────────────────────
    let allUsers  = [];
    let editingId = null;
    let pwTargetId = null;

    // ── DOM ──────────────────────────────────────────────────
    const tbody       = document.getElementById('users-tbody');
    const searchInput = document.getElementById('user-search');
    const roleFilter  = document.getElementById('filter-role');
    const statusFilter= document.getElementById('filter-status');
    const submitBtn   = document.getElementById('btn-submit-user');
    const userForm    = document.getElementById('user-form');

    // Hide Super Admin option from admins (role restriction)
    if (!isSuperAdmin) {
        document.getElementById('opt-super-admin')?.remove();
    }

    // ── Boot ─────────────────────────────────────────────────
    loadUsers();

    // ── Filters ──────────────────────────────────────────────
    searchInput?.addEventListener('input',   debounceFilter);
    roleFilter?.addEventListener('change',   debounceFilter);
    statusFilter?.addEventListener('change', debounceFilter);

    function debounceFilter() { renderTable(filterUsers()); }

    function filterUsers() {
        const term   = searchInput?.value.toLowerCase().trim() || '';
        const role   = roleFilter?.value   || '';
        const status = statusFilter?.value;

        return allUsers.filter(u => {
            const matchText   = !term   || u.name.toLowerCase().includes(term) || u.email.toLowerCase().includes(term);
            const matchRole   = !role   || u.role === role;
            const matchStatus = status === '' || String(u.is_active) === status;
            return matchText && matchRole && matchStatus;
        });
    }

    // ── Load users ────────────────────────────────────────────
    async function loadUsers() {
        const data = await API.get('/auth/users');
        if (!data?.success) { Toast.show('Failed to load users.', 'error'); return; }

        allUsers = data.data;
        renderStats();
        renderTable(allUsers);
    }

    function renderStats() {
        document.getElementById('stat-total').textContent    = allUsers.length;
        document.getElementById('stat-admins').textContent   = allUsers.filter(u => ['admin','super_admin'].includes(u.role)).length;
        document.getElementById('stat-cashiers').textContent = allUsers.filter(u => u.role === 'cashier').length;
    }

    // ── Render table ──────────────────────────────────────────
    function renderTable(users) {
        if (!tbody) return;

        if (!users.length) {
            tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted" style="padding:40px">No users found.</td></tr>`;
            return;
        }

        tbody.innerHTML = users.map(u => {
            const isSelf    = u.id === currentUser?.id;
            const roleLabel = { super_admin: '🔐 Super Admin', admin: '🔑 Admin', cashier: '🛒 Cashier' }[u.role] || u.role;
            const roleClass = u.role;
            const activeLabel = u.is_active
                ? '<span class="status-dot active"></span>Active'
                : '<span class="status-dot inactive"></span>Inactive';

            // Admins can only edit/delete cashier accounts
            const canEdit   = isSuperAdmin || u.role === 'cashier';
            const canDelete = isSuperAdmin && !isSelf;

            return `
            <tr class="${isSelf ? 'self-row' : ''}">
                <td>
                    <div class="fw-600">${escHtml(u.name)}${isSelf ? '<span class="self-badge">You</span>' : ''}</div>
                </td>
                <td style="color:var(--secondary);font-size:0.85rem">${escHtml(u.email)}</td>
                <td><span class="role-badge ${roleClass}">${roleLabel}</span></td>
                <td style="font-size:0.83rem">${activeLabel}</td>
                <td style="font-size:0.83rem;color:var(--secondary)">${Fmt.date(u.created_at)}</td>
                <td class="action-cell">
                    <div class="d-flex gap-8">
                        ${canEdit && !isSelf ? `
                            <button class="btn btn-light btn-sm btn-edit" data-id="${u.id}" title="Edit">✏️</button>
                            <button class="btn btn-light btn-sm btn-pw" data-id="${u.id}" data-name="${escHtml(u.name)}" title="Change Password">🔒</button>
                        ` : ''}
                        ${canDelete ? `
                            <button class="btn btn-danger btn-sm btn-delete" data-id="${u.id}" data-name="${escHtml(u.name)}" title="Deactivate">🗑️</button>
                        ` : ''}
                        ${isSelf ? `<span class="text-muted" style="font-size:0.78rem">—</span>` : ''}
                        ${!canEdit && !isSelf ? `<span class="text-muted" style="font-size:0.78rem">—</span>` : ''}
                    </div>
                </td>
            </tr>`;
        }).join('');

        // Wire up buttons
        tbody.querySelectorAll('.btn-edit').forEach(btn =>
            btn.addEventListener('click', () => openEditModal(parseInt(btn.dataset.id))));

        tbody.querySelectorAll('.btn-pw').forEach(btn =>
            btn.addEventListener('click', () => openPwModal(parseInt(btn.dataset.id), btn.dataset.name)));

        tbody.querySelectorAll('.btn-delete').forEach(btn =>
            btn.addEventListener('click', () => confirmDelete(parseInt(btn.dataset.id), btn.dataset.name)));
    }

    // ── Add Modal ─────────────────────────────────────────────
    document.getElementById('btn-add-user')?.addEventListener('click', () => {
        editingId = null;
        userForm?.reset();
        document.getElementById('user-modal-title').textContent = 'Add New User';
        document.getElementById('pw-label').textContent = 'Password *';
        document.getElementById('field-password').required = true;
        document.getElementById('field-password').placeholder = 'Min. 8 characters';
        document.getElementById('status-group')?.classList.add('hidden');
        document.getElementById('pw-bar').style.width = '0';
        document.getElementById('pw-hint').textContent = '';
        if (submitBtn) submitBtn.textContent = 'Add User';
        Modal.open('user-modal');
    });

    // ── Edit Modal ────────────────────────────────────────────
    function openEditModal(id) {
        editingId = id;
        const u = allUsers.find(x => x.id === id);
        if (!u) return;

        document.getElementById('user-modal-title').textContent = `Edit: ${u.name}`;
        document.getElementById('field-name').value      = u.name;
        document.getElementById('field-email').value     = u.email;
        document.getElementById('field-role').value      = u.role;
        document.getElementById('field-is_active').value = String(u.is_active);
        document.getElementById('field-password').value  = '';
        document.getElementById('field-password').required = false;
        document.getElementById('pw-label').textContent  = 'New Password (leave blank to keep current)';
        document.getElementById('field-password').placeholder = 'Leave blank to keep current';
        document.getElementById('status-group')?.classList.remove('hidden');
        document.getElementById('pw-bar').style.width = '0';
        document.getElementById('pw-hint').textContent = '';
        if (submitBtn) submitBtn.textContent = 'Save Changes';
        Modal.open('user-modal');
    }

    // ── Modal close ───────────────────────────────────────────
    document.querySelectorAll('.btn-close-modal').forEach(btn =>
        btn.addEventListener('click', () => Modal.close('user-modal')));

    // ── Submit ─────────────────────────────────────────────────
    submitBtn?.addEventListener('click', handleSubmit);

    async function handleSubmit() {
        const name     = document.getElementById('field-name')?.value.trim();
        const email    = document.getElementById('field-email')?.value.trim();
        const role     = document.getElementById('field-role')?.value;
        const password = document.getElementById('field-password')?.value;
        const is_active= document.getElementById('field-is_active')?.value;

        // Validation
        if (!name)  { Toast.show('Name is required.', 'error'); return; }
        if (!email) { Toast.show('Email is required.', 'error'); return; }
        if (!role)  { Toast.show('Role is required.', 'error'); return; }
        if (!editingId && !password) { Toast.show('Password is required for new users.', 'error'); return; }
        if (password && password.length < 8) { Toast.show('Password must be at least 8 characters.', 'error'); return; }

        // Admin role restriction check
        if (!isSuperAdmin && role !== 'cashier') {
            Toast.show('Admins can only create Cashier accounts.', 'error');
            return;
        }

        submitBtn.disabled    = true;
        submitBtn.textContent = editingId ? 'Saving…' : 'Adding…';

        let result;
        try {
            if (editingId) {
                const body = { name, email, role, is_active: parseInt(is_active) };
                if (password) body.password = password;
                result = await API.put(`/auth/users/${editingId}`, body);
            } else {
                result = await API.post('/auth/users', { name, email, role, password });
            }
        } finally {
            submitBtn.disabled    = false;
            submitBtn.textContent = editingId ? 'Save Changes' : 'Add User';
        }

        if (result?.success) {
            Toast.show(result.message, 'success');
            Modal.close('user-modal');
            loadUsers();
        } else {
            Toast.show(result?.message || 'Save failed.', 'error');
        }
    }

    // ── Delete / Deactivate ───────────────────────────────────
    function confirmDelete(id, name) {
        if (!confirm(`Deactivate "${name}"?\n\nThey will no longer be able to log in. This action can be reversed by editing the account.`)) return;
        doDelete(id);
    }

    async function doDelete(id) {
        const result = await API.delete(`/auth/users/${id}`);
        if (result?.success) {
            Toast.show('User deactivated.', 'success');
            loadUsers();
        } else {
            Toast.show(result?.message || 'Delete failed.', 'error');
        }
    }

    // ── Password Change Modal ─────────────────────────────────
    function openPwModal(id, name) {
        pwTargetId = id;
        document.getElementById('pw-target-name').textContent = name;
        document.getElementById('new-pw').value     = '';
        document.getElementById('confirm-pw').value = '';
        document.getElementById('pw-bar-2').style.width      = '0';
        document.getElementById('pw-hint-2').textContent     = '';
        Modal.open('pw-modal');
    }

    document.querySelectorAll('.btn-close-pw').forEach(btn =>
        btn.addEventListener('click', () => Modal.close('pw-modal')));

    document.getElementById('btn-save-pw')?.addEventListener('click', async () => {
        const newPw  = document.getElementById('new-pw')?.value;
        const confPw = document.getElementById('confirm-pw')?.value;

        if (!newPw || newPw.length < 8) { Toast.show('Password must be at least 8 characters.', 'error'); return; }
        if (newPw !== confPw)           { Toast.show('Passwords do not match.', 'error'); return; }

        const btn = document.getElementById('btn-save-pw');
        btn.disabled    = true;
        btn.textContent = 'Updating…';

        // Use the edit endpoint — send just the password
        const u = allUsers.find(x => x.id === pwTargetId);
        if (!u) { btn.disabled = false; btn.textContent = 'Update Password'; return; }

        const result = await API.put(`/auth/users/${pwTargetId}`, {
            name: u.name, email: u.email, role: u.role,
            is_active: u.is_active, password: newPw
        });

        btn.disabled    = false;
        btn.textContent = 'Update Password';

        if (result?.success) {
            Toast.show('Password updated successfully.', 'success');
            Modal.close('pw-modal');
        } else {
            Toast.show(result?.message || 'Update failed.', 'error');
        }
    });

    // ── Password strength meters ──────────────────────────────
    setupStrengthMeter('field-password', 'pw-bar', 'pw-hint');
    setupStrengthMeter('new-pw', 'pw-bar-2', 'pw-hint-2');

    function setupStrengthMeter(inputId, barId, hintId) {
        document.getElementById(inputId)?.addEventListener('input', e => {
            const val = e.target.value;
            const bar = document.getElementById(barId);
            const hint= document.getElementById(hintId);
            if (!bar || !hint) return;

            if (!val) { bar.style.cssText = ''; hint.textContent = ''; return; }

            let score = 0;
            if (val.length >= 8)                score++;
            if (/[A-Z]/.test(val))             score++;
            if (/[0-9]/.test(val))             score++;
            if (/[^A-Za-z0-9]/.test(val))      score++;

            const configs = [
                { width: '25%', color: '#dc3545', text: 'Weak' },
                { width: '50%', color: '#ffc107', text: 'Fair' },
                { width: '75%', color: '#0d6efd', text: 'Good' },
                { width: '100%',color: '#198754', text: 'Strong' }
            ];
            const cfg = configs[score - 1] || configs[0];
            bar.style.cssText  = `width:${cfg.width};background:${cfg.color}`;
            hint.textContent   = cfg.text;
            hint.style.color   = cfg.color;
        });
    }
});

// ── Utilities ─────────────────────────────────────────────────
function escHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}