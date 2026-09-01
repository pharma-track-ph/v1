# PharmaTrack — Inventory Restructure Handoff

**Purpose of this document:** context for continuing the Inventory restructure (Brand Name / Item No.) and the two pieces of it that were deliberately deferred. Add this file to the Project's Context section (the `+` button) alongside the other handoff docs, so any future chat can pick up from here without re-explaining.

---

## What's done (4b–4d, "Option B")

Implemented in this session:

- **No database schema change.** `products` is still one row per physical batch (own `stock_quantity`/`expiry_date`), exactly as before — the same grouping key POS's `groupBatchesForPOS()` already used (rows sharing the same `name`). Nothing new was added to the DB.
- **Backend** (`backend/models/Product.js`, `backend/controllers/inventoryController.js`, `backend/routes/inventoryRoutes.js`): new grouped-by-`name` methods (`findAllGrouped`, `findGroupById`, `createGroup`, `updateGroupFields`, `softDeleteGroup`, `addItem`, `updateItem`, `deleteItem`, `getGroupedAlertCounts`). The old per-row methods (`findAll`, `findById`, `update`, `softDelete`, the individual count getters) are untouched and still used elsewhere (CSV import, in particular).
- **Status rollup** (`Product._rollUpGroup`): a brand is "Expired" only if *every* Item No. under it is expired. Otherwise Out of Stock/Low Stock/In Stock is computed from the combined stock of its non-expired items only. "Expiring this month/in 3 months" is tracked *per item* (`has_item_expiring_this_month`/`_3mo`), shown as a secondary badge alongside the main status — a brand can show "In Stock" while one specific item is flagged for FEFO attention.
- **Frontend** (`frontend/pages/inventory.html`, `frontend/js/inventory.js`, `frontend/css/inventory.css`): main table now shows one row per brand (Brand Name / Category / Stock / Price / Earliest Expiry / Status / Actions — Item No. column removed). Edit modal shows the shared top-level fields (saving cascades across every Item No. row in that brand — simple "patch all rows" approach) plus a full Item No. list, each with its own inline Edit (Stock Qty + Expiry Date, shown as a real date, e.g. "Expires: March 15, 2027") and Delete, plus "+ Add Item No." for restocking. Deleting the last remaining Item No. is blocked (delete the whole product instead).
- **"Add Product" vs "Add Item No."**: Add Product creates a brand new medicine once (full details + Item No. 1 in one form) and blocks if the Brand Name already exists (case-insensitive), pointing to Add Item No. instead. Add Item No. (inside the Edit modal) just takes Stock Qty + Expiry Date and clones the brand's existing shared fields.
- **Barcode**: still one per brand (no separate barcode-consolidation decision was needed — no barcodes are printed yet, per the call to just proceed). Auto-generated on Add Product, unchanged mechanism (`Product.ensureBarcode`, `CODE128`/JsBarcode). Editing shared fields preserves the existing barcode rather than wiping it (this was a real bug caught and fixed mid-session — the Edit form has no barcode input anymore, so the update path now falls back to the group's *current* barcode instead of `null` when the client doesn't send one).
- **Header alert badges** (Low Stock/Near Expiry counts shown in the top header on every admin page) now come from `getGroupedAlertCounts`, so they agree with what Inventory's own filters show (e.g. "Low Stock: 3" means 3 brands, not 3 batches).

## Explicitly deferred (tagged here per your instruction, not built yet)

### 1. Rename scope (old 4a: "Product Name" → "Brand Name", "Batch Number/Batch No." → "Item No.")

Confirmed during investigation where this terminology still appears outside the Inventory page/API (which already use the new terms internally now — `name`/`generic_name` etc. stayed as the underlying field names, only the Inventory UI's labels changed):

- **`backend/controllers/exportController.js`** — Inventory export columns: `'Batch No.'`, `'Product Name'`.
- **`backend/controllers/reportController.js`** — Expired Inventory export columns: `'Batch No.'`, `'Product Name'` (`EXPIRED_COLUMNS`).
- **`frontend/pages/reports.html`** — Expired Inventory tab's on-screen table headers: `<th>Batch No.</th><th>Product Name</th>`.
- **Sales/Void Reports' expandable "Items Sold" rows** — column header is just `"Product"` (from `order_items.product_name`, a point-in-time snapshot of what was sold), not literally "Product Name" — lower priority, confirm whether to touch this too or leave as historical sale data.

Not done: renaming any of the above, or the underlying DB column names (`products.name`/`generic_name`, `order_items.product_name`/`batch_number` — the latter two are point-in-time snapshots on completed orders, changing them is a separate, higher-risk conversation).

### 2. CSV Import rewrite

`backend/controllers/inventoryController.js`'s `importCSV` and `Product.bulkUpsert` are **unchanged** — still the old flat `batch_number`-per-row format. A CSV import today still works (creates flat rows that happen to group into a brand like any other row), just without any of the new terminology or conflict-detection behavior below.

Full spec to implement later, as given:

**Columns the CSV should accept:** Brand Name, Generic Name, Category, Supplier (optional), Selling Price, Cost, Low Stock Threshold, Description (optional), Stock Quantity, Expiry Date.

**Columns removed entirely** (no longer user-supplied): Batch Number (Item No. is auto-incremented, never typed) and Barcode (auto-generated, never typed).

**Row logic:**
- Brand Name doesn't exist yet → mini "Add Product": create the product from the row's shared fields, auto-generate its barcode, create Item No. 1 from the row's Stock Quantity/Expiry Date.
- Brand Name already exists, and Category/Supplier/Selling Price/Cost/Low Stock Threshold/Description all match what's stored → mini "Add Item No.": append a new Item No. automatically, no interruption.
- Brand Name already exists but something differs → open that product's *existing* Edit modal (not a separate popup) with the mismatched fields pre-filled from the CSV and ideally visually flagged as changed; user reviews and saves as a normal edit, with the new Item No. added at the same time.

**Open question (my recommendation, not yet built):** queue conflicts and review them together after the rest of the import finishes, rather than interrupting per row. Reasoning: at this app's likely import scale (tens to a couple hundred rows for a single pharmacy, not bulk enterprise import), halting on every conflict one-by-one would mean many sequential modal interactions in a row for a messy CSV. Better flow: process all clean rows first (new brands + exact-match restocks), collect conflicting rows into a queue, then step through that queue afterward via the same Edit modal, one at a time, with a small "Reviewing conflict 2 of 5" indicator — matches how most bulk-import tools handle this (process everything, surface a review queue for what needs attention) without needing a separate custom UI.

## Not started yet (per the suggested order — next up is 4e)

3. Export updates (4e) — bring the Inventory/Expired-Inventory exports in line with the new rollup + (whichever way the rename above lands). Also needs a decision (flagged, not yet made): should exports drop the Item No. column entirely to match the on-screen table, or keep per-item detail since exports are often used for physical/audit purposes? Leaning toward keeping item-level detail per the original note, but confirm before building.
4. JotForm AI grounding in real inventory.
5. Void page search by order number.
6. Real-time POS stock sync across sessions.

---

## Update (later same project): status logic simplified, single badge, modal reorder, Inventory export rewritten

A few refinements on top of the original 4b–4d build above, plus the Inventory export decision (4e) got made and built for the Inventory export specifically (Expired Inventory report/export in `reportController.js` is UNCHANGED, still deferred with the rest of the 4a rename work).

**Status logic changed — "Expired" is no longer a brand-level `stock_status` value.** A brand where every Item No. is expired now shows "Out of Stock" like any other brand with nothing sellable, instead of a separate "Expired" badge — from a "can I sell this" standpoint they're the same thing, and the expired/depleted distinction only actually matters per ITEM (for deciding what to physically discard vs. reorder). `Product._rollUpGroup` now returns `all_items_expired` (a plain boolean) instead of computing a special `stock_status`; the Status filter's "Expired" option and the header alert count both switched to checking that flag instead.

**Status badge on the main table is now exactly ONE badge, not up to two.** It used to show a primary status badge plus a second "Item Expiring Soon/in 3mo" badge when applicable, which wrapped badly in the narrow Status column and could render as a truncated "...". `getStatusBadge()` in `inventory.js` now picks one by priority (Out of Stock > Low Stock > Item Expiring Soon > Item Expiring in 3mo > In Stock). The underlying flags are untouched and the Status filter dropdown still matches against all of them independently — only the single visible badge simplified, not the filtering.

**Edit modal reordered**: Item No. list (+ new "Removed Item No." section, see below) now sits right after Selling Price/Cost/Low Stock Threshold, above Description (was below Description before). Barcode preview moved to the very end, after Description. The ADD-mode "Initial Stock Qty/Expiry Date" row moved to the same position for consistency between Add and Edit layouts.

**Every Item No. now shows a proper tag** (Expired/Out of Stock/Expiring Soon/Within 3 Months/Good — "Good" shown even when nothing else applies, so every item consistently has one) instead of the old inline "(Within 3 months)"-style text.

**New "Removed Item No. (for removing batches)" section**, only shown when at least one Item No. is expired or out of stock. Those items move out of the active "Item No. (restock batches)" list into this section automatically, shown with only a "Remove" button (no Edit) — clicking it is **display-only for that modal session**, it never calls the delete API or touches the database. It's meant as a staff reminder to go physically clear out that stock; reopening the Edit modal later re-fetches from the server and will show it again if it's still there, unchanged. Actually deleting an Item No. from the database still only happens via the active list's own Delete button (which still refuses to delete the last remaining active item). Both the active and removed lists renumber independently and automatically ("Item No. 1, 2, 3…" within each list) whenever anything is added, edited, deleted, or dismissed.

**Inventory export rewritten** (`exportController.js`, plus a new `Product.findAllForInventoryExport()` in the model) — this resolves the item-level-detail-in-exports question from 4e, for the Inventory export specifically:
- Batch No. column removed entirely (all 3 formats).
- "Product Name" renamed to "Brand Name".
- Decision made: **keep per-item rows** (one row per Item No./batch), not rolled up to one row per brand — matches what a physical/audit report actually needs.
- Rows are grouped so every brand's items sit consecutively, sorted **alphabetically by Brand Name** overall, and within each brand's block its expired/out-of-stock items are listed **first**, then the rest in normal Item No. order — mirrors the same active/removed split logic as the Edit modal's Item No. list.
- Each row's Status column now shows that specific ITEM's own state (Expired/Out of Stock/Expiring This Month/Expiring in 3 Months/In Stock), not the brand-level rollup — repeating an identical brand-wide status across several rows of the same brand would have been misleading for a row that IS the specific expired/depleted batch.
- This only covers the Inventory export. The Expired Inventory report/export in `reportController.js` and the on-screen Expired Inventory tab in `reports.html` are untouched — still old per-row "Batch No./Product Name" terminology, still part of the deferred 4a rename work above.

---

## Update (later same project): CSV/Excel import implemented (simplified, not the full conflict-modal spec)

The CSV Import work logged as deferred above (section 2) is now DONE, but in a **simplified** form — not the full "detect conflicts, reopen the Edit modal with mismatched fields highlighted, queue for review" design from the original spec. What's actually built:

- **Accepts both `.csv` and `.xlsx`/`.xls`** now (`inventoryController.js`'s `parseImportFile`, using ExcelJS — already a project dependency for exports — to read Excel files server-side into the same row shape a CSV produces). Multer's file filter (`inventoryRoutes.js`) updated to allow all three extensions.
- **New Brand Name-based columns**, matching the rest of the app since the restructure: Brand Name, Generic Name, Category, Supplier, Selling Price, Cost, Low Stock Threshold, Description, Stock Quantity, Expiry Date. Header matching is normalized/flexible ("Brand Name", "brand_name", "BrandName" all resolve the same way), so the uploaded file doesn't have to match the template's exact wording.
- **Row logic**: Brand Name doesn't exist yet → creates the product (Add Product equivalent, auto-generates a barcode). Brand Name already exists → appends a new Item No. (Add Item No. equivalent) using that row's Stock Quantity/Expiry Date only.
- **What's simplified vs. the original spec**: when an existing brand's row has different Category/Supplier/Price/Cost/Threshold/Description than what's already stored, this does **not** reopen the Edit modal for manual review (the original spec's design). It just leaves the existing product's fields untouched and reports the mismatch back in the response (`field_mismatches` array) — surfaced to the user as a toast pointing at the browser console for details. This was a deliberate scope call to ship something useful now rather than build the full queued-review UI; revisit if the field-mismatch review flow is still wanted.
- **`GET /api/inventory/import/template`** — new endpoint (and "Download Template" link next to the Import button on the Inventory page) returning a ready-made `.xlsx` with the correct headers plus one example row.
- The OLD `Product.bulkUpsert` (flat, batch_number-keyed) is untouched and still exists in `Product.js`, just no longer called by `importCSV` — nothing else in the app uses it currently.

## Update (later same project): CSV export format added

The shared export engine (`backend/utils/reportExporter.js`) now supports a `csv` format alongside excel/pdf/word (`exportCSV`, wired into `exportReport()`'s dispatcher) — available to any report's export route, not just Inventory's, since it lives in the shared engine rather than being Inventory-specific. Currently exposed in the UI only on the Inventory page's Export dropdown. Deliberately skips the branded title/date/signature block the other three formats have (no merged cells in CSV, so it would just render as a row of bare commas) — just the header row + data rows + optional totals row, matching whatever `columns`/`rows` the calling controller already builds for the other formats.
