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
    setKPI('kpi-profit-today',  Fmt.currency(today.total_profit));
    setKPI('kpi-txn-count',     today.transaction_count);
    setKPI('kpi-low-stock',     alerts.low_stock);
    setKPI('kpi-near-expiry',   alerts.near_expiry);

    function setKPI(id, value) {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    }

    // ── Monthly Revenue Bar Chart ─────────────────────────────
    const monthlyCtx = document.getElementById('chart-monthly-revenue')?.getContext('2d');
    if (monthlyCtx && monthly_revenue.length) {
        new Chart(monthlyCtx, {
            type: 'bar',
            data: {
                labels:   monthly_revenue.map(m => m.month_label),
                datasets: [{
                    label:           'Monthly Revenue (₱)',
                    data:            monthly_revenue.map(m => parseFloat(m.revenue)),
                    backgroundColor: 'rgba(13, 110, 253, 0.75)',
                    borderColor:     'rgba(13, 110, 253, 1)',
                    borderWidth:     1,
                    borderRadius:    6
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
                    y: {
                        beginAtZero: true,
                        ticks: {
                            callback: v => '₱' + (v / 1000).toFixed(0) + 'k'
                        }
                    }
                }
            }
        });
    }

    // ── Top 5 Selling Products Pie Chart ─────────────────────
    const pieCtx = document.getElementById('chart-top-products')?.getContext('2d');
    if (pieCtx && top_products.length) {
        const colors = [
            'rgba(13, 110, 253, 0.85)',
            'rgba(25, 135, 84,  0.85)',
            'rgba(255, 193, 7,  0.85)',
            'rgba(220, 53,  69, 0.85)',
            'rgba(13,  202, 240, 0.85)'
        ];

        new Chart(pieCtx, {
            type: 'doughnut',
            data: {
                labels:   top_products.map(p => p.product_name),
                datasets: [{
                    data:            top_products.map(p => parseInt(p.total_qty)),
                    backgroundColor: colors,
                    borderWidth:     2,
                    borderColor:     '#fff'
                }]
            },
            options: {
                responsive:          true,
                maintainAspectRatio: false,
                cutout:              '60%',
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels:   { boxWidth: 12, font: { size: 11 } }
                    },
                    tooltip: {
                        callbacks: {
                            label: ctx => ` ${ctx.label}: ${ctx.raw} units`
                        }
                    }
                }
            }
        });
    }

    // ── Recent Transactions Table ─────────────────────────────
    const tbody = document.getElementById('recent-txn-tbody');
    if (tbody) {
        if (!recent_transactions.length) {
            tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted" style="padding:24px">No transactions yet.</td></tr>';
        } else {
            tbody.innerHTML = recent_transactions.map(t => `
                <tr>
                    <td class="fw-600">${t.order_number}</td>
                    <td>${t.cashier_name}</td>
                    <td>${t.item_count} item(s)</td>
                    <td class="fw-600" style="color:var(--primary)">${Fmt.currency(t.total)}</td>
                    <td>${Fmt.datetime(t.created_at)}</td>
                </tr>
            `).join('');
        }
    }
});
