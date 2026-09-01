// ============================================================
// PharmaTrack – users.js
// User management: CRUD, role assignment, password reset
// Accessible by: super_admin ("owner") only
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    if (!Auth.requireAuth(['super_admin'])) return;

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

    SearchSuggest.attach(searchInput, {
        getItems:    () => allUsers,
        getLabel:    u => u.name,
        getSubLabel: u => u.email
    });

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
        document.getElementById('stat-owners').textContent   = allUsers.filter(u => u.role === 'super_admin').length;
        document.getElementById('stat-admins').textContent   = allUsers.filter(u => u.role === 'admin').length;
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
            const roleLabel = { super_admin: 'Owner', admin: 'Admin', cashier: 'Pharmacy Assistant' }[u.role] || u.role;
            const roleClass = u.role;
            const activeLabel = u.is_active
                ? '<span class="status-dot active"></span>Active'
                : '<span class="status-dot inactive"></span>Inactive';

            // Owners can only be managed by themselves. Editing, resetting
            // the password of, or deleting ANOTHER owner account would let
            // owners lock each other out or tamper with a peer's access --
            // so peer-owner accounts are fully read-only here, regardless
            // of who's logged in. Editing your OWN account IS allowed (see
            // openEditModal for what stays locked even then: role/status).
            const isOtherOwner = u.role === 'super_admin' && !isSelf;
            const canEdit   = !isOtherOwner && (isSuperAdmin || u.role === 'cashier');
            const canDelete = !isOtherOwner && isSuperAdmin && !isSelf;

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
                        ${canEdit ? `
                            <button class="btn btn-light btn-sm btn-edit" data-id="${u.id}" title="Edit">Edit</button>
                            <button class="btn btn-light btn-sm btn-pw" data-id="${u.id}" data-name="${escHtml(u.name)}" title="Change Password">Password</button>
                        ` : ''}
                        ${canDelete ? `
                            <button class="btn btn-danger btn-sm btn-delete" data-id="${u.id}" data-name="${escHtml(u.name)}" title="Deactivate">Delete</button>
                        ` : ''}
                        ${isOtherOwner ? `<span class="text-muted" style="font-size:0.78rem" title="Owner accounts can only be managed by the account holder.">Protected</span>` : ''}
                        ${!canEdit && !canDelete && !isOtherOwner ? `<span class="text-muted" style="font-size:0.78rem">—</span>` : ''}
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
        // Undoes openEditModal's hiding of this field below -- without
        // this, the password INPUT stayed hidden on every Add User after
        // the first time you'd ever opened Edit on any user, while
        // handleSubmit()'s validation still correctly demanded a
        // password for new users -- a real deadlock (required, but no
        // visible way to enter it).
        document.getElementById('pw-group')?.classList.remove('hidden');
        document.getElementById('status-group')?.classList.add('hidden');
        document.getElementById('pw-bar').style.width = '0';
        document.getElementById('pw-hint').textContent = '';

        // Reset the self-edit lock left over from any previous
        // Edit-My-Account visit to this same shared modal.
        const roleField   = document.getElementById('field-role');
        const statusField = document.getElementById('field-is_active');
        if (roleField)   roleField.disabled   = false;
        if (statusField) statusField.disabled = false;
        document.getElementById('self-edit-note')?.classList.add('hidden');

        if (submitBtn) submitBtn.textContent = 'Add User';
        Modal.open('user-modal');
    });

    // ── Edit Modal ────────────────────────────────────────────
    function openEditModal(id) {
        editingId = id;
        const u = allUsers.find(x => x.id === id);
        if (!u) return;

        const isEditingSelf = id === currentUser?.id;

        document.getElementById('user-modal-title').textContent = isEditingSelf ? 'Edit My Account' : `Edit: ${u.name}`;
        document.getElementById('field-name').value      = u.name;
        document.getElementById('field-email').value     = u.email;
        document.getElementById('field-role').value      = u.role;
        document.getElementById('field-is_active').value = String(u.is_active);

        // Editing your OWN account: Role and Active-status stay locked
        // (still visible, not editable) so you can't accidentally demote or
        // deactivate yourself with no one else able to undo it in the
        // moment. Name/email are still editable, and password has its own
        // separate Change Password modal below.
        const roleField   = document.getElementById('field-role');
        const statusField = document.getElementById('field-is_active');
        if (roleField)   roleField.disabled   = isEditingSelf;
        if (statusField) statusField.disabled = isEditingSelf;
        document.getElementById('self-edit-note')?.classList.toggle('hidden', !isEditingSelf);

        // Password field lives in the modal only for the Add-New-User flow
        // now -- changing an EXISTING user's password has its own dedicated
        // Change Password modal (openPwModal), so there's no password input
        // to reset here anymore. See handleSubmit(), which no longer reads
        // it either.
        document.getElementById('pw-group')?.classList.add('hidden');
        document.getElementById('status-group')?.classList.remove('hidden');
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
        const passwordConfirm = document.getElementById('field-password-confirm')?.value;
        const is_active= document.getElementById('field-is_active')?.value;

        // Validation
        if (!name)  { Toast.show('Name is required.', 'error'); return; }
        if (!email) { Toast.show('Email is required.', 'error'); return; }
        if (!role)  { Toast.show('Role is required.', 'error'); return; }
        if (!editingId && !password) { Toast.show('Password is required for new users.', 'error'); return; }
        if (password && password.length < 8) { Toast.show('Password must be at least 8 characters.', 'error'); return; }
        // Confirm Password only exists/matters in Add mode -- the Edit
        // modal never shows the password field at all (see openEditModal),
        // so this only ever needs checking when creating a new user.
        if (!editingId && password !== passwordConfirm) { Toast.show('Passwords do not match.', 'error'); return; }

        // Admin role restriction check
        if (!isSuperAdmin && role !== 'cashier') {
            Toast.show('Admins can only create Pharmacy Assistant accounts.', 'error');
            return;
        }

        // ── Add User: OTP-gated -- nothing is created until the code sent
        // to YOU (the owner performing this) is confirmed. See
        // startActionOtp below; the account is created server-side only
        // inside confirmActionOtp. ──
        if (!editingId) {
            Modal.close('user-modal');
            const roleLabels = { super_admin: 'Owner', admin: 'Admin', cashier: 'Pharmacy Assistant' };
            startActionOtp('create_user', { name, email, role, password },
                `create a new ${roleLabels[role] || role} account for ${name}`);
            return;
        }

        // ── Edit (existing user): unchanged, still direct -- only Add
        // User, Change Password, and Delete are OTP-gated per the spec;
        // ordinary profile edits (name/role/status) and Email Change stay
        // exactly as they were. ──

        // Email changes on an EXISTING account go through the dedicated
        // OTP-verified flow below (startEmailChangeOtp) instead of being
        // applied directly here -- the backend ignores the email field on
        // this same PUT entirely (see authController.js's updateUser), so
        // name/role/status/password below still save normally either way.
        const originalUser = allUsers.find(x => x.id === editingId);
        const emailChanged = !!(originalUser && email.toLowerCase() !== originalUser.email.toLowerCase());

        submitBtn.disabled    = true;
        submitBtn.textContent = 'Saving…';

        let result;
        try {
            const body = { name, email, role, is_active: parseInt(is_active) };
            if (password) body.password = password;
            result = await API.put(`/auth/users/${editingId}`, body);
        } finally {
            submitBtn.disabled    = false;
            submitBtn.textContent = 'Save Changes';
        }

        if (result?.success) {
            if (emailChanged) {
                // Other fields are already saved at this point -- only the
                // email is still pending, gated behind a code sent to the
                // OWNER PERFORMING THE CHANGE (see startEmailChangeOtp).
                Modal.close('user-modal');
                Toast.show('Other changes saved. Verify the email change to finish.', 'info');
                startEmailChangeOtp(editingId, originalUser.name, email);
            } else {
                Toast.show(result.message, 'success');
                Modal.close('user-modal');
                loadUsers();
            }
        } else {
            Toast.show(result?.message || 'Save failed.', 'error');
        }
    }

    // ── Delete / Deactivate ───────────────────────────────────
    function confirmDelete(id, name) {
        if (!confirm(`Deactivate "${name}"?\n\nThey will no longer be able to log in. This action can be reversed by editing the account.`)) return;
        // OTP-gated now -- see startActionOtp below. Nothing is
        // deactivated until the code sent to you (the owner) is
        // confirmed; doDelete() is gone, this call replaces it.
        startActionOtp('delete_user', { targetId: id }, `deactivate ${name}'s account`);
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

        const u = allUsers.find(x => x.id === pwTargetId);
        if (!u) return;

        // OTP-gated now -- nothing is changed until the code sent to you
        // (the owner) is confirmed. See startActionOtp below.
        Modal.close('pw-modal');
        startActionOtp('update_password', { targetId: pwTargetId, newPassword: newPw },
            `change the password for ${u.name}'s account`);
    });

    // ── Email Change Verification (OTP) ───────────────
    // Mirrors the Forgot Password OTP flow on the login page, but the code
    // is sent to the OWNER PERFORMING THE CHANGE (whoever is logged in and
    // using this page right now), never to the target account's old or
    // new address -- this confirms "the person at this keyboard really
    // meant to do this", not that the new address is reachable. Triggered
    // from handleSubmit() above whenever the Edit modal's email field
    // differs from the account's current email.
    let pendingEmailOtp        = null; // { targetId, targetName, newEmail }
    let emailOtpResendCooldown = null;

    async function startEmailChangeOtp(targetId, targetName, newEmail) {
        pendingEmailOtp = { targetId, targetName, newEmail };

        document.getElementById('email-otp-target-name').textContent = targetName;
        document.getElementById('email-otp-new-email').textContent   = newEmail;
        const codeInput = document.getElementById('email-otp-code');
        if (codeInput) codeInput.value = '';
        setEmailOtpStatus('Sending verification code…');
        Modal.open('email-otp-modal');

        const result = await API.post(`/auth/users/${targetId}/email-otp/request`, { newEmail });

        if (result?.success) {
            setEmailOtpStatus(result.message || 'A verification code has been sent.');
            startEmailOtpResendCooldown();
            codeInput?.focus();
        } else {
            setEmailOtpStatus(result?.message || 'Could not send the verification email.', true);
        }
    }

    function setEmailOtpStatus(message, isError = false) {
        const el = document.getElementById('email-otp-status');
        if (!el) return;
        el.textContent = message;
        el.style.color = isError ? 'var(--danger)' : 'var(--secondary)';
    }

    function startEmailOtpResendCooldown() {
        const btn = document.getElementById('btn-resend-email-otp');
        if (!btn) return;
        let seconds = 30;
        btn.disabled    = true;
        btn.textContent = `Resend code (${seconds}s)`;
        if (emailOtpResendCooldown) clearInterval(emailOtpResendCooldown);
        emailOtpResendCooldown = setInterval(() => {
            seconds--;
            if (seconds <= 0) {
                clearInterval(emailOtpResendCooldown);
                btn.disabled    = false;
                btn.textContent = 'Resend code';
            } else {
                btn.textContent = `Resend code (${seconds}s)`;
            }
        }, 1000);
    }

    // Closing without confirming just abandons the pending email change --
    // the name/role/status/password changes from the same submit were
    // already saved beforehand, so the table is refreshed to reflect those
    // even though the email itself stays unchanged.
    function closeEmailOtpModal() {
        Modal.close('email-otp-modal');
        if (emailOtpResendCooldown) clearInterval(emailOtpResendCooldown);
        pendingEmailOtp = null;
        loadUsers();
    }

    document.querySelectorAll('.btn-close-email-otp').forEach(btn =>
        btn.addEventListener('click', closeEmailOtpModal));

    document.getElementById('btn-resend-email-otp')?.addEventListener('click', async () => {
        if (!pendingEmailOtp) return;
        const result = await API.post(`/auth/users/${pendingEmailOtp.targetId}/email-otp/request`, {
            newEmail: pendingEmailOtp.newEmail
        });
        if (result?.success) {
            setEmailOtpStatus(result.message || 'A new code has been sent.');
            startEmailOtpResendCooldown();
        } else {
            setEmailOtpStatus(result?.message || 'Could not resend code.', true);
        }
    });

    async function confirmEmailOtp() {
        if (!pendingEmailOtp) return;
        const otp = document.getElementById('email-otp-code')?.value.trim();
        if (!/^\d{6}$/.test(otp)) {
            setEmailOtpStatus('Enter the 6-digit code.', true);
            return;
        }

        const btn = document.getElementById('btn-confirm-email-otp');
        btn.disabled    = true;
        btn.textContent = 'Verifying…';
        const result = await API.post(`/auth/users/${pendingEmailOtp.targetId}/email-otp/confirm`, { otp });
        btn.disabled    = false;
        btn.textContent = 'Confirm';

        if (result?.success) {
            if (emailOtpResendCooldown) clearInterval(emailOtpResendCooldown);
            pendingEmailOtp = null;
            Modal.close('email-otp-modal');
            Toast.show(result.message || 'Email updated successfully.', 'success');
            loadUsers();
        } else {
            setEmailOtpStatus(result?.message || 'Incorrect code.', true);
        }
    }

    document.getElementById('btn-confirm-email-otp')?.addEventListener('click', confirmEmailOtp);
    document.getElementById('email-otp-code')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') confirmEmailOtp();
    });

    // ── Action Verification (OTP) ─────────────────
    // Generic version of the Email Change OTP flow above, reused for Add
    // User, Change Password, and Delete/Deactivate -- same "confirm it's
    // really you" pattern, code emailed to the OWNER PERFORMING the
    // action. Nothing is written to the database for any of these three
    // actions until the code is confirmed (see authController.js's
    // requestActionOtp/confirmActionOtp).
    let pendingAction           = null; // { action, payload }
    let actionOtpResendCooldown = null;

    async function startActionOtp(action, payload, descriptionText) {
        pendingAction = { action, payload };

        // textContent, not innerHTML -- descriptionText is built from a
        // user-entered name (see handleSubmit/confirmDelete/btn-save-pw
        // above), so this must never be interpreted as HTML.
        const descEl = document.getElementById('action-otp-description');
        if (descEl) descEl.textContent = descriptionText;

        const codeInput = document.getElementById('action-otp-code');
        if (codeInput) codeInput.value = '';
        setActionOtpStatus('Sending verification code…');
        Modal.open('action-otp-modal');

        const result = await API.post('/auth/action-otp/request', { action, payload });

        if (result?.success) {
            setActionOtpStatus(result.message || 'A verification code has been sent.');
            startActionOtpResendCooldown();
            codeInput?.focus();
        } else {
            setActionOtpStatus(result?.message || 'Could not send the verification email.', true);
        }
    }

    function setActionOtpStatus(message, isError = false) {
        const el = document.getElementById('action-otp-status');
        if (!el) return;
        el.textContent = message;
        el.style.color = isError ? 'var(--danger)' : 'var(--secondary)';
    }

    function startActionOtpResendCooldown() {
        const btn = document.getElementById('btn-resend-action-otp');
        if (!btn) return;
        let seconds = 30;
        btn.disabled    = true;
        btn.textContent = `Resend code (${seconds}s)`;
        if (actionOtpResendCooldown) clearInterval(actionOtpResendCooldown);
        actionOtpResendCooldown = setInterval(() => {
            seconds--;
            if (seconds <= 0) {
                clearInterval(actionOtpResendCooldown);
                btn.disabled    = false;
                btn.textContent = 'Resend code';
            } else {
                btn.textContent = `Resend code (${seconds}s)`;
            }
        }, 1000);
    }

    // Closing without confirming just abandons the pending action entirely
    // -- nothing was ever written to the database for it (unlike the
    // Email Change flow, where OTHER fields might already be saved --
    // these three actions have nothing partially applied to undo).
    function closeActionOtpModal() {
        Modal.close('action-otp-modal');
        if (actionOtpResendCooldown) clearInterval(actionOtpResendCooldown);
        pendingAction = null;
    }

    document.querySelectorAll('.btn-close-action-otp').forEach(btn =>
        btn.addEventListener('click', closeActionOtpModal));

    document.getElementById('btn-resend-action-otp')?.addEventListener('click', async () => {
        if (!pendingAction) return;
        const result = await API.post('/auth/action-otp/request', pendingAction);
        if (result?.success) {
            setActionOtpStatus(result.message || 'A new code has been sent.');
            startActionOtpResendCooldown();
        } else {
            setActionOtpStatus(result?.message || 'Could not resend code.', true);
        }
    });

    async function confirmActionOtp() {
        if (!pendingAction) return;
        const otp = document.getElementById('action-otp-code')?.value.trim();
        if (!/^\d{6}$/.test(otp)) {
            setActionOtpStatus('Enter the 6-digit code.', true);
            return;
        }

        const btn = document.getElementById('btn-confirm-action-otp');
        btn.disabled    = true;
        btn.textContent = 'Verifying…';
        const result = await API.post('/auth/action-otp/confirm', { otp });
        btn.disabled    = false;
        btn.textContent = 'Confirm';

        if (result?.success) {
            if (actionOtpResendCooldown) clearInterval(actionOtpResendCooldown);
            pendingAction = null;
            Modal.close('action-otp-modal');
            Toast.show(result.message || 'Action completed.', 'success');
            loadUsers();
        } else {
            setActionOtpStatus(result?.message || 'Incorrect code.', true);
        }
    }

    document.getElementById('btn-confirm-action-otp')?.addEventListener('click', confirmActionOtp);
    document.getElementById('action-otp-code')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') confirmActionOtp();
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
