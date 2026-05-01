// ============================================================
// PharmaTrack – audit.js
// Audit log viewer: paginated table, filters, CSV export
// Accessible by: super_admin only
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    if (!Auth.requireAuth(['super_admin'])) return;

    // ── State ────────────────────────────────────────────────
    let allLogs      = [];
    let filteredLogs = [];
    let currentPage  = 1;
    const PAGE_SIZE  = 25;

    // ── DOM ──────────────────────────────────────────────────
    const tbody        = document.getElementById('audit-tbody');
    const pagination   = document.getElementById('pagination');
    const searchInput  = document.getElementById('audit-search');
    const actionFilter = document.getElementById('filter-action');
    const entityFilter = document.getElementById('filter-entity');
    const dateFilter   = document.getElementById('filter-date');
    const clearBtn     = document.getElementById('btn-clear-filters');
    const refreshBtn   = document.getElementById('btn-refresh');
    const exportBtn    = document.getElementById('btn-export-audit');

    // ── Boot ─────────────────────────────────────────────────
    loadAuditLogs();

    // ── Event listeners ───────────────────────────────────────
    searchInput?.addEventListener('input',    applyFilters);
    actionFilter?.addEventListener('change',  applyFilters);
    entityFilter?.addEventListener('change',  applyFilters);
    dateFilter?.addEventListener('change',    applyFilters);
    clearBtn?.addEventListener('click',       clearFilters);
    refreshBtn?.addEventListener('click',     loadAuditLogs);
    exportBtn?.addEventListener('click',      exportCSV);

    // ── Load audit logs from API ──────────────────────────────
    async function loadAuditLogs() {
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="7" class="text-center" style="padding:40px">
                <div class="spinner" style="margin:0 auto"></div>
            </td></tr>`;
        }

        const data = await API.get('/auth/audit-logs?limit=500');

        if (!data?.success) {
            Toast.show('Failed to load audit logs.', 'error');
            if (tbody) {
                tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted" style="padding:40px">
                    Failed to load audit logs. Check your connection.
                </td></tr>`;
            }
            return;
        }

        allLogs = data.data || [];
        renderStats();
        applyFilters();
    }

    // ── Stats bar ─────────────────────────────────────────────
    function renderStats() {
        const today = new Date().toISOString().split('T')[0];

        const todayLogs    = allLogs.filter(l => l.created_at?.startsWith(today));
        const loginCount   = todayLogs.filter(l => l.action?.includes('LOGIN')).length;
        const editCount    = todayLogs.filter(l => l.action?.includes('UPDATE') || l.action?.includes('CREATE')).length;
        const deleteCount  = todayLogs.filter(l => l.action?.includes('DELETE')).length;

        const statTotal   = document.getElementById('stat-total');
        const statLogins  = document.getElementById('stat-logins');
        const statEdits   = document.getElementById('stat-edits');
        const statDeletes = document.getElementById('stat-deletes');

        if (statTotal)   statTotal.textContent   = allLogs.length;
        if (statLogins)  statLogins.textContent  = loginCount;
        if (statEdits)   statEdits.textContent   = editCount;
        if (statDeletes) statDeletes.textContent = deleteCount;
    }

    // ── Filtering ─────────────────────────────────────────────
    function applyFilters() {
        const term   = searchInput?.value.toLowerCase().trim() || '';
        const action = actionFilter?.value || '';
        const entity = entityFilter?.value || '';
        const date   = dateFilter?.value   || '';

        filteredLogs = allLogs.filter(log => {
            const matchText = !term || (
                log.user_name?.toLowerCase().includes(term) ||
                log.action?.toLowerCase().includes(term)    ||
                log.entity?.toLowerCase().includes(term)
            );
            const matchAction = !action || log.action?.startsWith(action);
            const matchEntity = !entity || log.entity === entity;
            const matchDate   = !date   || log.created_at?.startsWith(date);

            return matchText && matchAction && matchEntity && matchDate;
        });

        currentPage = 1;
        renderTable();
        renderPagination();
    }

    function clearFilters() {
        if (searchInput)  searchInput.value  = '';
        if (actionFilter) actionFilter.value = '';
        if (entityFilter) entityFilter.value = '';
        if (dateFilter)   dateFilter.value   = '';
        applyFilters();
    }

    // ── Render table ──────────────────────────────────────────
    function renderTable() {
        if (!tbody) return;

        const start = (currentPage - 1) * PAGE_SIZE;
        const page  = filteredLogs.slice(start, start + PAGE_SIZE);

        if (!filteredLogs.length) {
            tbody.innerHTML = `
                <tr><td colspan="7">
                    <div class="empty-audit">
                        <div class="empty-icon">🔍</div>
                        <div>No audit logs found for the selected filters.</div>
                    </div>
                </td></tr>`;
            return;
        }

        tbody.innerHTML = page.map((log, i) => {
            const globalIdx = start + i;
            const badgeHtml = getActionBadge(log.action);
            const roleLabel = log.user_role ? `<span style="font-size:0.68rem;color:var(--secondary);margin-left:4px">(${log.user_role.replace('_', ' ')})</span>` : '';

            return `
            <tr>
                <td>
                    <button class="btn-expand" data-index="${globalIdx}" title="View details">▶</button>
                </td>
                <td style="white-space:nowrap;font-size:0.83rem">${Fmt.datetime(log.created_at)}</td>
                <td>
                    <span class="fw-600">${escHtml(log.user_name || '—')}</span>${roleLabel}
                </td>
                <td>${badgeHtml}</td>
                <td style="font-size:0.83rem">${log.entity ? escHtml(log.entity) : '—'}</td>
                <td style="font-size:0.83rem;color:var(--secondary)">${log.entity_id || '—'}</td>
                <td style="font-size:0.83rem;color:var(--secondary)">${log.ip_address || '—'}</td>
            </tr>
            <tr class="detail-row hidden" id="detail-${globalIdx}">
                <td colspan="7">
                    <strong style="font-size:0.82rem">Details / Snapshot:</strong>
                    <div class="detail-json">${formatDetails(log.details)}</div>
                </td>
            </tr>`;
        }).join('');

        // Wire expand buttons
        tbody.querySelectorAll('.btn-expand').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx      = btn.dataset.index;
                const detailRow = document.getElementById(`detail-${idx}`);
                if (!detailRow) return;

                const isHidden = detailRow.classList.contains('hidden');
                detailRow.classList.toggle('hidden', !isHidden);
                btn.textContent = isHidden ? '▼' : '▶';
            });
        });
    }

    // ── Action badge ──────────────────────────────────────────
    function getActionBadge(action) {
        if (!action) return '<span class="action-badge DEFAULT">—</span>';

        let cls = 'DEFAULT';
        if (action.includes('CREATE') || action.includes('IMPORT')) cls = 'CREATE';
        else if (action.includes('UPDATE'))                          cls = 'UPDATE';
        else if (action.includes('DELETE'))                          cls = 'DELETE';
        else if (action.includes('LOGIN'))                           cls = 'LOGIN';
        else if (action.includes('CHECKOUT'))                        cls = 'CHECKOUT';

        const label = action.replace(/_/g, ' ');
        return `<span class="action-badge ${cls}">${escHtml(label)}</span>`;
    }

    // ── Format details JSON ───────────────────────────────────
    function formatDetails(details) {
        if (!details) return 'No details recorded.';
        try {
            const parsed = typeof details === 'string' ? JSON.parse(details) : details;
            if (Object.keys(parsed).length === 0) return 'No additional details.';
            return JSON.stringify(parsed, null, 2);
        } catch {
            return String(details);
        }
    }

    // ── Pagination ────────────────────────────────────────────
    function renderPagination() {
        if (!pagination) return;

        const totalPages = Math.ceil(filteredLogs.length / PAGE_SIZE);

        if (totalPages <= 1) {
            pagination.innerHTML = '';
            return;
        }

        const start = (currentPage - 1) * PAGE_SIZE + 1;
        const end   = Math.min(currentPage * PAGE_SIZE, filteredLogs.length);

        let html = `
            <button class="page-btn" id="pg-prev" ${currentPage === 1 ? 'disabled' : ''}>← Prev</button>`;

        // Show up to 5 page buttons around current page
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
            <span class="page-info">Showing ${start}–${end} of ${filteredLogs.length}</span>`;

        pagination.innerHTML = html;

        pagination.querySelector('#pg-prev')?.addEventListener('click', () => { currentPage--; renderTable(); renderPagination(); });
        pagination.querySelector('#pg-next')?.addEventListener('click', () => { currentPage++; renderTable(); renderPagination(); });

        pagination.querySelectorAll('[data-page]').forEach(btn => {
            btn.addEventListener('click', () => {
                currentPage = parseInt(btn.dataset.page);
                renderTable();
                renderPagination();
            });
        });
    }

    // ── CSV Export ────────────────────────────────────────────
    function exportCSV() {
        if (!filteredLogs.length) {
            Toast.show('No logs to export.', 'warning');
            return;
        }

        const headers = ['Date/Time', 'User', 'Role', 'Action', 'Entity', 'Entity ID', 'IP Address', 'Details'];
        const rows = filteredLogs.map(log => [
            Fmt.datetime(log.created_at),
            log.user_name  || '',
            log.user_role  || '',
            log.action     || '',
            log.entity     || '',
            log.entity_id  || '',
            log.ip_address || '',
            JSON.stringify(log.details || {}).replace(/"/g, '""')
        ]);

        const csv   = [headers, ...rows].map(r => r.map(v => `"${v}"`).join(',')).join('\n');
        const fname = `pharmatrack_audit_${new Date().toISOString().split('T')[0]}.csv`;
        const a     = Object.assign(document.createElement('a'), {
            href:     URL.createObjectURL(new Blob([csv], { type: 'text/csv' })),
            download: fname
        });
        a.click();
        Toast.show('Audit log exported.', 'success');
    }
});

// ── Utilities ─────────────────────────────────────────────────
function escHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}