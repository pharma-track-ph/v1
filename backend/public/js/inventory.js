// ============================================================
// PharmaTrack – inventory.js
// Inventory CRUD, expiry highlighting, CSV import
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    // Guard: only admin and above can access inventory
    if (!Auth.requireAuth(['admin', 'super_admin'])) return;

    // State
    let products  = [];
    let editingId = null;

    // ── DOM References ───────────────────────────────────────
    const tbody         = document.getElementById('inv-tbody');
    const searchInput   = document.getElementById('inv-search');
    const categoryFilter= document.getElementById('inv-filter-cat');
    const expiringFilter= document.getElementById('inv-filter-expiring');
    const totalCount    = document.getElementById('inv-total-count');
    const modalOverlay  = document.getElementById('product-modal');
    const productForm   = document.getElementById('product-form');
    const modalTitle    = document.getElementById('modal-title');
    const importInput   = document.getElementById('csv-import-input');

    // ── Load products on page load ───────────────────────────
    loadProducts();
    loadCategories();

    // ── Filters ──────────────────────────────────────────────
    searchInput?.addEventListener('input',   debounce(loadProducts, 300));
    categoryFilter?.addEventListener('change', loadProducts);
    expiringFilter?.addEventListener('change', loadProducts);

    // ── Add button ────────────────────────────────────────────
    document.getElementById('btn-add-product')?.addEventListener('click', () => {
        openAddModal();
    });

    // ── Import CSV button ─────────────────────────────────────
    document.getElementById('btn-import-csv')?.addEventListener('click', () => {
        importInput?.click();
    });

    importInput?.addEventListener('change', handleCSVImport);

    // ── Form submit ───────────────────────────────────────────
    productForm?.addEventListener('submit', handleFormSubmit);

    // ── Modal close buttons ───────────────────────────────────
    document.querySelectorAll('.btn-close-modal').forEach(btn => {
        btn.addEventListener('click', () => Modal.close('product-modal'));
    });

    // ─────────────────────────────────────────────────────────
    async function loadProducts() {
        const search   = searchInput?.value.trim()        || '';
        const category = categoryFilter?.value            || '';
        const expiring = expiringFilter?.value === 'true' ? 'true' : '';

        const params = new URLSearchParams({ search, category, expiring });
        const data   = await API.get(`/inventory?${params}`);

        if (!data?.success) {
            Toast.show('Failed to load products.', 'error');
            return;
        }

        products = data.data;
        renderTable(products);
        if (totalCount) totalCount.textContent = products.length;
    }

    function renderTable(data) {
        if (!tbody) return;

        if (!data.length) {
            tbody.innerHTML = `
                <tr><td colspan="8" class="text-center text-muted" style="padding:40px">
                    No products found.
                </td></tr>`;
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
                        <button class="btn btn-light btn-sm btn-edit" data-id="${p.id}" title="Edit">✏️</button>
                        <button class="btn btn-danger btn-sm btn-delete" data-id="${p.id}" title="Delete">🗑️</button>
                    </div>
                </td>
            </tr>`;
        }).join('');

        // Attach row action listeners
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
        let dotClass   = 'green';

        if (daysLeft < 0)  dotClass = 'red';
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

    async function loadCategories() {
        const data = await API.get('/inventory/alerts/summary');
        if (!data?.success || !categoryFilter) return;

        const cats = data.data.categories || [];
        cats.forEach(cat => {
            const opt = document.createElement('option');
            opt.value = cat;
            opt.textContent = cat;
            categoryFilter.appendChild(opt);
        });
    }

    // ── Add Modal ─────────────────────────────────────────────
    function openAddModal() {
        editingId = null;
        if (modalTitle)  modalTitle.textContent = 'Add New Product';
        productForm?.reset();
        document.getElementById('field-stock-add')?.classList.remove('hidden');
        document.getElementById('field-stock-edit')?.classList.add('hidden');
        Modal.open('product-modal');
    }

    // ── Edit Modal ────────────────────────────────────────────
    function openEditModal(id) {
        editingId = id;
        const p   = products.find(x => x.id === id);
        if (!p) return;

        if (modalTitle) modalTitle.textContent = `Edit: ${p.name}`;

        // Populate form fields
        const fields = ['batch_number','name','generic_name','category','supplier',
                        'barcode','price','cost','stock_quantity','low_stock_threshold',
                        'expiry_date','description'];

        fields.forEach(f => {
            const el = document.getElementById(`field-${f}`);
            if (el) el.value = p[f] ?? '';
        });

        document.getElementById('field-stock-add')?.classList.add('hidden');
        document.getElementById('field-stock-edit')?.classList.remove('hidden');

        Modal.open('product-modal');
    }

    // ── Form submission ───────────────────────────────────────
    async function handleFormSubmit(e) {
        e.preventDefault();

        const formData = new FormData(productForm);
        const body     = Object.fromEntries(formData.entries());

        // Type coercions
        body.price              = parseFloat(body.price);
        body.cost               = parseFloat(body.cost);
        body.stock_quantity     = parseInt(body.stock_quantity);
        body.low_stock_threshold= parseInt(body.low_stock_threshold);

        const submitBtn = productForm.querySelector('[type="submit"]');
        submitBtn.disabled = true;
        submitBtn.textContent = editingId ? 'Saving…' : 'Adding…';

        let result;
        if (editingId) {
            result = await API.put(`/inventory/${editingId}`, body);
        } else {
            result = await API.post('/inventory', body);
        }

        submitBtn.disabled = false;
        submitBtn.textContent = editingId ? 'Save Changes' : 'Add Product';

        if (result?.success) {
            Toast.show(result.message, 'success');
            Modal.close('product-modal');
            loadProducts();
        } else {
            Toast.show(result?.message || 'Save failed.', 'error');
        }
    }

    // ── Delete ────────────────────────────────────────────────
    function confirmDelete(id) {
        const p = products.find(x => x.id === id);
        if (!p) return;

        // Use browser confirm for simplicity; can be replaced with custom modal
        if (!confirm(`Remove "${p.name}" (${p.batch_number}) from inventory?\n\nThis is a soft delete — historical orders will be preserved.`)) return;

        deleteProduct(id);
    }

    async function deleteProduct(id) {
        const result = await API.delete(`/inventory/${id}`);
        if (result?.success) {
            Toast.show('Product removed.', 'success');
            loadProducts();
        } else {
            Toast.show(result?.message || 'Delete failed.', 'error');
        }
    }

    // ── CSV Import ────────────────────────────────────────────
    async function handleCSVImport(e) {
        const file = e.target.files[0];
        if (!file) return;

        const formData = new FormData();
        formData.append('file', file);

        Toast.show('Importing CSV…', 'info');

        const result = await API.upload('/inventory/import/csv', formData);

        if (result?.success) {
            Toast.show(result.message, 'success');
            loadProducts();
        } else {
            Toast.show(result?.message || 'Import failed.', 'error');
        }

        // Reset input so same file can be re-selected
        e.target.value = '';
    }
});

// ── Utility ────────────────────────────────────────────────────
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
