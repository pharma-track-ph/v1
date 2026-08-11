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
            tbody.innerHTML = `<tr><td colspan="6" class="text-center" style="padding:40px">
                <div class="spinner" style="margin:0 auto"></div>
            </td></tr>`;
        }

        const data = await API.get('/auth/audit-logs?limit=500');

        if (!data?.success) {
            Toast.show('Failed to load audit logs.', 'error');
            if (tbody) {
                tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted" style="padding:40px">
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

    // Display-only maps — underlying values in the database/logic (role,
    // entity) never change, only what's shown on screen here.
    const ROLE_LABELS = { super_admin: 'Owner', admin: 'Admin', cashier: 'Cashier' };

    function roleLabel(role) {
        if (!role) return '';
        return ROLE_LABELS[role] || role.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }

    const ENTITY_LABELS = {
        products:       'Product',
        users:          'User',
        orders:         'Order',
        order_items:    'Order Item',
        cash_sessions:  'Cash Session',
        cash_movements: 'Cash Movement',
        audit_logs:     'Audit Log'
    };

    function entityLabel(entity) {
        if (!entity) return '—';
        return ENTITY_LABELS[entity] || entity.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }

    // ── Render table ──────────────────────────────────────────
    function renderTable() {
        if (!tbody) return;

        const start = (currentPage - 1) * PAGE_SIZE;
        const page  = filteredLogs.slice(start, start + PAGE_SIZE);

        if (!filteredLogs.length) {
            tbody.innerHTML = `
                <tr><td colspan="6">
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
            const roleLabelText = log.user_role ? `<span style="font-size:0.68rem;color:var(--secondary);margin-left:4px">(${roleLabel(log.user_role)})</span>` : '';

            return `
            <tr>
                <td>
                    <button class="btn-expand" data-index="${globalIdx}" title="View details">▶</button>
                </td>
                <td style="white-space:nowrap;font-size:0.83rem">${Fmt.datetime(log.created_at)}</td>
                <td>
                    <span class="fw-600">${escHtml(log.user_name || '—')}</span>${roleLabelText}
                </td>
                <td>${badgeHtml}</td>
                <td style="font-size:0.83rem">${entityLabel(log.entity)}</td>
                <td style="font-size:0.83rem;color:var(--secondary)">${log.entity_id || '—'}</td>
            </tr>
            <tr class="detail-row hidden" id="detail-${globalIdx}">
                <td colspan="6">
                    <strong style="font-size:0.82rem">Details:</strong>
                    ${formatDetails(log)}
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
    function detailGrid(rows) {
        return `<div class="detail-grid">${rows.map(([label, value]) =>
            `<div class="detail-row-item"><span class="detail-label">${label}</span><span class="detail-value">${value}</span></div>`
        ).join('')}</div>`;
    }

    function prettyLabel(key) {
        return String(key).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }

    function formatDetails(log) {
        const raw = log.details;
        let parsed;
        try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { parsed = null; }

        if (!parsed || typeof parsed !== 'object' || Object.keys(parsed).length === 0) {
            return '<span class="text-muted">No additional details.</span>';
        }

        const action = log.action || '';

        if (action === 'OPEN_CASH_SESSION') {
            return detailGrid([['Opening Cash', Fmt.currency(parsed.opening_cash)]]);
        }

        if (action === 'CLOSE_CASH_SESSION') {
            const variance = parseFloat(parsed.variance || 0);
            const label = variance === 0 ? 'Balanced' : variance > 0 ? 'Overage' : 'Shortage';
            const color = variance === 0 ? 'var(--success)' : variance > 0 ? '#92400e' : 'var(--danger)';
            return detailGrid([
                ['Expected Cash', Fmt.currency(parsed.expected)],
                ['Actual Cash', Fmt.currency(parsed.actual)],
                ['Variance', `<span style="color:${color}">${Fmt.currency(Math.abs(variance))} (${label})</span>`]
            ]);
        }

        if (action === 'CASH_IN' || action === 'CASH_OUT') {
            return detailGrid([
                ['Amount', Fmt.currency(parsed.amount)],
                ['Reason', escHtml(parsed.reason || '—')]
            ]);
        }

        if (action === 'VOID_ORDER') {
            const rows = [
                ['Order #', escHtml(parsed.order_number || '—')],
                ['Total', Fmt.currency(parsed.total)]
            ];
            if (parsed.requested_by) rows.push(['Requested By (Cashier)', escHtml(parsed.requested_by)]);
            return detailGrid(rows);
        }

        if (action === 'CHECKOUT') {
            return detailGrid([
                ['Order #', escHtml(parsed.order_number || '—')],
                ['Total', Fmt.currency(parsed.total)]
            ]);
        }

        if (action === 'IMPORT_INVENTORY') {
            return detailGrid([
                ['Inserted', parsed.inserted != null ? parsed.inserted : 0],
                ['Updated', parsed.updated != null ? parsed.updated : 0],
                ['Errors', (parsed.errors || []).length]
            ]);
        }

        if (action === 'UPDATE_PRODUCT' && parsed.before && parsed.after) {
            const changed = Object.keys(parsed.after).filter(function(k) {
                const b = parsed.before[k] == null ? '' : parsed.before[k];
                const a = parsed.after[k]  == null ? '' : parsed.after[k];
                return String(b) !== String(a);
            });
            if (!changed.length) return '<span class="text-muted">No fields changed.</span>';
            return detailGrid(changed.map(function(k) {
                return [prettyLabel(k), escHtml(parsed.before[k] || '—') + ' → ' + escHtml(parsed.after[k] || '—')];
            }));
        }

        if (action === 'CREATE_PRODUCT') {
            return detailGrid(
                Object.entries(parsed)
                    .filter(function(entry) { return entry[0] !== 'description'; })
                    .map(function(entry) { return [prettyLabel(entry[0]), escHtml(entry[1] || '—')]; })
            );
        }

        return detailGrid(Object.entries(parsed).map(function(entry) {
            const k = entry[0], v = entry[1];
            const display = (typeof v === 'object' && v !== null) ? JSON.stringify(v) : v;
            return [prettyLabel(k), escHtml(display == null ? '—' : display)];
        }));
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

        const headers = ['Date/Time', 'User', 'Role', 'Action', 'Entity', 'Entity ID', 'Details'];
        const rows = filteredLogs.map(log => [
            Fmt.datetime(log.created_at),
            log.user_name  || '',
            log.user_role  || '',
            log.action     || '',
            log.entity     || '',
            log.entity_id  || '',
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