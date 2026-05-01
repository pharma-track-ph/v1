// ============================================================
// PharmaTrack – inventory.js
// Inventory CRUD, expiry highlighting, CSV import
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    if (!Auth.requireAuth(['admin', 'super_admin'])) return;

    // ── State ────────────────────────────────────────────────
    let products  = [];
    let editingId = null;

    // ── DOM References ───────────────────────────────────────
    const tbody          = document.getElementById('inv-tbody');
    const searchInput    = document.getElementById('inv-search');
    const categoryFilter = document.getElementById('inv-filter-cat');
    const statusFilter   = document.getElementById('inv-filter-status');
    const totalCount     = document.getElementById('inv-total-count');
    const productForm    = document.getElementById('product-form');
    const modalTitle     = document.getElementById('modal-title');
    const importInput    = document.getElementById('csv-import-input');
    const submitBtn      = document.getElementById('btn-submit-product');

    // ── Initial load ─────────────────────────────────────────
    loadProducts();
    loadCategories();

    // ── Filters ──────────────────────────────────────────────
    searchInput?.addEventListener('input',    debounce(loadProducts, 300));
    categoryFilter?.addEventListener('change', loadProducts);
    statusFilter?.addEventListener('change',   loadProducts);

    // ── Toolbar ───────────────────────────────────────────────
    document.getElementById('btn-add-product')?.addEventListener('click', openAddModal);
    document.getElementById('btn-import-csv')?.addEventListener('click', () => importInput?.click());
    importInput?.addEventListener('change', handleCSVImport);
    submitBtn?.addEventListener('click', handleFormSubmit);

    // ── Modal close ───────────────────────────────────────────
    document.querySelectorAll('.btn-close-modal').forEach(btn => {
        btn.addEventListener('click', () => Modal.close('product-modal'));
    });

    // ─────────────────────────────────────────────────────────
    // LOAD PRODUCTS
    // ─────────────────────────────────────────────────────────
    async function loadProducts() {
        const search   = searchInput?.value.trim() || '';
        const category = categoryFilter?.value     || '';
        const status   = statusFilter?.value       || '';

        const params = new URLSearchParams({ search, category, status });
        const data   = await OfflineAPI.get(`/inventory?${params}`);

        if (!data?.success) {
            Toast.show('Failed to load products.', 'error');
            return;
        }

        products = data.data;
        renderTable(products);
        if (totalCount) totalCount.textContent = products.length;
    }

    // ─────────────────────────────────────────────────────────
    // RENDER TABLE
    // ─────────────────────────────────────────────────────────
    function renderTable(data) {
        if (!tbody) return;

        if (!data.length) {
            tbody.innerHTML = `<tr><td colspan="8" class="text-center text-muted" style="padding:40px">
                No products found.</td></tr>`;
            return;
        }

        tbody.innerHTML = data.map(p => {
            const statusBadge = getStatusBadge(p.stock_status);
            const expiryCell  = getExpiryCell(p);
            const rowClass    = getRowClass(p.stock_status);
            return `
            <tr class="${rowClass}" data-id="${p.id}">
                <td><span class="fw-600">${escHtml(p.batch_number)}</span></td>
                <td>
                    <div class="fw-600">${escHtml(p.name)}</div>
                    ${p.generic_name ? `<div class="text-muted" style="font-size:0.73rem">${escHtml(p.generic_name)}</div>` : ''}
                </td>
                <td>${escHtml(p.category)}</td>
                <td>
                    <span class="${p.stock_quantity <= p.low_stock_threshold ? 'text-danger fw-600' : ''}">
                        ${p.stock_quantity}
                    </span>
                </td>
                <td>${Fmt.currency(p.price)}</td>
                <td>${expiryCell}</td>
                <td>${statusBadge}</td>
                <td>
                    <div class="d-flex gap-8">
                        <button class="btn btn-light btn-sm btn-edit"    data-id="${p.id}" title="Edit">✏️</button>
                        <button class="btn btn-danger btn-sm btn-delete" data-id="${p.id}" title="Delete">🗑️</button>
                    </div>
                </td>
            </tr>`;
        }).join('');

        tbody.querySelectorAll('.btn-edit').forEach(btn => {
            btn.addEventListener('click', () => openEditModal(parseInt(btn.dataset.id)));
        });
        tbody.querySelectorAll('.btn-delete').forEach(btn => {
            btn.addEventListener('click', () => confirmDelete(parseInt(btn.dataset.id)));
        });
    }

    function getStatusBadge(status) {
        const map = {
            in_stock:    '<span class="badge badge-success">In Stock</span>',
            low_stock:   '<span class="badge badge-warning">Low Stock</span>',
            near_expiry: '<span class="badge badge-warning">Near Expiry</span>',
            expired:     '<span class="badge badge-danger">Expired</span>',
            out_of_stock:'<span class="badge badge-secondary">Out of Stock</span>'
        };
        return map[status] || `<span class="badge badge-secondary">${status}</span>`;
    }

    function getExpiryCell(p) {
        const daysLeft = parseInt(p.days_until_expiry);
        let dotClass = 'green';
        if (daysLeft < 0)        dotClass = 'red';
        else if (daysLeft <= 30) dotClass = 'amber';
        return `
            <div class="expiry-cell">
                <span class="expiry-dot ${dotClass}"></span>
                ${Fmt.date(p.expiry_date)}
                ${daysLeft < 0 ? `<span style="font-size:0.7rem;color:var(--danger)">(Expired)</span>` : ''}
                ${daysLeft >= 0 && daysLeft <= 30 ? `<span style="font-size:0.7rem;color:#92400e">(${daysLeft}d)</span>` : ''}
            </div>`;
    }

    function getRowClass(status) {
        if (status === 'expired')     return 'row-expired';
        if (status === 'near_expiry') return 'row-expiring';
        if (status === 'low_stock')   return 'row-low-stock';
        return '';
    }

    // ─────────────────────────────────────────────────────────
    // CATEGORIES
    // ─────────────────────────────────────────────────────────
    async function loadCategories() {
        const data = await OfflineAPI.get('/inventory/alerts/summary');
        if (!data?.success || !categoryFilter) return;
        const cats = data.data.categories || [];
        cats.forEach(cat => {
            const opt = document.createElement('option');
            opt.value = cat; opt.textContent = cat;
            categoryFilter.appendChild(opt);
        });
    }

    // ─────────────────────────────────────────────────────────
    // MODALS
    // ─────────────────────────────────────────────────────────
    function openAddModal() {
        editingId = null;
        if (modalTitle) modalTitle.textContent = 'Add New Product';
        productForm?.reset();
        document.getElementById('field-stock-add')?.classList.remove('hidden');
        document.getElementById('field-stock-edit')?.classList.add('hidden');
        if (submitBtn) submitBtn.textContent = 'Add Product';
        Modal.open('product-modal');
    }

    function openEditModal(id) {
        editingId = id;
        const p = products.find(x => x.id === id);
        if (!p) return;

        if (modalTitle) modalTitle.textContent = `Edit: ${p.name}`;

        // Populate all non-stock fields
        const fields = ['batch_number','name','generic_name','category','supplier',
                        'barcode','price','cost','low_stock_threshold','expiry_date','description'];
        fields.forEach(f => {
            const el = document.getElementById(`field-${f}`);
            if (el) el.value = p[f] ?? '';
        });

        // FIX Bug 2: populate the edit-mode stock field by its unique element ID,
        // NOT by looking up 'field-stock_quantity' which belongs to the add field.
        const editStockEl = document.getElementById('field-stock_quantity_edit');
        if (editStockEl) editStockEl.value = p.stock_quantity ?? 0;

        document.getElementById('field-stock-add')?.classList.add('hidden');
        document.getElementById('field-stock-edit')?.classList.remove('hidden');
        if (submitBtn) submitBtn.textContent = 'Save Changes';
        Modal.open('product-modal');
    }

    // ─────────────────────────────────────────────────────────
    // FORM SUBMIT
    // ─────────────────────────────────────────────────────────
    async function handleFormSubmit() {
        // FIX Bug 1: only validate fields that are visible for the current mode.
        // 'stock_quantity' (add field) is hidden during edit — never block on it.
        const alwaysRequired = ['batch_number', 'name', 'category', 'price', 'cost', 'expiry_date'];
        for (const field of alwaysRequired) {
            const el = document.getElementById(`field-${field}`);
            if (!el || !String(el.value).trim()) {
                Toast.show(`${field.replace(/_/g, ' ')} is required.`, 'error');
                el?.focus();
                return;
            }
        }

        // Only validate stock qty when adding
        if (!editingId) {
            const stockEl = document.getElementById('field-stock_quantity');
            if (!stockEl || stockEl.value === '') {
                Toast.show('Stock quantity is required.', 'error');
                stockEl?.focus();
                return;
            }
        }

        // FIX Bug 2: build body manually and read from the correct stock field per mode.
        // Using FormData here is unreliable because both add/edit stock inputs share a
        // similar name, and the hidden one's value may bleed through depending on browser.
        const body = {
            batch_number:        document.getElementById('field-batch_number')?.value.trim()            || '',
            name:                document.getElementById('field-name')?.value.trim()                    || '',
            generic_name:        document.getElementById('field-generic_name')?.value.trim()            || null,
            category:            document.getElementById('field-category')?.value.trim()                || '',
            supplier:            document.getElementById('field-supplier')?.value.trim()                || null,
            barcode:             document.getElementById('field-barcode')?.value.trim()                 || null,
            price:               parseFloat(document.getElementById('field-price')?.value)              || 0,
            cost:                parseFloat(document.getElementById('field-cost')?.value)               || 0,
            low_stock_threshold: parseInt(document.getElementById('field-low_stock_threshold')?.value)  || 10,
            expiry_date:         document.getElementById('field-expiry_date')?.value                   || '',
            description:         document.getElementById('field-description')?.value.trim()             || null,
        };

        // Read from the correct stock element for each mode
        body.stock_quantity = editingId
            ? parseInt(document.getElementById('field-stock_quantity_edit')?.value) || 0
            : parseInt(document.getElementById('field-stock_quantity')?.value)      || 0;

        // Normalize empty optional strings to null
        ['generic_name', 'supplier', 'barcode', 'description'].forEach(k => {
            if (body[k] === '') body[k] = null;
        });

        if (submitBtn) {
            submitBtn.disabled    = true;
            submitBtn.textContent = editingId ? 'Saving…' : 'Adding…';
        }

        let result;
        try {
            result = editingId
                ? await OfflineAPI.put(`/inventory/${editingId}`, body)
                : await OfflineAPI.post('/inventory', body);
        } finally {
            if (submitBtn) {
                submitBtn.disabled    = false;
                submitBtn.textContent = editingId ? 'Save Changes' : 'Add Product';
            }
        }

        if (result?.success) {
            Toast.show(result.message, 'success');
            Modal.close('product-modal');
            loadProducts();
        } else {
            Toast.show(result?.message || 'Save failed. Check all fields and try again.', 'error');
        }
    }

    // ─────────────────────────────────────────────────────────
    // DELETE
    // ─────────────────────────────────────────────────────────
    function confirmDelete(id) {
        const p = products.find(x => x.id === id);
        if (!p) return;
        if (!confirm(`Remove "${p.name}" (${p.batch_number}) from inventory?\n\nThis is a soft delete — historical orders will be preserved.`)) return;
        doDelete(id);
    }

    async function doDelete(id) {
        const result = await OfflineAPI.delete(`/inventory/${id}`);
        if (result?.success) {
            Toast.show('Product removed.', 'success');
            loadProducts();
        } else {
            Toast.show(result?.message || 'Delete failed.', 'error');
        }
    }

    // ─────────────────────────────────────────────────────────
    // CSV IMPORT
    // FIX Bug 3: was using API.upload which may not exist in this codebase.
    // OfflineAPI has no upload method (multipart is always online-only),
    // so we call fetch directly using the same auth pattern as offlineSync.js.
    // ─────────────────────────────────────────────────────────
    async function handleCSVImport(e) {
        const file = e.target.files[0];
        if (!file) return;

        Toast.show('Importing CSV…', 'info');

        const formData = new FormData();
        formData.append('file', file);

        const config  = typeof getRuntimeConfig === 'function' ? getRuntimeConfig() : CONFIG;
        const token   = typeof Auth !== 'undefined' ? Auth.getToken()
                      : localStorage.getItem(config.TOKEN_KEY);

        let result;
        try {
            const res = await fetch(`${config.API_BASE}/inventory/import/csv`, {
                method:  'POST',
                headers: token ? { 'Authorization': `Bearer ${token}` } : {},
                body:    formData
            });
            result = await res.json();
        } catch (err) {
            Toast.show('Upload failed. Check your connection.', 'error');
            e.target.value = '';
            return;
        }

        if (result?.success) {
            Toast.show(result.message, 'success');
            loadProducts();
        } else {
            Toast.show(result?.message || 'Import failed.', 'error');
        }

        e.target.value = '';
    }
});

// ── Utilities ─────────────────────────────────────────────────
function escHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function debounce(fn, ms) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
}