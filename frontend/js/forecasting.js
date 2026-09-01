// ============================================================
// PharmaTrack – forecasting.js
// Demand Forecasting: 3 algorithms, user-friendly output
//
// Algorithms:
//   1. Simple Average (Moving Average — 4-week window)
//   2. Weighted Average (Simple Exponential Smoothing)
//   3. Seasonal Forecast (Holt-Winters Triple Exponential Smoothing)
// ============================================================

document.addEventListener('DOMContentLoaded', async () => {
    if (!Auth.requireAuth(['admin', 'super_admin'])) return;

    // ── State ────────────────────────────────────────────────
    let currentAlgorithm = 'holt-winters';
    let forecastChart    = null;
    let allProducts      = [];
    let trendingProducts = [];
    let lastForecastData = null; // { product, history } from the most recent /forecasting/data call
    let isCalculating     = false;

    // Per-algorithm forecast horizon options. Deliberately different per
    // method — a flat method like Moving Average doesn't get meaningfully
    // more accurate (or honest) by projecting further out, so longer
    // horizons simply aren't offered for it.
    const HORIZON_OPTIONS = {
        'moving-average': [
            { value: 1, label: '1 Week' },
            { value: 2, label: '2 Weeks' },
            { value: 4, label: '4 Weeks' }
        ],
        'exponential': [
            { value: 1, label: '1 Week' },
            { value: 2, label: '2 Weeks' },
            { value: 4, label: '4 Weeks' },
            { value: 8, label: '8 Weeks' },
            { value: 12, label: '12 Weeks', lowConfidence: true }
        ],
        'holt-winters': [
            { value: 1, label: '1 Week' },
            { value: 4, label: '4 Weeks' },
            { value: 8, label: '8 Weeks' },
            { value: 12, label: '12 Weeks' },
            { value: 'custom', label: 'Custom' }
        ]
    };

    let selectedHorizon = 4; // weeks; 'custom' when the Custom option is chosen

    // ── DOM ─────────────────────────────────────────────────
    const productSelect      = document.getElementById('forecast-product');
    const productSearch      = document.getElementById('product-search');
    const compareBtn         = document.getElementById('btn-compare-all');
    const resultsSection     = document.getElementById('forecast-results');
    const modal              = document.getElementById('comparison-modal');
    const closeModal         = document.getElementById('close-modal');
    const horizonButtonsEl   = document.getElementById('horizon-buttons');
    const horizonCustomWrap  = document.getElementById('horizon-custom-wrap');
    const horizonCustomInput = document.getElementById('horizon-custom-input');
    const horizonConfidenceEl= document.getElementById('horizon-confidence-note');

    // ── Algorithm explainer texts ─────────────────────────────
    const ALGO_INFO = {
        'moving-average': {
            title: 'Simple Average Method',
            desc:  'This method takes the average of the last 4 weeks of sales and uses that as the prediction for all future weeks. It works best for products with very stable, predictable demand that does not change much over time.'
        },
        'exponential': {
            title: 'Weighted Average Method',
            desc:  'This method gives more importance to recent sales when making predictions. If sales went up last week, the forecast will reflect that faster than a plain average. Good for products whose demand is slowly changing in one direction.'
        },
        'holt-winters': {
            title: 'Seasonal Forecast Method (Recommended)',
            desc:  'This is the most advanced method. It tracks three things at once: the normal level of demand, whether demand is growing or shrinking over time, and repeating seasonal patterns (like higher antibiotic sales when there is a flu outbreak). This is the best choice for most pharmacy products in the Philippines.'
        }
    };

    // ── Boot ────────────────────────────────────────────────
    renderHorizonButtons(currentAlgorithm);
    await Promise.all([loadProducts(), loadTrendingProducts(), loadRestockSuggestions()]);
    setupEventListeners();
    checkUrlParams();

    // ────────────────────────────────────────────────────────
    // LOAD PRODUCTS
    // ────────────────────────────────────────────────────────
    async function loadProducts() {
        const data = await API.get('/forecasting/products');
        if (!data?.success) { Toast.show('Could not load product list. Please refresh the page.', 'error'); return; }
        allProducts = data.data;
        renderProductOptions(allProducts);
        selectFirstAndRun(allProducts);
    }

    function renderProductOptions(products) {
        if (!productSelect) return;
        productSelect.innerHTML = '<option value="">Select a product</option>';
        products.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = `${p.name} (${p.category})`;
            opt.dataset.category = p.category;
            opt.dataset.name     = p.name;
            productSelect.appendChild(opt);
        });
    }

    // Auto-selects the first product in whatever list is currently shown
    // (respecting the active quick filter / search) and runs its forecast,
    // so the page always has something meaningful on screen without the
    // user needing to manually pick a product first.
    function selectFirstAndRun(products) {
        if (!productSelect) return;
        if (!products.length) {
            productSelect.value = '';
            resultsSection?.classList.add('hidden');
            return;
        }
        productSelect.value = products[0].id;
        runForecast();
    }

    // A dedicated combobox for #product-search -- clicking/focusing it
    // shows EVERY product (like opening a normal dropdown), and typing
    // floats whatever matches to the top WITHOUT removing anything else
    // from the list, so it never looks like products "disappeared". This
    // is deliberately its own small implementation rather than the shared
    // SearchSuggest component (main.js), which hides non-matching items
    // entirely and shows nothing at all until there's a query -- exactly
    // the opposite of what's needed here.
    function setupProductCombobox() {
        if (!productSearch) return;

        const wrap = document.createElement('div');
        wrap.className = 'search-suggest-wrap';
        productSearch.parentNode.insertBefore(wrap, productSearch);
        wrap.appendChild(productSearch);

        const dropdown = document.createElement('div');
        dropdown.className = 'search-suggest-dropdown hidden';
        wrap.appendChild(dropdown);

        function esc(str) {
            return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }

        // Every product, always -- just reordered so a name that STARTS
        // WITH the typed text ranks above one where it's merely buried in
        // the middle, and everything else keeps its normal order after
        // those matches (same relevance idea SearchSuggest itself uses,
        // minus the "hide anything that doesn't match" part).
        function orderedProducts(query) {
            const q = query.trim().toLowerCase();
            if (!q) return allProducts;
            const starts = [], contains = [], rest = [];
            allProducts.forEach(p => {
                const label = p.name.toLowerCase();
                if (label.startsWith(q))      starts.push(p);
                else if (label.includes(q))   contains.push(p);
                else                          rest.push(p);
            });
            return [...starts, ...contains, ...rest];
        }

        function renderDropdown() {
            const items = orderedProducts(productSearch.value);
            if (!items.length) { dropdown.classList.add('hidden'); return; }

            dropdown.innerHTML = items.map((p, i) => `
                <button type="button" class="search-suggest-item" data-index="${i}">
                    <span class="search-suggest-label">${esc(p.name)}</span>
                    <span class="search-suggest-sub">${esc(p.category)}</span>
                </button>
            `).join('');

            dropdown.querySelectorAll('.search-suggest-item').forEach(btn => {
                // mousedown (not click) fires BEFORE the input's blur event,
                // same reasoning as SearchSuggest -- otherwise blur hides the
                // dropdown before the click ever registers.
                btn.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    selectProduct(items[parseInt(btn.dataset.index)]);
                });
            });

            dropdown.classList.remove('hidden');
        }

        function selectProduct(p) {
            productSearch.value = p.name;
            dropdown.classList.add('hidden');

            // A direct pick from this dropdown isn't scoped to whichever
            // quick filter happened to be active, so that filter no longer
            // describes what's shown -- reset to "All" to match.
            document.querySelectorAll('.btn-filter').forEach(b => b.classList.remove('active'));
            document.querySelector('.btn-filter[data-filter="all"]')?.classList.add('active');
            renderProductOptions(allProducts);

            productSelect.value = p.id;
            runForecast();
        }

        productSearch.addEventListener('focus', () => {
            productSearch.select(); // next keystroke starts a fresh search
            renderDropdown();
        });
        productSearch.addEventListener('input', renderDropdown);
        productSearch.addEventListener('blur', () => {
            setTimeout(() => dropdown.classList.add('hidden'), 120);
        });
        productSearch.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') dropdown.classList.add('hidden');
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
            grid.innerHTML = '<div class="loading-placeholder" style="grid-column:1/-1">No sales data yet. Start making sales in the POS to see trending products here!</div>';
            return;
        }

        grid.innerHTML = products.slice(0, 4).map(p => {
            const trendClass = p.trend > 5 ? 'up' : (p.trend < -5 ? 'down' : 'stable');
            const trendLabel = p.trend > 5 ? `▲ ${p.trend}% vs last month`
                             : p.trend < -5 ? `▼ ${Math.abs(p.trend)}% vs last month`
                             : `Stable demand`;

            return `
                <div class="trending-card" data-product-id="${p.id}" title="Click to forecast ${p.name}">
                    <div class="trend-name">${p.name}</div>
                    <div class="trend-category">${p.category}</div>
                    <div class="trend-stats">
                        <span class="trend-badge ${trendClass}">${trendLabel}</span>
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
                    <span class="restock-qty">Order ${s.recommended_qty}</span>
                    <button class="btn btn-sm btn-primary"
                            onclick="window.location.href='inventory.html'">Restock</button>
                </div>
            </div>
        `).join('');
    }

    // ────────────────────────────────────────────────────────
    // FORECAST HORIZON SELECTOR
    // ────────────────────────────────────────────────────────
    function renderHorizonButtons(algo) {
        if (!horizonButtonsEl) return;
        const options = HORIZON_OPTIONS[algo] || HORIZON_OPTIONS['holt-winters'];

        // Keep the current selection if it's still valid for this algorithm;
        // otherwise fall back to 4 weeks (present in every option set).
        const stillValid = options.some(o => o.value === selectedHorizon);
        if (!stillValid) selectedHorizon = 4;

        horizonButtonsEl.innerHTML = options.map(o => `
            <button type="button" class="horizon-btn ${o.value === selectedHorizon ? 'active' : ''}" data-value="${o.value}">
                ${o.label}${o.lowConfidence ? '<span class="low-confidence-tag">Low confidence</span>' : ''}
            </button>
        `).join('');

        horizonButtonsEl.querySelectorAll('.horizon-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                horizonButtonsEl.querySelectorAll('.horizon-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');

                const raw = btn.dataset.value;
                selectedHorizon = raw === 'custom' ? 'custom' : parseInt(raw);

                horizonCustomWrap?.classList.toggle('hidden', selectedHorizon !== 'custom');

                updateConfidenceNote();
                if (productSelect?.value) runForecast();
            });
        });

        horizonCustomWrap?.classList.toggle('hidden', selectedHorizon !== 'custom');
        updateConfidenceNote();
    }

    horizonCustomInput?.addEventListener('change', () => {
        if (selectedHorizon === 'custom' && productSelect?.value) runForecast();
    });

    function resolvePeriods() {
        if (selectedHorizon === 'custom') {
            const v = parseInt(horizonCustomInput?.value) || 6;
            return Math.min(Math.max(v, 1), 26);
        }
        return selectedHorizon;
    }

    // Shows a plain-language warning when a longer Holt-Winters horizon is
    // requested but the product doesn't yet have close to a year of real
    // sales history behind it — the seasonal component is a guess in that
    // case, not a learned pattern.
    function updateConfidenceNote() {
        if (!horizonConfidenceEl) return;

        const periods = resolvePeriods();
        const isLongHWHorizon = currentAlgorithm === 'holt-winters' && periods >= 8;
        const isLowConfSES    = currentAlgorithm === 'exponential' && periods === 12;

        if (isLowConfSES) {
            horizonConfidenceEl.textContent = '12-week forecasts with this method drift in a straight line and get less reliable past ~2 months. Treat this as a rough estimate.';
            horizonConfidenceEl.classList.remove('hidden');
            return;
        }

        if (isLongHWHorizon) {
            const spanDays = lastForecastData?.data_span_days;
            if (spanDays != null && spanDays < 300) {
                horizonConfidenceEl.textContent = `Limited historical data: this product only has about ${Math.round(spanDays / 7)} week(s) of sales on record. Seasonal patterns need close to a year of data to be reliable, so treat this ${periods}-week forecast as lower confidence.`;
                horizonConfidenceEl.classList.remove('hidden');
                return;
            }
        }

        horizonConfidenceEl.classList.add('hidden');
    }

    // ────────────────────────────────────────────────────────
    // EVENT LISTENERS
    // ────────────────────────────────────────────────────────
    function setupEventListeners() {
        compareBtn?.addEventListener('click', compareAllMethods);

        // Choosing a product directly from the dropdown runs its forecast
        // immediately — there's no separate "Generate" step anymore.
        productSelect?.addEventListener('change', () => {
            if (productSelect.value) runForecast();
        });

        // The visible box is #product-search alone now -- see
        // setupProductCombobox() for how it behaves (click to see every
        // product, type to float matches to the top without hiding the
        // rest).
        setupProductCombobox();

        // Quick filters — auto-selects & forecasts the first product in
        // whichever filtered list results.
        document.querySelectorAll('.btn-filter').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.btn-filter').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                applyQuickFilter(btn.dataset.filter);
            });
        });

        // Algorithm card selection — auto-generates the forecast immediately
        document.querySelectorAll('.algo-card').forEach(card => {
            card.addEventListener('click', () => {
                document.querySelectorAll('.algo-card').forEach(c => c.classList.remove('active'));
                card.classList.add('active');
                currentAlgorithm = card.dataset.algo;
                updateAlgoExplainer(currentAlgorithm);
                renderHorizonButtons(currentAlgorithm);

                // Advanced Parameters: alpha applies to both Exponential
                // Smoothing and Holt-Winters, so the whole block shows for
                // either -- only Moving Average has nothing to tune. The
                // beta/gamma/season-length sub-group is Holt-Winters only.
                const hwParams     = document.getElementById('hw-params');
                const hwOnlyParams = document.querySelector('.hw-only-params');
                const summaryText  = document.getElementById('hw-params-summary');
                if (hwParams) {
                    hwParams.style.display = currentAlgorithm === 'moving-average' ? 'none' : '';
                }
                if (hwOnlyParams) {
                    hwOnlyParams.style.display = currentAlgorithm === 'holt-winters' ? 'flex' : 'none';
                }
                if (summaryText) {
                    summaryText.textContent = currentAlgorithm === 'holt-winters'
                        ? 'Advanced Parameters (α, β, γ) Holt-Winters only'
                        : 'Advanced Parameters (α) Exponential Smoothing only';
                }

                if (productSelect?.value) runForecast();
            });
        });

        // Slider live labels — also re-run automatically since these only
        // affect Holt-Winters math and that's the only time they're visible
        ['alpha', 'beta', 'gamma'].forEach(key => {
            const slider = document.getElementById(`forecast-${key}`);
            const label  = document.getElementById(`${key}-value`);
            slider?.addEventListener('input', () => { if (label) label.textContent = slider.value; });
            slider?.addEventListener('change', () => {
                if (currentAlgorithm === 'holt-winters' && productSelect?.value) runForecast();
            });
        });
        document.getElementById('forecast-season-length')?.addEventListener('change', () => {
            if (currentAlgorithm === 'holt-winters' && productSelect?.value) runForecast();
        });

        // Close modal -- only the X button closes this now, not clicking
        // outside (consistent with every other modal in the app).
        closeModal?.addEventListener('click', () => modal?.classList.add('hidden'));
    }

    function updateAlgoExplainer(algo) {
        const info     = ALGO_INFO[algo];
        const titleEl  = document.getElementById('explainer-title');
        const descEl   = document.getElementById('explainer-desc');
        if (titleEl) titleEl.textContent = info.title;
        if (descEl)  descEl.textContent  = info.desc;
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
                filtered = filtered.filter(p => p.days_to_expiry != null && p.days_to_expiry <= 30 && p.days_to_expiry >= 0);
                break;
        }
        renderProductOptions(filtered);
        selectFirstAndRun(filtered);
    }

    // ────────────────────────────────────────────────────────
    // RUN FORECAST
    // ────────────────────────────────────────────────────────
    // Keeps the visible combobox text in sync with whatever's actually
    // selected in the (now-hidden) #forecast-product, regardless of HOW
    // the selection happened -- trending-card click, quick filter,
    // direct search-pick, or the ?product= URL param -- since runForecast
    // is the one place all of those funnel through.
    function syncSearchInputToSelection() {
        if (!productSearch || !productSelect) return;
        const opt = productSelect.options[productSelect.selectedIndex];
        if (opt && opt.value) productSearch.value = opt.dataset.name || opt.textContent;
    }

    async function runForecast() {
        const productId = productSelect?.value;
        if (!productId) { Toast.show('Please select a product first.', 'warning'); return; }

        syncSearchInputToSelection();

        if (isCalculating) return; // avoid overlapping calls from rapid clicks
        isCalculating = true;

        try {
            const data = await API.get(`/forecasting/data/${productId}?weeks=52`);
            if (!data?.success) {
                Toast.show(data?.message || 'Could not load sales history for this product.', 'error');
                return;
            }

            lastForecastData = data;
            updateConfidenceNote();

            const result = runAlgorithm(data.history, currentAlgorithm);
            renderForecastResults(data.product, data.history, result);
            resultsSection?.classList.remove('hidden');
            resultsSection?.scrollIntoView({ behavior: 'smooth', block: 'start' });

        } catch (err) {
            console.error(err);
            Toast.show('Something went wrong. Please try again.', 'error');
        } finally {
            isCalculating = false;
        }
    }

    // ────────────────────────────────────────────────────────
    // ALGORITHM DISPATCHER
    // ────────────────────────────────────────────────────────
    function runAlgorithm(history, algorithm) {
        const sales   = history.map(h => h.total_qty);
        const periods = resolvePeriods();

        switch (algorithm) {
            case 'moving-average': return runMovingAverage(sales, periods);
            case 'exponential':    return runExponentialSmoothing(sales, periods);
            case 'holt-winters':   return runHoltWinters(sales, periods);
            default:               return runHoltWinters(sales, periods);
        }
    }

    // ── 1. Simple Moving Average ──────────────────────────────
    function runMovingAverage(sales, periods, window = 4) {
        const fitted = sales.map((_, i) => {
            if (i < window) return null;
            const slice = sales.slice(i - window, i);
            return Math.round(slice.reduce((s, v) => s + v, 0) / window);
        });

        // Forecast = last window average (flat projection)
        const lastSlice = sales.slice(-window);
        const avg       = Math.round(lastSlice.reduce((s, v) => s + v, 0) / window);
        const std       = Math.sqrt(lastSlice.reduce((s, v) => s + (v - avg) ** 2, 0) / Math.max(window - 1, 1));

        const predictions = Array.from({ length: periods }, () => ({
            forecast:   avg,
            upperBound: Math.round(avg + 1.5 * std),
            lowerBound: Math.max(0, Math.round(avg - 1.5 * std))
        }));

        const pattern = buildPattern(sales, fitted.filter(v => v !== null));
        const mape    = calcMAPE(sales.slice(window), fitted.slice(window).filter(v => v !== null));

        return { predictions, components: { fitted, levels: [], trends: [], seasonals: [] }, pattern, mape, method: 'Moving Average' };
    }

    // ── 2. Simple Exponential Smoothing ─────────────────────
    function runExponentialSmoothing(sales, periods) {
        const alpha = parseFloat(document.getElementById('forecast-alpha')?.value) || 0.3;

        const fitted = [sales[0]];
        for (let i = 1; i < sales.length; i++) {
            fitted.push(Math.round(alpha * sales[i] + (1 - alpha) * fitted[i - 1]));
        }

        const last    = fitted[fitted.length - 1];
        const absErrs = sales.map((v, i) => Math.abs(v - fitted[i]));
        const avgErr  = absErrs.reduce((s, v) => s + v, 0) / absErrs.length;

        const predictions = Array.from({ length: periods }, () => ({
            forecast:   last,
            upperBound: Math.round(last + 1.5 * avgErr),
            lowerBound: Math.max(0, Math.round(last - 1.5 * avgErr))
        }));

        const pattern = buildPattern(sales, fitted);
        const mape    = calcMAPE(sales, fitted);

        return { predictions, components: { fitted, levels: [], trends: [], seasonals: [] }, pattern, mape, method: 'Exponential Smoothing' };
    }

    // ── 3. Holt-Winters Triple Exponential Smoothing ─────────
    function runHoltWinters(sales, periods) {
        const alpha = parseFloat(document.getElementById('forecast-alpha')?.value)       || 0.3;
        const beta  = parseFloat(document.getElementById('forecast-beta')?.value)        || 0.1;
        const gamma = parseFloat(document.getElementById('forecast-gamma')?.value)       || 0.3;
        const s     = parseInt(document.getElementById('forecast-season-length')?.value) || 4;

        const n = sales.length;

        // Need at least 2 full seasons for HW; fall back to SES otherwise
        if (n < s * 2) {
            const result = runExponentialSmoothing(sales, periods);
            result.method = 'Holt-Winters (limited data, used Exponential Smoothing instead)';
            return result;
        }

        // ── Initialise ───────────────────────────────────────
        let L = sales.slice(0, s).reduce((sum, v) => sum + v, 0) / s;
        let T = (sales.slice(s, s * 2).reduce((sum, v) => sum + v, 0) / s - L) / s;

        // Initial seasonal indices
        const overallAvg = sales.slice(0, s * 2).reduce((a, b) => a + b, 0) / (s * 2) || 1;
        const S = [];
        for (let i = 0; i < s; i++) {
            const seasonAvg = (sales[i] + (sales[i + s] || sales[i])) / 2;
            S.push(seasonAvg / overallAvg);
        }

        const levels    = [];
        const trends    = [];
        const seasonals = [...S];
        const fitted    = [];

        for (let t = 0; t < n; t++) {
            const si  = seasonals[t % s] ?? 1;
            const Lp  = L;
            const Tp  = T;

            // One-step-ahead fitted value
            fitted.push(Math.max(0, Math.round((Lp + Tp) * si)));

            // Update Level
            L = alpha * (sales[t] / (si || 1)) + (1 - alpha) * (Lp + Tp);

            // Update Trend
            T = beta * (L - Lp) + (1 - beta) * Tp;

            // Update Seasonal index
            const newS = gamma * (sales[t] / (L || 1)) + (1 - gamma) * si;
            seasonals[t % s] = newS;

            levels.push(Math.round(L * 10) / 10);
            trends.push(Math.round(T * 100) / 100);
        }

        // ── Forecast ─────────────────────────────────────────
        const absErrors = sales.map((v, i) => Math.abs(v - fitted[i]));
        const rmse      = Math.sqrt(absErrors.reduce((sum, e) => sum + e * e, 0) / absErrors.length);

        const predictions = [];
        for (let m = 1; m <= periods; m++) {
            const sIdx = (n + m - 1) % s;
            const sVal = seasonals[sIdx] ?? 1;
            const fcst = Math.max(0, Math.round((L + m * T) * sVal));

            predictions.push({
                forecast:   fcst,
                upperBound: Math.round(fcst + 1.5 * rmse),
                lowerBound: Math.max(0, Math.round(fcst - 1.5 * rmse))
            });
        }

        const pattern = buildPattern(sales, fitted);
        const mape    = calcMAPE(sales, fitted);

        return {
            predictions,
            components: { levels, trends, seasonals: seasonals.slice(0, n), fitted },
            pattern,
            mape,
            method: 'Holt-Winters'
        };
    }

    // ────────────────────────────────────────────────────────
    // PATTERN ANALYSIS
    // ────────────────────────────────────────────────────────
    function buildPattern(sales, fitted) {
        const nonZero  = sales.filter(v => v > 0);
        const baseline = nonZero.length
            ? Math.round(nonZero.reduce((s, v) => s + v, 0) / nonZero.length)
            : 0;

        const first4  = sales.slice(0, 4).reduce((s, v) => s + v, 0) / 4 || 1;
        const last4   = sales.slice(-4).reduce((s, v) => s + v, 0) / 4;
        const trendPct= Math.round(((last4 - first4) / first4) * 100);

        const maxSale       = Math.max(...sales);
        const seasonalSpike = baseline > 0 ? Math.round(((maxSale - baseline) / baseline) * 100) : 0;
        const maxIdx        = sales.indexOf(maxSale);
        const quarter       = Math.floor((maxIdx / Math.max(sales.length, 1)) * 4);
        const quarterLabels = ['Jan–Mar', 'Apr–Jun', 'Jul–Sep', 'Oct–Dec'];
        const peakSeason    = `Peak: Q${quarter + 1} (${quarterLabels[quarter] || 'unknown'})`;

        return { baseline, trend: trendPct, seasonalSpike, peakSeason };
    }

    // ────────────────────────────────────────────────────────
    // RENDER RESULTS
    // ────────────────────────────────────────────────────────
    function renderForecastResults(product, history, result) {
        const { predictions, components, pattern, mape, method } = result;

        // Header
        document.getElementById('forecast-product-name').textContent     = product.name;
        document.getElementById('forecast-product-category').textContent = product.category;
        document.getElementById('quick-stock').textContent   = (product.stock_quantity ?? '—') + ' units';
        document.getElementById('quick-reorder').textContent = (product.reorder_level  ?? '—') + ' units';
        document.getElementById('quick-price').textContent   = typeof Fmt !== 'undefined'
            ? Fmt.currency(product.price)
            : `₱${parseFloat(product.price || 0).toFixed(2)}`;

        document.getElementById('chart-title').textContent =
            `${product.name}: ${method}`;

        renderPatternInsights(pattern, mape);
        renderForecastChart(history, predictions, components.fitted);
        renderPredictionsGrid(predictions);
        renderRecommendation(predictions, product);
        renderComponentsTable(history, components);
    }

    function renderPatternInsights(pattern, mape) {
        const container = document.getElementById('pattern-insights');
        if (!container) return;

        const trendLabel = pattern.trend > 5  ? 'Sales are growing'
                         : pattern.trend < -5 ? 'Sales are declining'
                         : 'Sales are stable';
        const trendColor = pattern.trend > 5 ? '#4ade80' : pattern.trend < -5 ? '#f87171' : '#94a3b8';

        container.innerHTML = `
            <div class="pattern-item">
                <div class="pattern-info">
                    <div class="pattern-label">Average Weekly Sales</div>
                    <div class="pattern-value">${pattern.baseline} units/week</div>
                    <div class="pattern-sub">Based on past sales history</div>
                </div>
            </div>
            <div class="pattern-item">
                <div class="pattern-info">
                    <div class="pattern-label">Sales Trend</div>
                    <div class="pattern-value" style="color:${trendColor}">${trendLabel}</div>
                    <div class="pattern-sub">${Math.abs(pattern.trend)}% change vs. earlier period</div>
                </div>
            </div>
            <div class="pattern-item">
                <div class="pattern-info">
                    <div class="pattern-label">Seasonal Pattern</div>
                    <div class="pattern-value">+${pattern.seasonalSpike}% at peak</div>
                    <div class="pattern-sub">${pattern.peakSeason}</div>
                </div>
            </div>
        `;
    }

    function renderPredictionsGrid(predictions) {
        const maxFcst = Math.max(...predictions.map(p => p.forecast), 1);

        const rows = predictions.map((p, i) => {
            let tagClass = 'good', tagText = 'Normal';
            if (p.forecast >= maxFcst * 0.9) {
                tagClass = 'urgent'; tagText = 'Peak Week';
            } else if (p.forecast >= maxFcst * 0.7) {
                tagClass = 'warning'; tagText = 'High Demand';
            }
            return { week: i + 1, forecast: p.forecast, lower: p.lowerBound, upper: p.upperBound, tagClass, tagText };
        });

        renderPaginatedTable({
            tbodyId:      'predictions-tbody',
            paginationId: 'predictions-pagination',
            rows,
            pageSize:     10,
            rowRenderer:  r => `
                <tr>
                    <td class="fw-600">Week ${r.week}</td>
                    <td class="fw-700">${r.forecast} <span class="text-muted" style="font-weight:400">units</span></td>
                    <td>${r.lower}–${r.upper} units</td>
                    <td><span class="pred-tag ${r.tagClass}">${r.tagText}</span></td>
                </tr>
            `
        });
    }

    function renderRecommendation(predictions, product) {
        const container = document.getElementById('recommendation-body');
        if (!container) return;

        const totalForecast    = predictions.reduce((s, p) => s + p.forecast, 0);
        const safetyBuffer     = Math.ceil(totalForecast * 0.2);
        const recommendedOrder = totalForecast + safetyBuffer;
        const currentStock     = product.stock_quantity || 0;
        const shortage         = Math.max(0, recommendedOrder - currentStock);

        const stockStatus = currentStock >= recommendedOrder
            ? 'You have enough'
            : currentStock >= totalForecast
            ? 'Borderline, consider ordering'
            : 'Order Now';

        const orderDate = new Date();
        orderDate.setDate(orderDate.getDate() + 7);
        const orderDateLabel = orderDate.toLocaleDateString('en-PH', {
            month: 'long', day: 'numeric', timeZone: 'Asia/Manila'
        });

        const fmtNum = v => v.toLocaleString('en-PH');
        const fmtCur = v => typeof Fmt !== 'undefined' ? Fmt.currency(v)
            : `₱${parseFloat(v || 0).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`;

        container.innerHTML = `
            <div class="rec-stat">
                <div class="rec-label">Total Expected Demand</div>
                <div class="rec-value">${fmtNum(totalForecast)}</div>
                <small>units over next ${predictions.length} week${predictions.length > 1 ? 's' : ''}</small>
            </div>
            <div class="rec-stat">
                <div class="rec-label">Current Stock</div>
                <div class="rec-value" style="font-size:1.3rem">${stockStatus}</div>
                <small>${fmtNum(currentStock)} units on hand</small>
            </div>
            <div class="rec-stat">
                <div class="rec-label">Recommended Order</div>
                <div class="rec-value">${fmtNum(recommendedOrder)}</div>
                <small>includes 20% safety buffer</small>
            </div>
            <div class="rec-action">
                <div class="rec-message">
                    ${shortage > 0
                        ? `You may run short by ${fmtNum(shortage)} units. Place an order by <strong>${orderDateLabel}</strong>`
                        : `Stock levels look good for the next ${predictions.length} week${predictions.length > 1 ? 's' : ''}.`}
                </div>
                <div class="rec-deadline" style="margin-top:8px;opacity:0.85">
                    Estimated value of order: ${fmtCur(recommendedOrder * parseFloat(product.price || 0))}
                </div>
            </div>
        `;
    }

    // How many of the most recently fetched weeks to actually PLOT on the
    // chart -- separate from how many weeks the algorithm itself used
    // (still the full `history` array passed in, always up to the 52
    // weeks fetched in runForecast). Fewer weeks on screen just means a
    // less crowded chart; it never changes what the forecast math was
    // computed from.
    function resolveHistoryDisplayWeeks(periods) {
        if (periods <= 4)  return 12;
        if (periods <= 12) return 26;
        // Holt-Winters Custom beyond 12 weeks -- scale a bit with the
        // horizon so a long forecast still has enough context behind it,
        // but never just dump the entire fetched dataset on screen.
        return Math.min(52, Math.max(26, periods * 2));
    }

    function renderForecastChart(history, predictions, fitted) {
        const ctx = document.getElementById('forecast-chart')?.getContext('2d');
        if (!ctx) return;
        if (forecastChart) forecastChart.destroy();

        // Trim to a readable recent window for DISPLAY only -- `history`
        // and `predictions` themselves are already computed from the full,
        // un-trimmed series (still up to 52 weeks, fetched once in
        // runForecast), so this never changes what the algorithm actually
        // used, only how much of it gets drawn.
        const displayWeeks   = Math.min(resolveHistoryDisplayWeeks(predictions.length), history.length);
        const trimStart      = history.length - displayWeeks;
        const displayHistory = history.slice(trimStart);
        const displayFitted  = (fitted || []).slice(trimStart, history.length);

        const histLabels = displayHistory.map(h => h.week_label);
        const predLabels = predictions.map((_, i) => `Week +${i + 1} (forecast)`);
        const allLabels  = [...histLabels, ...predLabels];

        const actualData  = [...displayHistory.map(h => h.total_qty), ...Array(predictions.length).fill(null)];
        const fittedData  = [...displayFitted, ...Array(predictions.length).fill(null)];

        // Bridge: connect last actual point to first forecast
        const forecastData = [
            ...Array(displayHistory.length - 1).fill(null),
            displayHistory[displayHistory.length - 1].total_qty,
            ...predictions.map(p => p.forecast)
        ];

        const upperData = [...Array(displayHistory.length).fill(null), ...predictions.map(p => p.upperBound)];
        const lowerData = [...Array(displayHistory.length).fill(null), ...predictions.map(p => p.lowerBound)];

        // A light vertical "TODAY" marker at the historical/forecast
        // boundary, so that split is visually unambiguous on its own --
        // not just implied by the Actual-Sales-vs-Forecast color change.
        const todayMarkerPlugin = {
            id: 'todayMarker',
            afterDraw(chart) {
                if (!predictions.length) return;
                const xScale = chart.scales.x;
                const yScale = chart.scales.y;
                const idx = displayHistory.length - 1;
                if (idx < 0) return;
                const x = xScale.getPixelForValue(idx);
                const c = chart.ctx;
                c.save();
                c.beginPath();
                c.moveTo(x, yScale.top);
                c.lineTo(x, yScale.bottom);
                c.lineWidth = 1.5;
                c.strokeStyle = 'rgba(33,37,41,0.35)';
                c.setLineDash([4, 4]);
                c.stroke();
                c.setLineDash([]);
                c.fillStyle = '#495057';
                c.font = '600 10px ' + (window.getComputedStyle(document.body).fontFamily || 'sans-serif');
                c.textAlign = 'center';
                c.fillText('TODAY', x, yScale.top - 8);
                c.restore();
            }
        };

        forecastChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: allLabels,
                datasets: [
                    {
                        label: 'Actual Sales',
                        data: actualData,
                        borderColor: '#0d6efd',
                        backgroundColor: 'rgba(13,110,253,0.1)',
                        borderWidth: 2.5,
                        pointRadius: 4,
                        pointBackgroundColor: '#0d6efd',
                        fill: true,
                        tension: 0.3,
                        spanGaps: false
                    },
                    {
                        label: 'Model Fit',
                        data: fittedData,
                        borderColor: '#198754',
                        borderWidth: 1.5,
                        borderDash: [5, 5],
                        pointRadius: 2,
                        fill: false,
                        tension: 0.3,
                        spanGaps: false
                    },
                    {
                        label: 'Forecast (predicted)',
                        data: forecastData,
                        borderColor: '#dc3545',
                        borderWidth: 3,
                        borderDash: [8, 4],
                        pointRadius: 6,
                        pointStyle: 'triangle',
                        pointBackgroundColor: '#dc3545',
                        fill: false,
                        tension: 0,
                        spanGaps: true
                    },
                    {
                        label: 'Upper Range',
                        data: upperData,
                        borderColor: 'rgba(255,193,7,0.6)',
                        borderWidth: 1,
                        borderDash: [3, 3],
                        pointRadius: 0,
                        fill: false,
                        spanGaps: true
                    },
                    {
                        label: 'Lower Range',
                        data: lowerData,
                        borderColor: 'rgba(255,193,7,0.6)',
                        borderWidth: 1,
                        borderDash: [3, 3],
                        pointRadius: 0,
                        fill: '-1',
                        backgroundColor: 'rgba(255,193,7,0.12)',
                        spanGaps: true
                    }
                ]
            },
            plugins: [todayMarkerPlugin],
            options: {
                responsive: true,
                maintainAspectRatio: false,
                // Reserves room above the plot area specifically for the
                // "TODAY" text the todayMarkerPlugin draws just above the
                // chart -- without this, that text sits right at (or past)
                // the canvas's own top edge and gets clipped.
                layout: { padding: { top: 22 } },
                interaction: { intersect: false, mode: 'index' },
                plugins: {
                    legend: {
                        display: false  // we use custom legend HTML above the chart
                    },
                    tooltip: {
                        callbacks: {
                            title: items => items[0].label,
                            label: item => {
                                if (item.raw === null || item.raw === undefined) return '';
                                const label = item.dataset.label;
                                const val   = item.raw;
                                if (label === 'Upper Range' || label === 'Lower Range') return '';
                                return `  ${label}: ${val} units`;
                            },
                            afterBody: items => {
                                const forecastItem = items.find(i => i.dataset.label === 'Forecast (predicted)');
                                if (forecastItem && forecastItem.raw !== null) {
                                    const idx = forecastItem.dataIndex - displayHistory.length;
                                    if (idx >= 0 && idx < predictions.length) {
                                        const p = predictions[idx];
                                        return [`  Expected range: ${p.lowerBound}–${p.upperBound} units`];
                                    }
                                }
                                return [];
                            }
                        }
                    },
                    annotation: undefined
                },
                scales: {
                    x: {
                        ticks: {
                            maxRotation: 45,
                            // Chart.js thins these out on its own once there are
                            // more than ~10 ticks worth of room, evenly spacing
                            // whichever it keeps -- this is what actually fixes
                            // the "crowded with Week of … labels" problem, on
                            // top of the display window already being much
                            // smaller than the full fetched history.
                            autoSkip: true,
                            maxTicksLimit: 10,
                            font: { size: 10 },
                            callback: function(val) {
                                // Concise on the axis ("Sep 8" instead of "Week of
                                // Sep 8") -- the tooltip TITLE above still uses the
                                // full original label untouched, since this
                                // callback only affects what's drawn on the axis.
                                const label = this.getLabelForValue(val);
                                return label.replace(/^Week of /, '');
                            }
                        },
                        grid: { color: 'rgba(0,0,0,0.05)' }
                    },
                    y: {
                        beginAtZero: true,
                        title: {
                            display: true,
                            text: 'Units Sold / Expected',
                            font: { size: 11 }
                        },
                        ticks: { precision: 0 },
                        grid: { color: 'rgba(0,0,0,0.05)' }
                    }
                }
            }
        });
    }

    function renderComponentsTable(history, components) {
        const rows = history.map((h, i) => ({
            label:    h.week_label,
            qty:      h.total_qty,
            level:    components.levels?.[i],
            trend:    components.trends?.[i],
            seasonal: components.seasonals?.[i],
            fitted:   components.fitted?.[i]
        }));

        renderPaginatedTable({
            tbodyId:      'components-tbody',
            paginationId: 'components-pagination',
            rows,
            pageSize:     10,
            rowRenderer:  r => `
                <tr>
                    <td>${r.label}</td>
                    <td><strong>${r.qty}</strong></td>
                    <td>${r.level    != null ? r.level                : '—'}</td>
                    <td>${r.trend    != null ? r.trend.toFixed(2)     : '—'}</td>
                    <td>${r.seasonal != null ? r.seasonal.toFixed(2)  : '—'}</td>
                    <td>${r.fitted   != null ? r.fitted               : '—'}</td>
                </tr>
            `
        });
    }

    // Shared by Weekly Demand Predictions and Historical Data -- renders
    // `pageSize` rows at a time into the given tbody, with Prev/Next
    // controls in the given pagination container. Keeps its own page
    // state per call (a fresh call, e.g. from a new forecast, always
    // starts back at page 1).
    function renderPaginatedTable({ tbodyId, paginationId, rows, pageSize, rowRenderer }) {
        const tbody = document.getElementById(tbodyId);
        const paginationEl = document.getElementById(paginationId);
        if (!tbody) return;

        let currentPage = 1;
        const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));

        function renderPage() {
            const start = (currentPage - 1) * pageSize;
            tbody.innerHTML = rows.slice(start, start + pageSize).map(rowRenderer).join('');

            if (!paginationEl) return;

            if (totalPages <= 1) {
                paginationEl.innerHTML = '';
                return;
            }

            paginationEl.innerHTML = `
                <button type="button" class="pg-btn" id="${paginationId}-prev" ${currentPage === 1 ? 'disabled' : ''}>‹ Prev</button>
                <span class="pg-info">Page ${currentPage} of ${totalPages}</span>
                <button type="button" class="pg-btn" id="${paginationId}-next" ${currentPage === totalPages ? 'disabled' : ''}>Next ›</button>
            `;
            document.getElementById(`${paginationId}-prev`)?.addEventListener('click', () => { currentPage--; renderPage(); });
            document.getElementById(`${paginationId}-next`)?.addEventListener('click', () => { currentPage++; renderPage(); });
        }

        renderPage();
    }

    // ────────────────────────────────────────────────────────
    // COMPARE ALL METHODS
    // ────────────────────────────────────────────────────────
    // Each method only ever forecasts as far as ITS OWN available range
    // supports (see HORIZON_OPTIONS above) -- Moving Average tops out at 4
    // weeks, Exponential Smoothing at 12, Holt-Winters at the full custom
    // range (26). Forcing every method to the same horizon regardless of
    // what it actually supports would mean either capping everything down
    // to Moving Average's ceiling (hiding what the other two can really
    // do) or projecting Moving Average further out than it was ever
    // designed for.
    const METHOD_MAX_PERIODS = { 'moving-average': 4, 'exponential': 12, 'holt-winters': 26 };

    async function compareAllMethods() {
        const productId = productSelect?.value;
        if (!productId) { Toast.show('Please select a product first.', 'warning'); return; }

        compareBtn.disabled    = true;
        compareBtn.textContent = 'Comparing…';

        // Uses whatever forecast range is CURRENTLY selected on screen, so
        // the comparison reflects the same horizon the person is already
        // looking at -- clamped per method to what that method actually
        // supports (see METHOD_MAX_PERIODS above), rather than a horizon
        // hard-coded to 4 weeks regardless of the on-screen selection.
        const requestedPeriods = resolvePeriods();

        try {
            // Fetch history and run all 3 algorithms client-side for consistent results
            const data = lastForecastData && lastForecastData.product.id == productId
                ? lastForecastData
                : await API.get(`/forecasting/data/${productId}?weeks=52`);

            if (!data?.success) {
                // Fall back to server-side compare
                const serverData = await API.get(`/forecasting/compare/${productId}`);
                if (serverData?.success) {
                    renderComparisonModal(serverData, null);
                    modal?.classList.remove('hidden');
                } else {
                    Toast.show('Could not load comparison data.', 'error');
                }
                return;
            }

            // Run all 3 locally, each capped to its own supported range
            const history = data.history;
            const sales   = history.map(h => h.total_qty);

            const periodsByMethod = {
                'moving-average': Math.min(requestedPeriods, METHOD_MAX_PERIODS['moving-average']),
                'exponential':    Math.min(requestedPeriods, METHOD_MAX_PERIODS['exponential']),
                'holt-winters':   Math.min(requestedPeriods, METHOD_MAX_PERIODS['holt-winters'])
            };

            const maResult  = runMovingAverage(sales, periodsByMethod['moving-average']);
            const sesResult = runExponentialSmoothing(sales, periodsByMethod['exponential']);
            const hwResult  = runHoltWinters(sales, periodsByMethod['holt-winters']);

            renderComparisonModalLocal(data.product, maResult, sesResult, hwResult, periodsByMethod, requestedPeriods);
            modal?.classList.remove('hidden');

        } catch (err) {
            console.error(err);
            Toast.show('Error comparing methods.', 'error');
        } finally {
            compareBtn.disabled    = false;
            compareBtn.textContent = 'Compare All Methods';
        }
    }

    function renderComparisonModalLocal(product, ma, ses, hw, periodsByMethod, requestedPeriods) {
        const body = document.getElementById('comparison-body');
        if (!body) return;

        const titleEl = document.getElementById('comparison-modal-title');
        if (titleEl) titleEl.textContent = `Algorithm Comparison: ${product.name}`;

        // Same names shown on the algorithm cards earlier on this page
        // (Moving Average / Exponential Smoothing / Holt-Winters) -- this
        // table used to call them "Simple Average"/"Weighted Average"/
        // "Seasonal Forecast" instead, which read as three DIFFERENT,
        // unrelated methods rather than the exact three already selected
        // from above.
        const methods = [
            { key: 'moving-average', name: 'Moving Average',        result: ma,  desc: 'Best for stable, predictable products' },
            { key: 'exponential',    name: 'Exponential Smoothing', result: ses, desc: 'Best for products with gradual growth/decline' },
            // No "(recommended)" here -- the BEST FIT badge below already
            // says which method actually won for THIS product; hardcoding
            // a recommendation onto Holt-Winters regardless of the real
            // result would contradict that badge whenever a different
            // method scores better (as seen above: Exponential Smoothing).
            { key: 'holt-winters',   name: 'Holt-Winters',          result: hw,  desc: 'Best for seasonal patterns' }
        ];

        // Only methods with a measurable MAPE can be meaningfully compared.
        // A null MAPE means "not enough sales history to score" -- not "0%
        // error" -- and must never accidentally win "best fit" through JS's
        // null-coerces-to-0 comparison quirk (null < 5 is true!).
        const scorable = methods.filter(m => m.result.mape !== null);

        // A "best" pick is only meaningful if at least one method actually
        // scored reasonably well. When every method's error is this high
        // (>=90%), the underlying sales history is too sparse for the
        // comparison to mean anything -- reduce() would still pick ONE as
        // "BEST FIT" in that case (usually just whichever comes first when
        // every score ties), which looks like a real recommendation but
        // isn't one.
        const bestMethod = (scorable.length && scorable.some(m => m.result.mape < 90))
            ? scorable.reduce((best, m) => m.result.mape < best.result.mape ? m : best, scorable[0])
            : null;

        body.innerHTML = `
            <div style="overflow-x:auto">
                <table style="width:100%;border-collapse:collapse;font-size:0.85rem">
                    <thead>
                        <tr style="background:var(--light-blue)">
                            <th style="padding:10px 8px;text-align:left;border-bottom:2px solid var(--primary)">Method</th>
                            <th style="padding:10px 8px;text-align:center;border-bottom:2px solid var(--primary)">Accuracy (lower = better)</th>
                            <th style="padding:10px 8px;text-align:center;border-bottom:2px solid var(--primary)">Total Predicted</th>
                            <th style="padding:10px 8px;text-align:left;border-bottom:2px solid var(--primary)">Best Used For</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${methods.map(m => {
                            const isBest   = bestMethod && m.name === bestMethod.name;
                            const total    = m.result.predictions.reduce((s, p) => s + p.forecast, 0);
                            const hasScore = m.result.mape !== null;
                            const periods  = periodsByMethod[m.key];
                            return `
                            <tr style="border-bottom:1px solid var(--gray-200);${isBest ? 'background:#f0f7ff' : ''}">
                                <td style="padding:10px 8px">
                                    <strong>${m.name}</strong>
                                    ${isBest ? '<span style="margin-left:6px;background:var(--primary);color:white;padding:2px 7px;border-radius:10px;font-size:0.65rem;font-weight:700">BEST FIT</span>' : ''}
                                </td>
                                <td style="padding:10px 8px;text-align:center">
                                    ${hasScore ? `
                                    <span style="font-size:1.05rem;font-weight:700;color:${m.result.mape < 20 ? 'var(--success)' : m.result.mape < 40 ? '#f0ad4e' : 'var(--danger)'}">
                                        ${m.result.mape}%
                                    </span>
                                    <div style="font-size:0.68rem;color:var(--secondary)">${m.result.mape < 20 ? 'Excellent' : m.result.mape < 40 ? 'Acceptable' : 'Less accurate'}</div>
                                    ` : `
                                    <span style="font-size:1.05rem;font-weight:700;color:var(--secondary)">N/A</span>
                                    <div style="font-size:0.68rem;color:var(--secondary)">No sales data yet</div>
                                    `}
                                </td>
                                <td style="padding:10px 8px;text-align:center;font-size:1.05rem;font-weight:700;color:var(--primary)">
                                    ${total} units
                                    <div style="font-size:0.68rem;font-weight:600;color:var(--secondary)">${periods} wk${periods > 1 ? 's' : ''}${periods < requestedPeriods ? ' (max for this method)' : ''}</div>
                                </td>
                                <td style="padding:10px 8px;font-size:0.8rem;color:var(--secondary)">${m.desc}</td>
                            </tr>`;
                        }).join('')}
                    </tbody>
                </table>
            </div>
            ${bestMethod ? `
            <div style="margin-top:14px;padding:12px 14px;background:#eef4ff;border-radius:10px;border-left:4px solid var(--primary)">
                <strong style="font-size:0.88rem">Our Recommendation for ${product.name}:</strong>
                <p style="margin-top:6px;font-size:0.83rem">
                    Based on historical sales, the <strong>${bestMethod.name}</strong> method has the lowest error rate
                    (${bestMethod.result.mape}%). This means it would have predicted past sales most accurately.
                    We recommend using this method for future forecasts of this product.
                </p>
            </div>
            ` : `
            <div style="margin-top:14px;padding:12px 14px;background:#fff8e6;border-radius:10px;border-left:4px solid #f0ad4e">
                <strong style="font-size:0.88rem">Not enough sales data to compare reliably</strong>
                <p style="margin-top:6px;font-size:0.83rem">
                    This product's sales history is too limited or inconsistent for any of the three methods to be scored with confidence right now.
                    The predictions above are still shown, but treat them as rough starting estimates until more real sales accumulate.
                </p>
            </div>
            `}
        `;
    }

    // Fallback for server-side compare response
    function renderComparisonModal(data) {
        const body = document.getElementById('comparison-body');
        if (!body) return;

        const titleEl = document.getElementById('comparison-modal-title');
        if (titleEl) titleEl.textContent = data?.product?.name ? `Algorithm Comparison: ${data.product.name}` : 'Algorithm Comparison';

        body.innerHTML = `
            <table style="width:100%;border-collapse:collapse;font-size:0.875rem">
                <thead>
                    <tr style="background:var(--light-blue)">
                        <th style="padding:10px;text-align:left;border-bottom:2px solid var(--primary)">Method</th>
                        <th style="padding:10px;text-align:center;border-bottom:2px solid var(--primary)">Accuracy</th>
                        <th style="padding:10px;text-align:left;border-bottom:2px solid var(--primary)">Best For</th>
                    </tr>
                </thead>
                <tbody>
                    ${(data.methods || []).map(m => {
                        const mapeDisplay = m.mape === null ? 'N/A'
                            : m.mape === 'Calculated on-demand' ? m.mape
                            : `${m.mape}%`;
                        return `
                    <tr style="border-bottom:1px solid var(--gray-200)">
                        <td style="padding:10px"><strong>${m.name}</strong></td>
                        <td style="padding:10px;text-align:center">${mapeDisplay}</td>
                        <td style="padding:10px;font-size:0.82rem;color:var(--secondary)">${m.bestFor}</td>
                    </tr>`;
                    }).join('')}
                </tbody>
            </table>
            ${data.recommendation ? `<div style="margin-top:16px;padding:14px;background:#eef4ff;border-radius:8px;border-left:4px solid var(--primary);font-size:0.875rem">${data.recommendation}</div>` : ''}
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
        // No comparable weeks means accuracy genuinely cannot be measured —
        // return null rather than 0, since 0% would misleadingly imply a
        // perfect score when really there was nothing to score at all.
        return count === 0 ? null : parseFloat(((sum / count) * 100).toFixed(1));
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
