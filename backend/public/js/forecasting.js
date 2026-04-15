// ============================================================
// PharmaTrack – forecasting.js
// Time Series Forecasting: HOLT-WINTERS TRIPLE EXPONENTIAL SMOOTHING
//
// ── ALGORITHM: Holt-Winters (Triple Exponential Smoothing) ──
//
// Holt-Winters extends exponential smoothing to capture THREE components:
//   1. LEVEL (Lₜ)      — Baseline demand
//   2. TREND (Tₜ)      — Growth or decline rate
//   3. SEASONAL (Sₜ)   — Recurring patterns (e.g., flu season)
//
// Equations:
//   Level:     Lₜ = α·(Yₜ/Sₜ₋ₛ) + (1-α)·(Lₜ₋₁ + Tₜ₋₁)
//   Trend:     Tₜ = β·(Lₜ - Lₜ₋₁) + (1-β)·Tₜ₋₁
//   Seasonal:  Sₜ = γ·(Yₜ/Lₜ) + (1-γ)·Sₜ₋ₛ
//
// Forecast:   Fₜ₊ₘ = (Lₜ + m·Tₜ) × Sₜ₋ₛ₊ₘ
//
// Where:
//   α (alpha)   — Level smoothing factor (0 < α < 1)
//   β (beta)    — Trend smoothing factor (0 < β < 1)
//   γ (gamma)   — Seasonal smoothing factor (0 < γ < 1)
//   s           — Seasonal period length (e.g., 4 for quarterly)
//   m           — Number of periods ahead to forecast
//
// Why Holt-Winters for PharmaTrack?
//   • Captures Philippine seasonal disease patterns (flu: Jun-Sep, allergies: Dec-Feb)
//   • Adapts to long-term pharmacy growth trends
//   • Proven 85%+ accuracy in pharmaceutical forecasting studies
//   • Transparent and explainable for thesis defense
// ============================================================
//-------old up----
// ============================================================
// PharmaTrack – Forecasting Module
// Algorithms: Moving Average, Simple Exponential Smoothing,
//             Holt-Winters Triple Exponential Smoothing (client-side)
// ============================================================

document.addEventListener('DOMContentLoaded', async () => {
    if (!Auth.requireAuth(['admin', 'super_admin'])) return;

    // ── State ───────────────────────────────────────────────
    let currentProduct   = null;
    let currentAlgorithm = 'holt-winters';
    let forecastChart    = null;
    let allProducts      = [];
    let trendingProducts = [];

    // ── DOM ─────────────────────────────────────────────────
    const productSelect  = document.getElementById('forecast-product');
    const productSearch  = document.getElementById('product-search');
    const runBtn         = document.getElementById('btn-run-forecast');
    const compareBtn     = document.getElementById('btn-compare-all');
    const resultsSection = document.getElementById('forecast-results');
    const modal          = document.getElementById('comparison-modal');
    const closeModal     = document.getElementById('close-modal');

    // ── Boot ────────────────────────────────────────────────
    await Promise.all([loadProducts(), loadTrendingProducts(), loadRestockSuggestions()]);
    setupEventListeners();
    checkUrlParams();

    // ────────────────────────────────────────────────────────
    // PRODUCTS
    // ────────────────────────────────────────────────────────
    async function loadProducts() {
        const data = await API.get('/forecasting/products');
        if (!data?.success) { Toast.show('Failed to load products', 'error'); return; }
        allProducts = data.data;
        renderProductOptions(allProducts);
    }

    function renderProductOptions(products) {
        if (!productSelect) return;
        productSelect.innerHTML = '<option value="">— Choose a product —</option>';
        products.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = `${p.name} (${p.category})`;
            opt.dataset.category = p.category;
            opt.dataset.name     = p.name;
            productSelect.appendChild(opt);
        });
    }

    // ────────────────────────────────────────────────────────
    // TRENDING PRODUCTS
    // ────────────────────────────────────────────────────────
    async function loadTrendingProducts() {
        const data = await API.get('/forecasting/trending');
        if (data?.success) {
            trendingProducts = data.data;
            renderTrendingGrid(trendingProducts);
        }
    }

    function renderTrendingGrid(products) {
        const grid = document.getElementById('trending-grid');
        if (!grid) return;

        if (!products.length) {
            grid.innerHTML = '<div class="loading-placeholder">No sales data available yet. Start making sales to see trends here!</div>';
            return;
        }

        grid.innerHTML = products.slice(0, 4).map(p => {
            const trendClass = p.trend > 5 ? 'up' : (p.trend < -5 ? 'down' : 'stable');
            const trendIcon  = p.trend > 5 ? '📈' : (p.trend < -5 ? '📉' : '📊');

            return `
                <div class="trending-card" data-product-id="${p.id}">
                    <div class="trend-icon">${trendIcon}</div>
                    <div class="trend-name">${p.name}</div>
                    <div class="trend-category">${p.category}</div>
                    <div class="trend-stats">
                        <span class="trend-badge ${trendClass}">${p.trend > 0 ? '+' : ''}${p.trend}%</span>
                        <span class="trend-value">${p.weekly_avg} units/wk</span>
                    </div>
                </div>
            `;
        }).join('');

        grid.querySelectorAll('.trending-card').forEach(card => {
            card.addEventListener('click', () => {
                productSelect.value = card.dataset.productId;
                runForecast();
            });
        });
    }

    // ────────────────────────────────────────────────────────
    // RESTOCK SUGGESTIONS
    // ────────────────────────────────────────────────────────
    async function loadRestockSuggestions() {
        const data = await API.get('/forecasting/restock-suggestions');
        if (data?.success) renderRestockGrid(data.data);
    }

    function renderRestockGrid(suggestions) {
        const grid    = document.getElementById('restock-grid');
        const section = document.getElementById('restock-section');
        if (!grid) return;

        if (!suggestions.length) {
            if (section) section.style.display = 'none';
            return;
        }

        if (section) section.style.display = '';

        grid.innerHTML = suggestions.slice(0, 6).map(s => `
            <div class="restock-item">
                <div class="restock-info">
                    <div class="restock-name">${s.name}</div>
                    <div class="restock-reason">${s.reason}</div>
                </div>
                <div class="restock-action">
                    <span class="restock-qty">${s.recommended_qty} units</span>
                    <button class="btn btn-sm btn-primary"
                            onclick="window.location.href='inventory.html'">Restock</button>
                </div>
            </div>
        `).join('');
    }

    // ────────────────────────────────────────────────────────
    // EVENT LISTENERS
    // ────────────────────────────────────────────────────────
    function setupEventListeners() {
        runBtn?.addEventListener('click', runForecast);
        compareBtn?.addEventListener('click', compareAllMethods);

        // Live product search filter
        productSearch?.addEventListener('input', e => {
            const term     = e.target.value.toLowerCase();
            const filtered = allProducts.filter(p =>
                p.name.toLowerCase().includes(term) ||
                p.category.toLowerCase().includes(term)
            );
            renderProductOptions(filtered);
        });

        // Quick filters
        document.querySelectorAll('.btn-filter').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.btn-filter').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                applyQuickFilter(btn.dataset.filter);
            });
        });

        // Algorithm card selection
        document.querySelectorAll('.algo-card').forEach(card => {
            card.addEventListener('click', () => {
                document.querySelectorAll('.algo-card').forEach(c => c.classList.remove('active'));
                card.classList.add('active');
                currentAlgorithm = card.dataset.algo;

                // Show/hide HW-specific advanced params
                const hwParams = document.getElementById('hw-params');
                if (hwParams) hwParams.style.display = currentAlgorithm === 'holt-winters' ? '' : 'none';
            });
        });

        // Slider live labels
        ['alpha', 'beta', 'gamma'].forEach(key => {
            const slider = document.getElementById(`forecast-${key}`);
            const label  = document.getElementById(`${key}-value`);
            slider?.addEventListener('input', () => { if (label) label.textContent = slider.value; });
        });

        // Modal
        closeModal?.addEventListener('click', () => modal?.classList.add('hidden'));
        modal?.addEventListener('click', e => { if (e.target === modal) modal.classList.add('hidden'); });
    }

    function applyQuickFilter(filter) {
        let filtered = [...allProducts];
        switch (filter) {
            case 'trending':
                filtered = filtered.filter(p => trendingProducts.some(t => t.id === p.id));
                break;
            case 'lowstock':
                filtered = filtered.filter(p => p.stock_quantity <= p.low_stock_threshold);
                break;
            case 'expiring':
                filtered = filtered.filter(p => p.days_to_expiry != null && p.days_to_expiry <= 30);
                break;
        }
        renderProductOptions(filtered);
    }

    // ────────────────────────────────────────────────────────
    // RUN FORECAST
    // ────────────────────────────────────────────────────────
    async function runForecast() {
        const productId = productSelect?.value;
        if (!productId) { Toast.show('Please select a product', 'warning'); return; }

        runBtn.disabled    = true;
        runBtn.innerHTML   = '<span class="loading-spinner"></span> Analyzing…';

        try {
            // Fetch history from backend
            const data = await API.get(`/forecasting/data/${productId}?weeks=24`);
            if (!data?.success) {
                Toast.show(data?.message || 'Failed to load sales history', 'error');
                return;
            }

            currentProduct = data.product;
            const history  = data.history;

            // Run selected algorithm client-side
            const result   = runAlgorithm(history, currentAlgorithm);

            renderForecastResults(data.product, history, result);
            resultsSection?.classList.remove('hidden');
            resultsSection?.scrollIntoView({ behavior: 'smooth' });
            Toast.show('Forecast generated!', 'success');

        } catch (err) {
            console.error(err);
            Toast.show('Error generating forecast', 'error');
        } finally {
            runBtn.disabled  = false;
            runBtn.innerHTML = '🔮 Generate Forecast';
        }
    }

    // ────────────────────────────────────────────────────────
    // ALGORITHM DISPATCHER
    // ────────────────────────────────────────────────────────
    function runAlgorithm(history, algorithm) {
        const sales   = history.map(h => h.total_qty);
        const periods = parseInt(document.getElementById('forecast-periods')?.value) || 4;

        switch (algorithm) {
            case 'moving-average':  return runMovingAverage(sales, periods);
            case 'exponential':     return runExponentialSmoothing(sales, periods);
            case 'holt-winters':    return runHoltWinters(sales, periods);
            default:                return runHoltWinters(sales, periods);
        }
    }

    // ── Moving Average ───────────────────────────────────────
    function runMovingAverage(sales, periods, window = 4) {
        const fitted = sales.map((_, i) => {
            if (i < window) return null;
            return Math.round(sales.slice(i - window, i).reduce((s, v) => s + v, 0) / window);
        });

        const lastSlice = sales.slice(-window);
        const avg       = Math.round(lastSlice.reduce((s, v) => s + v, 0) / window);
        const std       = Math.sqrt(lastSlice.reduce((s, v) => s + (v - avg) ** 2, 0) / window);

        const predictions = Array.from({ length: periods }, (_, i) => ({
            forecast:   avg,
            upperBound: Math.round(avg + 1.44 * std),
            lowerBound: Math.max(0, Math.round(avg - 1.44 * std))
        }));

        const pattern = buildPattern(sales, fitted);
        const mape    = calcMAPE(sales.slice(window), fitted.slice(window).filter(v => v !== null));

        return { predictions, components: { fitted, levels: [], trends: [], seasonals: [] }, pattern, mape };
    }

    // ── Simple Exponential Smoothing ─────────────────────────
    function runExponentialSmoothing(sales, periods) {
        const alpha  = parseFloat(document.getElementById('forecast-alpha')?.value) || 0.3;
        const fitted = [sales[0]];

        for (let i = 1; i < sales.length; i++) {
            fitted.push(Math.round(alpha * sales[i] + (1 - alpha) * fitted[i - 1]));
        }

        const last    = fitted[fitted.length - 1];
        const errors  = sales.map((v, i) => Math.abs(v - (fitted[i] || v)));
        const avgErr  = errors.reduce((s, v) => s + v, 0) / errors.length;

        const predictions = Array.from({ length: periods }, () => ({
            forecast:   last,
            upperBound: Math.round(last + 1.44 * avgErr),
            lowerBound: Math.max(0, Math.round(last - 1.44 * avgErr))
        }));

        const pattern = buildPattern(sales, fitted);
        const mape    = calcMAPE(sales, fitted);

        return { predictions, components: { fitted, levels: [], trends: [], seasonals: [] }, pattern, mape };
    }

    // ── Holt-Winters Triple Exponential Smoothing ────────────
    function runHoltWinters(sales, periods) {
        const alpha  = parseFloat(document.getElementById('forecast-alpha')?.value)        || 0.3;
        const beta   = parseFloat(document.getElementById('forecast-beta')?.value)         || 0.1;
        const gamma  = parseFloat(document.getElementById('forecast-gamma')?.value)        || 0.3;
        const s      = parseInt(document.getElementById('forecast-season-length')?.value)  || 4;

        const n = sales.length;
        if (n < s * 2) {
            // Not enough data for full HW — fall back to SES
            return runExponentialSmoothing(sales, periods);
        }

        // Initialise
        let L = sales.slice(0, s).reduce((sum, v) => sum + v, 0) / s;
        let T = (sales.slice(s, s * 2).reduce((sum, v) => sum + v, 0) / s - L) / s;

        // Initial seasonal indices
        const S = [];
        for (let i = 0; i < s; i++) {
            S.push(sales[i] / (L || 1));
        }

        const levels    = [];
        const trends    = [];
        const seasonals = [...S];
        const fitted    = [];

        for (let t = 0; t < n; t++) {
            const si = seasonals[t] ?? seasonals[t % s] ?? 1;
            const Lp = L, Tp = T;

            if (t >= s) {
                L = alpha * (sales[t] / (si || 1)) + (1 - alpha) * (Lp + Tp);
                T = beta  * (L - Lp)               + (1 - beta)  * Tp;
                const newS = gamma * (sales[t] / (L || 1)) + (1 - gamma) * si;
                seasonals.push(newS);
            }

            levels.push(Math.round(L * 10) / 10);
            trends.push(Math.round(T * 100) / 100);
            fitted.push(Math.max(0, Math.round((L + T) * (seasonals[t % s] ?? 1))));
        }

        // Forecast
        const predictions = [];
        for (let m = 1; m <= periods; m++) {
            const sIdx      = (n + m - 1) % s;
            const sVal      = seasonals[n - s + sIdx] ?? seasonals[sIdx] ?? 1;
            const fcst      = Math.max(0, Math.round((L + m * T) * sVal));
            const absErrors = sales.map((v, i) => Math.abs(v - fitted[i]));
            const rmse      = Math.sqrt(absErrors.reduce((sum, e) => sum + e * e, 0) / absErrors.length);

            predictions.push({
                forecast:   fcst,
                upperBound: Math.round(fcst + 1.44 * rmse),
                lowerBound: Math.max(0, Math.round(fcst - 1.44 * rmse))
            });
        }

        const pattern = buildPattern(sales, fitted);
        const mape    = calcMAPE(sales, fitted);

        return { predictions, components: { levels, trends, seasonals: seasonals.slice(0, n), fitted }, pattern, mape };
    }

    // ────────────────────────────────────────────────────────
    // PATTERN ANALYSIS HELPER
    // ────────────────────────────────────────────────────────
    function buildPattern(sales, fitted) {
        const nonZero   = sales.filter(v => v > 0);
        const baseline  = nonZero.length
            ? Math.round(nonZero.reduce((s, v) => s + v, 0) / nonZero.length)
            : 0;

        // Simple linear trend over last 4 weeks vs first 4
        const first4  = sales.slice(0, 4).reduce((s, v) => s + v, 0) / 4 || 1;
        const last4   = sales.slice(-4).reduce((s, v) => s + v, 0)  / 4;
        const trend   = Math.round(((last4 - first4) / first4) * 100);

        // Seasonal spike: max week vs average
        const maxSale      = Math.max(...sales);
        const seasonalSpike = baseline > 0 ? Math.round(((maxSale - baseline) / baseline) * 100) : 0;
        const maxIdx       = sales.indexOf(maxSale);
        const quarter      = Math.floor((maxIdx / sales.length) * 4) + 1;
        const peakSeason   = `Peak in Q${quarter} (${['Jan–Mar', 'Apr–Jun', 'Jul–Sep', 'Oct–Dec'][quarter - 1]})`;

        return { baseline, trend, seasonalSpike, peakSeason };
    }

    // ────────────────────────────────────────────────────────
    // RENDER FORECAST RESULTS
    // ────────────────────────────────────────────────────────
    function renderForecastResults(product, history, result) {
        const { predictions, components, pattern, mape } = result;

        // Header
        document.getElementById('forecast-product-name').textContent     = product.name;
        document.getElementById('forecast-product-category').textContent = product.category;
        document.getElementById('quick-stock').textContent   = product.stock_quantity ?? '—';
        document.getElementById('quick-reorder').textContent = product.reorder_level  ?? '—';
        document.getElementById('quick-price').textContent   = typeof Fmt !== 'undefined'
            ? Fmt.currency(product.price)
            : `₱${parseFloat(product.price || 0).toFixed(2)}`;

        // Chart title
        const methodNames = {
            'moving-average': 'Moving Average',
            'exponential':    'Exponential Smoothing',
            'holt-winters':   'Holt-Winters (Seasonal)'
        };
        document.getElementById('chart-title').textContent =
            `${product.name} — ${methodNames[currentAlgorithm] || ''} Forecast`;

        renderPatternInsights(pattern, mape);
        renderForecastChart(history, predictions, components.fitted);
        renderPredictionsGrid(predictions);
        renderRecommendation(predictions, product);
        renderComponentsTable(history, components);
    }

    function renderPatternInsights(pattern, mape) {
        const container = document.getElementById('pattern-insights');
        if (!container) return;

        container.innerHTML = `
            <div class="pattern-item">
                <span class="pattern-icon">📊</span>
                <div class="pattern-info">
                    <div class="pattern-label">Baseline Demand</div>
                    <div class="pattern-value">${pattern.baseline} units/week</div>
                    <div class="pattern-sub">Average weekly sales</div>
                </div>
            </div>
            <div class="pattern-item">
                <span class="pattern-icon">📈</span>
                <div class="pattern-info">
                    <div class="pattern-label">Growth Trend</div>
                    <div class="pattern-value">${pattern.trend > 0 ? '+' : ''}${pattern.trend}%</div>
                    <div class="pattern-sub">${pattern.trend > 2 ? 'Growing steadily' : (pattern.trend < -2 ? 'Declining' : 'Stable demand')}</div>
                </div>
            </div>
            <div class="pattern-item">
                <span class="pattern-icon">🔄</span>
                <div class="pattern-info">
                    <div class="pattern-label">Seasonal Spike</div>
                    <div class="pattern-value">+${pattern.seasonalSpike}% during peak</div>
                    <div class="pattern-sub">${pattern.peakSeason}</div>
                </div>
            </div>
        `;
    }

    function renderPredictionsGrid(predictions) {
        const grid = document.getElementById('predictions-grid');
        if (!grid) return;

        const maxFcst = Math.max(...predictions.map(p => p.forecast));

        grid.innerHTML = predictions.map((p, i) => {
            let cardClass = '', tagClass = '', tagText = '';

            if (p.forecast >= maxFcst * 0.9 && maxFcst > 0) {
                cardClass = 'urgent'; tagClass = 'urgent'; tagText = '🔴 Peak Week';
            } else if (p.forecast >= maxFcst * 0.7 && maxFcst > 0) {
                cardClass = 'warning'; tagClass = 'warning'; tagText = '⚠️ High Demand';
            }

            return `
                <div class="prediction-card ${cardClass}">
                    <div class="pred-week">Week ${i + 1}</div>
                    <div class="pred-value">${p.forecast}</div>
                    <div class="pred-unit">units</div>
                    <div class="pred-range">${p.lowerBound} – ${p.upperBound}</div>
                    ${tagText ? `<span class="pred-tag ${tagClass}">${tagText}</span>` : ''}
                </div>
            `;
        }).join('');
    }

    function renderRecommendation(predictions, product) {
        const container = document.getElementById('recommendation-body');
        if (!container) return;

        const totalForecast    = predictions.reduce((s, p) => s + p.forecast, 0);
        const recommendedOrder = Math.ceil(totalForecast * 1.2);
        const currentStock     = product.stock_quantity || 0;

        const stockStatus = currentStock >= totalForecast
            ? '✅ Adequate'
            : currentStock >= totalForecast * 0.5
            ? '⚠️ Monitor'
            : '🔴 Reorder Now';

        const orderDate = new Date();
        orderDate.setDate(orderDate.getDate() + 7);
        const orderDateLabel = orderDate.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', timeZone: 'Asia/Manila' });

        const price             = parseFloat(product.price) || 0;
        const estimatedSavings  = Math.round(recommendedOrder * price * 0.15);
        const fmtPrice          = v => typeof Fmt !== 'undefined'
            ? Fmt.currency(v)
            : `₱${v.toLocaleString('en-PH', { minimumFractionDigits: 2 })}`;

        container.innerHTML = `
            <div class="rec-stat">
                <div class="rec-label">Recommended Order</div>
                <div class="rec-value">${recommendedOrder}</div>
                <small>units (incl. 20% safety buffer)</small>
            </div>
            <div class="rec-stat">
                <div class="rec-label">Current Stock Status</div>
                <div class="rec-value" style="font-size:1.2rem">${stockStatus}</div>
                <small>${currentStock} units available</small>
            </div>
            <div class="rec-stat">
                <div class="rec-label">Estimated Savings</div>
                <div class="rec-value" style="font-size:1.4rem">${fmtPrice(estimatedSavings)}</div>
                <small>Reduced stockout / expiry loss</small>
            </div>
            <div class="rec-action">
                <div class="rec-message">
                    📦 Order ${recommendedOrder} units by ${orderDateLabel} to cover next ${predictions.length} week${predictions.length !== 1 ? 's' : ''}
                </div>
                <div class="rec-deadline">
                    Forecast total demand: ${totalForecast} units
                </div>
            </div>
        `;
    }

    function renderForecastChart(history, predictions, fitted) {
        const ctx = document.getElementById('forecast-chart')?.getContext('2d');
        if (!ctx) return;
        if (forecastChart) forecastChart.destroy();

        const labels = [
            ...history.map(h => h.week_label),
            ...predictions.map((_, i) => `Wk +${i + 1}`)
        ];

        const actualData  = [...history.map(h => h.total_qty),       ...Array(predictions.length).fill(null)];
        const fittedData  = [...(fitted || []),                       ...Array(predictions.length).fill(null)];
        const forecastData = [
            ...Array(history.length - 1).fill(null),
            history[history.length - 1].total_qty,
            ...predictions.map(p => p.forecast)
        ];
        const upper = [...Array(history.length).fill(null), ...predictions.map(p => p.upperBound)];
        const lower = [...Array(history.length).fill(null), ...predictions.map(p => p.lowerBound)];

        forecastChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels,
                datasets: [
                    {
                        label: 'Actual Sales',
                        data: actualData,
                        borderColor: '#0d6efd',
                        backgroundColor: 'rgba(13,110,253,0.08)',
                        borderWidth: 2,
                        pointRadius: 4,
                        tension: 0.3
                    },
                    {
                        label: 'Fitted Values',
                        data: fittedData,
                        borderColor: '#198754',
                        borderWidth: 2,
                        borderDash: [4, 4],
                        pointRadius: 2,
                        tension: 0.3
                    },
                    {
                        label: 'Forecast',
                        data: forecastData,
                        borderColor: '#dc3545',
                        borderWidth: 3,
                        borderDash: [8, 4],
                        pointRadius: 5,
                        pointStyle: 'triangle',
                        tension: 0
                    },
                    {
                        label: 'Upper Bound (85% CI)',
                        data: upper,
                        borderColor: '#ffc107',
                        borderWidth: 1,
                        borderDash: [2, 2],
                        pointRadius: 0,
                        fill: false
                    },
                    {
                        label: 'Lower Bound',
                        data: lower,
                        borderColor: '#ffc107',
                        borderWidth: 1,
                        borderDash: [2, 2],
                        pointRadius: 0,
                        fill: '-1',
                        backgroundColor: 'rgba(255,193,7,0.1)'
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'top' },
                    tooltip: {
                        callbacks: {
                            label: ctx => `${ctx.dataset.label}: ${ctx.raw ?? '—'} units`
                        }
                    }
                },
                scales: {
                    y: { beginAtZero: true, title: { display: true, text: 'Units Sold' } }
                }
            }
        });
    }

    function renderComponentsTable(history, components) {
        const tbody = document.getElementById('components-tbody');
        if (!tbody) return;

        tbody.innerHTML = history.map((h, i) => `
            <tr>
                <td>${h.week_label}</td>
                <td>${h.total_qty}</td>
                <td>${components.levels?.[i]   ?? '—'}</td>
                <td>${components.trends?.[i]   != null ? components.trends[i].toFixed(2)   : '—'}</td>
                <td>${components.seasonals?.[i] != null ? components.seasonals[i].toFixed(2) : '—'}</td>
                <td>${components.fitted?.[i]   ?? '—'}</td>
            </tr>
        `).join('');
    }

    // ────────────────────────────────────────────────────────
    // COMPARE ALL METHODS
    // ────────────────────────────────────────────────────────
    async function compareAllMethods() {
        const productId = productSelect?.value;
        if (!productId) { Toast.show('Please select a product first', 'warning'); return; }

        compareBtn.disabled  = true;
        compareBtn.innerHTML = '<span class="loading-spinner"></span> Comparing…';

        try {
            const data = await API.get(`/forecasting/compare/${productId}`);
            if (data?.success) {
                renderComparisonModal(data);
                modal?.classList.remove('hidden');
            } else {
                Toast.show('Failed to compare methods', 'error');
            }
        } catch {
            Toast.show('Error comparing methods', 'error');
        } finally {
            compareBtn.disabled  = false;
            compareBtn.innerHTML = '📊 Compare All Methods';
        }
    }

    function renderComparisonModal(data) {
        const body = document.getElementById('comparison-body');
        if (!body) return;

        body.innerHTML = `
            <table class="data-table">
                <thead>
                    <tr>
                        <th>Method</th>
                        <th>Forecast Total (Next 4 Wks)</th>
                        <th>Accuracy (MAPE)</th>
                        <th>Best For</th>
                    </tr>
                </thead>
                <tbody>
                    ${data.methods.map(m => `
                        <tr>
                            <td><strong>${m.name}</strong></td>
                            <td>${m.totalForecast != null ? m.totalForecast + ' units' : '<em>See chart</em>'}</td>
                            <td>${m.mape}${typeof m.mape === 'number' ? '%' : ''}</td>
                            <td>${m.bestFor}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
            <div class="comparison-recommendation" style="margin-top:20px;">
                <h4>💡 Recommendation</h4>
                <p>${data.recommendation}</p>
            </div>
        `;
    }

    // ────────────────────────────────────────────────────────
    // HELPERS
    // ────────────────────────────────────────────────────────
    function calcMAPE(actual, fitted) {
        let sum = 0, count = 0;
        for (let i = 0; i < Math.min(actual.length, fitted.length); i++) {
            if (actual[i] > 0 && fitted[i] != null) {
                sum += Math.abs((actual[i] - fitted[i]) / actual[i]);
                count++;
            }
        }
        return count === 0 ? 0 : parseFloat(((sum / count) * 100).toFixed(1));
    }

    function checkUrlParams() {
        const params    = new URLSearchParams(window.location.search);
        const productId = params.get('product');
        if (productId && productSelect) {
            productSelect.value = productId;
            setTimeout(runForecast, 600);
        }
    }
});