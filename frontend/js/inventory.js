// ============================================================
// PharmaTrack – inventory.js
// Inventory CRUD (Brand Name + Item No. list), expiry highlighting,
// CSV import
//
// "Product" in this file means a BRAND (e.g. "Paracetamol 500mg"),
// rolled up server-side from one or more underlying batch rows -- see
// backend/models/Product.js's "Brand-level grouping" section for how
// that works. Each brand's individual restock batches are its "Item
// No." entries, managed from inside the Edit modal.
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    if (!Auth.requireAuth(['admin', 'super_admin'])) return;

    // ── State ────────────────────────────────────────────────
    let products     = [];   // grouped brand summaries (main table)
    let editingId     = null; // representative row id of the brand being edited
    let currentItems  = [];   // Item No. entries for the brand currently open in the modal

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
    const urlStatus = new URLSearchParams(window.location.search).get('status');
    if (urlStatus && statusFilter) statusFilter.value = urlStatus;

    loadProducts();
    loadCategories();

    // ── Filters ──────────────────────────────────────────────
    searchInput?.addEventListener('input',    debounce(loadProducts, 300));
    categoryFilter?.addEventListener('change', loadProducts);
    statusFilter?.addEventListener('change',   loadProducts);

    SearchSuggest.attach(searchInput, {
        getItems:    () => products,
        getLabel:    p => p.name,
        getSubLabel: p => `${p.category} \u00b7 ${p.item_count} item${p.item_count === 1 ? '' : 's'}`
    });

    // ── Toolbar ───────────────────────────────────────────────
    document.getElementById('btn-add-product')?.addEventListener('click', openAddModal);
    document.getElementById('btn-import-csv')?.addEventListener('click', () => importInput?.click());
    importInput?.addEventListener('change', handleCSVImport);
    submitBtn?.addEventListener('click', handleFormSubmit);

    document.getElementById('btn-download-template')?.addEventListener('click', async (e) => {
        e.preventDefault();
        const config = typeof getRuntimeConfig === 'function' ? getRuntimeConfig() : CONFIG;
        const ok = await downloadAuthenticatedFile(
            `${config.API_BASE}/inventory/import/template`,
            'PharmaTrack_Inventory_Import_Template.xlsx'
        );
        if (!ok) Toast.show('Could not download the template. Check your connection.', 'error');
    });

    // ── Export dropdown (Excel / PDF / Word) ─────────────────
    const exportToggleBtn = document.getElementById('btn-export-toggle');
    const exportMenu       = document.getElementById('export-menu');

    exportToggleBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        exportMenu?.classList.toggle('hidden');
    });

    document.addEventListener('click', (e) => {
        if (exportMenu && !exportMenu.classList.contains('hidden') && !e.target.closest('#export-dropdown')) {
            exportMenu.classList.add('hidden');
        }
    });

    document.querySelectorAll('.export-menu-item').forEach(btn => {
        btn.addEventListener('click', () => {
            exportMenu?.classList.add('hidden');
            downloadExport(btn.dataset.format);
        });
    });

    const EXPORT_FILE_INFO = {
        excel: { path: 'excel', filename: 'PharmaTrack_Inventory_Report.xlsx' },
        pdf:   { path: 'pdf',   filename: 'PharmaTrack_Inventory_Report.pdf'  },
        word:  { path: 'word',  filename: 'PharmaTrack_Inventory_Report.docx' },
        csv:   { path: 'csv',   filename: 'PharmaTrack_Inventory_Report.csv'  }
    };

    // Uses fetch (not a plain <a href>) since the endpoint needs the
    // Authorization header — same pattern as backup.js's download and this
    // page's own CSV import.
    // NOTE: the Inventory export itself (exportController.js) still uses
    // the old "Batch No./Product Name" per-row terminology and layout --
    // that's the deferred rename/export-update work (see the handoff
    // doc), not part of this restructure.
    async function downloadExport(format) {
        const info = EXPORT_FILE_INFO[format];
        if (!info) return;

        Toast.show('Preparing report…', 'info');

        const config = typeof getRuntimeConfig === 'function' ? getRuntimeConfig() : CONFIG;
        const token  = typeof Auth !== 'undefined' ? Auth.getToken() : localStorage.getItem(config.TOKEN_KEY);

        try {
            const res = await fetch(`${config.API_BASE}/inventory/export/${info.path}`, {
                headers: token ? { 'Authorization': `Bearer ${token}` } : {}
            });
            if (!res.ok) throw new Error('Export failed.');

            const blob = await res.blob();
            const url  = URL.createObjectURL(blob);
            const a    = document.createElement('a');
            a.href     = url;
            a.download = info.filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        } catch (err) {
            Toast.show('Export failed. Check your connection.', 'error');
        }
    }

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
            tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted" style="padding:40px">
                No products found.</td></tr>`;
            return;
        }

        tbody.innerHTML = data.map(p => {
            const statusBadge = getStatusBadge(p);
            const expiryCell  = getEarliestExpiryCell(p);
            const rowClass    = getRowClass(p);
            return `
            <tr class="${rowClass}" data-id="${p.id}">
                <td title="${escHtml(p.name)}">
                    <div class="fw-600">${escHtml(p.name)}</div>
                    ${p.generic_name ? `<div class="text-muted" style="font-size:0.73rem">${escHtml(p.generic_name)}</div>` : ''}
                </td>
                <td title="${escHtml(p.category)}">${escHtml(p.category)}</td>
                <td>
                    <span class="${p.stock_quantity <= p.low_stock_threshold ? 'text-danger fw-600' : ''}">
                        ${p.stock_quantity}
                    </span>
                    <div class="text-muted" style="font-size:0.7rem">${p.item_count} item${p.item_count === 1 ? '' : 's'}</div>
                </td>
                <td>${Fmt.currency(p.price)}</td>
                <td>${expiryCell}</td>
                <td>${statusBadge}</td>
                <td>
                    <div class="d-flex gap-8">
                        <button class="btn btn-light btn-sm btn-edit"    data-id="${p.id}" title="Edit">Edit</button>
                        <button class="btn btn-danger btn-sm btn-delete" data-id="${p.id}" title="Delete">Delete</button>
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

    // Exactly ONE badge. When a specific status filter is active, every
    // row already matches that condition (see loadProducts) -- show THAT
    // status as the badge, matching what was actually searched for, rather
    // than some other status that also happens to apply (filtering "Low
    // Stock" but the row's badge saying "Expiring in 3 Months" instead
    // looks like the filter didn't work, even though it did). With no
    // filter active ("All Status"), falls back to the single-pick
    // hierarchy from Product._rollUpGroup on the backend. Either way this
    // is the MAIN TABLE badge only -- the Edit modal's per-Item-No. tags
    // (getItemTagHtml below) always show that item's own real state,
    // completely independent of whatever filter is active out here.
    function getStatusBadge(p) {
        const activeFilter = statusFilter?.value || '';
        if (activeFilter) {
            const filterBadges = {
                expired:      '<span class="badge badge-danger">Expired</span>',
                out_of_stock: '<span class="badge badge-secondary">Out of Stock</span>',
                low_stock:    '<span class="badge badge-warning">Low Stock</span>',
                expiring:     '<span class="badge badge-warning">Expiring This Month</span>',
                expiring_3mo: '<span class="badge badge-info">Expiring in 3 Months</span>',
                in_stock:     '<span class="badge badge-success">In Stock</span>'
            };
            if (filterBadges[activeFilter]) return filterBadges[activeFilter];
        }

        const map = {
            expired:      '<span class="badge badge-danger">Expired</span>',
            out_of_stock: '<span class="badge badge-secondary">Out of Stock</span>',
            near_expiry:  '<span class="badge badge-warning">Expiring This Month</span>',
            expiring_3mo: '<span class="badge badge-info">Expiring in 3 Months</span>',
            low_stock:    '<span class="badge badge-warning">Low Stock</span>',
            in_stock:     '<span class="badge badge-success">In Stock</span>'
        };
        return map[p.effective_status] || `<span class="badge badge-secondary">${p.effective_status}</span>`;
    }

    function getEarliestExpiryCell(p) {
        if (!p.earliest_expiry) {
            // Every Item No. is expired -- nothing "still good" to show a
            // date for; the Expired badge already covers this case.
            return '<span class="text-muted">—</span>';
        }
        const daysLeft = parseInt(p.earliest_expiry_days_left);
        let dotClass = 'green';
        if (daysLeft <= 30)      dotClass = 'amber';
        else if (daysLeft <= 90) dotClass = 'blue';
        return `
            <div class="expiry-cell">
                <span class="expiry-dot ${dotClass}"></span>
                ${Fmt.date(p.earliest_expiry)}
                ${daysLeft <= 90 ? `<span style="font-size:0.7rem;color:#92400e">(${daysLeft}d)</span>` : ''}
            </div>`;
    }

    function getRowClass(p) {
        if (p.effective_status === 'expired')      return 'row-expired';
        if (p.effective_status === 'out_of_stock') return 'row-soldout';
        if (p.effective_status === 'near_expiry')  return 'row-expiring';
        if (p.effective_status === 'expiring_3mo') return 'row-expiring-3mo';
        if (p.effective_status === 'low_stock')    return 'row-low-stock';
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
        editingId    = null;
        currentItems = [];
        if (modalTitle) modalTitle.textContent = 'Add New Product';
        productForm?.reset();
        document.getElementById('field-first-item-row')?.classList.remove('hidden');
        document.getElementById('edit-only-item-section')?.classList.add('hidden');
        document.getElementById('field-barcode-preview')?.classList.add('hidden');
        if (submitBtn) submitBtn.textContent = 'Add Product';
        Modal.open('product-modal');
    }

    async function openEditModal(id) {
        editingId = id;

        // Full group detail (shared fields + every Item No.) — fetched
        // fresh rather than reused from the table's summary row, since the
        // table only carries the ROLLED-UP numbers, not the individual
        // items this modal needs to list.
        const data = await API.get(`/inventory/${id}`);
        if (!data?.success) {
            Toast.show('Failed to load product.', 'error');
            return;
        }
        const p = data.data;
        currentItems = p.items || [];

        if (modalTitle) modalTitle.textContent = `Edit: ${p.name}`;

        const fields = ['name', 'generic_name', 'category', 'supplier',
                        'price', 'cost', 'low_stock_threshold', 'description'];
        fields.forEach(f => {
            const el = document.getElementById(`field-${f}`);
            if (el) el.value = p[f] ?? '';
        });

        document.getElementById('field-first-item-row')?.classList.add('hidden');
        document.getElementById('edit-only-item-section')?.classList.remove('hidden');
        document.getElementById('field-barcode-preview')?.classList.remove('hidden');
        document.getElementById('add-item-form')?.classList.add('hidden');
        if (submitBtn) submitBtn.textContent = 'Save Changes';

        renderItemList();
        Modal.open('product-modal');

        // Barcode preview — every product always has a real, persisted
        // barcode value: this endpoint auto-generates and saves one
        // server-side if the product doesn't have one yet.
        const barcodeValueText = document.getElementById('barcode-value-text');
        if (barcodeValueText) barcodeValueText.textContent = 'Loading barcode…';

        const barcodeData = await API.get(`/inventory/${id}/barcode`);

        if (barcodeData?.success) {
            const value = barcodeData.barcode;
            if (typeof JsBarcode !== 'undefined') {
                try {
                    JsBarcode('#barcode-svg', value, {
                        format: 'CODE128', width: 3, height: 90, displayValue: false, margin: 10
                    });
                    if (barcodeValueText) barcodeValueText.textContent = value;
                } catch (err) {
                    if (barcodeValueText) barcodeValueText.textContent = `${value} (could not render image)`;
                }
            } else {
                if (barcodeValueText) barcodeValueText.textContent = `${value} (barcode library failed to load)`;
            }
        } else {
            if (barcodeValueText) barcodeValueText.textContent = p.barcode || '—';
        }
    }

    // ─────────────────────────────────────────────────────────
    // ITEM NO. LIST (inside the Edit modal)
    // ─────────────────────────────────────────────────────────
    function formatLongDate(dateStr) {
        if (!dateStr) return '—';
        const d = new Date(dateStr);
        if (isNaN(d.getTime())) return String(dateStr);
        return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    }

    // Accepts either a full ISO datetime or a plain YYYY-MM-DD and returns
    // just the date part, for pre-filling a <input type="date">.
    function toDateInputValue(dateStr) {
        if (!dateStr) return '';
        return String(dateStr).split('T')[0];
    }

    // An item that's expired OR fully depleted moves out of the active
    // "Item No. (restock batches)" list and into "Removed Item No." below
    // -- see the HTML comment on #removed-items-section for why that
    // section's own "Remove" button is display-only and never a database
    // delete.
    function itemNeedsRemoval(item) {
        return item.is_expired || item.stock_quantity <= 0;
    }

    // Every item gets exactly one tag -- Expired and Out of Stock take
    // priority over the expiry-window tags (an expired OR depleted item
    // isn't meaningfully "expiring soon" anymore, it already IS the
    // concern), "Good" is shown even when nothing else applies so every
    // row consistently has a tag rather than some having one and others
    // not.
    function getItemTagHtml(item) {
        if (item.is_expired)          return '<span class="item-tag expired">Expired</span>';
        if (item.stock_quantity <= 0) return '<span class="item-tag out-of-stock">Out of Stock</span>';
        if (item.expiring_this_month) return '<span class="item-tag expiring-soon">Expiring This Month</span>';
        if (item.expiring_3mo)        return '<span class="item-tag expiring-3mo">Expiring in 3 Months</span>';
        return '<span class="item-tag good">Good</span>';
    }

    function renderItemList() {
        const activeContainer  = document.getElementById('item-list');
        const removedContainer = document.getElementById('removed-item-list');
        const removedSection   = document.getElementById('removed-items-section');
        if (!activeContainer || !removedContainer) return;

        // Split first, then number EACH list independently (Item No. 1, 2,
        // 3... within the active list, and separately within the removed
        // list) -- renumbering happens automatically here every time this
        // re-renders, so an edit/add/delete/dismiss never leaves a gap in
        // either list.
        const activeItems  = currentItems.filter(i => !itemNeedsRemoval(i));
        const removedItems = currentItems.filter(itemNeedsRemoval);

        if (!activeItems.length) {
            activeContainer.innerHTML = '<p class="text-muted" style="font-size:0.82rem;padding:4px 0">No active items.</p>';
        } else {
            activeContainer.innerHTML = activeItems.map((item, idx) => `
                <div class="item-row" data-item-id="${item.id}">
                    <div class="item-row-display" id="item-display-${item.id}">
                        <div class="item-row-main">
                            <span class="item-no-label">Item No. ${idx + 1}</span>
                            <span class="item-qty">${item.stock_quantity} units</span>
                            <span class="item-expiry">Expires: ${formatLongDate(item.expiry_date)}</span>
                            ${getItemTagHtml(item)}
                        </div>
                        <div class="item-row-actions">
                            <button type="button" class="btn btn-light btn-sm btn-edit-item" data-item-id="${item.id}">Edit</button>
                            <button type="button" class="btn btn-danger btn-sm btn-delete-item" data-item-id="${item.id}">Delete</button>
                        </div>
                    </div>
                    <div class="item-row-form hidden" id="item-edit-form-${item.id}">
                        <div class="form-group">
                            <label class="form-label">Stock Qty</label>
                            <input type="number" class="form-control item-edit-qty" min="0" value="${item.stock_quantity}">
                        </div>
                        <div class="form-group">
                            <label class="form-label">Expiry Date</label>
                            <input type="date" class="form-control item-edit-expiry" value="${toDateInputValue(item.expiry_date)}">
                        </div>
                        <div class="item-row-form-actions">
                            <button type="button" class="btn btn-light btn-sm btn-cancel-item-edit" data-item-id="${item.id}">Cancel</button>
                            <button type="button" class="btn btn-primary btn-sm btn-save-item" data-item-id="${item.id}">Save</button>
                        </div>
                    </div>
                </div>`).join('');

            activeContainer.querySelectorAll('.btn-edit-item').forEach(btn =>
                btn.addEventListener('click', () => toggleItemEdit(btn.dataset.itemId, true)));
            activeContainer.querySelectorAll('.btn-cancel-item-edit').forEach(btn =>
                btn.addEventListener('click', () => toggleItemEdit(btn.dataset.itemId, false)));
            activeContainer.querySelectorAll('.btn-save-item').forEach(btn =>
                btn.addEventListener('click', () => saveItemEdit(btn.dataset.itemId)));
            activeContainer.querySelectorAll('.btn-delete-item').forEach(btn =>
                btn.addEventListener('click', () => deleteItemRow(btn.dataset.itemId)));
        }

        if (removedItems.length) {
            removedContainer.innerHTML = removedItems.map((item, idx) => `
                <div class="item-row" data-item-id="${item.id}">
                    <div class="item-row-display">
                        <div class="item-row-main">
                            <span class="item-no-label">Item No. ${idx + 1}</span>
                            <span class="item-qty">${item.stock_quantity} units</span>
                            <span class="item-expiry">Expires: ${formatLongDate(item.expiry_date)}</span>
                            ${getItemTagHtml(item)}
                        </div>
                        <div class="item-row-actions">
                            <button type="button" class="btn btn-light btn-sm btn-dismiss-item" data-item-id="${item.id}">Remove</button>
                        </div>
                    </div>
                </div>`).join('');

            removedContainer.querySelectorAll('.btn-dismiss-item').forEach(btn =>
                btn.addEventListener('click', () => dismissItemFromView(btn.dataset.itemId)));

            removedSection?.classList.remove('hidden');
        } else {
            removedContainer.innerHTML = '';
            removedSection?.classList.add('hidden');
        }
    }

    // Display-only, for THIS modal session -- never calls the delete API
    // (see the "Removed Item No." HTML comment for why). Reopening this
    // product's Edit modal later re-fetches from the server and will show
    // it again if it's still sitting there in the database, unchanged.
    function dismissItemFromView(itemId) {
        currentItems = currentItems.filter(i => String(i.id) !== String(itemId));
        renderItemList();
    }

    function toggleItemEdit(itemId, showEdit) {
        document.getElementById(`item-display-${itemId}`)?.classList.toggle('hidden', showEdit);
        document.getElementById(`item-edit-form-${itemId}`)?.classList.toggle('hidden', !showEdit);
    }

    async function saveItemEdit(itemId) {
        const formEl = document.getElementById(`item-edit-form-${itemId}`);
        const qty    = parseInt(formEl?.querySelector('.item-edit-qty')?.value);
        const expiry = formEl?.querySelector('.item-edit-expiry')?.value;

        if (isNaN(qty) || qty < 0 || !expiry) {
            Toast.show('Enter a valid stock quantity and expiry date.', 'error');
            return;
        }

        const result = await OfflineAPI.put(`/inventory/items/${itemId}`, { stock_quantity: qty, expiry_date: expiry });
        if (result?.success) {
            Toast.show('Item updated.', 'success');
            await reloadEditingItems();
        } else {
            Toast.show(result?.message || 'Failed to update item.', 'error');
        }
    }

    async function deleteItemRow(itemId) {
        const confirmed = await ConfirmDialog.show({
            title:       'Delete Item No.',
            message:     'Remove this restock batch? This cannot be undone.',
            confirmText: 'Delete'
        });
        if (!confirmed) return;

        const result = await OfflineAPI.delete(`/inventory/items/${itemId}`);
        if (result?.success) {
            Toast.show('Item removed.', 'success');
            await reloadEditingItems();
        } else {
            // e.g. "can't delete the last remaining Item No." — surfaced
            // as-is from the backend.
            Toast.show(result?.message || 'Failed to delete item.', 'error');
        }
    }

    async function reloadEditingItems() {
        if (!editingId) return;
        const data = await API.get(`/inventory/${editingId}`);
        if (data?.success) {
            currentItems = data.data.items || [];
            renderItemList();
        }
        loadProducts(); // main table's rolled-up stock/status may have changed
    }

    // "+ Add Item No." — small inline form, same shape as each item's own
    // Edit form, posting to a different endpoint (addItem vs updateItem).
    document.getElementById('btn-add-item')?.addEventListener('click', () => {
        const form = document.getElementById('add-item-form');
        form?.classList.remove('hidden');
        const qtyEl = document.getElementById('add-item-qty');
        const expEl = document.getElementById('add-item-expiry');
        if (qtyEl) qtyEl.value = '';
        if (expEl) expEl.value = '';
        qtyEl?.focus();
    });

    document.getElementById('btn-cancel-add-item')?.addEventListener('click', () => {
        document.getElementById('add-item-form')?.classList.add('hidden');
    });

    document.getElementById('btn-save-add-item')?.addEventListener('click', async () => {
        const qty    = parseInt(document.getElementById('add-item-qty')?.value);
        const expiry = document.getElementById('add-item-expiry')?.value;

        if (isNaN(qty) || qty < 0 || !expiry) {
            Toast.show('Enter a valid stock quantity and expiry date.', 'error');
            return;
        }
        if (!editingId) return;

        const result = await OfflineAPI.post(`/inventory/${editingId}/items`, { stock_quantity: qty, expiry_date: expiry });
        if (result?.success) {
            Toast.show('Item No. added.', 'success');
            document.getElementById('add-item-form')?.classList.add('hidden');
            await reloadEditingItems();
        } else {
            Toast.show(result?.message || 'Failed to add item.', 'error');
        }
    });

    // ─────────────────────────────────────────────────────────
    // FORM SUBMIT (Add Product / Save shared fields)
    // ─────────────────────────────────────────────────────────
    async function handleFormSubmit() {
        const alwaysRequired = ['name', 'category', 'price', 'cost'];
        for (const field of alwaysRequired) {
            const el = document.getElementById(`field-${field}`);
            if (!el || !String(el.value).trim()) {
                Toast.show(`${field.replace(/_/g, ' ')} is required.`, 'error');
                el?.focus();
                return;
            }
        }

        // Add mode only: the very first Item No. (quantity + expiry) is
        // required alongside the product's own details.
        if (!editingId) {
            const stockEl  = document.getElementById('field-stock_quantity');
            const expiryEl = document.getElementById('field-expiry_date');
            if (!stockEl || stockEl.value === '') {
                Toast.show('Initial stock quantity is required.', 'error');
                stockEl?.focus();
                return;
            }
            if (!expiryEl || !expiryEl.value) {
                Toast.show('Expiry date is required.', 'error');
                expiryEl?.focus();
                return;
            }
        }

        const body = {
            name:                document.getElementById('field-name')?.value.trim()                    || '',
            generic_name:        document.getElementById('field-generic_name')?.value.trim()            || null,
            category:            document.getElementById('field-category')?.value.trim()                || '',
            supplier:            document.getElementById('field-supplier')?.value.trim()                || null,
            price:               parseFloat(document.getElementById('field-price')?.value)              || 0,
            cost:                parseFloat(document.getElementById('field-cost')?.value)               || 0,
            low_stock_threshold: parseInt(document.getElementById('field-low_stock_threshold')?.value)  || 10,
            description:         document.getElementById('field-description')?.value.trim()             || null
        };

        if (!editingId) {
            body.stock_quantity = parseInt(document.getElementById('field-stock_quantity')?.value) || 0;
            body.expiry_date    = document.getElementById('field-expiry_date')?.value              || '';
        }

        ['generic_name', 'supplier', 'description'].forEach(k => {
            if (body[k] === '') body[k] = null;
        });

        const summary = editingId
            ? `Brand Name: ${body.name}${body.generic_name ? ' (' + body.generic_name + ')' : ''}\n` +
              `Category: ${body.category}\n` +
              `Price: ${Fmt.currency(body.price)}   Cost: ${Fmt.currency(body.cost)}\n` +
              `Low-stock alert at: ${body.low_stock_threshold}\n\n` +
              `This updates ALL ${currentItems.length} Item No. entr${currentItems.length === 1 ? 'y' : 'ies'} under this product ` +
              `with these shared details. Stock/expiry per item is managed separately below.`
            : `Brand Name: ${body.name}${body.generic_name ? ' (' + body.generic_name + ')' : ''}\n` +
              `Category: ${body.category}\n` +
              `Price: ${Fmt.currency(body.price)}   Cost: ${Fmt.currency(body.cost)}\n` +
              `Stock: ${body.stock_quantity} units   Low-stock alert at: ${body.low_stock_threshold}\n` +
              `Expiry: ${Fmt.date(body.expiry_date)}`;

        const confirmed = await ConfirmDialog.show({
            title:       editingId ? 'Confirm Changes' : 'Confirm New Product',
            message:     summary,
            confirmText: editingId ? 'Save Changes' : 'Add Product',
            danger:      false
        });

        if (!confirmed) return;

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
            // Covers the "Brand Name already exists" conflict from the
            // backend (see Product.createGroup/updateGroupFields) as well
            // as ordinary validation failures.
            Toast.show(result?.message || 'Save failed. Check all fields and try again.', 'error');
        }
    }

    // ─────────────────────────────────────────────────────────
    // DELETE (whole brand)
    // ─────────────────────────────────────────────────────────
    async function confirmDelete(id) {
        const p = products.find(x => x.id === id);
        if (!p) return;
        const confirmed = await ConfirmDialog.show({
            title:       'Remove Product',
            message:     `Remove "${p.name}" and all ${p.item_count} of its Item No. entries from inventory?\n\nThis is a soft delete — historical orders will be preserved.`,
            confirmText: 'Remove'
        });
        if (!confirmed) return;
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
    // IMPORT (CSV or Excel)
    // Accepts either format -- an .xlsx upload is parsed server-side into
    // the same shape a CSV would produce (see inventoryController.js's
    // parseImportFile). Expected columns: Brand Name, Generic Name,
    // Category, Supplier, Selling Price, Cost, Low Stock Threshold,
    // Description, Stock Quantity, Expiry Date -- see "Download Template"
    // above for a ready-made file with these exact headers. A brand that
    // doesn't exist yet is created; an existing brand just gets a new
    // Item No. (restock) from that row's Stock Quantity/Expiry Date --
    // its other fields are never silently overwritten by the import.
    // ─────────────────────────────────────────────────────────
    async function handleCSVImport(e) {
        const file = e.target.files[0];
        if (!file) return;

        Toast.show('Importing…', 'info');

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

            // Field mismatches aren't errors -- the import still applied
            // the row's Stock Quantity/Expiry Date as a restock, it just
            // left that brand's other fields (Category, Price, etc.)
            // untouched because the file's values for them didn't match
            // what's already stored. Surfaced as a second toast so it's
            // visible without blocking/failing the import over it.
            const mismatches = result.data?.field_mismatches || [];
            if (mismatches.length) {
                Toast.show(
                    `${mismatches.length} row${mismatches.length === 1 ? '' : 's'} had details that didn't match the existing product and were left unchanged. Check the browser console for specifics.`,
                    'warning'
                );
                console.warn('[Inventory Import] Field mismatches:', mismatches);
            }

            const errors = result.data?.errors || [];
            if (errors.length) {
                Toast.show(`${errors.length} row${errors.length === 1 ? '' : 's'} could not be imported. Check the browser console for specifics.`, 'warning');
                console.warn('[Inventory Import] Row errors:', errors);
            }

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
