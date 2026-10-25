// ============================================================
// PharmaTrack – pos.js
// Point of Sale: product search, barcode sim, cart, checkout,
// and cash register (Opening Cash / Cash In-Out / Close Register)
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    // Cashier, admin, and super_admin can access POS
    if (!Auth.requireAuth(['cashier', 'admin', 'super_admin'])) return;

    // ── State ─────────────────────────────────────────────────
    // -- VAT / Senior-PWD preview math --
    // Same arithmetic as backend/utils/vat.js (whole centavos, VAT-inclusive
    // prices, 12% VAT; Senior/PWD removes the VAT first, then takes 20% off).
    // The SERVER recalculates everything at checkout and is the authority --
    // this only keeps the cart's totals in step with what it will charge.
    function vatLine(grossCents, taxExempt, seniorPwd) {
        const gross = Math.round(grossCents);

        if (!taxExempt && !seniorPwd) {
            const net = Math.round(gross * 100 / 112);
            return { gross, discount: 0, vat: gross - net, vatableNet: net, exempt: 0 };
        }
        if (!taxExempt && seniorPwd) {
            const pay = Math.round(gross * 5 / 7);       // gross / 1.12 * 0.8
            return { gross, discount: gross - pay, vat: 0, vatableNet: 0, exempt: pay };
        }
        if (taxExempt && !seniorPwd) {
            return { gross, discount: 0, vat: 0, vatableNet: 0, exempt: gross };
        }
        const pay = Math.round(gross * 4 / 5);         // tax-exempt brand: only the 20%
        return { gross, discount: gross - pay, vat: 0, vatableNet: 0, exempt: pay };
    }

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
                this.items.push({ product, quantity: qty, seniorPwd: false });
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

        // Directly setting a quantity (typed into the cart's own quantity
        // field, same idea as "Type Barcode") rather than only being able
        // to step it one unit at a time via +/-. Same stock-cap and
        // remove-on-zero rules as updateQty above.
        setQty(productId, newQty) {
            const item = this.items.find(i => i.product.id === productId);
            if (!item) return;

            newQty = parseInt(newQty);

            if (isNaN(newQty) || newQty < 1) {
                this.removeItem(productId);
                return;
            }

            if (newQty > item.product.stock_quantity) {
                Toast.show(`Only ${item.product.stock_quantity} units of ${item.product.name} available.`, 'warning');
                newQty = item.product.stock_quantity;
            }

            item.quantity = newQty;
            renderCart();
            saveCartToStorage();
        },

        // Totals are worked out per cart line in whole centavos (see vatLine
        // above). discountEnabled is the Senior/PWD (20%) toggle: VAT comes off
        // first, then 20%, so the "discount" here is larger than a flat 20%.
        _calc() {
            const t = { gross: 0, discount: 0, vat: 0, vatableNet: 0, exempt: 0 };
            this.items.forEach(i => {
                const gross = Math.round(Number(i.product.price) * 100) * i.quantity;
                const r = vatLine(gross, Number(i.product.is_tax_exempt) === 1, this.discountEnabled || i.seniorPwd === true);
                t.gross      += r.gross;
                t.discount   += r.discount;
                t.vat        += r.vat;
                t.vatableNet += r.vatableNet;
                t.exempt     += r.exempt;
            });
            return t;
        },
        get subtotal()  { return this._calc().gross / 100; },
        get discount()  { return this._calc().discount / 100; },
        get total()     { const t = this._calc(); return Math.max(0, (t.gross - t.discount) / 100); },
        get vatAmount() { return this._calc().vat / 100; },
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

    // Changes the server refused (everything except sales, which have their own Pending
    // Sales list below) are shown by the shared panel in offlineSync.js: a plain-language
    // explanation of each one. The Inventory page has its own copy for inventory changes.
    SyncIssues.mount('pos');
    const FailedSyncPanel = { refresh: () => SyncIssues.refresh() };

    // -- Pending Sales (offline checkouts waiting to reach the server) --
    // Lists every sale that was made without a connection (or whose reply was
    // lost) and has not been recorded yet, plus any the server refused. Each
    // row can be synced on its own, and "Sync All" does the lot. Nothing here
    // can double-record a sale: every sale carries a unique reference the
    // server checks, and only one sync runs at a time.
    const PendingPanel = {
        isOpen:          false,
        busy:            false,
        syncedThisVisit: [],   // rows that synced while the list was open (shown with a tick until it is closed)
        notes:           new Map(),   // queue id -> last "will retry" message

        async refresh() {
            const { total, failed } = await OfflineAPI.getPendingCheckoutCount(Auth.getUser()?.id);
            this.renderButton(total, failed);
            if (this.isOpen) this.renderList();
        },

        renderButton(total, failed) {
            let btn = document.getElementById('pending-sales-banner');
            if (total > 0) {
                if (!btn) {
                    btn = document.createElement('button');
                    btn.id   = 'pending-sales-banner';
                    btn.type = 'button';
                    btn.addEventListener('click', () => this.openModal());
                    document.body.appendChild(btn);
                }
                btn.className   = 'pending-sales-banner' + (failed > 0 ? ' has-failed' : '');
                btn.textContent = failed > 0
                    ? `Pending Sales (${total}) - ${failed} failed`
                    : `Pending Sales (${total})`;
            } else if (btn) {
                btn.remove();
            }
        },

        ensureModal() {
            if (document.getElementById('pending-sales-modal')) return;
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay';
            overlay.id = 'pending-sales-modal';
            overlay.innerHTML = `
                <div class="modal" style="max-width:520px">
                    <div class="modal-header">
                        <h3>Pending Sales</h3>
                        <button class="btn-close" id="btn-close-pending-sales">X</button>
                    </div>
                    <div class="modal-body" id="pending-sales-body" style="max-height:60vh;overflow-y:auto"></div>
                    <div class="modal-footer pending-sales-footer">
                        <span class="pending-sales-status" id="pending-sales-status"></span>
                        <button class="btn btn-light" id="btn-close-pending-sales-2">Close</button>
                        <button class="btn btn-primary" id="btn-sync-all-pending">Sync All</button>
                    </div>
                </div>`;
            document.body.appendChild(overlay);

            document.getElementById('btn-close-pending-sales')?.addEventListener('click', () => this.closeModal());
            document.getElementById('btn-close-pending-sales-2')?.addEventListener('click', () => this.closeModal());
            document.getElementById('btn-sync-all-pending')?.addEventListener('click', () => this.runSync());

            document.getElementById('pending-sales-body')?.addEventListener('click', async (e) => {
                const btn = e.target.closest('button');
                if (!btn || this.busy) return;
                const id = parseInt(btn.dataset.id);

                if (btn.classList.contains('btn-pending-sync')) {
                    this.runSync({ id });
                } else if (btn.classList.contains('btn-pending-retry')) {
                    const newId = await OfflineAPI.retryFailedCheckout(id);
                    if (newId != null) this.runSync({ id: newId });
                } else if (btn.classList.contains('btn-pending-dismiss')) {
                    const ok = await TypedConfirm.show({
                        title:       'Dismiss This Sale',
                        message:     'This sale was never recorded. Dismissing removes it from this list for good, so only do it if the sale was handled another way.',
                        confirmText: 'Dismiss Sale'
                    });
                    if (!ok) return;
                    await OfflineAPI.clearFailedSync(id);
                    this.refresh();
                }
            });
        },

        async openModal() {
            this.ensureModal();
            this.syncedThisVisit = [];
            this.isOpen = true;
            this.setStatus('');
            Modal.open('pending-sales-modal');
            await this.renderList();
        },

        closeModal() {
            this.isOpen = false;
            this.syncedThisVisit = [];
            Modal.close('pending-sales-modal');
            this.refresh();
        },

        setStatus(text) {
            const el = document.getElementById('pending-sales-status');
            if (el) el.textContent = text;
        },

        setBusy(isBusy) {
            document.getElementById('pending-sales-body')?.querySelectorAll('button')
                .forEach(b => { b.disabled = isBusy; });
            const all = document.getElementById('btn-sync-all-pending');
            if (all) { all.disabled = isBusy; all.textContent = isBusy ? 'Syncing...' : 'Sync All'; }
        },

        // Syncs one queued sale (id given) or everything queued (no id)
        async runSync({ id = null } = {}) {
            if (this.busy) return;

            if (!offlineSync.isOnline) {
                this.setStatus("You're offline. Pending sales sync by themselves when the connection returns.");
                return;
            }

            this.busy = true;
            this.setBusy(true);
            this.setStatus('');

            // Snapshot first: a sale that syncs disappears from storage, and we
            // still want to show it here as done, with its order number.
            const before = await OfflineAPI.getPendingCheckouts();

            try {
                const outcome = id == null ? await offlineSync.processSyncQueue() : await offlineSync.syncOne(id);

                if (outcome.skipped === 'busy') {
                    this.setStatus('A sync is already running. Try again in a moment.');
                } else if (outcome.skipped === 'offline') {
                    this.setStatus("You're offline. Pending sales sync by themselves when the connection returns.");
                } else {
                    (outcome.results || []).forEach(res => {
                        if (res.endpoint !== '/pos/checkout') return;
                        const row = before.find(r => r.source === 'queue' && r.id === res.id);
                        if (res.status === 'synced' && row) {
                            this.syncedThisVisit.push({ ...row, orderNumber: res.orderNumber, duplicate: res.duplicate });
                        } else if (res.status === 'retry' || res.status === 'auth') {
                            this.notes.set(res.id, res.message);
                        }
                    });
                }
            } catch (err) {
                console.warn('Pending sync failed:', err);
                this.setStatus('Sync failed. Check your connection and try again.');
            } finally {
                this.busy = false;
                this.setBusy(false);
            }

            await this.refresh();
        },

        async renderList() {
            const body = document.getElementById('pending-sales-body');
            if (!body) return;

            const me   = Auth.getUser();
            const rows = await OfflineAPI.getPendingCheckouts();
            const done = this.syncedThisVisit;

            const allBtn = document.getElementById('btn-sync-all-pending');
            if (allBtn) allBtn.disabled = !rows.some(r => r.status === 'pending');

            if (!rows.length && !done.length) {
                body.innerHTML = `<p class="text-muted" style="text-align:center;padding:20px">Nothing pending. Every sale has been recorded.</p>`;
                return;
            }

            const itemsText = r => (r.items || []).map(i => `${escHtml(i.name)} x${i.quantity}`).join(', ');
            const totalText = r => r.total != null ? Fmt.currency(r.total) : 'Total not available';

            const doneHtml = done.map(r => `
                <div class="pending-item synced">
                    <div class="pending-item-head">
                        <strong>${Fmt.datetime(r.createdAt)}</strong>
                        <span class="pending-badge synced">Synced</span>
                    </div>
                    <div class="pending-item-lines">${itemsText(r)}</div>
                    <div class="pending-item-total">${totalText(r)}</div>
                    <div class="pending-item-note synced">${r.orderNumber ? 'Recorded as ' + escHtml(r.orderNumber) + '.' : 'Recorded.'}${r.duplicate ? ' (It had already been saved earlier.)' : ''}</div>
                </div>`).join('');

            const rowsHtml = rows.map(r => {
                const mine = r.cashierId == null || r.cashierId === me?.id;
                const note = r.status === 'failed'
                    ? (r.reason || 'The server refused this sale.')
                    : (this.notes.get(r.id) || r.reason || '');
                const buttons = r.status === 'failed'
                    ? `<button class="btn btn-primary btn-sm btn-pending-retry" data-id="${r.id}" ${mine ? '' : 'disabled'}>Retry</button>
                       <button class="btn btn-light btn-sm btn-pending-dismiss" data-id="${r.id}">Dismiss</button>`
                    : `<button class="btn btn-primary btn-sm btn-pending-sync" data-id="${r.id}" ${mine ? '' : 'disabled'}>Sync</button>`;

                return `
                <div class="pending-item ${r.status}">
                    <div class="pending-item-head">
                        <strong>${Fmt.datetime(r.createdAt)}</strong>
                        <span class="pending-badge ${r.status}">${r.status === 'failed' ? 'Failed' : 'Pending'}</span>
                    </div>
                    <div class="pending-item-lines">${itemsText(r)}</div>
                    <div class="pending-item-total">${totalText(r)}${r.cashierName ? ' &middot; ' + escHtml(r.cashierName) : ''}</div>
                    ${note ? `<div class="pending-item-note ${r.status}">${escHtml(note)}</div>` : ''}
                    ${mine ? '' : `<div class="pending-item-note">Sign in as ${escHtml(r.cashierName || 'the cashier who made it')} to sync this sale.</div>`}
                    <div class="pending-item-actions">${buttons}</div>
                </div>`;
            }).join('');

            body.innerHTML = rowsHtml + doneHtml;
        }
    };

    // Housekeeping for the offline queue, once per page load: drop any void
    // request an older version left in browser storage (it holds a manager's
    // password), and give older queued sales their duplicate-guard reference.
    (async () => {
        try {
            const removedVoids = await OfflineAPI.purgeStoredVoidRequests();
            if (removedVoids > 0) {
                Toast.show(
                    `${removedVoids} offline void request${removedVoids === 1 ? ' was' : 's were'} removed for security. Voids now need an internet connection - please redo ${removedVoids === 1 ? 'it' : 'them'} online.`,
                    'warning'
                );
            }
            await OfflineAPI.ensureCheckoutRefs();
        } catch (err) {
            console.warn('Offline queue housekeeping failed:', err);
        }
        PendingPanel.refresh();
    })();

    window.addEventListener('pharmatrack:sync-complete', () => {
        FailedSyncPanel.refresh();
        PendingPanel.refresh();
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

    // -- Quick-cash buttons (Open Register modal) --
    // Each button ADDS its amount to whatever is already in the field (typed
    // or from earlier taps); Clear empties it. The field itself is still a
    // normal number input, so typing or editing by hand keeps working
    // between taps. Math is done in whole centavos so a typed amount like
    // 100.10 never picks up floating-point drift (e.g. 100.10000000000001).
    const openRegisterAmountInput = document.getElementById('open-register-amount');

    document.querySelectorAll('#open-register-quick-cash .quick-cash-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (!openRegisterAmountInput) return;
            const add     = parseFloat(btn.dataset.amount) || 0;
            const current = parseFloat(openRegisterAmountInput.value);
            const base    = (isNaN(current) || current < 0) ? 0 : current;
            const result  = Math.round(base * 100 + add * 100) / 100;

            if (result > 99999999.99) {
                Toast.show('That amount is too large.', 'warning');
                return;
            }

            openRegisterAmountInput.value = String(result);
        });
    });

    document.getElementById('open-register-clear')?.addEventListener('click', () => {
        if (!openRegisterAmountInput) return;
        openRegisterAmountInput.value = '';
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
                    promptMessage = `${result.message} Please try again.`;
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
                    promptMessage = `${result.message} Please try again.`;
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
    document.getElementById('btn-close-register')?.addEventListener('click', async () => {
        if (!currentCashSession) return;

        // Sales still waiting to sync are not in the register's totals yet, and
        // once the register is closed the server refuses them. So closing is
        // held until they are synced (or dismissed on purpose).
        const pending = await OfflineAPI.getPendingCheckoutCount(Auth.getUser()?.id);
        if (pending.total > 0) {
            const openList = await ConfirmDialog.show({
                title:       'Sales Still Pending',
                message:     `${pending.total} sale${pending.total === 1 ? ' has' : 's have'} not been recorded on the server yet${pending.failed ? ` (${pending.failed} failed)` : ''}. Sync ${pending.total === 1 ? 'it' : 'them'} before closing the register, or the drawer total will not match.`,
                confirmText: 'Open Pending Sales'
            });
            if (openList) PendingPanel.openModal();
            return;
        }

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
                    promptMessage = `${result.message} Please try again.`;
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

    // Suggestions read from whatever `allProducts` currently holds -- since
    // that's replaced by each search's own results, suggestions may lag by
    // one keystroke during very rapid typing, an acceptable tradeoff
    // rather than keeping a whole separate "master catalog" copy just for
    // this.
    SearchSuggest.attach(searchInput, {
        getItems:    () => allProducts,
        getLabel:    p => p.name,
        getSubLabel: p => `${Fmt.currency(p.price)} · Stock: ${p.stock_quantity}`
    });

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
    // The label above the 20% toggle is fixed text ("Discount: Senior/PWD" in
    // pos.html). It does NOT change when the toggle or an item tick changes.
    function renderCart() {
        if (!cartItemsEl) return;

        if (cart.isEmpty) {
            cartItemsEl.innerHTML = `
                <div class="cart-empty">
                    <span>Cart is empty</span>
                </div>`;
        } else {
            cartItemsEl.innerHTML = cart.items.map(item => `
                <div class="cart-item">
                    <div class="cart-item-info">
                        <div class="cart-item-name">${escHtml(item.product.name)}</div>
                        <div class="cart-item-price">${Fmt.currency(item.product.price)} each</div>
                        <label class="cart-item-sp${(cart.discountEnabled || item.seniorPwd) ? ' active' : ''}${cart.discountEnabled ? ' locked' : ''}"
                               title="${cart.discountEnabled ? 'Applied to every item by the 20% OFF toggle' : 'Apply the Senior/PWD 20% discount to this item only'}">
                            <input type="checkbox" class="sp-checkbox" data-id="${item.product.id}"
                                   ${(cart.discountEnabled || item.seniorPwd) ? 'checked' : ''} ${cart.discountEnabled ? 'disabled' : ''}>
                            Senior/PWD 20%
                        </label>
                    </div>
                    <div class="cart-item-controls">
                        <button class="qty-btn" data-action="dec" data-id="${item.product.id}">−</button>
                        <input type="number" class="qty-input" data-id="${item.product.id}"
                               value="${item.quantity}" min="1" max="${item.product.stock_quantity}">
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

            // Direct quantity entry -- same idea as "Type Barcode": type a
            // number instead of only being able to step one at a time.
            // `change` (fires on blur/Enter), not `input`, since renderCart()
            // replaces this exact element with a new one every time setQty
            // runs -- reacting on every keystroke would yank focus away
            // mid-typing.
            cartItemsEl.querySelectorAll('.qty-input').forEach(input => {
                input.addEventListener('change', () => {
                    const id = parseInt(input.dataset.id);
                    cart.setQty(id, input.value);
                });
                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') input.blur(); // commits via the change handler above
                });
                // Selecting the existing value on focus means typing
                // immediately replaces it, rather than needing to manually
                // clear the field first.
                input.addEventListener('focus', () => input.select());
            });

            // Senior/PWD tick on a single cart line (the 20% OFF toggle, when on,
            // covers every line and locks these boxes).
            cartItemsEl.querySelectorAll('.sp-checkbox').forEach(cb => {
                cb.addEventListener('change', () => {
                    const item = cart.items.find(i => i.product.id === parseInt(cb.dataset.id));
                    if (!item) return;
                    item.seniorPwd = cb.checked;
                    renderCart();
                    saveCartToStorage();
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

    // Quantity to add per typed/scanned barcode -- same stepper pattern as
    // the camera scanner's #camera-scan-qty (see getCameraScanQty below),
    // read fresh on every Enter so changing it mid-session (e.g. from 1 to
    // 20 for the next product) applies immediately without reopening
    // anything.
    const barcodeQtyInput = document.getElementById('barcode-scan-qty');

    function getBarcodeScanQty() {
        const val = parseInt(barcodeQtyInput?.value);
        return (!val || val < 1) ? 1 : val;
    }

    document.getElementById('barcode-qty-dec')?.addEventListener('click', () => {
        if (!barcodeQtyInput) return;
        barcodeQtyInput.value = Math.max(1, getBarcodeScanQty() - 1);
    });
    document.getElementById('barcode-qty-inc')?.addEventListener('click', () => {
        if (!barcodeQtyInput) return;
        barcodeQtyInput.value = getBarcodeScanQty() + 1;
    });
    barcodeQtyInput?.addEventListener('input', () => {
        if (barcodeQtyInput.value !== '' && getBarcodeScanQty() < 1) barcodeQtyInput.value = 1;
    });
    // Typing/adjusting the quantity shouldn't fall through to the barcode
    // input's own Enter/Escape handling below.
    barcodeQtyInput?.addEventListener('keydown', (e) => e.stopPropagation());

    barcodeInput?.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') {
            const code = barcodeInput.value.trim();
            if (!code) return;

            const qty  = getBarcodeScanQty();
            const data = await OfflineAPI.get(`/pos/products?barcode=${encodeURIComponent(code)}`);

            if (data?.success && data.data.length) {
                addToCart(data.data[0], qty);
                barcodeInput.value = '';
            } else {
                Toast.show(data?.message || `Barcode "${code}" not found.`, 'warning');
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
                cameraFeedback.textContent = `Added ${product.name} ×${qty}`;
                cameraFeedback.className   = 'camera-scan-feedback success';
            }
        } else {
            Toast.show(data?.message || `Barcode "${code}" not found.`, 'warning');
            if (cameraFeedback) {
                cameraFeedback.textContent = data?.message || `Barcode "${code}" not found.`;
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
    // Shows up to the last 50 completed sales from the last CALENDAR MONTH,
    // from ANY cashier -- not just your own -- so a mistake noticed later,
    // possibly by someone other than who rang it up, can still be found
    // and corrected.
    let voidCandidates = []; // full list from the server, filtered client-side by voidSearch below

    voidBtn?.addEventListener('click', async () => {
        const candidates = await OfflineAPI.get('/pos/void-candidates');

        if (!candidates?.success || !candidates.data?.length) {
            Toast.show('No transaction from the last month available to void.', 'info');
            return;
        }

        voidCandidates = candidates.data;
        const voidSearchInput = document.getElementById('void-search');
        if (voidSearchInput) voidSearchInput.value = '';
        renderVoidList(voidCandidates);
        Modal.open('void-list-modal');
        setTimeout(() => voidSearchInput?.focus(), 50);
    });

    // The full ~50-candidate list is already loaded client-side in one shot
    // above (not paginated), so filtering by order number just narrows the
    // in-memory array and re-renders -- no extra request needed.
    document.getElementById('void-search')?.addEventListener('input', debounce((e) => {
        const term = e.target.value.trim().toLowerCase();
        const filtered = term
            ? voidCandidates.filter(o => o.order_number.toLowerCase().includes(term))
            : voidCandidates;
        renderVoidList(filtered);
    }, 150));

    function renderVoidList(orders) {
        const body = document.getElementById('void-list-body');
        if (!body) return;

        if (!orders.length) {
            body.innerHTML = '<p class="text-muted" style="text-align:center;padding:20px">No matching transactions.</p>';
            return;
        }

        body.innerHTML = orders.map(order => {
            const items = order.items || [];
            const chips = items.slice(0, 4)
                .map(i => `<span class="void-chip">${escHtml(i.product_name)} <b>x${i.quantity}</b></span>`)
                .join('');
            const more = items.length > 4 ? `<span class="void-chip void-chip-more">+${items.length - 4} more</span>` : '';
            return `
            <div class="void-list-item">
                <div class="void-list-item-header">
                    <div>
                        <strong class="void-order-no">${order.order_number}</strong>
                        <div class="void-list-item-meta">${Fmt.datetime(order.created_at)} &middot; ${escHtml(order.cashier_name)}</div>
                    </div>
                    <span class="void-amount">${Fmt.currency(order.total)}</span>
                </div>
                <div class="void-list-item-items">${chips}${more}</div>
                <div class="void-list-item-actions">
                    <button class="btn btn-danger btn-sm btn-void-this" data-id="${order.id}">Void This Transaction</button>
                    <button class="btn btn-light btn-sm btn-partial-void" data-id="${order.id}">Partial Void</button>
                </div>
            </div>`;
        }).join('');

        body.querySelectorAll('.btn-void-this').forEach(btn => {
            btn.addEventListener('click', () => {
                const order = orders.find(o => o.id === parseInt(btn.dataset.id));
                if (order) confirmAndVoidOrder(order);
            });
        });

        body.querySelectorAll('.btn-partial-void').forEach(btn => {
            btn.addEventListener('click', () => {
                const order = orders.find(o => o.id === parseInt(btn.dataset.id));
                if (order) PartialVoid.open(order);
            });
        });
    }

    async function confirmAndVoidOrder(order) {
        const itemsList = (order.items || [])
            .map(i => `• ${i.product_name} x${i.quantity}`)
            .join('\n');

        // Voiding something from a PREVIOUS day (or a different cashier's
        // sale) is allowed, but it can make a Sales/Register report already
        // generated for that date incorrect after the fact -- flag it
        // clearly here so it's a conscious choice, not a surprise.
        const orderDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(order.created_at));
        const today     = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
        const isOlderDay = orderDay !== today;

        const currentUserId = Auth.getUser()?.id;
        const isOtherCashier = order.cashier_id !== currentUserId;

        let warningLine = '';
        if (isOlderDay) {
            warningLine += `\nThis sale is from ${Fmt.date(order.created_at)}, not today. Reports already generated for that date won't automatically reflect this void.\n`;
        }
        if (isOtherCashier) {
            warningLine += `\nThis sale was rung up by ${order.cashier_name}, not you.\n`;
        }

        // Step 1: show what would be voided (same for every role) -- an item list
        // and soft alert boxes instead of one block of plain text
        const voidItemRows = (order.items || []).map(i => `
            <div class="dlg-item">
                <div>${escHtml(i.product_name)}<small>Quantity ${i.quantity}</small></div>
            </div>`).join('');

        const voidHtml = `
            <div class="dlg-lead">
                <div><div class="dlg-label">Sale total</div><div class="dlg-big">${Fmt.currency(order.total)}</div></div>
                <div class="dlg-label">${escHtml(order.cashier_name)}</div>
            </div>
            <div class="dlg-items">${voidItemRows}</div>
            ${isOlderDay ? `<div class="dlg-alert warn">This sale is from ${Fmt.date(order.created_at)}, not today. Reports already generated for that date will not automatically reflect this void.</div>` : ''}
            ${isOtherCashier ? `<div class="dlg-alert info">This sale was rung up by ${escHtml(order.cashier_name)}, not you.</div>` : ''}
            <div class="dlg-alert danger">This restores stock and cannot be undone.</div>`;

        const confirmed = await ConfirmDialog.show({
            title:       `Void ${order.order_number}?`,
            message:     `Total: ${Fmt.currency(order.total)}\n${itemsList}\n${warningLine}\nThis restores stock and cannot be undone.`,
            html:        voidHtml,
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

                if (result?.offline) {
                    Toast.show(result.message, 'warning');
                    return;
                }

                if (result?.success) {
                    Toast.show(result.message, 'success');
                    Modal.close('void-list-modal');
                    loadPOSProducts();
                    loadCashSession(); // a void can change cash sales for the shift
                    return;
                }

                if (result?.message?.toLowerCase().includes('credentials')) {
                    // Wrong email/password or not an admin/owner -- let them retry
                    promptMessage = `${result.message} Please try again.`;
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

            if (result?.offline) {
                Toast.show(result.message, 'warning');
                return;
            }

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
    // -- Partial Void --
    // Void only some of the items (or some of the quantity) of a sale. The server
    // voids the original receipt, restocks just what was voided, and issues a NEW
    // receipt for what remains (see posController.partialVoidOrder). Same approval
    // as a full void; needs an internet connection like one.
    const PartialVoid = {
        order: null,
        qty:   new Map(),   // order_items.id -> quantity to void

        ensureModal() {
            if (document.getElementById('partial-void-modal')) return;
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay';
            overlay.id = 'partial-void-modal';
            overlay.innerHTML = `
                <div class="modal" style="max-width:520px">
                    <div class="modal-header">
                        <h3 id="partial-void-title">Partial Void</h3>
                        <button class="btn-close" id="btn-close-partial-void">X</button>
                    </div>
                    <div class="modal-body" id="partial-void-body" style="max-height:65vh;overflow-y:auto"></div>
                    <div class="modal-footer">
                        <button class="btn btn-light" id="btn-cancel-partial-void">Cancel</button>
                        <button class="btn btn-danger" id="btn-confirm-partial-void" disabled>Void Selected Items</button>
                    </div>
                </div>`;
            document.body.appendChild(overlay);

            document.getElementById('btn-close-partial-void')?.addEventListener('click', () => this.close());
            document.getElementById('btn-cancel-partial-void')?.addEventListener('click', () => this.close());
            document.getElementById('btn-confirm-partial-void')?.addEventListener('click', () => this.submit());

            document.getElementById('partial-void-body')?.addEventListener('click', (e) => {
                const btn = e.target.closest('button');
                if (!btn) return;
                const id   = parseInt(btn.dataset.id);
                const item = (this.order?.items || []).find(i => i.id === id);
                if (!item) return;
                const current = this.qty.get(id) || 0;
                if (btn.classList.contains('pv-plus'))  this.qty.set(id, Math.min(item.quantity, current + 1));
                if (btn.classList.contains('pv-minus')) this.qty.set(id, Math.max(0, current - 1));
                this.render();
            });
        },

        open(order) {
            this.ensureModal();
            this.order = order;
            this.qty   = new Map();
            document.getElementById('partial-void-title').textContent = `Partial Void - ${order.order_number}`;
            this.render();
            Modal.open('partial-void-modal');
        },

        close() {
            Modal.close('partial-void-modal');
            this.order = null;
            this.qty   = new Map();
        },

        // Live numbers for the summary, worked out with the same VAT/Senior-PWD math
        // the server uses (vatLine above), so what you see is what the new receipt
        // will total.
        summary() {
            const items = this.order?.items || [];
            const soldUnits = items.reduce((s, i) => s + i.quantity, 0);
            const voidUnits = [...this.qty.values()].reduce((s, q) => s + q, 0);

            const groups = new Map();
            items.forEach(i => {
                const key = `${i.product_name}|${Number(i.is_tax_exempt) ? 1 : 0}`;
                const g = groups.get(key) || { taxExempt: Number(i.is_tax_exempt) === 1, discounted: false, keptGross: 0 };
                if (Math.round(Number(i.discount_amount || 0) * 100) > 0) g.discounted = true;
                g.keptGross += Math.round(Number(i.unit_price) * 100) * (i.quantity - (this.qty.get(i.id) || 0));
                groups.set(key, g);
            });

            let newTotalCents = 0;
            groups.forEach(g => {
                if (g.keptGross > 0) {
                    const r = vatLine(g.keptGross, g.taxExempt, g.discounted);
                    newTotalCents += r.gross - r.discount;
                }
            });

            const refundCents = Math.max(0, Math.round(Number(this.order.total) * 100) - newTotalCents);
            return { soldUnits, voidUnits, newTotalCents, refundCents, valid: voidUnits >= 1 && voidUnits < soldUnits };
        },

        render() {
            const body = document.getElementById('partial-void-body');
            if (!body || !this.order) return;
            const order = this.order;
            const items = order.items || [];
            const s = this.summary();

            // same cautions as a full void: an older day / someone else's sale
            const dayFmt = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));
            let warnings = '';
            if (dayFmt(order.created_at) !== dayFmt(new Date())) {
                warnings += `<div class="pv-warning">This sale is from ${Fmt.date(order.created_at)}, not today. The new receipt keeps that date, so a report already generated for that day will not automatically reflect this change.</div>`;
            }
            if (order.cashier_id !== Auth.getUser()?.id) {
                warnings += `<div class="pv-warning">This sale was rung up by ${escHtml(order.cashier_name)}, not you.</div>`;
            }

            // when a brand was filled from several batches it has several rows;
            // show the batch so they can be told apart
            const nameCount = items.reduce((m, i) => m.set(i.product_name, (m.get(i.product_name) || 0) + 1), new Map());

            const rows = items.map(i => {
                const v = this.qty.get(i.id) || 0;
                const batch = nameCount.get(i.product_name) > 1 && i.batch_number ? ` <span class="pv-batch">(batch ${escHtml(i.batch_number)})</span>` : '';
                return `
                <div class="pv-row${v > 0 ? ' selected' : ''}">
                    <div class="pv-name">${escHtml(i.product_name)}${batch}
                        <div class="pv-meta">${Fmt.currency(i.unit_price)} each &middot; sold ${i.quantity}</div>
                    </div>
                    <div class="pv-stepper">
                        <button type="button" class="pv-minus" data-id="${i.id}" ${v <= 0 ? 'disabled' : ''}>-</button>
                        <span class="pv-qty">${v}</span>
                        <button type="button" class="pv-plus" data-id="${i.id}" ${v >= i.quantity ? 'disabled' : ''}>+</button>
                    </div>
                </div>`;
            }).join('');

            let note = 'Use + to choose how many of each item to void.';
            if (s.voidUnits >= s.soldUnits && s.voidUnits > 0) note = 'That voids the whole sale. Use "Void This Transaction" for that instead.';
            else if (s.voidUnits > 0) note = 'The original receipt is voided and a new receipt is issued for the rest.';

            body.innerHTML = `
                <div class="pv-info">${Fmt.datetime(order.created_at)} &middot; ${escHtml(order.cashier_name)} &middot; Total ${Fmt.currency(order.total)}</div>
                ${warnings}
                <div class="pv-rows">${rows}</div>
                <div class="pv-summary">
                    <div class="pv-summary-row"><span>Refund</span><strong>${Fmt.currency(s.refundCents / 100)}</strong></div>
                    <div class="pv-summary-row"><span>New receipt total</span><strong>${Fmt.currency(s.newTotalCents / 100)}</strong></div>
                    <div class="pv-note">${note}</div>
                </div>`;

            const confirmBtn = document.getElementById('btn-confirm-partial-void');
            if (confirmBtn) confirmBtn.disabled = !s.valid;
        },

        async submit() {
            const s = this.summary();
            if (!s.valid || !this.order) return;
            const order = this.order;

            const lines = (order.items || [])
                .filter(i => (this.qty.get(i.id) || 0) > 0)
                .map(i => `\u2022 ${i.product_name} x${this.qty.get(i.id)}`)
                .join('\n');

            const confirmed = await ConfirmDialog.show({
                title:       `Partial Void ${order.order_number}?`,
                message:     `Voiding:\n${lines}\n\nRefund: ${Fmt.currency(s.refundCents / 100)}\nNew receipt total: ${Fmt.currency(s.newTotalCents / 100)}\n\nThe original receipt is voided and a new one is issued for the remaining items. This restores stock for the voided items and cannot be undone.`,
                confirmText: 'Void Selected Items'
            });
            if (!confirmed) return;

            const isCashier = Auth.getUser()?.role === 'cashier';

            if (!isCashier) {
                // admins/owners already have the authority -- one explicit final confirmation
                const finalConfirmed = await ConfirmDialog.show({
                    title:       'Final Confirmation',
                    message:     `Are you absolutely sure you want to partially void ${order.order_number}? This action is permanent.`,
                    confirmText: 'Yes, Void Them'
                });
                if (!finalConfirmed) return;
            }

            const selections = [...this.qty].filter(([, q]) => q > 0).map(([id, q]) => ({ order_item_id: id, quantity: q }));
            let promptMessage = `Voiding part of ${order.order_number} requires an admin or owner to approve.`;

            while (true) {
                const body = { order_id: order.id, items: selections };

                if (isCashier) {
                    const creds = await ManagerApprovalDialog.show(promptMessage);
                    if (!creds) return;   // cancelled
                    body.manager_email    = creds.email;
                    body.manager_password = creds.password;
                }

                const result = await OfflineAPI.post('/pos/partial-void', body);

                if (result?.offline) {
                    Toast.show(result.message, 'warning');
                    return;
                }

                if (result?.success) {
                    Toast.show(result.message, 'success');
                    this.close();
                    Modal.close('void-list-modal');
                    loadPOSProducts();
                    loadCashSession();
                    if (result.receipt) showReceipt(result.receipt);   // the NEW receipt, ready to print
                    return;
                }

                if (isCashier && result?.message?.toLowerCase().includes('credentials')) {
                    promptMessage = `${result.message} Please try again.`;
                    continue;
                }

                Toast.show(result?.message || 'Partial void failed.', 'error');
                return;
            }
        }
    };

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
            .map(i => `• ${i.product.name} x${i.quantity} @ ${Fmt.currency(i.product.price)} = ${Fmt.currency(i.product.price * i.quantity)}${(cart.discountEnabled || i.seniorPwd) ? '  [Senior/PWD 20%]' : ''}`)
            .join('\n');

        const summary =
            `${itemsList}\n\n` +
            `Subtotal: ${Fmt.currency(cart.subtotal)}\n` +
            (cart.discount > 0 ? `Discount: -${Fmt.currency(cart.discount)}\n` : '') +
            `TOTAL: ${Fmt.currency(cart.total)}\n` +
            `VAT (12%) included: ${Fmt.currency(cart.vatAmount)}\n` +
            `Payment: ${cart.paymentMethod.toUpperCase()}\n` +
            `Tendered: ${Fmt.currency(tendered)}\n` +
            `Change: ${Fmt.currency(tendered - cart.total)}`;

        // The same facts as the plain-text summary above, laid out as an item list
        // and a totals card so it reads at a glance.
        const money = (v) => Fmt.currency(v);
        const itemRows = cart.items.map(i => {
            const senior = cart.discountEnabled || i.seniorPwd === true;
            return `<div class="dlg-item">
                <div>${escHtml(i.product.name)}${senior ? '<span class="dlg-tag">Senior/PWD</span>' : ''}
                    <small>${i.quantity} x ${money(i.product.price)}</small></div>
                <div class="dlg-amt">${money(i.product.price * i.quantity)}</div>
            </div>`;
        }).join('');

        const checkoutHtml = `
            <div class="dlg-lead">
                <div><div class="dlg-label">Total to pay</div><div class="dlg-big">${money(cart.total)}</div></div>
                <div class="dlg-label">${escHtml(String(cart.paymentMethod).toUpperCase())}</div>
            </div>
            <div class="dlg-items">${itemRows}</div>
            <div class="dlg-totals">
                <div class="dlg-total-row"><span>Subtotal</span><span>${money(cart.subtotal)}</span></div>
                ${cart.discount > 0 ? `<div class="dlg-total-row"><span>Discount</span><span>- ${money(cart.discount)}</span></div>` : ''}
                <div class="dlg-total-row"><span>VAT (12%) included</span><span>${money(cart.vatAmount)}</span></div>
                <div class="dlg-total-row"><span>Tendered</span><span>${money(tendered)}</span></div>
                <div class="dlg-total-row dlg-change"><span>Change</span><span>${money(tendered - cart.total)}</span></div>
            </div>`;

        const confirmed = await ConfirmDialog.show({
            title:       'Confirm Checkout',
            message:     summary,
            html:        checkoutHtml,
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
                quantity:   i.quantity,
                senior_pwd: i.seniorPwd === true
            })),
            payment_method:  cart.paymentMethod,
            amount_tendered: tendered,
            senior_pwd_all:  cart.discountEnabled,
            cash_session_id: currentCashSession.id,
            // A random reference for THIS sale. The server remembers it, so if
            // this exact sale ever arrives twice (a reply lost on the way back,
            // or a manual re-sync) it is recognized and recorded only once.
            client_ref:      OfflineAPI.newSaleRef()
        };

        // Details kept with a sale that ends up queued, only so the Pending Sales
        // list can describe it. Never sent to the server.
        const me = Auth.getUser();
        const saleMeta = {
            created_at:   new Date().toISOString(),
            total:        cart.total,
            cashier_id:   me?.id ?? null,
            cashier_name: me?.name ?? null,
            items:        cart.items.map(i => ({
                name:      i.product.name,
                quantity:  i.quantity,
                price:     Number(i.product.price),
                seniorPwd: cart.discountEnabled || i.seniorPwd === true
            }))
        };

        const result = await OfflineAPI.post('/pos/checkout', payload, saleMeta);

        checkoutBtn.disabled = false;
        checkoutBtn.textContent = 'Checkout';

        if (result?.success) {
            if (result.queued) {
                Toast.show(
                    `Checkout queued for sync${result.queueCount ? ` (${result.queueCount} pending)` : ''}.`,
                    'info'
                );
                cart.clear();
                loadPOSProducts();
                PendingPanel.refresh();
            } else if (result.duplicate && !result.receipt) {
                // The server had already recorded this exact sale (an earlier
                // attempt got through but its reply was lost) -- nothing to redo.
                Toast.show(`This sale was already recorded${result.order_number ? ' as ' + result.order_number : ''}.`, 'info');
                cart.clear();
                loadPOSProducts();
                loadCashSession();
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
                Toast.show(result.message, 'error', 'Sale Blocked');
            } else {
                Toast.show(result?.message || 'Checkout failed.', 'error');
            }
        }
    }

    // ── Receipt Modal ─────────────────────────────────────────
    function showReceipt(receipt) {
        const receiptBody = document.getElementById('receipt-body');
        if (!receiptBody) return;

        // The receipt layout lives in receipt.js (shared with the Sales Report
        // reprint and the print-only 80mm output), so what's shown here is
        // exactly what gets printed.
        Receipt.current = receipt;
        receiptBody.innerHTML = Receipt.build(receipt);

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
