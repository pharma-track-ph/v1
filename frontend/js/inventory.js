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
    let invSort       = null; // set once the table's sortable headers are wired up (see loadProducts)
    let invPaginate   = null; // set once, alongside invSort (see loadProducts)
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
    // A stored category list ("Analgesic|Antipyretic") shown the way people read it
    function fmtCategory(value) {
        return String(value ?? '').split('|').map(s => s.trim()).filter(Boolean).join(', ');
    }

    function levenshtein(a, b) {
        const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
        for (let j = 0; j <= b.length; j++) dp[0][j] = j;
        for (let i = 1; i <= a.length; i++) {
            for (let j = 1; j <= b.length; j++) {
                dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            }
        }
        return dp[a.length][b.length];
    }

    // -- Category picker (Add / Edit Product) --
    // A product can have several categories. They are ticked from the list of
    // categories already in use; a brand-new one is typed in and added. Typing
    // something that looks like an existing category (a typo, a plural) shows a
    // "Did you mean...?" choice first. The chosen categories are kept, joined
    // with |, in the hidden #field-category input, which the form already reads.
    const CategoryPicker = {
        known:    [],   // every category currently in use
        selected: [],   // the ones ticked for THIS product
        el: (id) => document.getElementById(id),

        setKnown(list) { this.known = list.slice(); this.render(); },

        setValue(joined) {
            this.selected = String(joined || '').split('|').map(s => s.trim()).filter(Boolean);
            const input = this.el('field-new-category');
            if (input) input.value = '';
            this.hideSuggestion();
            this.close();
            this.render();
        },

        sync() {
            const hidden = this.el('field-category');
            if (hidden) hidden.value = this.selected.join('|');
        },

        has(name) { return this.selected.some(s => s.toLowerCase() === name.toLowerCase()); },

        // The dropdown list (filtered by what is typed in the input above it, each
        // category with a checkbox) and the chips for what is ticked.
        render() {
            const list  = this.el('category-list');
            const typed = (this.el('field-new-category')?.value || '').trim().replace(/\s+/g, ' ');
            const byKey = new Map();
            [...this.known, ...this.selected].forEach(c => { if (!byKey.has(c.toLowerCase())) byKey.set(c.toLowerCase(), c); });
            const all   = [...byKey.values()].sort((a, b) => a.localeCompare(b));
            const shown = typed ? all.filter(n => n.toLowerCase().includes(typed.toLowerCase())) : all;
            const exact = typed && all.some(n => n.toLowerCase() === typed.toLowerCase());

            if (list) {
                const addRow = (typed && !exact)
                    ? `<button type="button" class="category-add-item" data-add="1">+ Add "${escHtml(typed)}" as a new category</button>`
                    : '';
                const items = shown.map(name => `
                    <label class="category-item">
                        <input type="checkbox" value="${escHtml(name)}" ${this.has(name) ? 'checked' : ''}>
                        <span>${escHtml(name)}</span>
                    </label>`).join('');
                list.innerHTML = (addRow + items) || '<div class="category-empty">No categories yet. Type a name above to add the first one.</div>';
            }
            this.renderChips();
            this.sync();
        },

        renderChips() {
            const chips = this.el('category-selected');
            if (!chips) return;
            chips.innerHTML = this.selected.length
                ? this.selected.map(name => `<span class="category-chip">${escHtml(name)}<button type="button" class="category-chip-x" data-remove="${escHtml(name)}" aria-label="Remove ${escHtml(name)}">&times;</button></span>`).join('')
                : '<span class="text-muted" style="font-size:0.78rem">No category chosen yet.</span>';
        },

        open() {
            this.el('category-list')?.classList.remove('hidden');
            this.el('field-new-category')?.setAttribute('aria-expanded', 'true');
        },

        close() {
            this.el('category-list')?.classList.add('hidden');
            this.el('field-new-category')?.setAttribute('aria-expanded', 'false');
        },

        toggle(name, checked) {
            if (checked && !this.has(name)) this.selected.push(name);
            if (!checked) this.selected = this.selected.filter(s => s.toLowerCase() !== name.toLowerCase());
            this.sync();
        },

        // The existing category a typed name most likely means, or null. Names that
        // differ only by capitals, spaces, punctuation or a plural "s" count as the
        // same; longer names also tolerate a small typo.
        findSimilar(name) {
            const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/s$/, '');
            const target = norm(name);
            if (target.length < 3) return null;
            const allowed = target.length >= 8 ? 2 : (target.length >= 5 ? 1 : 0);
            let best = null, bestDist = Infinity;
            for (const c of this.known) {
                if (c.toLowerCase() === name.toLowerCase()) continue;
                const n = norm(c);
                const d = n === target ? 0 : levenshtein(n, target);
                if (d <= allowed && d < bestDist) { best = c; bestDist = d; }
            }
            return best;
        },

        hideSuggestion() {
            const s = this.el('category-suggestion');
            if (s) { s.classList.add('hidden'); s.innerHTML = ''; }
        },

        showSuggestion(typed, similar) {
            const s = this.el('category-suggestion');
            if (!s) return;
            s.innerHTML = `Did you mean <strong>${escHtml(similar)}</strong>?<br>
                <button type="button" class="btn btn-light btn-sm" data-act="use" data-name="${escHtml(similar)}">Yes, use "${escHtml(similar)}"</button>
                <button type="button" class="btn btn-light btn-sm" data-act="new" data-name="${escHtml(typed)}">No, add "${escHtml(typed)}" as a new category</button>`;
            s.classList.remove('hidden');
        },

        addTyped() {
            const input = this.el('field-new-category');
            const name = (input?.value || '').trim().replace(/\s+/g, ' ');
            if (!name) return;
            if (name.includes('|'))  { Toast.show('A category name cannot contain the | character.', 'error'); return; }
            if (name.length > 60)    { Toast.show('A category name can be at most 60 characters.', 'error'); return; }

            // already exists (any capitals): just tick it, never create a twin
            const existing = [...this.known, ...this.selected].find(c => c.toLowerCase() === name.toLowerCase());
            if (existing) {
                this.toggle(existing, true);
                input.value = '';
                this.hideSuggestion();
                this.render();
                return;
            }

            const similar = this.findSimilar(name);
            if (similar) { this.showSuggestion(name, similar); return; }

            this.commitNew(name);
        },

        commitNew(name) {
            const input = this.el('field-new-category');
            if (!this.has(name)) this.selected.push(name);
            if (input) input.value = '';
            this.hideSuggestion();
            this.render();
        },

        init() {
            const input = this.el('field-new-category');
            const list  = this.el('category-list');

            // opening: click into the input (like the Forecasting product search)
            input?.addEventListener('focus', () => { this.render(); this.open(); });
            input?.addEventListener('click', () => { this.render(); this.open(); });
            // typing filters the list (and offers "+ Add ..." for a new name)
            input?.addEventListener('input', () => { this.hideSuggestion(); this.render(); this.open(); });
            input?.addEventListener('keydown', (e) => {
                if (e.key === 'Enter')  { e.preventDefault(); this.addTyped(); }
                if (e.key === 'Escape') { this.close(); }
            });

            // ticking a checkbox keeps the list open so several can be ticked in a row
            list?.addEventListener('change', (e) => {
                const cb = e.target.closest('input[type="checkbox"]');
                if (cb) { this.toggle(cb.value, cb.checked); this.renderChips(); }
            });
            list?.addEventListener('click', (e) => {
                if (e.target.closest('[data-add]')) this.addTyped();
            });

            // the little x on a chip un-ticks it
            this.el('category-selected')?.addEventListener('click', (e) => {
                const x = e.target.closest('[data-remove]');
                if (!x) return;
                this.toggle(x.dataset.remove, false);
                this.render();
            });

            // clicking anywhere outside the field closes the list
            document.addEventListener('click', (e) => {
                if (!this.el('category-combo')?.contains(e.target)) this.close();
            });

            this.el('category-suggestion')?.addEventListener('click', (e) => {
                const btn = e.target.closest('button[data-act]');
                if (!btn) return;
                if (btn.dataset.act === 'use') {
                    this.toggle(btn.dataset.name, true);
                    const inp = this.el('field-new-category'); if (inp) inp.value = '';
                    this.hideSuggestion();
                    this.render();
                } else {
                    this.commitNew(btn.dataset.name);
                }
            });
        }
    };
    CategoryPicker.init();

    // -- Manage Categories (rename / merge / split) --
    // Every change rewrites the category of every product that uses it, so each
    // one goes through the typed "confirm" step.
    const ManageCategories = {
        rows: [],

        ensureModal() {
            if (document.getElementById('manage-categories-modal')) return;
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay';
            overlay.id = 'manage-categories-modal';
            overlay.innerHTML = `
                <div class="modal" style="max-width:640px">
                    <div class="modal-header">
                        <h3>Manage Categories</h3>
                        <button class="btn-close" id="mc-close">X</button>
                    </div>
                    <div class="modal-body" style="max-height:62vh;overflow-y:auto">
                        <p class="mc-note">Rename or delete a category, or add a new one. A change applies to every product that uses it, so you will be asked to type "confirm". To delete, tick the categories first (you can tick several).</p>
                        <div class="table-container">
                            <table class="table mc-table" style="white-space:normal">
                                <thead><tr>
                                    <th style="width:36px"></th>
                                    <th class="col-text">Category</th>
                                    <th class="col-num">Products</th>
                                    <th class="col-text" style="text-align:right">Actions</th>
                                </tr></thead>
                                <tbody id="mc-tbody"></tbody>
                            </table>
                        </div>
                    </div>
                    <div class="modal-footer">
                        <button class="btn btn-light" id="mc-close-2">Close</button>
                        <button class="btn btn-danger" id="mc-delete" disabled>Delete</button>
                        <button class="btn btn-primary" id="mc-add">Add Category</button>
                    </div>
                </div>`;
            document.body.appendChild(overlay);

            const close = () => Modal.close('manage-categories-modal');
            document.getElementById('mc-close').addEventListener('click', close);
            document.getElementById('mc-close-2').addEventListener('click', close);
            document.getElementById('mc-delete').addEventListener('click', () => this.remove());
            document.getElementById('mc-add').addEventListener('click', () => this.add());

            const tbody = document.getElementById('mc-tbody');
            tbody.addEventListener('change', () => {
                const picked = tbody.querySelectorAll('input.mc-pick:checked').length;
                document.getElementById('mc-delete').disabled = picked < 1;
            });
            tbody.addEventListener('click', (e) => {
                const btn = e.target.closest('button[data-act]');
                if (!btn) return;
                if (btn.dataset.act === 'rename') this.rename(btn.dataset.name);
            });
        },

        async open() {
            this.ensureModal();
            Modal.open('manage-categories-modal');
            await this.load();
        },

        async load() {
            const res = await API.get('/inventory/categories');
            const tbody = document.getElementById('mc-tbody');
            if (!tbody) return;
            if (!res?.success) {
                tbody.innerHTML = `<tr><td colspan="4" class="text-center text-muted">${escHtml(res?.message || 'Could not load categories.')}</td></tr>`;
                return;
            }
            this.rows = res.data || [];
            tbody.innerHTML = this.rows.length ? this.rows.map(r => `
                <tr>
                    <td><input type="checkbox" class="mc-pick" value="${escHtml(r.name)}" aria-label="Select ${escHtml(r.name)}"></td>
                    <td class="col-text">${escHtml(r.name)}</td>
                    <td class="col-num">${r.brands}</td>
                    <td class="mc-actions">
                        <button type="button" class="btn btn-light btn-sm" data-act="rename" data-name="${escHtml(r.name)}">Rename</button>
                    </td>
                </tr>`).join('')
                : '<tr><td colspan="4" class="text-center text-muted">No categories yet.</td></tr>';
            document.getElementById('mc-delete').disabled = true;
        },

        // A small window asking for one or more names. Resolves to an array of
        // clean names, or null if cancelled.
        askNames({ title, intro, labels, initial = [], confirmText = 'Continue', allowMore = false }) {
            return new Promise((resolve) => {
                let overlay = document.getElementById('category-name-modal');
                if (!overlay) {
                    overlay = document.createElement('div');
                    overlay.className = 'modal-overlay';
                    overlay.id = 'category-name-modal';
                    overlay.innerHTML = `
                        <div class="modal" style="max-width:420px">
                            <div class="modal-header"><h3 id="cn-title"></h3></div>
                            <div class="modal-body">
                                <p class="mc-note" id="cn-intro"></p>
                                <div id="cn-inputs"></div>
                                <button type="button" class="btn btn-light btn-sm hidden" id="cn-more">+ Add another</button>
                                <p class="error-msg" id="cn-error" style="min-height:18px;margin-top:8px"></p>
                            </div>
                            <div class="modal-footer">
                                <button class="btn btn-light" id="cn-cancel">Cancel</button>
                                <button class="btn btn-primary" id="cn-ok">Continue</button>
                            </div>
                        </div>`;
                    document.body.appendChild(overlay);
                }
                document.getElementById('cn-title').textContent = title;
                document.getElementById('cn-intro').textContent = intro || '';
                document.getElementById('cn-error').textContent = '';
                document.getElementById('cn-ok').textContent = confirmText;
                const holder = document.getElementById('cn-inputs');
                const addInput = (label, value = '') => {
                    const row = document.createElement('div');
                    row.className = 'form-group mc-name-row';
                    row.innerHTML = `<label class="form-label">${escHtml(label)}</label><input type="text" class="form-control cn-input" maxlength="60" value="${escHtml(value)}" autocomplete="off">`;
                    holder.appendChild(row);
                };
                holder.innerHTML = '';
                labels.forEach((label, i) => addInput(label, initial[i] || ''));
                const more = document.getElementById('cn-more');
                more.classList.toggle('hidden', !allowMore);
                more.onclick = () => addInput(`Another category`);

                const finish = (value) => { Modal.close('category-name-modal'); resolve(value); };
                document.getElementById('cn-cancel').onclick = () => finish(null);
                document.getElementById('cn-ok').onclick = () => {
                    const names = [...holder.querySelectorAll('.cn-input')].map(i => i.value.trim().replace(/\s+/g, ' ')).filter(Boolean);
                    const err = document.getElementById('cn-error');
                    if (names.length < labels.length && !allowMore) { err.textContent = 'Please fill in every name.'; return; }
                    if (allowMore && names.length < 2) { err.textContent = 'Give at least two names.'; return; }
                    if (names.some(n => n.includes('|'))) { err.textContent = 'A name cannot contain the | character.'; return; }
                    if (names.some(n => n.length > 60)) { err.textContent = 'A name can be at most 60 characters.'; return; }
                    if (new Set(names.map(n => n.toLowerCase())).size !== names.length) { err.textContent = 'The names must be different from each other.'; return; }
                    finish(names);
                };
                Modal.open('category-name-modal');
                setTimeout(() => holder.querySelector('.cn-input')?.focus(), 50);
            });
        },

        async apply(kind, payload, title, message) {
            const ok = await TypedConfirm.show({
                title, message,
                confirmText:  'Apply Change',
                finalMessage: 'This changes every product that uses it.'
            });
            if (!ok) return;
            const res = await API.post(`/inventory/categories/${kind}`, payload);
            if (res?.success) {
                Toast.show(res.message, 'success');
                await this.load();
                await loadCategories();     // the filter list and the picker
                loadProducts();
            } else if (res?.details?.blocked?.length) {
                // refused: some product would be left with no category -- say which ones
                await this.showBlocked(res.details.blocked, payload.names);
            } else {
                Toast.show(res?.message || 'The change could not be applied.', 'error');
            }
        },

        // The server refused a Delete because products would be left with no category. This is
        // a notice with one OK button (not a toast that vanishes), so it is actually read, and
        // it names the products that depend on the category.
        async showBlocked(blocked, askedNames) {
            const asked = (askedNames || []).filter(Boolean);
            const n = blocked.length;
            const lead = asked.length === 1
                ? `<strong>${escHtml(asked[0])}</strong> is the <strong>only</strong> category of ${n} product${n === 1 ? '' : 's'}, so it cannot be deleted.`
                : `${n} product${n === 1 ? '' : 's'} would be left with <strong>no category</strong>, so nothing was deleted.`;
            const rows = blocked.slice(0, 8).map(b => `
                <div class="dlg-item"><div>${escHtml(b.product)}
                    <small>${b.categories.length === 1 ? 'Only category' : 'Categories'}: ${escHtml(b.categories.join(', '))}</small></div></div>`).join('');
            const more = n > 8 ? `<div class="dlg-item"><div><small>and ${n - 8} more</small></div></div>` : '';
            await ConfirmDialog.show({
                title:       'Cannot Delete This Category',
                html:        `<div class="dlg-alert warn" style="margin-top:0">${lead}</div>
                              <div class="dlg-items" style="margin-top:12px">${rows}${more}</div>
                              <div class="dlg-alert info">Every product needs at least one category. Give ${n === 1 ? 'that product' : 'those products'} another category first (Edit Product), or use <strong>Rename</strong> instead. Nothing was changed.</div>`,
                confirmText: 'OK',
                danger:      false,
                hideCancel:  true
            });
        },

        brandsOf(name) { return this.rows.find(r => r.name.toLowerCase() === name.toLowerCase())?.brands ?? 0; },

        async rename(name) {
            const names = await this.askNames({ title: `Rename "${name}"`, intro: 'Enter the new name for this category.', labels: ['New name'], initial: [name], confirmText: 'Continue' });
            if (!names) return;
            const to = names[0];
            if (to.toLowerCase() === name.toLowerCase() && to === name) return;
            const exists = this.rows.some(r => r.name.toLowerCase() === to.toLowerCase() && r.name.toLowerCase() !== name.toLowerCase());
            await this.apply('rename', { from: name, to }, 'Rename Category',
                `Rename "${name}" to "${to}" on ${this.brandsOf(name)} product${this.brandsOf(name) === 1 ? '' : 's'}.` +
                (exists ? `\n\n"${to}" already exists, so the two will be combined.` : ''));
        },

        // Add a category to the list (it can be ticked on products afterwards)
        async add() {
            const names = await this.askNames({ title: 'Add Category', intro: 'Add a category to the list. You can tick it on products afterwards.', labels: ['Category name'], confirmText: 'Add' });
            if (!names) return;
            const res = await API.post('/inventory/categories', { name: names[0] });
            if (res?.success) {
                Toast.show(res.message, 'success');
                await this.load();
                await loadCategories();
            } else {
                Toast.show(res?.message || 'The category could not be added.', 'error');
            }
        },

        // Delete every ticked category (one or several at once)
        async remove() {
            const picked = [...document.querySelectorAll('#mc-tbody input.mc-pick:checked')].map(i => i.value);
            if (!picked.length) return;
            const uses = picked.reduce((s, n) => s + this.brandsOf(n), 0);
            await this.apply('delete', { names: picked }, `Delete ${picked.length} Categor${picked.length === 1 ? 'y' : 'ies'}`,
                `Delete ${picked.map(p => `"${p}"`).join(', ')}.\n\n` +
                (uses
                    ? `They will be removed from the products that use them (up to ${uses}). A product cannot lose its ONLY category: if any would, nothing is deleted.`
                    : 'None of them is used by a product yet.'));
        }
    };

    // -- Import Results window: what happened to every row --
    const ImportResults = {
        show(result) {
            if (!document.getElementById('import-result-modal')) {
                const overlay = document.createElement('div');
                overlay.className = 'modal-overlay';
                overlay.id = 'import-result-modal';
                overlay.innerHTML = `
                    <div class="modal" style="max-width:680px">
                        <div class="modal-header">
                            <h3>Import Results</h3>
                            <button class="btn-close" id="ir-close">X</button>
                        </div>
                        <div class="modal-body" id="ir-body" style="max-height:65vh;overflow-y:auto"></div>
                        <div class="modal-footer"><button class="btn btn-primary" id="ir-close-2">Close</button></div>
                    </div>`;
                document.body.appendChild(overlay);
                const close = () => Modal.close('import-result-modal');
                document.getElementById('ir-close').addEventListener('click', close);
                document.getElementById('ir-close-2').addEventListener('click', close);
            }
            const d = result.data || {};
            const list = (items) => `<ul>${items.map(i => `<li>${escHtml(i)}</li>`).join('')}</ul>`;
            document.getElementById('ir-body').innerHTML = `
                <div class="ir-summary">${escHtml(result.message || 'Import complete.')}</div>
                ${d.details?.length ? `<div class="ir-section"><h4>What happened to each row</h4>${list(d.details)}</div>` : ''}
                ${d.errors?.length ? `<div class="ir-section ir-errors"><h4>Rows that could not be imported (${d.errors.length})</h4>${list(d.errors)}</div>` : ''}
                ${d.field_mismatches?.length ? `<div class="ir-section ir-warnings"><h4>Details left unchanged (${d.field_mismatches.length})</h4>${list(d.field_mismatches)}</div>` : ''}
                ${d.ignored_columns?.length ? `<div class="ir-section ir-warnings"><h4>Columns not recognized, so ignored</h4>${list(d.ignored_columns)}</div>` : ''}`;
            Modal.open('import-result-modal');
        }
    };

    // Inventory changes the server refused (a product or restock that could not be
    // saved) show here, in plain words -- not only on the POS page.
    SyncIssues.mount('inventory');

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
        getSubLabel: p => `${fmtCategory(p.category)} \u00b7 ${p.item_count} item${p.item_count === 1 ? '' : 's'}`
    });

    // ── Toolbar ───────────────────────────────────────────────
    document.getElementById('btn-add-product')?.addEventListener('click', openAddModal);
    document.getElementById('btn-manage-categories')?.addEventListener('click', () => ManageCategories.open());
    document.getElementById('btn-import-csv')?.addEventListener('click', () => importInput?.click());
    importInput?.addEventListener('change', handleCSVImport);
    submitBtn?.addEventListener('click', handleFormSubmit);

    document.getElementById('btn-download-template')?.addEventListener('click', async () => {
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
        word:  { path: 'word',  filename: 'PharmaTrack_Inventory_Report.docx' }
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

            if (!res.ok) {
                // A real endpoint failure sends a JSON error body -- read
                // it instead of a generic message, same fix as
                // main.js's shared API.request().
                let message = 'Export failed.';
                try {
                    const errBody = await res.json();
                    if (errBody?.message) message = errBody.message;
                } catch (e) { /* not JSON -- keep the generic message */ }
                Toast.show(message, 'error');
                return;
            }

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
            // Genuine network-level failure (fetch() itself rejected) --
            // distinct from the clean-but-unsuccessful response above.
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
        if (totalCount) totalCount.textContent = products.length;

        // Sort wiring is done ONCE -- re-attaching on every load (search/
        // filter changes all re-fetch from the server) would double up
        // click listeners on the same header cells. getData (not a plain
        // array) means this stays correct even though `products` gets
        // REASSIGNED to a new array on every load above -- see TableSort's
        // own comment for why a plain array reference would go stale here.
        if (!invSort) {
            invSort = TableSort.attach(document.querySelector('.inventory-table thead'), {
                getData: () => products,
                getValue: (row, key) => {
                    if (key === 'stock_quantity' || key === 'price') return parseFloat(row[key] || 0);
                    if (key === 'earliest_expiry_days_left') {
                        // No expiry left to compare (every item already
                        // expired) sorts to the end regardless of
                        // direction -- null is handled that way by
                        // TableSort itself already.
                        return row.earliest_expiry ? parseInt(row.earliest_expiry_days_left) : null;
                    }
                    return (row[key] || '').toString().toLowerCase();
                },
                // Goes through Paginate now, not straight to renderTable --
                // sorting changes ORDER, and pagination needs to reslice
                // against that new order, not just redraw whatever page
                // was already showing against the OLD order.
                onSorted: () => invPaginate.resetToFirstPage()
            });
        }

        // Same one-time-attach guard as invSort above.
        if (!invPaginate) {
            invPaginate = Paginate.attach(document.getElementById('inv-pagination'), {
                getData:  () => products,
                onRender: (pageItems) => renderTable(pageItems),
                pageSize: 25
            });
        }

        // Always -- TableSort's resort() unconditionally triggers onSorted
        // at the end regardless of whether a sort is currently active (see
        // that function's own implementation), which is exactly what's
        // needed here either way: on the very first load, this is what
        // produces the FIRST render at all (attach() alone doesn't render
        // without a defaultKey, which this doesn't use); on every later
        // load (a fresh search/filter/Refresh), this re-sorts the new data
        // (a no-op if nothing's sorted) and resets to page 1 against it.
        invSort.resort();
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

        const activeKey = invSort?.getCurrentSort().key;
        const tint = (key) => key === activeKey ? ' sort-col-tint' : '';

        tbody.innerHTML = data.map(p => {
            const statusBadge = getStatusBadge(p);
            const expiryCell  = getEarliestExpiryCell(p);
            const rowClass    = getRowClass(p);
            return `
            <tr class="${rowClass}" data-id="${p.id}">
                <td class="col-text sticky-col${tint('name')}" title="${escHtml(p.name)}">
                    <div class="fw-600">${escHtml(p.name)}</div>
                    ${p.generic_name ? `<div class="text-muted" style="font-size:0.73rem">${escHtml(p.generic_name)}</div>` : ''}
                </td>
                <td class="col-text${tint('category')}" title="${escHtml(fmtCategory(p.category))}">${escHtml(fmtCategory(p.category))}</td>
                <td class="col-num${tint('stock_quantity')}">
                    <span class="${p.stock_quantity <= p.low_stock_threshold ? 'text-danger fw-600' : ''}">
                        ${p.stock_quantity}
                    </span>
                    <div class="text-muted" style="font-size:0.7rem">${p.item_count} item${p.item_count === 1 ? '' : 's'}</div>
                </td>
                <td class="col-num${tint('price')}">${Fmt.currency(p.price)}</td>
                <td class="col-text${tint('earliest_expiry_days_left')}">${expiryCell}</td>
                <td class="col-text${tint('effective_status')}">${statusBadge}</td>
                <td>
                    <div class="d-flex gap-8 row-actions">
                        <button class="btn btn-light btn-sm btn-edit"    data-id="${p.id}" title="Edit">Edit</button>
                        <button class="btn btn-danger btn-sm btn-delete" data-id="${p.id}" title="Delete">Delete</button>
                    </div>
                    <button class="kebab-trigger" data-id="${p.id}" data-name="${escHtml(p.name)}" title="More actions" aria-label="More actions">⋮</button>
                </td>
            </tr>`;
        }).join('');

        tbody.querySelectorAll('.btn-edit').forEach(btn => {
            btn.addEventListener('click', () => openEditModal(parseInt(btn.dataset.id)));
        });
        tbody.querySelectorAll('.btn-delete').forEach(btn => {
            btn.addEventListener('click', () => confirmDelete(parseInt(btn.dataset.id)));
        });
        // Touch-device equivalent of the two buttons above -- see
        // .kebab-trigger in global.css, only ever visible where hover isn't
        // available.
        tbody.querySelectorAll('.kebab-trigger').forEach(btn => {
            const id = parseInt(btn.dataset.id);
            attachKebabMenu(btn, [
                { label: 'Edit', onClick: () => openEditModal(id) },
                { label: 'Delete', danger: true, onClick: () => confirmDelete(id) }
            ]);
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
        if (!data?.success) return;
        const cats = data.data.categories || [];
        CategoryPicker.setKnown(cats);          // the checkboxes in Add / Edit Product
        if (!categoryFilter) return;
        const keep = categoryFilter.value;      // re-runnable: Manage Categories calls this after a change
        while (categoryFilter.options.length > 1) categoryFilter.remove(1);
        cats.forEach(cat => {
            const opt = document.createElement('option');
            opt.value = cat; opt.textContent = cat;
            categoryFilter.appendChild(opt);
        });
        if (keep && cats.includes(keep)) categoryFilter.value = keep;
    }

    // ─────────────────────────────────────────────────────────
    // MODALS
    // ─────────────────────────────────────────────────────────
    function openAddModal() {
        editingId    = null;
        currentItems = [];
        if (modalTitle) modalTitle.textContent = 'Add New Product';
        productForm?.reset();
        CategoryPicker.setValue('');
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
        CategoryPicker.setValue(p.category);

        // Tax Exempt checkbox (not a text field, so it isn't in the list above)
        const taxExemptEl = document.getElementById('field-is_tax_exempt');
        if (taxExemptEl) taxExemptEl.checked = Number(p.is_tax_exempt) === 1;

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
        const confirmed = await TypedConfirm.show({
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

        body.is_tax_exempt = document.getElementById('field-is_tax_exempt')?.checked ? 1 : 0;

        ['generic_name', 'supplier', 'description'].forEach(k => {
            if (body[k] === '') body[k] = null;
        });

        const summary = editingId
            ? `Brand Name: ${body.name}${body.generic_name ? ' (' + body.generic_name + ')' : ''}\n` +
              `Category: ${fmtCategory(body.category)}\n` +
              `Price: ${Fmt.currency(body.price)}   Cost: ${Fmt.currency(body.cost)}\n` +
              `Low-stock alert at: ${body.low_stock_threshold}\n` +
              `Tax Exempt: ${body.is_tax_exempt ? 'Yes (no VAT)' : 'No'}\n\n` +
              `This updates ALL ${currentItems.length} Item No. entr${currentItems.length === 1 ? 'y' : 'ies'} under this product ` +
              `with these shared details. Stock/expiry per item is managed separately below.`
            : `Brand Name: ${body.name}${body.generic_name ? ' (' + body.generic_name + ')' : ''}\n` +
              `Category: ${fmtCategory(body.category)}\n` +
              `Price: ${Fmt.currency(body.price)}   Cost: ${Fmt.currency(body.cost)}\n` +
              `Stock: ${body.stock_quantity} units   Low-stock alert at: ${body.low_stock_threshold}\n` +
              `Tax Exempt: ${body.is_tax_exempt ? 'Yes (no VAT)' : 'No'}\n` +
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
        const confirmed = await TypedConfirm.show({
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
            ImportResults.show(result);   // what happened to every row, and why any row failed

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
                Toast.show(`${errors.length} row${errors.length === 1 ? '' : 's'} could not be imported. See the results window for the reason on each row.`, 'warning');
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
