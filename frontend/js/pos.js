// ============================================================
// PharmaTrack – pos.js
// Point of Sale: product search, barcode sim, cart, checkout,
// and cash register (Opening Cash / Cash In-Out / Close Register)
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    // Cashier, admin, and super_admin can access POS
    if (!Auth.requireAuth(['cashier', 'admin', 'super_admin'])) return;

    // ── State ─────────────────────────────────────────────────
    const cart = {
        items:            [],    // Array of { product, quantity }
        discountEnabled:  false, // true = flat 20% discount applied
        paymentMethod:    'cash',
        amountTendered:   0,

        addItem(product, qty = 1) {
            const existing = this.items.find(i => i.product.id === product.id);
            if (existing) {
                existing.quantity += qty;
            } else {
                this.items.push({ product, quantity: qty });
            }
            renderCart();
            saveCartToStorage();
        },

        removeItem(productId) {
            this.items = this.items.filter(i => i.product.id !== productId);
            renderCart();
            saveCartToStorage();
        },

        updateQty(productId, delta) {
            const item = this.items.find(i => i.product.id === productId);
            if (!item) return;
            item.quantity += delta;
            if (item.quantity <= 0) this.removeItem(productId);
            else { renderCart(); saveCartToStorage(); }
        },

        get subtotal()  { return this.items.reduce((s, i) => s + (i.product.price * i.quantity), 0); },
        get discount()  { return this.discountEnabled ? Math.round(this.subtotal * 0.20 * 100) / 100 : 0; },
        get total()     { return Math.max(0, this.subtotal - this.discount); },
        get change()    { return this.amountTendered - this.total; },
        get isEmpty()   { return !this.items.length; },

        clear() {
            this.items = [];
            this.discountEnabled = false;
            this.amountTendered = 0;
            renderCart();
            saveCartToStorage();
            setCartExpanded(false); // back to the compact peek bar on mobile
        }
    };

    // Cash register state — null means no OPEN session for this cashier
    let currentCashSession = null;

    // ── Cart persistence ──────────────────────
    // This is a traditional multi-page app, not a single-page app — navigating
    // to another page and back is a full page reload, which wipes any
    // in-memory JS state. sessionStorage survives that (it persists across
    // reloads/navigation within the same browser tab), but clears when the
    // tab itself is closed — exactly right for "don't lose my cart if I check
    // Inventory real quick", without an abandoned cart lingering forever.
    const CART_STORAGE_KEY = 'pharmatrack_pos_cart';

    function saveCartToStorage() {
        try {
            sessionStorage.setItem(CART_STORAGE_KEY, JSON.stringify({
                items:           cart.items,
                discountEnabled: cart.discountEnabled,
                paymentMethod:   cart.paymentMethod,
                amountTendered:  cart.amountTendered
            }));
        } catch (e) { /* storage unavailable/full — cart just won't persist, non-fatal */ }
    }

    function loadCartFromStorage() {
        try {
            const raw = sessionStorage.getItem(CART_STORAGE_KEY);
            if (!raw) return;
            const saved = JSON.parse(raw);
            cart.items           = saved.items           || [];
            cart.discountEnabled = saved.discountEnabled || false;
            cart.paymentMethod   = saved.paymentMethod    || 'cash';
            cart.amountTendered  = saved.amountTendered   || 0;
        } catch (e) { /* corrupted data — just start fresh */ }
    }

    // Syncs the DOM controls (which aren't part of the `cart` object itself)
    // to match a just-restored cart, since setting the JS state alone doesn't
    // move a toggle switch or re-select a payment button.
    function restoreCartUI() {
        if (discountToggle) {
            discountToggle.classList.toggle('active', cart.discountEnabled);
            discountToggle.setAttribute('aria-pressed', String(cart.discountEnabled));
        }
        if (tenderedInput && cart.amountTendered) {
            tenderedInput.value = cart.amountTendered;
        }
        document.querySelectorAll('.pay-method-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.method === cart.paymentMethod);
        });
        renderCart();
    }

    // ── DOM References ────────────────────────────────────────
    const productGrid     = document.getElementById('product-grid');
    const posSearchBar    = document.getElementById('pos-search-bar');
    const searchInput     = document.getElementById('pos-search');
    const barcodeRow      = document.getElementById('barcode-input-row');
    const barcodeInput    = document.getElementById('barcode-input');
    const cartItemsEl     = document.getElementById('cart-items');
    const cartCountEl     = document.getElementById('cart-count');
    const subtotalEl      = document.getElementById('cart-subtotal');
    const discountEl      = document.getElementById('cart-discount-display');
    const totalEl         = document.getElementById('cart-total');
    const changeEl        = document.getElementById('change-display');
    const discountToggle  = document.getElementById('discount-toggle');
    const tenderedInput   = document.getElementById('amount-tendered');
    const checkoutBtn     = document.getElementById('btn-checkout');
    const clearCartBtn    = document.getElementById('btn-clear-cart');
    const voidBtn         = document.getElementById('btn-void');

    const registerStrip   = document.getElementById('register-strip');
    const registerBlocker = document.getElementById('register-blocker');
    const posLayout       = document.getElementById('pos-layout');

    // Mobile cart peek/expand controls — see .pos-right's mobile rules in
    // pos.css. cartPanel itself doubles as both the desktop full panel and
    // the mobile peek bar; only .cart-expanded changes which one it looks
    // like on a narrow screen.
    const cartPanel        = document.querySelector('.pos-right');
    const cartToggleBtn    = document.getElementById('cart-toggle-btn');
    const cartToggleIcon   = document.getElementById('cart-toggle-icon');
    const cartMobileOverlay= document.getElementById('cart-mobile-overlay');

    // ── Mobile cart peek/expand ──────────────────────────────
    // Toggles the cart between its compact "peek" bar and the expanded
    // panel that occupies most of the screen on mobile (see .pos-right's
    // mobile rules in pos.css). No-op on desktop — .cart-expanded has no
    // visual effect there since the cart is already a normal full panel.
    function setCartExpanded(expanded) {
        if (!cartPanel) return;
        cartPanel.classList.toggle('cart-expanded', expanded);
        cartToggleBtn?.setAttribute('aria-expanded', String(expanded));
        cartToggleBtn?.setAttribute('aria-label', expanded ? 'Collapse cart' : 'Expand cart');
        if (cartToggleIcon) cartToggleIcon.textContent = expanded ? '▼' : '▲';
        cartMobileOverlay?.classList.toggle('active', expanded);
    }

    cartToggleBtn?.addEventListener('click', () => {
        setCartExpanded(!cartPanel.classList.contains('cart-expanded'));
    });

    cartMobileOverlay?.addEventListener('click', () => setCartExpanded(false));

    // ── Boot ────────────────────────────────────────────────
    loadCartFromStorage();
    loadPOSProducts();
    loadCashSession();
    restoreCartUI();

    const FailedSyncPanel = {
        async refresh() {
            const failed = await OfflineAPI.getFailedSyncs();
            this.render(failed.length);
        },

        render(count) {
            let banner = document.getElementById('failed-sync-banner');
            if (count > 0) {
                if (!banner) {
                    banner = document.createElement('button');
                    banner.id = 'failed-sync-banner';
                    banner.className = 'failed-sync-banner';
                    banner.type = 'button';
                    banner.addEventListener('click', () => this.openModal());
                    document.body.appendChild(banner);
                }
                banner.textContent = `${count} Sync Issue${count === 1 ? '' : 's'} – Tap to view`;
            } else if (banner) {
                banner.remove();
            }
        },

        ensureModal() {
            if (document.getElementById('failed-sync-modal')) return;
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay';
            overlay.id = 'failed-sync-modal';
            overlay.innerHTML = `
                <div class="modal" style="max-width:480px">
                    <div class="modal-header">
                        <h3>Offline Sync Issues</h3>
                        <button class="btn-close" id="btn-close-failed-sync">X</button>
                    </div>
                    <div class="modal-body" id="failed-sync-body" style="max-height:400px;overflow-y:auto"></div>
                    <div class="modal-footer">
                        <button class="btn btn-light" id="btn-dismiss-all-failed">Dismiss All</button>
                        <button class="btn btn-primary" id="btn-close-failed-sync-2">Close</button>
                    </div>
                </div>`;
            document.body.appendChild(overlay);

            document.getElementById('btn-close-failed-sync')?.addEventListener('click', () => Modal.close('failed-sync-modal'));
            document.getElementById('btn-close-failed-sync-2')?.addEventListener('click', () => Modal.close('failed-sync-modal'));
            document.getElementById('btn-dismiss-all-failed')?.addEventListener('click', async () => {
                const confirmed = await ConfirmDialog.show({
                    title:       'Dismiss All',
                    message:     'Clear this list? Only do this after you\'ve checked each item.',
                    confirmText: 'Dismiss All'
                });
                if (!confirmed) return;
                await OfflineAPI.clearAllFailedSyncs();
                Modal.close('failed-sync-modal');
                this.refresh();
            });
        },

        async openModal() {
            const failed = await OfflineAPI.getFailedSyncs();
            this.ensureModal();
            const body = document.getElementById('failed-sync-body');

            if (!failed.length) {
                body.innerHTML = `<p class="text-muted" style="text-align:center;padding:20px">No sync issues.</p>`;
            } else {
                body.innerHTML = failed.map(item => {
                    const isCheckout = item.endpoint === '/pos/checkout';
                    const itemsSummary = isCheckout
                        ? (item.body?.items || []).map(i => `x${i.quantity} (product #${i.product_id})`).join(', ')
                        : '';
                    return `
                    <div class="failed-sync-item">
                        <div class="failed-sync-item-header">
                            <strong>${isCheckout ? 'Checkout' : escHtml(item.endpoint)}</strong>
                            <span class="text-muted" style="font-size:0.75rem">${Fmt.datetime(new Date(item.timestamp).toISOString())}</span>
                        </div>
                        <div class="failed-sync-reason">${escHtml(item.reason)}</div>
                        ${isCheckout ? `<div class="failed-sync-detail">Items: ${escHtml(itemsSummary)} -- Total tendered: ${Fmt.currency(item.body?.amount_tendered)}</div>` : ''}
                        <button class="btn btn-light btn-sm btn-dismiss-failed" data-id="${item.id}">Dismiss</button>
                    </div>`;
                }).join('');

                body.querySelectorAll('.btn-dismiss-failed').forEach(btn => {
                    btn.addEventListener('click', async () => {
                        await OfflineAPI.clearFailedSync(parseInt(btn.dataset.id));
                        this.openModal();
                        this.refresh();
                    });
                });
            }

            Modal.open('failed-sync-modal');
        }
    };

    FailedSyncPanel.refresh();

    window.addEventListener('pharmatrack:sync-complete', () => {
        FailedSyncPanel.refresh();
        loadPOSProducts();
        loadCashSession();
    });

    // ── Load all available products ───────────────────────────
    // Every card here represents one product *family* — batches of the
    // same product name are combined server-side into a single card with
    // a combined stock count, and expired batches are excluded entirely.
    let allProducts = [];

    async function loadPOSProducts(query = '') {
        const params = query ? `?q=${encodeURIComponent(query)}` : '';
        const data   = await OfflineAPI.get(`/pos/products${params}`);
        if (!data?.success) return;

        allProducts = data.data;
        renderProductGrid(allProducts);
    }

    // ────────────────────────────────────────────────────────
    // CASH REGISTER (Opening Cash / Cash In-Out / Close Register)
    // ────────────────────────────────────────────────────────
    async function loadCashSession() {
        const data = await OfflineAPI.get('/pos/cash-session/current');
        currentCashSession = data?.success ? data.data : null;
        renderRegisterUI();
    }

    function renderRegisterUI() {
        if (!registerStrip || !registerBlocker || !posLayout) return;

        if (currentCashSession) {
            registerStrip.classList.remove('hidden');
            registerBlocker.classList.add('hidden');
            posLayout.classList.remove('hidden');
            cartPanel?.classList.remove('hidden');
            posSearchBar?.classList.remove('hidden');

            const openedTime = new Date(currentCashSession.opened_at).toLocaleTimeString('en-PH', {
                hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Manila'
            });

            document.getElementById('reg-opening-cash').textContent = Fmt.currency(currentCashSession.opening_cash);
            document.getElementById('reg-opened-time').textContent  = openedTime;
            document.getElementById('reg-cash-sales').textContent   = Fmt.currency(currentCashSession.cash_sales);
            document.getElementById('reg-expected-cash').textContent = Fmt.currency(currentCashSession.expected_cash);
        } else {
            registerStrip.classList.add('hidden');
            registerBlocker.classList.remove('hidden');
            posLayout.classList.add('hidden');
            cartPanel?.classList.add('hidden');
            // Nothing to search or scan for until a register session is
            // open — hide the whole search/scan toolbar, and make sure the
            // simulated barcode input row isn't left open behind it either.
            posSearchBar?.classList.add('hidden');
            barcodeRow?.classList.remove('active');
        }
    }

    // ── Open Register ─────────────────────────────────────────
    document.getElementById('btn-open-register')?.addEventListener('click', () => {
        const input = document.getElementById('open-register-amount');
        if (input) input.value = '';
        Modal.open('open-register-modal');
        setTimeout(() => input?.focus(), 50);
    });

    document.getElementById('btn-confirm-open-register')?.addEventListener('click', async () => {
        const btn    = document.getElementById('btn-confirm-open-register');
        const amount = parseFloat(document.getElementById('open-register-amount')?.value);

        if (isNaN(amount) || amount < 0) {
            Toast.show('Enter a valid opening cash amount.', 'warning');
            return;
        }

        const confirmed = await ConfirmDialog.show({
            title:       'Open Register',
            message:     `Open your register with ${Fmt.currency(amount)}?`,
            confirmText: 'Open Register',
            danger:      false
        });
        if (!confirmed) return;

        const isCashier = Auth.getUser()?.role === 'cashier';

        if (isCashier) {
            // Manager/owner approval required to open too now -- same retry
            // loop pattern as Cash In/Out/Close/Void.
            let promptMessage = 'Opening the register requires an admin or owner to approve.';

            while (true) {
                const creds = await ManagerApprovalDialog.show(promptMessage);
                if (!creds) return; // cashier cancelled

                btn.disabled = true;
                const result = await API.post('/pos/cash-session/open', {
                    opening_cash: amount,
                    manager_email: creds.email,
                    manager_password: creds.password
                });
                btn.disabled = false;

                if (result?.success) {
                    Modal.close('open-register-modal');
                    Toast.show('Register opened.', 'success');
                    await loadCashSession();
                    return;
                }

                if (result?.message?.toLowerCase().includes('credentials')) {
                    promptMessage = `❌ ${result.message} Please try again.`;
                    continue;
                }

                Toast.show(result?.message || 'Could not open register.', 'error');
                return;
            }
        } else {
            btn.disabled = true;
            const result = await API.post('/pos/cash-session/open', { opening_cash: amount });
            btn.disabled = false;

            if (result?.success) {
                Modal.close('open-register-modal');
                Toast.show('Register opened.', 'success');
                await loadCashSession();
            } else {
                Toast.show(result?.message || 'Could not open register.', 'error');
            }
        }
    });

    // ── Cash In ────────────────────────────────────────────────
    document.getElementById('btn-cash-in')?.addEventListener('click', () => {
        document.getElementById('cash-in-amount').value = '';
        document.getElementById('cash-in-reason').value = '';
        Modal.open('cash-in-modal');
    });

    document.getElementById('btn-confirm-cash-in')?.addEventListener('click', () => {
        handleCashMovement('CASH_IN');
    });

    // ── Cash Out ───────────────────────────────────────────────
    document.getElementById('btn-cash-out')?.addEventListener('click', () => {
        document.getElementById('cash-out-amount').value = '';
        document.getElementById('cash-out-reason').value = '';
        Modal.open('cash-out-modal');
    });

    document.getElementById('btn-confirm-cash-out')?.addEventListener('click', () => {
        handleCashMovement('CASH_OUT');
    });

    async function handleCashMovement(type) {
        const isIn        = type === 'CASH_IN';
        const modalId      = isIn ? 'cash-in-modal'  : 'cash-out-modal';
        const amountInput  = document.getElementById(isIn ? 'cash-in-amount' : 'cash-out-amount');
        const reasonInput  = document.getElementById(isIn ? 'cash-in-reason' : 'cash-out-reason');
        const confirmBtn   = document.getElementById(isIn ? 'btn-confirm-cash-in' : 'btn-confirm-cash-out');

        const amount = parseFloat(amountInput?.value);
        const reason = (reasonInput?.value || '').trim();

        if (isNaN(amount) || amount <= 0) {
            Toast.show('Enter a valid amount.', 'warning');
            return;
        }
        if (!reason) {
            Toast.show('Enter a reason.', 'warning');
            return;
        }

        // Standard confirmation, same as everywhere else in the app
        const confirmed = await ConfirmDialog.show({
            title:       isIn ? 'Confirm Cash In' : 'Confirm Cash Out',
            message:     `${Fmt.currency(amount)}\nReason: ${reason}`,
            confirmText: isIn ? 'Add Cash' : 'Remove Cash',
            danger:      !isIn
        });
        if (!confirmed) return;

        const endpoint = isIn ? '/pos/cash-session/cash-in' : '/pos/cash-session/cash-out';
        const isCashier = Auth.getUser()?.role === 'cashier';

        if (isCashier) {
            // Manager/owner approval required — same retry loop pattern as Void
            let promptMessage = `${isIn ? 'Adding' : 'Removing'} ${Fmt.currency(amount)} requires an admin or owner to approve.`;

            while (true) {
                const creds = await ManagerApprovalDialog.show(promptMessage);
                if (!creds) return; // cashier cancelled

                confirmBtn.disabled = true;
                const result = await API.post(endpoint, {
                    amount, reason,
                    manager_email: creds.email,
                    manager_password: creds.password
                });
                confirmBtn.disabled = false;

                if (result?.success) {
                    Modal.close(modalId);
                    Toast.show(result.message, 'success');
                    await loadCashSession();
                    return;
                }

                if (result?.message?.toLowerCase().includes('credentials')) {
                    promptMessage = `❌ ${result.message} Please try again.`;
                    continue;
                }

                Toast.show(result?.message || 'Failed.', 'error');
                return;
            }
        } else {
            confirmBtn.disabled = true;
            const result = await API.post(endpoint, { amount, reason });
            confirmBtn.disabled = false;

            if (result?.success) {
                Modal.close(modalId);
                Toast.show(result.message, 'success');
                await loadCashSession();
            } else {
                Toast.show(result?.message || 'Failed.', 'error');
            }
        }
    }

    // ── Close Register ─────────────────────────────────────────
    document.getElementById('btn-close-register')?.addEventListener('click', () => {
        if (!currentCashSession) return;

        const summaryEl  = document.getElementById('close-reg-summary');
        const actualInput = document.getElementById('close-register-actual');
        const varianceEl  = document.getElementById('close-reg-variance');

        summaryEl.innerHTML = `
            <div class="crs-row"><span>Opening Cash</span><span>${Fmt.currency(currentCashSession.opening_cash)}</span></div>
            <div class="crs-row"><span>Cash Sales</span><span>${Fmt.currency(currentCashSession.cash_sales)}</span></div>
            <div class="crs-row"><span>Cash In</span><span>+${Fmt.currency(currentCashSession.cash_in)}</span></div>
            <div class="crs-row"><span>Cash Out</span><span>-${Fmt.currency(currentCashSession.cash_out)}</span></div>
            <div class="crs-row crs-total"><span>Expected Cash</span><span>${Fmt.currency(currentCashSession.expected_cash)}</span></div>
        `;
        actualInput.value = '';
        varianceEl.textContent = '';
        varianceEl.className = 'close-reg-variance';

        Modal.open('close-register-modal');
        setTimeout(() => actualInput.focus(), 50);
    });

    // Live variance preview as the cashier types the actual counted cash
    document.getElementById('close-register-actual')?.addEventListener('input', (e) => {
        const varianceEl = document.getElementById('close-reg-variance');
        const actual = parseFloat(e.target.value);

        if (isNaN(actual) || !currentCashSession) {
            varianceEl.textContent = '';
            varianceEl.className = 'close-reg-variance';
            return;
        }

        const variance = Math.round((actual - currentCashSession.expected_cash) * 100) / 100;
        let cls = 'zero', label = 'Balanced — no variance';
        if (variance < 0) { cls = 'shortage'; label = `Shortage: -${Fmt.currency(Math.abs(variance))}`; }
        if (variance > 0) { cls = 'overage';  label = `Overage: +${Fmt.currency(variance)}`; }

        varianceEl.textContent = label;
        varianceEl.className = `close-reg-variance ${cls}`;
    });

    document.getElementById('btn-confirm-close-register')?.addEventListener('click', async () => {
        const btn    = document.getElementById('btn-confirm-close-register');
        const actual = parseFloat(document.getElementById('close-register-actual')?.value);

        if (isNaN(actual) || actual < 0) {
            Toast.show('Enter the actual cash counted.', 'warning');
            return;
        }

        const variance = Math.round((actual - currentCashSession.expected_cash) * 100) / 100;
        const varianceLabel = variance === 0 ? 'No variance' : variance > 0
            ? `Overage of ${Fmt.currency(variance)}`
            : `Shortage of ${Fmt.currency(Math.abs(variance))}`;

        const confirmed = await ConfirmDialog.show({
            title:       'Confirm Close Register',
            message:     `Actual cash counted: ${Fmt.currency(actual)}\nExpected: ${Fmt.currency(currentCashSession.expected_cash)}\n${varianceLabel}\n\nThis cannot be undone.`,
            confirmText: 'Close Register',
            danger:      variance !== 0
        });
        if (!confirmed) return;

        const isCashier = Auth.getUser()?.role === 'cashier';

        if (isCashier) {
            let promptMessage = 'Closing the register requires an admin or owner to approve.';

            while (true) {
                const creds = await ManagerApprovalDialog.show(promptMessage);
                if (!creds) return;

                btn.disabled = true;
                const result = await API.post('/pos/cash-session/close', {
                    actual_cash: actual,
                    manager_email: creds.email,
                    manager_password: creds.password
                });
                btn.disabled = false;

                if (result?.success) {
                    Modal.close('close-register-modal');
                    Toast.show(result.message, 'success');
                    await loadCashSession();
                    return;
                }

                if (result?.message?.toLowerCase().includes('credentials')) {
                    promptMessage = `❌ ${result.message} Please try again.`;
                    continue;
                }

                Toast.show(result?.message || 'Could not close register.', 'error');
                return;
            }
        } else {
            btn.disabled = true;
            const result = await API.post('/pos/cash-session/close', { actual_cash: actual });
            btn.disabled = false;

            if (result?.success) {
                Modal.close('close-register-modal');
                Toast.show(result.message, 'success');
                await loadCashSession();
            } else {
                Toast.show(result?.message || 'Could not close register.', 'error');
            }
        }
    });

    // ── Product search ────────────────────────────────────────
    searchInput?.addEventListener('input', debounce(() => {
        loadPOSProducts(searchInput.value.trim());
    }, 280));

    // ── Render product cards ───────────────────────────────────
    // No status tags (expired/low-stock/near-expiry) — expired items
    // never appear at all, and stock count alone is enough signal.
    function renderProductGrid(products) {
        if (!productGrid) return;

        productGrid.innerHTML = products.map(p => {
            const isOOS     = p.stock_status === 'out_of_stock';
            const cardClass = isOOS ? 'out-of-stock' : '';

            return `
            <div class="product-card ${cardClass}"
                 data-id="${p.id}"
                 title="${isOOS ? 'Sold out' : 'Click to add'}">
                <div class="p-name">${escHtml(p.name)}</div>
                <div class="p-generic text-muted">${p.generic_name ? escHtml(p.generic_name) : '&nbsp;'}</div>
                <div class="p-price">${Fmt.currency(p.price)}</div>
                <div class="p-stock">Stock: ${p.stock_quantity} ${p.unit || 'pcs'}</div>
            </div>`;
        }).join('') || '<div class="text-center text-muted" style="padding:40px;grid-column:1/-1">No products found.</div>';

        // Add click listeners
        productGrid.querySelectorAll('.product-card:not(.out-of-stock)').forEach(card => {
            card.addEventListener('click', () => {
                const id      = parseInt(card.dataset.id);
                const product = allProducts.find(p => p.id === id);
                if (product) addToCart(product);
            });
        });
    }

    // ── Add to cart ─────────────────────────────────────────────
    // Expired batches are never returned by the backend at all, so no
    // client-side expiry check is needed here — the checkout endpoint
    // still re-validates server-side as a final safety net regardless.
    function addToCart(product, qty = 1) {
        qty = Math.max(1, parseInt(qty) || 1);

        // Stock check against the combined total across all non-expired batches
        const currentQty = cart.items.find(i => i.product.id === product.id)?.quantity || 0;
        if (currentQty >= product.stock_quantity) {
            Toast.show(`Only ${product.stock_quantity} units available.`, 'warning');
            return false;
        }
        if (currentQty + qty > product.stock_quantity) {
            const room = product.stock_quantity - currentQty;
            Toast.show(`Only ${room} more unit${room === 1 ? '' : 's'} of ${product.name} available — added ${room} instead of ${qty}.`, 'warning');
            cart.addItem(product, room);
            return true;
        }

        cart.addItem(product, qty);
        return true;
    }

    // ── Render cart ───────────────────────────────────────────
    function renderCart() {
        if (!cartItemsEl) return;

        if (cart.isEmpty) {
            cartItemsEl.innerHTML = `
                <div class="cart-empty">
                    <span class="empty-icon">🛒</span>
                    <span>Cart is empty</span>
                </div>`;
        } else {
            cartItemsEl.innerHTML = cart.items.map(item => `
                <div class="cart-item">
                    <div class="cart-item-info">
                        <div class="cart-item-name">${escHtml(item.product.name)}</div>
                        <div class="cart-item-price">${Fmt.currency(item.product.price)} each</div>
                    </div>
                    <div class="cart-item-controls">
                        <button class="qty-btn" data-action="dec" data-id="${item.product.id}">−</button>
                        <span class="qty-display">${item.quantity}</span>
                        <button class="qty-btn" data-action="inc" data-id="${item.product.id}">+</button>
                    </div>
                    <span class="cart-item-total">${Fmt.currency(item.product.price * item.quantity)}</span>
                    <button class="btn-remove-item" data-id="${item.product.id}" title="Remove">✕</button>
                </div>
            `).join('');

            // Qty buttons
            cartItemsEl.querySelectorAll('.qty-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const id = parseInt(btn.dataset.id);
                    cart.updateQty(id, btn.dataset.action === 'inc' ? 1 : -1);
                });
            });

            // Remove buttons
            cartItemsEl.querySelectorAll('.btn-remove-item').forEach(btn => {
                btn.addEventListener('click', () => cart.removeItem(parseInt(btn.dataset.id)));
            });
        }

        // Update counts and totals
        if (cartCountEl)  cartCountEl.textContent  = cart.items.reduce((s, i) => s + i.quantity, 0);
        if (subtotalEl)   subtotalEl.textContent    = Fmt.currency(cart.subtotal);
        if (discountEl)   discountEl.textContent    = Fmt.currency(cart.discount);
        if (totalEl)      totalEl.textContent       = Fmt.currency(cart.total);

        updateChange();
    }

    // ── Discount toggle (flat 20%) ───────────────────────────
    discountToggle?.addEventListener('click', () => {
        cart.discountEnabled = !cart.discountEnabled;
        discountToggle.classList.toggle('active', cart.discountEnabled);
        discountToggle.setAttribute('aria-pressed', String(cart.discountEnabled));
        renderCart();
        saveCartToStorage();
    });

    // ── Tendered amount ───────────────────────────────────────
    tenderedInput?.addEventListener('input', () => {
        cart.amountTendered = parseFloat(tenderedInput.value) || 0;
        updateChange();
        saveCartToStorage();
    });

    function updateChange() {
        if (!changeEl) return;
        const change = cart.amountTendered - cart.total;
        changeEl.textContent = change >= 0 ? Fmt.currency(change) : '—';
        changeEl.style.color = change >= 0 ? 'var(--success)' : 'var(--danger)';
    }

    // ── Payment method buttons ────────────────────────────────
    document.querySelectorAll('.pay-method-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.pay-method-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            cart.paymentMethod = btn.dataset.method;
            saveCartToStorage();
        });
    });

    // ── Simulated Barcode Scanner ─────────────────────────────
    document.getElementById('btn-barcode-scan')?.addEventListener('click', () => {
        barcodeRow?.classList.add('active');
        barcodeInput?.focus();
    });

    barcodeInput?.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') {
            const code = barcodeInput.value.trim();
            if (!code) return;

            const data = await OfflineAPI.get(`/pos/products?barcode=${encodeURIComponent(code)}`);

            if (data?.success && data.data.length) {
                addToCart(data.data[0]);
                barcodeInput.value = '';
            } else {
                Toast.show(`Barcode "${code}" not found.`, 'warning');
            }

            barcodeInput.value = '';
        }

        if (e.key === 'Escape') {
            barcodeRow?.classList.remove('active');
        }
    });

    // ── Camera Scanner (real camera, phone/laptop/desktop) ──────
    // Uses ZXing (loaded via CDN in pos.html) to decode barcodes from a live
    // video feed. Reuses the exact same lookup as manual/simulated scanning
    // below — the only new part is getting a code INTO that lookup via a
    // camera instead of a keyboard.
    let zxingControls = null;

    // Quantity-per-scan stepper (camera modal). Read fresh on every
    // successful scan (see handleScannedCode), so changing it mid-session
    // (e.g. from 1 to 50 for the next product) applies immediately without
    // needing to reopen the scanner.
    const cameraQtyInput = document.getElementById('camera-scan-qty');
    const cameraFeedback = document.getElementById('camera-scan-feedback');

    function getCameraScanQty() {
        const val = parseInt(cameraQtyInput?.value);
        return (!val || val < 1) ? 1 : val;
    }

    document.getElementById('camera-qty-dec')?.addEventListener('click', () => {
        if (!cameraQtyInput) return;
        cameraQtyInput.value = Math.max(1, getCameraScanQty() - 1);
    });
    document.getElementById('camera-qty-inc')?.addEventListener('click', () => {
        if (!cameraQtyInput) return;
        cameraQtyInput.value = getCameraScanQty() + 1;
    });
    cameraQtyInput?.addEventListener('input', () => {
        if (cameraQtyInput.value !== '' && getCameraScanQty() < 1) cameraQtyInput.value = 1;
    });

    document.getElementById('btn-camera-scan')?.addEventListener('click', openCameraScanner);
    document.getElementById('btn-camera-done')?.addEventListener('click', closeCameraScanner);
    document.getElementById('btn-camera-close')?.addEventListener('click', closeCameraScanner);

    // Only Done/✕ close this now -- backdrop-click-to-close was removed
    // app-wide (see main.js), since it was too easy to trigger by
    // accident and lose scanning progress or an in-progress form.

    async function openCameraScanner() {
        console.log('[Camera Scanner] Opening... ZXingBrowser loaded?', typeof ZXingBrowser !== 'undefined');

        if (typeof ZXingBrowser === 'undefined') {
            Toast.show('Camera scanner failed to load. Check your internet connection.', 'error');
            console.error('[Camera Scanner] ZXingBrowser is undefined — the CDN script did not load.');
            return;
        }

        Modal.open('camera-scan-modal');
        const videoEl = document.getElementById('camera-scan-video');

        // Fresh state for this scanning session — quantity defaults back to
        // 1 and any leftover "Added X" feedback from a previous visit to
        // this modal is cleared.
        if (cameraQtyInput) cameraQtyInput.value = 1;
        if (cameraFeedback) { cameraFeedback.textContent = ''; cameraFeedback.className = 'camera-scan-feedback'; }

        // Explicitly telling ZXing which formats to look for, plus TRY_HARDER,
        // is the documented, recommended way to use this library — confirmed
        // via its own source code and official examples. Without this, the
        // reader defaults to hints=null, which is exactly what earlier
        // diagnostic logging showed: a perfect video feed (readyState 4,
        // 640x480, continuously attempting frames) that never once
        // successfully decoded a barcode clearly in view. TRY_HARDER trades
        // a bit of per-frame speed for meaningfully better accuracy, which is
        // the right tradeoff here since we only need one successful decode,
        // not rapid-fire scanning of many items per second.
        let hints = null;
        if (typeof ZXing !== 'undefined' && ZXing.DecodeHintType && ZXing.BarcodeFormat) {
            hints = new Map();
            hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [
                ZXing.BarcodeFormat.CODE_128,
                ZXing.BarcodeFormat.EAN_13,
                ZXing.BarcodeFormat.EAN_8,
                ZXing.BarcodeFormat.UPC_A,
                ZXing.BarcodeFormat.UPC_E
            ]);
            hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
            console.log('[Camera Scanner] Hints configured with explicit formats + TRY_HARDER:', hints);
        } else {
            console.warn('[Camera Scanner] ZXing core library (window.ZXing) not found — falling back to default detection with no format hints. This was likely the actual bug.');
        }

        const reader = new ZXingBrowser.BrowserMultiFormatReader(hints);
        console.log('[Camera Scanner] Reader created:', reader);

        let frameCount = 0;

        // ── Scan confirmation (fixes false-positive misreads) ──────
        // ZXing decodes continuously, on essentially every camera frame, and
        // previously the FIRST successful decode was trusted and acted on
        // immediately. That's exactly what let a single noisy/blurry/glare-y
        // frame get accepted as a completely different (wrong) barcode from
        // the one actually in view — confirmed from a real session where the
        // camera was pointed at barcode 4800001005001 but a stray frame
        // decoded as 55112888. The longer a code is held in frame, the more
        // single-frame attempts happen, so this got worse the longer you held
        // the barcode up rather than better.
        //
        // Fix: require the SAME decoded text on two consecutive frames before
        // accepting it. A spurious/erroneous decode essentially never repeats
        // identically twice in a row, so this filters out false positives
        // while adding only a fraction of a second of perceived delay for a
        // real, steady scan. `scanLocked` additionally blocks any further
        // frame callbacks the instant a code IS confirmed.
        //
        // The scanner now stays open across multiple scans (see
        // handleScannedCode below) instead of closing after the first one,
        // so a code being confirmed is no longer the end of this session —
        // scanLocked/lastDecodedText/consecutiveMatches get RESET on a short
        // cooldown afterwards (see resetScanState) rather than staying
        // locked forever. That cooldown is what stops the same barcode,
        // still sitting in front of the camera, from being immediately
        // re-added a second time before the person has had a chance to move
        // on to the next product.
        const REQUIRED_CONSECUTIVE_MATCHES = 2;
        const SCAN_COOLDOWN_MS             = 1200;
        let lastDecodedText     = null;
        let consecutiveMatches  = 0;
        let scanLocked          = false;
        let cooldownTimer       = null;

        function resetScanState() {
            lastDecodedText    = null;
            consecutiveMatches = 0;
            scanLocked         = false;
        }

        function handleDecodeResult(result, err) {
            frameCount++;
            if (result) {
                if (scanLocked) return; // in cooldown after a confirmed scan — ignore stray in-flight frames

                const text = result.getText();
                if (text === lastDecodedText) {
                    consecutiveMatches++;
                } else {
                    lastDecodedText    = text;
                    consecutiveMatches = 1;
                }

                console.log(`[Camera Scanner] Candidate "${text}" — ${consecutiveMatches}/${REQUIRED_CONSECUTIVE_MATCHES} consecutive matches`);

                if (consecutiveMatches >= REQUIRED_CONSECUTIVE_MATCHES) {
                    scanLocked = true;
                    console.log('[Camera Scanner] CONFIRMED:', text);
                    clearTimeout(cooldownTimer);
                    handleScannedCode(text);
                    // Give the person a beat to move to the next product before
                    // the same code in frame could be confirmed again.
                    cooldownTimer = setTimeout(resetScanState, SCAN_COOLDOWN_MS);
                }
            } else if (err && frameCount % 30 === 0) {
                // ZXing calls this back on EVERY frame, even when nothing is
                // found (that's normal — it's continuously trying). Logging
                // every 30th attempt (roughly once a second) instead of every
                // single frame, so the console stays readable while still
                // proving the decode loop is actually running at all.
                console.log('[Camera Scanner] Still scanning, no code found yet. Attempt #' + frameCount, err?.name || err);
            }
        }

        try {
            // facingMode: 'environment' is a soft preference, not a hard
            // requirement — on a phone it correctly picks the back camera;
            // on a laptop with no "environment"-facing camera, the browser
            // falls back to whatever camera IS available (the webcam),
            // rather than failing outright. This is what lets the exact same
            // code work sensibly on both phones and laptops.
            zxingControls = await reader.decodeFromConstraints(
                { video: { facingMode: 'environment' } },
                videoEl,
                handleDecodeResult
            );
            console.log('[Camera Scanner] Camera stream started successfully. Controls:', zxingControls);
            console.log('[Camera Scanner] Video element readyState:', videoEl.readyState, '| dimensions:', videoEl.videoWidth, 'x', videoEl.videoHeight);
        } catch (err) {
            console.error('[Camera Scanner] FAILED to start camera:', err);
            Toast.show('Could not access camera: ' + (err?.message || 'permission denied.'), 'error');
            closeCameraScanner();
            return;
        }

        // If more than one camera is available (e.g. a laptop with both a
        // built-in webcam and an external USB one), offer a picker so the
        // person isn't stuck on the wrong one with no way to switch.
        try {
            const devices = await ZXingBrowser.BrowserCodeReader.listVideoInputDevices();
            const selectWrap = document.getElementById('camera-select-wrap');
            const select     = document.getElementById('camera-device-select');
            if (devices.length > 1 && selectWrap && select) {
                select.innerHTML = devices.map(d => `<option value="${d.deviceId}">${escHtml(d.label || 'Camera')}</option>`).join('');
                selectWrap.classList.remove('hidden');
                select.onchange = async () => {
                    if (zxingControls) { zxingControls.stop(); }
                    // Reset scan-confirmation state for the newly selected camera —
                    // a candidate from the old camera feed shouldn't count towards
                    // confirming a code on the new one.
                    lastDecodedText    = null;
                    consecutiveMatches = 0;
                    scanLocked         = false;
                    const newReader = new ZXingBrowser.BrowserMultiFormatReader(hints);
                    zxingControls = await newReader.decodeFromVideoDevice(select.value, videoEl, handleDecodeResult);
                };
            } else if (selectWrap) {
                selectWrap.classList.add('hidden');
            }
        } catch (err) {
            // Device enumeration failing isn't fatal — the camera is likely
            // already running fine from decodeFromConstraints() above; this
            // just means no device-picker dropdown will be shown.
        }
    }

    function closeCameraScanner() {
        if (zxingControls) {
            zxingControls.stop();  // releases the camera so it doesn't stay on
            zxingControls = null;
        }
        document.getElementById('camera-select-wrap')?.classList.add('hidden');
        Modal.close('camera-scan-modal');
    }

    // Camera stays open after a successful scan — no closeCameraScanner()
    // call here — so the cashier can keep scanning the next product without
    // reopening the modal each time. The quantity stepper is read fresh on
    // every call, so it's added at whatever quantity was set for THIS scan.
    async function handleScannedCode(code) {
        const qty  = getCameraScanQty();
        const data = await OfflineAPI.get(`/pos/products?barcode=${encodeURIComponent(code)}`);

        if (data?.success && data.data.length) {
            const product = data.data[0];
            const added   = addToCart(product, qty);
            if (added && cameraFeedback) {
                cameraFeedback.textContent = `✅ Added ${product.name} ×${qty}`;
                cameraFeedback.className   = 'camera-scan-feedback success';
            }
        } else {
            Toast.show(`Barcode "${code}" not found.`, 'warning');
            if (cameraFeedback) {
                cameraFeedback.textContent = `❌ Barcode "${code}" not found.`;
                cameraFeedback.className   = 'camera-scan-feedback error';
            }
        }
    }

    // ── Clear cart ────────────────────────────────────────────
    clearCartBtn?.addEventListener('click', async () => {
        if (cart.isEmpty) return;
        const confirmed = await ConfirmDialog.show({
            title: 'Clear Cart',
            message: 'Remove all items from the cart?',
            confirmText: 'Clear'
        });
        if (confirmed) cart.clear();
    });

    // ── Void: pick which transaction ───────────────
    // Shows up to the last 10 completed sales from the last 10 days (see
    // Order.VOID_WINDOW_DAYS on the backend) -- regardless of login
    // session or whether that day's register has since closed -- so a
    // wrong item caught late, even a day or two later, doesn't require
    // voiding everything back to it.
    voidBtn?.addEventListener('click', async () => {
        const candidates = await OfflineAPI.get('/pos/void-candidates');

        if (!candidates?.success || !candidates.data?.length) {
            Toast.show('No transaction from the last 10 days available to void.', 'info');
            return;
        }

        renderVoidList(candidates.data);
        Modal.open('void-list-modal');
    });

    function renderVoidList(orders) {
        const body = document.getElementById('void-list-body');
        if (!body) return;

        body.innerHTML = orders.map(order => {
            const itemsSummary = (order.items || [])
                .map(i => `${escHtml(i.product_name)} x${i.quantity}`)
                .join(', ');
            return `
            <div class="void-list-item">
                <div class="void-list-item-header">
                    <strong>${order.order_number}</strong>
                    <span>${Fmt.currency(order.total)}</span>
                </div>
                <div class="text-muted" style="font-size:0.75rem;margin-bottom:4px">${Fmt.datetime(order.created_at)}</div>
                <div class="void-list-item-items">${itemsSummary}</div>
                <button class="btn btn-danger btn-sm btn-void-this" data-id="${order.id}">Void This Transaction</button>
            </div>`;
        }).join('');

        body.querySelectorAll('.btn-void-this').forEach(btn => {
            btn.addEventListener('click', () => {
                const order = orders.find(o => o.id === parseInt(btn.dataset.id));
                if (order) confirmAndVoidOrder(order);
            });
        });
    }

    async function confirmAndVoidOrder(order) {
        const itemsList = (order.items || [])
            .map(i => `• ${i.product_name} x${i.quantity}`)
            .join('\n');

        // Voiding something from a PREVIOUS day is now allowed (it used to
        // be blocked once that day's register closed), but it can make a
        // Sales/Register report already generated for that date incorrect
        // after the fact -- flag it clearly here so it's a conscious
        // choice, not a surprise.
        const orderDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(order.created_at));
        const today     = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
        const isOlderDay = orderDay !== today;

        const warningLine = isOlderDay
            ? `\n\u26a0\ufe0f This sale is from ${Fmt.date(order.created_at)}, not today. Reports already generated for that date won't automatically reflect this void.\n`
            : '';

        // Step 1: show what would be voided (same for every role)
        const confirmed = await ConfirmDialog.show({
            title:       `Void ${order.order_number}?`,
            message:     `Total: ${Fmt.currency(order.total)}\n${itemsList}\n${warningLine}\nThis restores stock and cannot be undone.`,
            confirmText: 'Void Transaction'
        });

        if (!confirmed) return;

        const isCashier = Auth.getUser()?.role === 'cashier';

        if (isCashier) {
            // Cashiers cannot void on their own authority -- an admin/owner must
            // approve by entering their own credentials right here. Loop so a
            // typo doesn't just silently fail; every exit path below is an
            // explicit return (success, cashier cancels, or a non-credential
            // failure), so this never spins forever.
            let promptMessage = `Voiding ${order.order_number} requires an admin or owner to approve.`;

            while (true) {
                const creds = await ManagerApprovalDialog.show(promptMessage);
                if (!creds) return; // cashier cancelled

                const result = await OfflineAPI.post('/pos/void', {
                    order_id: order.id,
                    manager_email: creds.email,
                    manager_password: creds.password
                });

                if (result?.success) {
                    Toast.show(result.message, 'success');
                    Modal.close('void-list-modal');
                    loadPOSProducts();
                    loadCashSession(); // a void can change cash sales for the shift
                    return;
                }

                if (result?.message?.toLowerCase().includes('credentials')) {
                    // Wrong email/password or not an admin/owner -- let them retry
                    promptMessage = `❌ ${result.message} Please try again.`;
                    continue;
                }

                // Any other failure (already voided, closed session, etc.) -- stop
                Toast.show(result?.message || 'Void failed.', 'error');
                return;
            }
        } else {
            // Admins/super_admins already have full authority -- just a final
            // explicit confirmation since voiding cannot be reversed.
            const finalConfirmed = await ConfirmDialog.show({
                title:       'Final Confirmation',
                message:     `Are you absolutely sure you want to void ${order.order_number}? This action is permanent.`,
                confirmText: 'Yes, Void It'
            });

            if (!finalConfirmed) return;

            const result = await OfflineAPI.post('/pos/void', { order_id: order.id });

            if (result?.success) {
                Toast.show(result.message, 'success');
                Modal.close('void-list-modal');
                loadPOSProducts();
                loadCashSession(); // a void can change cash sales for the shift
            } else {
                Toast.show(result?.message || 'Void failed.', 'error');
            }
        }
    }

    // ── Checkout ──────────────────────────────────────────────
    checkoutBtn?.addEventListener('click', handleCheckout);

    async function handleCheckout() {
        if (cart.isEmpty) {
            Toast.show('Cart is empty.', 'warning');
            return;
        }

        if (!currentCashSession) {
            Toast.show('Please open your register before processing sales.', 'warning');
            return;
        }

        const tendered = parseFloat(tenderedInput?.value) || 0;
        if (cart.discount < 0 || cart.discount > cart.subtotal) {
            Toast.show('Discount cannot be greater than subtotal.', 'warning');
            return;
        }

        if (tendered < cart.total) {
            Toast.show(`Amount tendered must be at least ${Fmt.currency(cart.total)}.`, 'warning');
            return;
        }

        // Show a summary of exactly what's about to be charged before doing
        // anything irreversible — same principle as the void confirmation.
        const itemsList = cart.items
            .map(i => `• ${i.product.name} x${i.quantity} @ ${Fmt.currency(i.product.price)} = ${Fmt.currency(i.product.price * i.quantity)}`)
            .join('\n');

        const summary =
            `${itemsList}\n\n` +
            `Subtotal: ${Fmt.currency(cart.subtotal)}\n` +
            (cart.discount > 0 ? `Discount: -${Fmt.currency(cart.discount)}\n` : '') +
            `TOTAL: ${Fmt.currency(cart.total)}\n` +
            `Payment: ${cart.paymentMethod.toUpperCase()}\n` +
            `Tendered: ${Fmt.currency(tendered)}\n` +
            `Change: ${Fmt.currency(tendered - cart.total)}`;

        const confirmed = await ConfirmDialog.show({
            title:       'Confirm Checkout',
            message:     summary,
            confirmText: 'Confirm & Checkout',
            danger:      false
        });

        if (!confirmed) return;

        checkoutBtn.disabled = true;
        checkoutBtn.textContent = 'Processing…';

        // batch_ids lets the backend consume stock FEFO (earliest-expiring
        // batch first) across whichever batches make up this product's
        // combined stock count.
        //
        // cash_session_id is captured HERE, at the moment Checkout is
        // clicked — this matters for offline mode: if this sale gets
        // queued and only syncs later (possibly after this exact shift
        // has since closed), the server will check THIS specific session
        // ID is still open, rather than silently attaching the sale to
        // whatever shift happens to be open at sync time.
        const payload = {
            items: cart.items.map(i => ({
                product_id: i.product.id,
                batch_ids:  i.product.batch_ids,
                quantity:   i.quantity
            })),
            payment_method:  cart.paymentMethod,
            amount_tendered: tendered,
            discount:        cart.discount,
            cash_session_id: currentCashSession.id
        };

        const result = await OfflineAPI.post('/pos/checkout', payload);

        checkoutBtn.disabled = false;
        checkoutBtn.textContent = '✅ Checkout';

        if (result?.success) {
            if (result.queued) {
                Toast.show(
                    `Checkout queued for sync${result.queueCount ? ` (${result.queueCount} pending)` : ''}.`,
                    'info'
                );
                cart.clear();
                loadPOSProducts();
            } else {
                showReceipt(result.receipt);
                cart.clear();
                loadPOSProducts();  // Refresh stock
                loadCashSession();  // Refresh live cash totals
            }
        } else {
            if (result?.blocked && result?.reason === 'no_open_register') {
                // Our cached state was stale (e.g. register closed in another
                // tab) — resync so the blocker screen shows correctly.
                Toast.show(result.message, 'error');
                loadCashSession();
            } else if (result?.blocked && result?.reason === 'session_mismatch') {
                Toast.show(result.message, 'error');
                loadCashSession();
            } else if (result?.blocked && result?.reason === 'expired') {
                Toast.show(result.message, 'error', '⛔ Sale Blocked');
            } else {
                Toast.show(result?.message || 'Checkout failed.', 'error');
            }
        }
    }

    // ── Receipt Modal ─────────────────────────────────────────
    function showReceipt(receipt) {
        const receiptBody = document.getElementById('receipt-body');
        if (!receiptBody) return;

        receiptBody.innerHTML = `
            <div style="text-align:center;margin-bottom:16px">
                <strong style="font-size:1.1rem">PharmaTrack</strong>
                <div style="font-size:0.8rem;color:var(--secondary)">Official Receipt</div>
                <div style="font-size:0.8rem;color:var(--secondary)">${Fmt.datetime(receipt.created_at)}</div>
            </div>
            <div style="margin-bottom:8px;font-size:0.82rem">
                <strong>OR #:</strong> ${receipt.order_number}<br>
                <strong>Cashier:</strong> ${receipt.cashier_name}
            </div>
            <div class="table-container" style="margin-bottom:12px">
                <table class="table" style="white-space:normal">
                    <thead><tr>
                        <th>Item</th><th>Qty</th><th>Price</th><th>Total</th>
                    </tr></thead>
                    <tbody>
                        ${receipt.items.map(i => `
                        <tr>
                            <td>${escHtml(i.product_name)}</td>
                            <td>${i.quantity}</td>
                            <td>${Fmt.currency(i.unit_price)}</td>
                            <td>${Fmt.currency(i.subtotal)}</td>
                        </tr>`).join('')}
                    </tbody>
                </table>
            </div>
            <div style="font-size:0.875rem">
                <div style="display:flex;justify-content:space-between"><span>Subtotal</span><span>${Fmt.currency(receipt.subtotal)}</span></div>
                ${receipt.discount > 0 ? `<div style="display:flex;justify-content:space-between;color:var(--danger)"><span>Discount</span><span>− ${Fmt.currency(receipt.discount)}</span></div>` : ''}
                <div style="display:flex;justify-content:space-between;font-weight:700;font-size:1.05rem;margin-top:6px;padding-top:6px;border-top:1px solid var(--gray-200)">
                    <span>TOTAL</span><span style="color:var(--primary)">${Fmt.currency(receipt.total)}</span>
                </div>
                <div style="display:flex;justify-content:space-between;margin-top:4px"><span>Tendered</span><span>${Fmt.currency(receipt.amount_tendered)}</span></div>
                <div style="display:flex;justify-content:space-between;color:var(--success);font-weight:600"><span>Change</span><span>${Fmt.currency(receipt.change)}</span></div>
                <div style="margin-top:8px;font-size:0.78rem;color:var(--secondary)">Payment: ${receipt.payment_method.toUpperCase()}</div>
            </div>
            <div style="text-align:center;margin-top:16px;font-size:0.75rem;color:var(--secondary)">
                Thank you for your purchase!<br>Please consult your pharmacist for medication advice.
            </div>
        `;

        Modal.open('receipt-modal');
    }

    // ── AI Suggestion (Mock Prototype) ─────────────────────────
    // AI medicine suggestions are now handled by the JotForm AI Agent
    // (floating chat widget, loaded directly in pos.html) — the old mock
    // keyword-lookup endpoint (/pos/ai-suggest) is no longer used here.
});

function escHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function debounce(fn, ms) {
    let timer;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}
