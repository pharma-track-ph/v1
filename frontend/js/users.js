// PharmaTrack - users.js - User management: CRUD, role assignment
document.addEventListener('DOMContentLoaded', () => {
    if (!Auth.requireAuth(['super_admin'])) return;

    const currentUser = Auth.getUser();
    const isSuperAdmin = currentUser?.role === 'super_admin';

    // State
    let allUsers  = [];
    let usersSort  = null; // set once the table's sortable headers are wired up
    let usersPaginate = null; // set once, alongside usersSort (see loadUsers)
    let editingId = null;
    let pwTargetId = null;

    // DOM
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

    // Boot
    loadUsers();

    // Filters
    searchInput?.addEventListener('input',   debounceFilter);
    roleFilter?.addEventListener('change',   debounceFilter);
    statusFilter?.addEventListener('change', debounceFilter);

    SearchSuggest.attach(searchInput, {
        getItems:    () => allUsers,
        getLabel:    u => u.name,
        getSubLabel: u => u.email
    });

    function debounceFilter() {
        // A NEW filter/search value has no obvious meaning for whatever page you...
        usersPaginate.resetToFirstPage();
    }

    function filterUsers() {
        const term   = searchInput?.value.toLowerCase().trim() || '';
        const role   = roleFilter?.value   || '';
        const status = statusFilter?.value;

        return allUsers.filter(u => {
            const matchText   = !term   || u.name.toLowerCase().includes(term) || u.email.toLowerCase().includes(term);
            const matchRole   = !role   || u.role === role;
            // "All Status" shows EVERY account, active and inactive.
            const matchStatus = status === '' || String(u.is_active) === status;
            return matchText && matchRole && matchStatus;
        });
    }

    // Load users
    async function loadUsers() {
        const data = await API.get('/auth/users');
        if (!data?.success) { Toast.show('Failed to load users.', 'error'); return; }

        allUsers = data.data;
        renderStats();

        // Sorting operates on allUsers ITSELF (not the filtered view rendered below)
        if (!usersSort) {
            usersSort = TableSort.attach(document.querySelector('#users-table thead'), {
                getData: () => allUsers,
                getValue: (row, key) => {
                    if (key === 'role') return roleLabel(row.role).toLowerCase();
                    if (key === 'is_active') return row.is_active ? 1 : 0;
                    if (key === 'created_at') return new Date(row.created_at).getTime();
                    return (row[key] || '').toString().toLowerCase();
                },
                // Goes through Paginate now, not straight to renderTable sorting...
                onSorted: () => usersPaginate.resetToFirstPage()
            });
        }

        // Same one-time-attach guard as usersSort above. getData calls filterUsers()...
        if (!usersPaginate) {
            usersPaginate = Paginate.attach(document.getElementById('users-pagination'), {
                getData:  () => filterUsers(),
                onRender: (pageItems) => renderTable(pageItems),
                pageSize: 25
            });
        }

        // Always - TableSort's resort() unconditionally triggers onSorted at the end...
        usersSort.resort();
    }

    function renderStats() {
        document.getElementById('stat-total').textContent    = allUsers.length;
        document.getElementById('stat-owners').textContent   = allUsers.filter(u => u.role === 'super_admin').length;
        document.getElementById('stat-admins').textContent   = allUsers.filter(u => u.role === 'admin').length;
        document.getElementById('stat-cashiers').textContent = allUsers.filter(u => u.role === 'cashier').length;
    }

    // Render table
    function renderTable(users) {
        if (!tbody) return;

        if (!users.length) {
            tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted" style="padding:40px">No users found.</td></tr>`;
            return;
        }

        const activeKey = usersSort?.getCurrentSort().key;
        const tint = (key) => key === activeKey ? ' sort-col-tint' : '';

        tbody.innerHTML = users.map(u => {
            const isSelf    = u.id === currentUser?.id;
            // Names come from the shared roleLabel() in main.js
            const roleName  = roleLabel(u.role);
            const roleClass = u.role;
            const activeLabel = u.is_active
                ? '<span class="status-dot active"></span>Active'
                : '<span class="status-dot inactive"></span>Inactive';

            // Owners can only be managed by themselves.
            const isOtherOwner = u.role === 'super_admin' && !isSelf;
            const canEdit   = !isOtherOwner && (isSuperAdmin || u.role === 'cashier');
            // Another Admin's DEACTIVATED account can be reactivated
            const canReactivateAdmin = isOtherOwner && !u.is_active;
            // Editing your OWN account (Role / Account Status) is offered only
            const canEditFields = (canEdit && (!isSelf || activeAdminCount() >= 2)) || canReactivateAdmin;

            return `
            <tr class="${isSelf ? 'self-row' : ''}${u.is_active ? '' : ' row-inactive'}">
                <td class="col-text sticky-col${tint('name')}">
                    <div class="fw-600">${escHtml(u.name)}${isSelf ? '<span class="self-badge">You</span>' : ''}</div>
                </td>
                <td class="col-text${tint('email')}" style="color:var(--secondary);font-size:0.85rem">${escHtml(u.email)}</td>
                <td class="col-text${tint('role')}"><span class="role-badge ${roleClass}">${roleName}</span></td>
                <td class="col-text${tint('is_active')}" style="font-size:0.83rem">${activeLabel}</td>
                <td class="col-text${tint('created_at')}" style="font-size:0.83rem;color:var(--secondary)">${Fmt.date(u.created_at)}</td>
                <td class="action-cell">
                    <div class="d-flex gap-8 row-actions">
                        ${canEditFields ? `<button class="btn btn-light btn-sm btn-edit" data-id="${u.id}" title="Edit">Edit</button>` : ''}
                        ${canEdit ? `
                            <button class="btn btn-light btn-sm btn-pw" data-id="${u.id}" data-name="${escHtml(u.name)}" title="Change Password">Password</button>
                        ` : ''}
                        ${(isOtherOwner && !canReactivateAdmin) ? `<span class="text-muted" style="font-size:0.78rem" title="Owner accounts can only be managed by the account holder.">Protected</span>` : ''}
                        ${!canEdit && !isOtherOwner ? `<span class="text-muted" style="font-size:0.78rem">—</span>` : ''}
                    </div>
                    ${(canEdit || canReactivateAdmin) ? `<button class="kebab-trigger" data-id="${u.id}" title="More actions" aria-label="More actions">⋮</button>` : ''}
                </td>
            </tr>`;
        }).join('');

        // Wire up buttons
        tbody.querySelectorAll('.btn-edit').forEach(btn =>
            btn.addEventListener('click', () => openEditModal(parseInt(btn.dataset.id))));

        tbody.querySelectorAll('.btn-pw').forEach(btn =>
            btn.addEventListener('click', () => openPwModal(parseInt(btn.dataset.id), btn.dataset.name)));


        // Touch-device equivalent of the buttons above
        tbody.querySelectorAll('.kebab-trigger').forEach(btn => {
            const id = parseInt(btn.dataset.id);
            const u  = allUsers.find(x => x.id === id);
            if (!u) return;
            const isSelf    = u.id === currentUser?.id;
            const isOtherOwner = u.role === 'super_admin' && !isSelf;
            const canEdit   = !isOtherOwner && (isSuperAdmin || u.role === 'cashier');
            const canReactivateAdmin = isOtherOwner && !u.is_active;
            const canEditFields = (canEdit && (!isSelf || activeAdminCount() >= 2)) || canReactivateAdmin;

            const actions = [];
            if (canEditFields) {
                actions.push({ label: 'Edit', onClick: () => openEditModal(id) });
            }
            if (canEdit) {
                actions.push({ label: 'Change Password', onClick: () => openPwModal(id, u.name) });
            }
            attachKebabMenu(btn, actions);
        });
    }

    // Add Modal
    document.getElementById('btn-add-user')?.addEventListener('click', () => {
        editingId = null;
        userForm?.reset();
        document.getElementById('user-modal-title').textContent = 'Add New User';
        document.getElementById('pw-label').textContent = 'Password *';
        document.getElementById('field-password').required = true;
        document.getElementById('field-password').placeholder = 'Min. 10 characters';
        // Undoes openEditModal's hiding of this field below
        document.getElementById('pw-group')?.classList.remove('hidden');
        // Name and Email only exist in Add mode
        document.getElementById('name-group')?.classList.remove('hidden');
        document.getElementById('email-group')?.classList.remove('hidden');
        document.getElementById('status-group')?.classList.add('hidden');
        document.getElementById('pw-bar').style.width = '0';
        document.getElementById('pw-hint').textContent = '';

        // Reset the self-edit lock left over from any previous Edit-My-Account visit...
        const roleField   = document.getElementById('field-role');
        const statusField = document.getElementById('field-is_active');
        if (roleField)   roleField.disabled   = false;
        if (statusField) statusField.disabled = false;
        document.getElementById('reactivate-note')?.classList.add('hidden');
        document.getElementById('self-edit-note')?.classList.add('hidden');

        if (submitBtn) submitBtn.textContent = 'Add User';
        Modal.open('user-modal');
    });

    // Edit Modal - How many Admin accounts are active right now.
    function activeAdminCount() {
        return allUsers.filter(u => u.role === 'super_admin' && u.is_active).length;
    }

    function openEditModal(id) {
        editingId = id;
        const u = allUsers.find(x => x.id === id);
        if (!u) return;

        const isEditingSelf = id === currentUser?.id;

        document.getElementById('user-modal-title').textContent = isEditingSelf ? 'Edit My Account' : `Edit: ${u.name}`;
        // Admins can no longer edit a person's name or email
        document.getElementById('name-group')?.classList.add('hidden');
        document.getElementById('email-group')?.classList.add('hidden');
        document.getElementById('field-role').value      = u.role;
        document.getElementById('field-is_active').value = String(u.is_active);

        // Editing your OWN account: Role and Account Status are editable only
        const roleField   = document.getElementById('field-role');
        const statusField = document.getElementById('field-is_active');
        if (roleField)   roleField.disabled   = false;
        if (statusField) statusField.disabled = false;

        // Another Admin's deactivated account: the only change allowed is turning it...
        const reactivatingAdmin = !isEditingSelf && u.role === 'super_admin';
        if (roleField) roleField.disabled = reactivatingAdmin;
        document.getElementById('reactivate-note')?.classList.toggle('hidden', !reactivatingAdmin);
        document.getElementById('self-edit-note')?.classList.toggle('hidden', !isEditingSelf);

        // Password field lives in the modal only for the Add-New-User flow now
        document.getElementById('pw-group')?.classList.add('hidden');
        document.getElementById('status-group')?.classList.remove('hidden');
        if (submitBtn) submitBtn.textContent = 'Save Changes';
        Modal.open('user-modal');
    }

    // Modal close
    document.querySelectorAll('.btn-close-modal').forEach(btn =>
        btn.addEventListener('click', () => Modal.close('user-modal')));

    // Submit
    submitBtn?.addEventListener('click', handleSubmit);

    async function handleSubmit() {
        const name     = document.getElementById('field-name')?.value.trim();
        const email    = document.getElementById('field-email')?.value.trim();
        const role     = document.getElementById('field-role')?.value;
        const password = document.getElementById('field-password')?.value;
        const passwordConfirm = document.getElementById('field-password-confirm')?.value;
        const is_active= document.getElementById('field-is_active')?.value;

        // Validation
        if (!editingId && !name)  { Toast.show('Name is required.', 'error'); return; }
        if (!editingId && !email) { Toast.show('Email is required.', 'error'); return; }
        if (!role)  { Toast.show('Role is required.', 'error'); return; }
        if (!editingId && !password) { Toast.show('Password is required for new users.', 'error'); return; }
        if (password && password.length < 10) { Toast.show('Password must be at least 10 characters.', 'error'); return; }
        // Confirm Password only exists/matters in Add mode
        if (!editingId && password !== passwordConfirm) { Toast.show('Passwords do not match.', 'error'); return; }

        // Admin role restriction check
        if (!isSuperAdmin && role !== 'cashier') {
            Toast.show('Admins can only create Pharmacist accounts.', 'error');
            return;
        }

        // Add User: OTP-gated
        if (!editingId) {
            submitBtn.disabled    = true;
            submitBtn.textContent = 'Sending code…';
            const otpResult = await startActionOtp('create_user', { name, email, role, password },
                `create a new ${roleLabel(role)} account for ${name}`);
            submitBtn.disabled    = false;
            submitBtn.textContent = 'Add User';
            if (!otpResult.success) {
                Toast.show(otpResult.message, 'error');
                return;
            }
            Modal.close('user-modal');
            return;
        }

        // Edit (existing user): unchanged, still direct

        // Edit only sends Role and Account Status

        // An Admin changing their OWN role or status loses Admin access the moment...
        const removesOwnAdmin = editingId === currentUser?.id
            && (role !== 'super_admin' || parseInt(is_active) !== 1);

        if (removesOwnAdmin) {
            const deactivating = parseInt(is_active) !== 1;
            const confirmedSelf = await TypedConfirm.show({
                title:        'Change Your Own Access?',
                message:      deactivating
                    ? 'You are about to DEACTIVATE your own account.\n\nYou will be signed out right away. Another Owner can reactivate your account from User Management.'
                    : 'You are about to change your own role.\n\nYou will be signed out right away and will no longer have Owner access to User Management. Another Owner can restore your access.',
                confirmText:  'Change My Access',
                finalMessage: 'You will be signed out as soon as this is saved.'
            });
            if (!confirmedSelf) return;
        }

        // Changing ANOTHER account's role, or switching their account off
        if (!removesOwnAdmin) {
            const target       = allUsers.find(u => u.id === editingId);
            const roleChanged  = !!target && role !== target.role;
            const deactivating = !!target && !!target.is_active && parseInt(is_active) !== 1;

            if (roleChanged || deactivating) {
                const who   = target.name || 'this account';
                const parts = [];
                if (roleChanged)  parts.push(`Change ${who} from ${roleLabel(target.role)} to ${roleLabel(role)}.`);
                if (deactivating) parts.push(`${who} will no longer be able to sign in.`);

                const confirmedChange = await TypedConfirm.show({
                    title:        roleChanged ? 'Change Role?' : `Deactivate ${who}?`,
                    message:      parts.join('\n\n') + '\n\nThe change takes effect right away.',
                    confirmText:  roleChanged ? 'Change Role' : 'Deactivate',
                    severity:     'warning',
                    finalMessage: 'This takes effect as soon as it is saved.'
                });
                if (!confirmedChange) return;
            }
        }

        submitBtn.disabled    = true;
        submitBtn.textContent = 'Saving…';

        let result;
        try {
            const body = { role, is_active: parseInt(is_active) };
            result = await API.put(`/auth/users/${editingId}`, body);
        } finally {
            submitBtn.disabled    = false;
            submitBtn.textContent = 'Save Changes';
        }

        if (result?.success) {
            Toast.show(result.message, 'success');
            Modal.close('user-modal');
            loadUsers();
            if (removesOwnAdmin) {
                setTimeout(() => Auth.logout('Your access was changed. Please sign in again.'), 900);
            }
        } else {
            Toast.show(result?.message || 'Save failed.', 'error');
        }
    }

    // Delete / Deactivate
    async function confirmDelete(id, name) {
        const confirmedDelete = await TypedConfirm.show({
            title:       `Deactivate ${name}?`,
            message:     'They will no longer be able to log in. This can be reversed by editing the account.',
            confirmText: 'Deactivate'
        });
        if (!confirmedDelete) return;
        // OTP-gated - nothing is deactivated until the code sent to you
        const otpResult = await startActionOtp('delete_user', { targetId: id }, `deactivate ${name}'s account`);
        if (!otpResult.success) {
            Toast.show(otpResult.message, 'error');
        }
    }

    // Password Change Modal
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

        if (!newPw || newPw.length < 10) { Toast.show('Password must be at least 10 characters.', 'error'); return; }
        if (newPw !== confPw)           { Toast.show('Passwords do not match.', 'error'); return; }

        const u = allUsers.find(x => x.id === pwTargetId);
        if (!u) return;

        // OTP-gated - nothing is changed until the code sent to you
        const btn = document.getElementById('btn-save-pw');
        btn.disabled    = true;
        btn.textContent = 'Sending code…';
        const otpResult = await startActionOtp('update_password', { targetId: pwTargetId, newPassword: newPw },
            `change the password for ${u.name}'s account`);
        btn.disabled    = false;
        btn.textContent = 'Update Password';

        if (!otpResult.success) {
            Toast.show(otpResult.message, 'error');
            return;
        }
        Modal.close('pw-modal');
    });

    // Email Change Verification (OTP) - Mirrors the Forgot Password OTP flow...
    let pendingEmailOtp        = null; // { targetId, targetName, newEmail }
    let emailOtpResendCooldown = null;

    async function startEmailChangeOtp(targetId, targetName, newEmail) {
        // Request the code FIRST
        const result = await API.post(`/auth/users/${targetId}/email-otp/request`, { newEmail });

        if (!result?.success) {
            Toast.show(result?.message || 'Could not send the verification email.', 'error');
            loadUsers(); // reflect the already-saved fields even though the email...
            return;
        }

        pendingEmailOtp = { targetId, targetName, newEmail };

        document.getElementById('email-otp-target-name').textContent = targetName;
        document.getElementById('email-otp-new-email').textContent   = newEmail;
        const codeInput = document.getElementById('email-otp-code');
        if (codeInput) codeInput.value = '';
        Modal.open('email-otp-modal');
        setEmailOtpStatus(result.message || 'A verification code has been sent.');
        startEmailOtpResendCooldown();
        codeInput?.focus();
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

    // Closing without confirming just abandons the pending email change...
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

    // Action Verification (OTP) - Generic version of the Email Change OTP flow above
    let pendingAction           = null; // { action, payload }
    let actionOtpResendCooldown = null;

    async function startActionOtp(action, payload, descriptionText) {
        // Request the code FIRST
        const result = await API.post('/auth/action-otp/request', { action, payload });

        if (!result?.success) {
            return { success: false, message: result?.message || 'Could not send the verification email.' };
        }

        pendingAction = { action, payload };

        // For Add User specifically, the backend only knows AFTER checking whether...
        const descEl = document.getElementById('action-otp-description');
        if (descEl) descEl.textContent = result.data?.description || descriptionText;

        const codeInput = document.getElementById('action-otp-code');
        if (codeInput) codeInput.value = '';
        Modal.open('action-otp-modal');
        setActionOtpStatus(result.message || 'A verification code has been sent.');
        startActionOtpResendCooldown();
        codeInput?.focus();

        return { success: true };
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

    // Closing without confirming just abandons the pending action entirely nothing...
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
            const descEl = document.getElementById('action-otp-description');
            if (descEl && result.data?.description) descEl.textContent = result.data.description;
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

    // Password strength meters
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
            if (val.length >= 10)               score++;
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

// Utilities
function escHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
