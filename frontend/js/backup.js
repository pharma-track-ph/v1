// ============================================================
// PharmaTrack – backup.js
// Backup & Restore: manual backup, list, restore, delete, download,
// configurable auto-backup schedule.
// Accessible by: super_admin ("owner") only
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    if (!Auth.requireAuth(['super_admin'])) return;

    const tbody          = document.getElementById('backup-tbody');
    const backupBtn       = document.getElementById('btn-backup-now');
    const lastRunEl        = document.getElementById('backup-last-run');
    const totalCountEl     = document.getElementById('backup-total-count');
    const hourSelect       = document.getElementById('backup-schedule-hour');
    const minuteSelect     = document.getElementById('backup-schedule-minute');
    const periodSelect     = document.getElementById('backup-schedule-period');
    const saveScheduleBtn  = document.getElementById('btn-save-schedule');

    // ── State (sort + pagination) ─────────────────────
    let allBackups     = [];
    let backupSort      = null; // set once the table's sortable headers are wired up (see loadBackups)
    let backupPaginate  = null; // set once, alongside backupSort (see loadBackups)

    populateTimeSelects();
    loadBackups();
    loadSchedule();

    backupBtn?.addEventListener('click', runManualBackup);
    saveScheduleBtn?.addEventListener('click', saveSchedule);

    // ── Schedule ──────────────────────────────────────────────
    // Plain dropdowns instead of the browser's built-in time picker --
    // that one scrolls its hour/minute lists in an endless loop, which is
    // confusing. These are just fixed lists: 1-12 and 00-59, nothing to
    // scroll past the end of.
    function populateTimeSelects() {
        if (!hourSelect || !minuteSelect) return;

        for (let h = 1; h <= 12; h++) {
            const opt = document.createElement('option');
            opt.value = opt.textContent = String(h).padStart(2, '0');
            hourSelect.appendChild(opt);
        }
        for (let m = 0; m < 60; m++) {
            const opt = document.createElement('option');
            opt.value = opt.textContent = String(m).padStart(2, '0');
            minuteSelect.appendChild(opt);
        }
    }

    // Converts the server's 24-hour "HH:MM" into what the three dropdowns
    // need (12-hour + AM/PM).
    function setSelectsFrom24Hour(time24) {
        const [hStr, mStr] = (time24 || '23:59').split(':');
        let hour = parseInt(hStr, 10);
        const period = hour >= 12 ? 'PM' : 'AM';
        hour = hour % 12;
        if (hour === 0) hour = 12;

        if (hourSelect)   hourSelect.value   = String(hour).padStart(2, '0');
        if (minuteSelect) minuteSelect.value = mStr;
        if (periodSelect) periodSelect.value = period;
    }

    // Converts the three dropdowns back into 24-hour "HH:MM" for the API.
    function get24HourFromSelects() {
        let hour = parseInt(hourSelect.value, 10) % 12;
        if (periodSelect.value === 'PM') hour += 12;
        return `${String(hour).padStart(2, '0')}:${minuteSelect.value}`;
    }

    async function loadSchedule() {
        const data = await API.get('/backup/schedule');
        if (data?.success) {
            setSelectsFrom24Hour(data.data.time);
        }
    }

    async function saveSchedule() {
        if (!hourSelect?.value || !minuteSelect?.value) {
            Toast.show('Pick a time first.', 'warning');
            return;
        }

        const time = get24HourFromSelects();

        saveScheduleBtn.disabled    = true;
        saveScheduleBtn.textContent = 'Saving…';

        const result = await API.put('/backup/schedule', { time });

        saveScheduleBtn.disabled    = false;
        saveScheduleBtn.textContent = 'Save Time';

        if (result?.success) {
            Toast.show(result.message, 'success');
        } else {
            Toast.show(result?.message || 'Could not save schedule.', 'error');
        }
    }

    // ── Load list ─────────────────────────────────────────────
    async function loadBackups() {
        const data = await API.get('/backup');

        if (!data?.success) {
            Toast.show('Failed to load backups.', 'error');
            if (tbody) {
                tbody.innerHTML = `<tr><td colspan="4" class="text-center text-muted" style="padding:40px">
                    Could not load backups.</td></tr>`;
            }
            return;
        }

        allBackups = data.data || [];
        renderSummary(allBackups);

        // Sort operates on allBackups itself; getData (not a plain array)
        // keeps this correct even though allBackups gets REASSIGNED on
        // every reload above -- see TableSort's own comment for why a
        // plain array reference would go stale here.
        if (!backupSort) {
            backupSort = TableSort.attach(document.querySelector('#backup-table thead'), {
                getData: () => allBackups,
                getValue: (row, key) => {
                    if (key === 'created_at') return new Date(row.created_at).getTime();
                    if (key === 'size') return parseFloat(row.size || 0);
                    return (row[key] || '').toString().toLowerCase();
                },
                onSorted: () => backupPaginate.resetToFirstPage()
            });
        }

        if (!backupPaginate) {
            backupPaginate = Paginate.attach(document.getElementById('backup-pagination'), {
                getData:  () => allBackups,
                onRender: (pageItems) => renderTable(pageItems),
                pageSize: 25
            });
        }

        // Always -- TableSort's resort() unconditionally triggers onSorted
        // regardless of whether a sort is active, which produces both the
        // very first render and every later reload's reset-to-page-1
        // against the freshly-loaded data (same pattern used throughout
        // inventory.js/users.js/reports.html for this).
        backupSort.resort();
    }

    function renderSummary(list) {
        if (totalCountEl) totalCountEl.textContent = list.length;
        if (lastRunEl) {
            lastRunEl.textContent = list.length ? Fmt.datetime(list[0].created_at) : 'No backups yet';
        }
    }

    // ── Render table ──────────────────────────────────────────
    function renderTable(list) {
        if (!tbody) return;

        if (!allBackups.length) {
            tbody.innerHTML = `<tr><td colspan="4" class="text-center text-muted" style="padding:40px">
                No backups yet. Click "Backup Now" to create the first one.</td></tr>`;
            return;
        }

        const activeKey = backupSort?.getCurrentSort().key;
        const tint = (key) => key === activeKey ? ' sort-col-tint' : '';

        tbody.innerHTML = list.map(b => `
            <tr>
                <td class="col-text sticky-col${tint('created_at')}">${Fmt.datetime(b.created_at)}</td>
                <td class="col-num${tint('size')}">${formatBytes(b.size)}</td>
                <td class="col-text${tint('triggered_by')}">${typeBadge(b.triggered_by)}</td>
                <td class="action-cell">
                    <div class="d-flex gap-8 row-actions">
                        <button class="btn btn-light btn-sm backup-action-btn btn-download" data-filename="${b.filename}" title="Download this backup file">Download</button>
                        <button class="btn btn-light btn-sm backup-action-btn btn-restore"  data-filename="${b.filename}" title="Replace the current database with this backup">Restore</button>
                        <button class="btn btn-danger btn-sm backup-action-btn btn-delete"  data-filename="${b.filename}" title="Permanently delete this backup file">Delete</button>
                    </div>
                    <button class="kebab-trigger" data-filename="${b.filename}" title="More actions" aria-label="More actions">⋮</button>
                </td>
            </tr>
        `).join('');

        tbody.querySelectorAll('.btn-download').forEach(btn =>
            btn.addEventListener('click', () => downloadBackup(btn.dataset.filename)));
        tbody.querySelectorAll('.btn-restore').forEach(btn =>
            btn.addEventListener('click', () => confirmRestore(btn.dataset.filename)));
        tbody.querySelectorAll('.btn-delete').forEach(btn =>
            btn.addEventListener('click', () => confirmDelete(btn.dataset.filename)));
        // Touch-device equivalent of the three buttons above -- see
        // .kebab-trigger in global.css, only ever visible where hover isn't
        // available.
        tbody.querySelectorAll('.kebab-trigger').forEach(btn => {
            const filename = btn.dataset.filename;
            attachKebabMenu(btn, [
                { label: 'Download', onClick: () => downloadBackup(filename) },
                { label: 'Restore',  onClick: () => confirmRestore(filename) },
                { label: 'Delete', danger: true, onClick: () => confirmDelete(filename) }
            ]);
        });
    }

    function typeBadge(triggeredBy) {
        const labels = {
            manual:                 'Manual',
            scheduled:               'Scheduled',
            'pre-restore-safety':    'Safety copy'
        };
        const cls   = triggeredBy || 'manual';
        const label = labels[triggeredBy] || 'Manual';
        return `<span class="backup-type-badge ${cls}">${label}</span>`;
    }

    // ── Manual backup ─────────────────────────────────────────
    async function runManualBackup() {
        backupBtn.disabled    = true;
        backupBtn.textContent = 'Backing up…';

        const result = await API.post('/backup/run', {});

        backupBtn.disabled    = false;
        backupBtn.textContent = 'Backup Now';

        if (result?.success) {
            Toast.show(result.message, 'success');
            loadBackups();
        } else {
            Toast.show(result?.message || 'Backup failed.', 'error');
        }
    }

    // ── Restore ───────────────────────────────────────────────
    async function confirmRestore(filename) {
        const confirmed = await ConfirmDialog.show({
            title:       'Restore This Backup?',
            message:     `This will replace all your current data with this backup.\nA safety copy of what you have now will be saved first.\n\nContinue?`,
            confirmText: 'Restore',
            danger:      true
        });
        if (!confirmed) return;

        Toast.show('Restoring… this may take a moment.', 'info');

        const result = await API.post(`/backup/${encodeURIComponent(filename)}/restore`, {});

        if (result?.success) {
            Toast.show('Restored successfully.', 'success');
            loadBackups();
        } else {
            Toast.show(result?.message || 'Restore failed.', 'error');
        }
    }

    // ── Delete ────────────────────────────────────────────────
    async function confirmDelete(filename) {
        const confirmed = await ConfirmDialog.show({
            title:       'Delete Backup',
            message:     `Delete this backup? This cannot be undone.`,
            confirmText: 'Delete'
        });
        if (!confirmed) return;

        const result = await API.delete(`/backup/${encodeURIComponent(filename)}`);

        if (result?.success) {
            Toast.show('Backup deleted.', 'success');
            loadBackups();
        } else {
            Toast.show(result?.message || 'Delete failed.', 'error');
        }
    }

    // ── Download ──────────────────────────────────────────────
    // Uses fetch (not a plain <a href>) since the endpoint needs the
    // Authorization header — same pattern as inventory.js's CSV import.
    async function downloadBackup(filename) {
        const config = typeof getRuntimeConfig === 'function' ? getRuntimeConfig() : CONFIG;
        const token  = Auth.getToken();

        Toast.show('Preparing download…', 'info');

        try {
            const res = await fetch(`${config.API_BASE}/backup/${encodeURIComponent(filename)}/download`, {
                headers: token ? { 'Authorization': `Bearer ${token}` } : {}
            });

            if (!res.ok) {
                // A real endpoint failure sends a JSON error body -- read
                // it instead of a generic message, same fix as
                // main.js's shared API.request().
                let message = 'Download failed.';
                try {
                    const errBody = await res.json();
                    if (errBody?.message) message = errBody.message;
                } catch (e) { /* not JSON -- keep the generic message */ }
                Toast.show(message, 'error');
                return;
            }

            const blob = await res.blob();
            const url  = URL.createObjectURL(blob);
            const a    = document.createElement('a');
            a.href     = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        } catch (err) {
            // Genuine network-level failure (fetch() itself rejected) --
            // distinct from the clean-but-unsuccessful response above.
            Toast.show('Download failed. Check your connection.', 'error');
        }
    }
});

// ── Utilities ─────────────────────────────────────────────────
function formatBytes(bytes) {
    if (!bytes) return '0 KB';
    const units = ['B', 'KB', 'MB', 'GB'];
    let val = bytes;
    let i   = 0;
    while (val >= 1024 && i < units.length - 1) {
        val /= 1024;
        i++;
    }
    return `${val.toFixed(val < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}
