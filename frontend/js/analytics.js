// ============================================================
// PharmaTrack – analytics.js
// Dashboard KPIs and Chart.js visualizations
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {
    if (!Auth.requireAuth()) return;

    // Load all dashboard data in one API call
    const data = await API.get('/reports/dashboard-kpis');

    if (!data?.success) {
        Toast.show('Failed to load dashboard data.', 'error');
        return;
    }

    const { today, monthly_revenue, top_products, recent_transactions, alerts } = data.data;

    // ── KPI Cards ─────────────────────────────────────────────
    setKPI('kpi-sales-today',   Fmt.currency(today.total_sales));
    // The server leaves profit out for a Pharmacy Assistant (it is worked out from purchase
    // cost, which they never see). No profit figure -> no "Profit Today" card at all.
    if (today.total_profit === undefined || today.total_profit === null) {
        const profitCard = document.getElementById('kpi-card-profit');
        if (profitCard) profitCard.style.display = 'none';
    } else {
        setKPI('kpi-profit-today', Fmt.currency(today.total_profit));
    }
    setKPI('kpi-txn-count',     today.transaction_count);
    setKPI('kpi-low-stock',     alerts.low_stock);
    setKPI('kpi-near-expiry',   alerts.near_expiry);

    function setKPI(id, value) {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    }

    // ── KPI card click-through (role-gated) ───────────────────
    // Sales/Profit → Reports (admin, super_admin only)
    // Low Stock/Near Expiry → Inventory (admin, super_admin only)
    function goIfAllowed(path, allowedRoles) {
        const user = Auth.getUser();
        if (user && allowedRoles.includes(user.role)) {
            window.location.href = path;
        } else {
            Toast.show("You don't have access to that section.", 'warning');
        }
    }

    document.getElementById('kpi-card-sales')?.addEventListener('click', () => {
        goIfAllowed('reports.html', ['admin', 'super_admin']);
    });
    document.getElementById('kpi-card-profit')?.addEventListener('click', () => {
        goIfAllowed('reports.html', ['admin', 'super_admin']);
    });
    document.getElementById('kpi-card-low-stock')?.addEventListener('click', () => {
        goIfAllowed('inventory.html?status=low_stock', ['admin', 'super_admin']);
    });
    document.getElementById('kpi-card-near-expiry')?.addEventListener('click', () => {
        goIfAllowed('inventory.html?status=expiring', ['admin', 'super_admin']);
    });

    // ── Monthly Revenue Bar Chart ─────────────────────────────
    const monthlyCtx = document.getElementById('chart-monthly-revenue')?.getContext('2d');
    if (monthlyCtx) {
        new Chart(monthlyCtx, {
            type: 'line',
            data: {
                labels:   monthly_revenue.map(m => m.month_label),
                datasets: [{
                    label:                'Monthly Revenue (₱)',
                    data:                 monthly_revenue.map(m => parseFloat(m.revenue)),
                    borderColor:          'rgba(13, 110, 253, 1)',
                    backgroundColor:      'rgba(13, 110, 253, 0.12)',
                    borderWidth:          2,
                    tension:              0.3,
                    fill:                 false,
                    pointRadius:          4,
                    pointHoverRadius:     6,
                    pointBackgroundColor: 'rgba(13, 110, 253, 1)'
                }]
            },
            options: {
                responsive:         true,
                maintainAspectRatio:false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: ctx => ' ₱' + ctx.raw.toLocaleString('en-PH', { minimumFractionDigits: 2 })
                        }
                    }
                },
                scales: {
                    // Show EVERY month label. Chart.js hides some category labels
                    // by default (autoSkip) when it thinks they are crowded, which
                    // made a month look missing even though its point was there.
                    // Labels rotate to fit instead of being dropped.
                    x: {
                        ticks: { autoSkip: false, maxRotation: 60, minRotation: 0 }
                    },
                    y: {
                        beginAtZero: true,
                        ticks: {
                            callback: v => v >= 1000 ? '₱' + (v / 1000).toFixed(v % 1000 === 0 ? 0 : 1) + 'k' : '₱' + Number(v.toFixed(2))
                        }
                    }
                }
            }
        });
    }

    // ── Top 5 Selling Products Pie Chart ─────────────────────
    const pieCtx = document.getElementById('chart-top-products')?.getContext('2d');
    if (pieCtx && !top_products.length) {
        // No completed sales yet -- say so instead of leaving a blank canvas
        const emptyWrap = document.getElementById('chart-top-products')?.parentElement;
        if (emptyWrap) emptyWrap.innerHTML = '<div class="text-center text-muted" style="padding:60px 0">No sales yet.</div>';
    } else if (pieCtx) {
        const colors = [
            'rgba(13, 110, 253, 0.85)',
            'rgba(25, 135, 84,  0.85)',
            'rgba(255, 193, 7,  0.85)',
            'rgba(220, 53,  69, 0.85)',
            'rgba(13,  202, 240, 0.85)'
        ];

        new Chart(pieCtx, {
            type: 'bar',
            data: {
                labels:   top_products.map(p => p.product_name),
                datasets: [{
                    data:            top_products.map(p => parseInt(p.total_qty)),
                    backgroundColor: colors,
                    borderWidth:     1,
                    borderColor:     colors,
                    borderRadius:    6
                }]
            },
            options: {
                indexAxis:           'y',   // horizontal bars
                responsive:          true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            // the tooltip title already shows the FULL brand name
                            label: ctx => ` ${ctx.raw} units`
                        }
                    }
                },
                scales: {
                    x: {
                        beginAtZero: true,
                        ticks:      { precision: 0 },   // whole units only
                        title:      { display: true, text: 'Units sold' }
                    },
                    y: {
                        ticks: {
                            // long brand names are shortened on the axis only
                            callback: function (value) {
                                const label = this.getLabelForValue(value);
                                return label.length > 24 ? label.slice(0, 23) + '...' : label;
                            }
                        }
                    }
                }
            }
        });
    }

    // ── Recent Transactions Table (expandable rows) ───────────
    const tbody = document.getElementById('recent-txn-tbody');
    if (tbody) {
        if (!recent_transactions.length) {
            tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted" style="padding:24px">No transactions yet.</td></tr>';
        } else {
            tbody.innerHTML = recent_transactions.map((t, idx) => `
                <tr>
                    <td><button class="btn-expand" data-index="${idx}" title="View items sold">▶</button></td>
                    <td class="fw-600">${t.order_number}</td>
                    <td>${t.cashier_name}</td>
                    <td>${t.item_count} item(s)</td>
                    <td class="fw-600" style="color:var(--primary)">${Fmt.currency(t.total)}</td>
                    <td>${Fmt.datetime(t.created_at)}</td>
                </tr>
                <tr class="detail-row hidden" id="txn-detail-${idx}">
                    <td colspan="6">
                        <strong style="font-size:0.82rem">Items Sold:</strong>
                        <div class="table-container" style="margin-top:8px">
                            <table class="table" style="white-space:normal">
                                <thead><tr><th>Product</th><th>Qty</th><th>Unit Price</th><th>Line Total</th></tr></thead>
                                <tbody>
                                    ${(t.items || []).map(item => `
                                    <tr>
                                        <td>${escHtml(item.product_name)}</td>
                                        <td>${item.quantity}</td>
                                        <td>${Fmt.currency(item.unit_price)}</td>
                                        <td class="fw-600">${Fmt.currency(item.subtotal)}</td>
                                    </tr>`).join('') || '<tr><td colspan="4" class="text-center text-muted">No item details recorded.</td></tr>'}
                                </tbody>
                            </table>
                        </div>
                    </td>
                </tr>
            `).join('');

            tbody.querySelectorAll('.btn-expand').forEach(btn => {
                btn.addEventListener('click', () => {
                    const idx = btn.dataset.index;
                    const detailRow = document.getElementById(`txn-detail-${idx}`);
                    if (!detailRow) return;
                    const isHidden = detailRow.classList.contains('hidden');
                    detailRow.classList.toggle('hidden', !isHidden);
                    btn.textContent = isHidden ? '▼' : '▶';
                });
            });
        }
    }
});

function escHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
