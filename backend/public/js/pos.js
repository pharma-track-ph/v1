// ============================================================
// PharmaTrack – pos.js
// Point of Sale: product search, barcode sim, cart, checkout
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    // Cashier, admin, and super_admin can access POS
    if (!Auth.requireAuth(['cashier', 'admin', 'super_admin'])) return;

    // ── State ─────────────────────────────────────────────────
    const cart = {
        items:         [],    // Array of { product, quantity }
        discount:      0,
        paymentMethod: 'cash',
        amountTendered: 0,

        addItem(product) {
            const existing = this.items.find(i => i.product.id === product.id);
            if (existing) {
                existing.quantity++;
            } else {
                this.items.push({ product, quantity: 1 });
            }
            renderCart();
        },

        removeItem(productId) {
            this.items = this.items.filter(i => i.product.id !== productId);
            renderCart();
        },

        updateQty(productId, delta) {
            const item = this.items.find(i => i.product.id === productId);
            if (!item) return;
            item.quantity += delta;
            if (item.quantity <= 0) this.removeItem(productId);
            else renderCart();
        },

        get subtotal() { return this.items.reduce((s, i) => s + (i.product.price * i.quantity), 0); },
        get total()    { return Math.max(0, this.subtotal - this.discount); },
        get change()   { return this.amountTendered - this.total; },
        get isEmpty()  { return !this.items.length; },

        clear() {
            this.items = [];
            this.discount = 0;
            this.amountTendered = 0;
            renderCart();
        }
    };

    // ── DOM References ────────────────────────────────────────
    const productGrid     = document.getElementById('product-grid');
    const searchInput     = document.getElementById('pos-search');
    const barcodeRow      = document.getElementById('barcode-input-row');
    const barcodeInput    = document.getElementById('barcode-input');
    const cartItemsEl     = document.getElementById('cart-items');
    const cartCountEl     = document.getElementById('cart-count');
    const subtotalEl      = document.getElementById('cart-subtotal');
    const discountEl      = document.getElementById('cart-discount-display');
    const totalEl         = document.getElementById('cart-total');
    const changeEl        = document.getElementById('change-display');
    const discountInput   = document.getElementById('discount-input');
    const tenderedInput   = document.getElementById('amount-tendered');
    const checkoutBtn     = document.getElementById('btn-checkout');
    const clearCartBtn    = document.getElementById('btn-clear-cart');

    // ── Load all available products ───────────────────────────
    let allProducts = [];
    loadPOSProducts();

    async function loadPOSProducts(query = '') {
        const params = query ? `?q=${encodeURIComponent(query)}` : '';
        const data   = await API.get(`/pos/products${params}`);
        if (!data?.success) return;

        allProducts = data.data;
        renderProductGrid(allProducts);
    }

    // ── Product search ────────────────────────────────────────
    searchInput?.addEventListener('input', debounce(() => {
        const q = searchInput.value.trim();
        if (q.length === 0) {
            renderProductGrid(allProducts);
        } else {
            loadPOSProducts(q);
        }
    }, 280));

    // ── Render product cards ───────────────────────────────────
    function renderProductGrid(products) {
        if (!productGrid) return;

        productGrid.innerHTML = products.map(p => {
            const isExpired = p.stock_status === 'expired';
            const isOOS     = p.stock_status === 'out_of_stock';
            const cardClass = isExpired ? 'expired' : (isOOS ? 'out-of-stock' : '');

            return `
            <div class="product-card ${cardClass}"
                 data-id="${p.id}"
                 title="${isExpired ? 'Expired — cannot sell' : (isOOS ? 'Out of stock' : 'Click to add')}">
                <div class="p-name">${escHtml(p.name)}</div>
                ${p.generic_name ? `<div class="text-muted" style="font-size:0.72rem">${escHtml(p.generic_name)}</div>` : ''}
                <div class="p-price">${Fmt.currency(p.price)}</div>
                <div class="p-stock">Stock: ${p.stock_quantity} ${p.unit || 'pcs'}</div>
                ${isExpired ? `<div class="p-expiry-warn">⛔ EXPIRED</div>` : ''}
                ${p.stock_status === 'near_expiry' ? `<div class="p-expiry-warn" style="color:var(--warning)">⚠️ Near expiry</div>` : ''}
                ${p.stock_status === 'low_stock'   ? `<div class="p-expiry-warn" style="color:var(--primary)">📦 Low stock</div>` : ''}
            </div>`;
        }).join('') || '<div class="text-center text-muted" style="padding:40px;grid-column:1/-1">No products found.</div>';

        // Add click listeners
        productGrid.querySelectorAll('.product-card:not(.expired):not(.out-of-stock)').forEach(card => {
            card.addEventListener('click', () => {
                const id      = parseInt(card.dataset.id);
                const product = allProducts.find(p => p.id === id);
                if (product) addToCart(product);
            });
        });
    }

    // ── Add to cart (with expiry block) ───────────────────────
    function addToCart(product) {
        const today = new Date().toISOString().split('T')[0];

        // ── EXPIRY BLOCK ──────────────────────────────────────
        if (product.expiry_date <= today) {
            Toast.show(
                `Cannot sell batch ${product.batch_number}: Item expired.`,
                'error',
                'Sale Blocked'
            );
            return;
        }

        // ── STOCK CHECK ───────────────────────────────────────
        const currentQty = cart.items.find(i => i.product.id === product.id)?.quantity || 0;
        if (currentQty >= product.stock_quantity) {
            Toast.show(`Only ${product.stock_quantity} units available.`, 'warning');
            return;
        }

        cart.addItem(product);
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

    // ── Discount ──────────────────────────────────────────────
    discountInput?.addEventListener('input', () => {
        cart.discount = parseFloat(discountInput.value) || 0;
        renderCart();
    });

    // ── Tendered amount ───────────────────────────────────────
    tenderedInput?.addEventListener('input', () => {
        cart.amountTendered = parseFloat(tenderedInput.value) || 0;
        updateChange();
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

            const data = await API.get(`/pos/products?barcode=${encodeURIComponent(code)}`);

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

    // ── Clear cart ────────────────────────────────────────────
    clearCartBtn?.addEventListener('click', () => {
        if (cart.isEmpty) return;
        if (confirm('Clear the cart?')) cart.clear();
    });

    // ── Checkout ──────────────────────────────────────────────
    checkoutBtn?.addEventListener('click', handleCheckout);

    async function handleCheckout() {
        if (cart.isEmpty) {
            Toast.show('Cart is empty.', 'warning');
            return;
        }

        const tendered = parseFloat(tenderedInput?.value) || 0;
        if (tendered < cart.total) {
            Toast.show(`Amount tendered must be at least ${Fmt.currency(cart.total)}.`, 'warning');
            return;
        }

        checkoutBtn.disabled = true;
        checkoutBtn.textContent = 'Processing…';

        const payload = {
            items: cart.items.map(i => ({
                product_id: i.product.id,
                quantity:   i.quantity
            })),
            payment_method:  cart.paymentMethod,
            amount_tendered: tendered,
            discount:        cart.discount
        };

        const result = await API.post('/pos/checkout', payload);

        checkoutBtn.disabled = false;
        checkoutBtn.textContent = '✅ Checkout';

        if (result?.success) {
            showReceipt(result.receipt);
            cart.clear();
            loadPOSProducts();  // Refresh stock
        } else {
            // Handle expiry block from backend as extra safety layer
            if (result?.blocked && result?.reason === 'expired') {
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
    document.getElementById('btn-ai-suggest')?.addEventListener('click', async () => {
        const symptomInput = document.getElementById('ai-symptoms-input');
        const resultEl     = document.getElementById('ai-result');

        if (!symptomInput?.value.trim()) {
            Toast.show('Enter symptoms first.', 'warning');
            return;
        }

        resultEl.textContent = '⏳ Analyzing…';

        const data = await API.post('/pos/ai-suggest', { symptoms: symptomInput.value });

        if (data?.success) {
            resultEl.innerHTML = `
                💊 <strong>Suggested:</strong> ${escHtml(data.suggestion)}<br>
                <span class="ai-disclaimer">${escHtml(data.disclaimer)}</span>`;
        } else {
            resultEl.textContent = 'Unable to get suggestion.';
        }
    });
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
