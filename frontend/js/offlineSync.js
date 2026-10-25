// ============================================================
// Offline Sync Module
// IndexedDB-based offline-first data sync for PharmaTrack
//
// Covers: product/inventory browsing, the CURRENT cash register session,
// and POS checkout -- all three keep working with no internet, and sync
// back once the connection returns. Built for a single-cashier pharmacy
// (see pos.js), so this deliberately does NOT try to reconcile
// simultaneous multi-cashier stock conflicts -- it optimistically trusts
// the locally cached numbers while offline, and the server still has
// final say once synced. If a queued sale is ever rejected at sync time
// (e.g. stock genuinely ran out in the meantime), it's recorded in
// `failed_syncs` instead of silently vanishing -- see recordFailedSync()
// and OfflineAPI.getFailedSyncs().
// ============================================================

class OfflineSync {
    constructor() {
        this.db = null;
        this.isOnline = navigator.onLine;
        this.initDB();
        this.setupEventListeners();
    }

    async initDB() {
        return new Promise((resolve, reject) => {
            // Bumped 1 -> 2 to add the `session` and `failed_syncs` stores
            // below. onupgradeneeded only fires for browsers that still
            // have the old version 1 database, so existing cached
            // products/sync_queue data is untouched by this bump.
            const request = indexedDB.open('pharmatrack_offline', 2);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.db = request.result;
                resolve();
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                if (!db.objectStoreNames.contains('products')) {
                    db.createObjectStore('products', { keyPath: 'id' });
                }

                if (!db.objectStoreNames.contains('sync_queue')) {
                    const queueStore = db.createObjectStore('sync_queue', { keyPath: 'id', autoIncrement: true });
                    queueStore.createIndex('endpoint', 'endpoint', { unique: false });
                    queueStore.createIndex('timestamp', 'timestamp', { unique: false });
                }

                if (!db.objectStoreNames.contains('orders')) {
                    db.createObjectStore('orders', { keyPath: 'id' });
                }

                // Single-row cache of "the cashier's currently open register"
                // (see OfflineAPI.cacheCurrentSession) -- keyPath 'key' with
                // one fixed record ('current'), same pattern as any small
                // singleton cache.
                if (!db.objectStoreNames.contains('session')) {
                    db.createObjectStore('session', { keyPath: 'key' });
                }

                // Sync attempts that got permanently discarded (rejected by
                // the server, or gave up after repeated failures) land here
                // instead of just disappearing -- see recordFailedSync().
                if (!db.objectStoreNames.contains('failed_syncs')) {
                    const failedStore = db.createObjectStore('failed_syncs', { keyPath: 'id', autoIncrement: true });
                    failedStore.createIndex('timestamp', 'timestamp', { unique: false });
                }
            };
        });
    }

    setupEventListeners() {
        window.addEventListener('online', () => {
            this.isOnline = true;
            this.showOfflineBanner(false);
            this.processSyncQueue();
        });

        window.addEventListener('offline', () => {
            this.isOnline = false;
            this.showOfflineBanner(true);
        });
    }

    showOfflineBanner(show) {
        let banner = document.getElementById('offline-banner');
        if (show && !banner) {
            const topHeader   = document.querySelector('.top-header');
            const headerRight = document.querySelector('.header-right');
            if (!topHeader) return; // no header on this page (e.g. login) -- nothing to show it in

            banner = document.createElement('div');
            banner.id = 'offline-banner';
            banner.textContent = 'Offline Mode';

            // Inserted BEFORE .header-right (not just appended) so it lands
            // in the middle of the header's own flex layout
            // (justify-content:space-between between .header-left and
            // .header-right) -- the empty gap that's already there on
            // every page, rather than overlaying anything.
            if (headerRight) {
                topHeader.insertBefore(banner, headerRight);
            } else {
                topHeader.appendChild(banner);
            }
        } else if (!show && banner) {
            banner.remove();
        }
    }

    async get(table, id) {
        if (!this.db) await this.initDB();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([table], 'readonly');
            const store = transaction.objectStore(table);
            const request = store.get(id);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });
    }

    async put(table, data) {
        if (!this.db) await this.initDB();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([table], 'readwrite');
            const store = transaction.objectStore(table);
            const request = store.put(data);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });
    }

    async getAll(table) {
        if (!this.db) await this.initDB();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([table], 'readonly');
            const store = transaction.objectStore(table);
            const request = store.getAll();

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });
    }

    async delete(table, id) {
        if (!this.db) await this.initDB();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([table], 'readwrite');
            const store = transaction.objectStore(table);
            const request = store.delete(id);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });
    }

    async addToSyncQueue(operation) {
        if (!this.db) await this.initDB();
        const queueItem = {
            ...operation,
            timestamp: Date.now(),
            retries: 0
        };

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['sync_queue'], 'readwrite');
            const store = transaction.objectStore('sync_queue');
            const request = store.add(queueItem);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                resolve(request.result);
                // lets a page's "waiting to sync" note appear at once
                window.dispatchEvent(new CustomEvent('pharmatrack:queue-changed'));
            };
        });
    }

    /**
     * Records a sync attempt that's being permanently given up on (rejected
     * by the server, or repeated failures) so it doesn't just silently
     * vanish -- OfflineAPI.getFailedSyncs() surfaces these on the POS page
     * for the cashier/owner to review and handle manually if needed.
     */
    async recordFailedSync(item, reason) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['failed_syncs'], 'readwrite');
            const store = transaction.objectStore('failed_syncs');
            const request = store.add({
                endpoint:  item.endpoint,
                method:    item.method,
                body:      item.body,
                meta:      item.meta || null,
                retries:   item.retries || 0,
                reason,
                timestamp: Date.now()
            });

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });
    }

    /**
     * Sends ONE queued item and reports what happened. Outcomes:
     *   synced -- the server accepted it (or answered "already recorded");
     *             it is removed from the queue.
     *   failed -- the server refused it (or it kept erroring); it is moved to
     *             failed_syncs with the reason.
     *   retry  -- could not be completed this time; it stays queued.
     *   auth   -- the login expired. The item is KEPT (it was not refused,
     *             just unsigned) and syncing resumes after signing in again.
     */
    async syncItem(item) {
        try {
            const queuedHeaders = { ...(item.headers || {}) };
            delete queuedHeaders.Authorization;
            delete queuedHeaders.authorization;

            const response = await fetch(getRequestUrl(item.endpoint), {
                method: item.method,
                headers: buildAuthHeaders({
                    'Content-Type': 'application/json',
                    ...queuedHeaders
                }),
                body: item.body ? JSON.stringify(item.body) : undefined
            });

            if (response.ok) {
                const data = await parseJsonSafely(response);
                await this.deleteFromQueue(item.id);
                return {
                    status:      'synced',
                    orderNumber: data?.order_number || data?.receipt?.order_number || null,
                    duplicate:   !!data?.duplicate
                };
            }

            if (response.status === 401) {
                handleAuthFailure();
                return { status: 'auth', message: 'Your login expired. Sign in again to continue syncing.' };
            }

            if (response.status >= 400 && response.status < 500) {
                const data   = await parseJsonSafely(response);
                const reason = data?.message || `Server rejected this (HTTP ${response.status}).`;
                await this.recordFailedSync(item, reason);
                await this.deleteFromQueue(item.id);
                console.warn('Sync item refused by the server:', item, response.status);
                return { status: 'failed', message: reason };
            }

            return await this.noteRetry(item,
                'Server kept returning errors after 3 attempts.',
                `Server error (HTTP ${response.status}). Will retry.`);
        } catch (error) {
            console.warn('Sync failed:', error);
            return await this.noteRetry(item,
                'Could not reach the server after 3 attempts.',
                'Could not reach the server. Will retry.');
        }
    }

    // Counts a failed attempt; after 3 the item is given up on and moved to
    // failed_syncs (where it can be retried or dismissed by hand).
    async noteRetry(item, finalReason, softMessage) {
        item.retries   = (item.retries || 0) + 1;
        item.lastError = softMessage;
        if (item.retries < 3) {
            await this.put('sync_queue', item);
            return { status: 'retry', message: softMessage };
        }
        await this.recordFailedSync(item, finalReason);
        await this.deleteFromQueue(item.id);
        return { status: 'failed', message: finalReason };
    }

    /**
     * One sync pass -- the automatic one (when the connection returns), "Sync
     * all", and the per-sale Sync button all come through here. `onlyIds`
     * limits it to specific queue items. Only ONE pass runs at a time: a
     * second request while one is running is refused as "busy" rather than
     * sending the same sale twice (the server's duplicate guard is the second
     * line of defence behind this lock).
     * Returns { results, skipped? } with one result per item attempted.
     */
    async runSync(onlyIds = null) {
        if (!this.isOnline || !this.db) return { results: [], skipped: 'offline' };
        if (this.syncRunning)           return { results: [], skipped: 'busy' };

        this.syncRunning = true;
        const results = [];

        try {
            const queue = (await this.getAll('sync_queue'))
                .filter(item => !onlyIds || onlyIds.includes(item.id))
                .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));   // oldest first

            for (const item of queue) {
                const outcome = await this.syncItem(item);
                results.push({
                    id:       item.id,
                    endpoint: item.endpoint,
                    ref:      item.body?.client_ref || null,
                    ...outcome
                });
                if (outcome.status === 'auth') break;   // everything after it would fail the same way
            }
        } finally {
            this.syncRunning = false;
        }

        const syncedCount = results.filter(r => r.status === 'synced').length;
        const failedCount = results.filter(r => r.status === 'failed').length;

        if (syncedCount > 0) {
            Toast.show(`${syncedCount} offline change${syncedCount === 1 ? '' : 's'} synced successfully!`, 'success');
        }
        if (failedCount > 0) {
            Toast.show(
                `${failedCount} offline change${failedCount === 1 ? '' : 's'} could not be saved. Open the red "not saved" note on the page they were made on (Inventory or POS) to see why.`,
                'error'
            );
        }

        // Lets any page listening (pos.js's Pending list and FailedSyncPanel)
        // refresh itself right after a pass -- both to update what's shown and
        // to re-pull the server's now-authoritative stock/session numbers
        // instead of the offline cache's approximation.
        if (results.length) {
            window.dispatchEvent(new CustomEvent('pharmatrack:sync-complete', {
                detail: { syncedCount, failedCount, results }
            }));
        }

        return { results };
    }

    // The automatic pass (online event) and "Sync all"
    processSyncQueue()  { return this.runSync(); }

    // Sync a single queued sale
    syncOne(queueId)    { return this.runSync([queueId]); }

    async deleteFromQueue(id) {
        const result = await this.delete('sync_queue', id);
        window.dispatchEvent(new CustomEvent('pharmatrack:queue-changed'));
        return result;
    }
}

function getRuntimeConfig() {
    return typeof CONFIG !== 'undefined'
        ? CONFIG
        : { API_BASE: '', TOKEN_KEY: 'pharmatrack_token' };
}

function getAuthToken() {
    if (typeof Auth !== 'undefined' && typeof Auth.getToken === 'function') {
        return Auth.getToken();
    }

    return localStorage.getItem(getRuntimeConfig().TOKEN_KEY);
}

function buildAuthHeaders(extraHeaders = {}) {
    const headers = { ...extraHeaders };
    const token = getAuthToken();

    if (token) {
        headers.Authorization = `Bearer ${token}`;
    }

    return headers;
}

function getRequestUrl(endpoint) {
    if (/^https?:\/\//i.test(endpoint)) {
        return endpoint;
    }

    return `${getRuntimeConfig().API_BASE}${endpoint}`;
}

// Only a server that is TEMPORARILY unavailable (502/503/504: restarting, cold
// start, gateway) is treated like being offline and queued. A plain 500 means the
// server RECEIVED the request and its own code or database failed: retrying the
// same request later cannot fix that, and queuing it only hid the failure behind
// a green "added" message while nothing was saved. A 500 is now shown as a
// failure, with the server's message (and its short error code).
function isTemporaryServerStatus(status) {
    return status === 502 || status === 503 || status === 504;
}

function handleAuthFailure(reason) {
    if (typeof Auth !== 'undefined' && typeof Auth.logout === 'function') {
        Auth.logout(reason);
    }
}

function isInventorySummaryEndpoint(endpoint) {
    return endpoint === '/inventory/alerts/summary' || endpoint.startsWith('/inventory/alerts/summary?');
}

function isInventoryListEndpoint(endpoint) {
    return endpoint === '/inventory' || endpoint.startsWith('/inventory?');
}

function isPosProductsEndpoint(endpoint) {
    return endpoint === '/pos/products' || endpoint.startsWith('/pos/products?');
}

function isCashSessionEndpoint(endpoint) {
    return endpoint === '/pos/cash-session/current';
}

function isCheckoutEndpoint(endpoint) {
    return endpoint === '/pos/checkout';
}

function normalizeStatusFilter(status) {
    return status === 'expiring' ? 'near_expiry' : status;
}

function normalizeCachedProduct(product) {
    const normalized = { ...product };
    const stockQuantity = Number(normalized.stock_quantity ?? 0);
    const lowStockThreshold = Number(normalized.low_stock_threshold ?? 0);

    if (normalized.days_until_expiry == null && normalized.expiry_date) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const expiryDate = new Date(`${normalized.expiry_date}T00:00:00`);
        if (!Number.isNaN(expiryDate.getTime())) {
            normalized.days_until_expiry = Math.round((expiryDate - today) / 86400000);
        }
    } else if (normalized.days_until_expiry != null) {
        normalized.days_until_expiry = Number(normalized.days_until_expiry);
    }

    if (!normalized.stock_status) {
        if (normalized.days_until_expiry < 0) {
            normalized.stock_status = 'expired';
        } else if (normalized.days_until_expiry <= 30) {
            normalized.stock_status = 'near_expiry';
        } else if (stockQuantity <= 0) {
            normalized.stock_status = 'out_of_stock';
        } else if (stockQuantity <= lowStockThreshold) {
            normalized.stock_status = 'low_stock';
        } else {
            normalized.stock_status = 'in_stock';
        }
    }

    return normalized;
}

async function parseJsonSafely(response) {
    try {
        return await response.json();
    } catch (error) {
        return null;
    }
}

const offlineSync = new OfflineSync();

const OfflineAPI = {
    lastFallbackToastAt: 0,

    showFallbackWarning(message) {
        const now = Date.now();
        if (now - this.lastFallbackToastAt < 3000) return;

        this.lastFallbackToastAt = now;
        Toast.show(message, 'warning');
    },

    async cacheProducts(products = []) {
        for (const product of products) {
            await offlineSync.put('products', normalizeCachedProduct(product));
        }
    },

    // POS list refresh. The /pos/products response is the full list of brands
    // that are sellable RIGHT NOW (stock left, not expired), so after caching
    // it, any POS entry cached earlier that is no longer in the response is
    // removed -- otherwise a brand that sold out (and so disappeared online)
    // would keep showing in offline mode. Only done for the unfiltered list,
    // never for a search or barcode result, which is just a slice of it.
    // Entries are tagged _pos so Inventory's own cached rows are never touched.
    async cachePosProducts(products = [], endpoint = '') {
        const url        = new URL(endpoint, window.location.origin);
        const isFullList = !(url.searchParams.get('q') || url.searchParams.get('barcode'));
        const freshIds   = new Set(products.map(p => p.id));

        for (const product of products) {
            await offlineSync.put('products', normalizeCachedProduct({ ...product, _pos: true }));
        }

        if (isFullList) {
            const cached = await offlineSync.getAll('products');
            for (const item of cached) {
                if (item._pos === true && !freshIds.has(item.id)) {
                    await offlineSync.delete('products', item.id);
                }
            }
        }
    },

    async getCachedProducts(endpoint) {
        const cached = (await offlineSync.getAll('products'))
            .map(normalizeCachedProduct)
            .filter(product => product.is_active !== 0);

        const url = new URL(endpoint, window.location.origin);
        const search = (url.searchParams.get('search') || url.searchParams.get('q') || '').trim();
        const barcode = url.searchParams.get('barcode') || '';
        const category = url.searchParams.get('category') || '';
        const status = normalizeStatusFilter(url.searchParams.get('status') || '');

        let filtered = cached;

        // The POS only offers brands with stock left (see Product.findAllForPOS)
        if (isPosProductsEndpoint(endpoint)) {
            filtered = filtered.filter(product => Number(product.stock_quantity) > 0);
        }

        if (search) {
            const lowerSearch = search.toLowerCase();
            filtered = filtered.filter(product =>
                product.name?.toLowerCase().includes(lowerSearch) ||
                product.generic_name?.toLowerCase().includes(lowerSearch) ||
                product.batch_number?.toLowerCase().includes(lowerSearch) ||
                product.barcode?.includes(search)
            );
        }

        if (barcode) {
            filtered = filtered.filter(product => product.barcode === barcode);
        }

        if (category) {
            filtered = filtered.filter(product => product.category === category);
        }

        if (status) {
            filtered = filtered.filter(product => product.stock_status === status);
        }

        return { success: true, data: filtered, total: filtered.length, cached: true };
    },

    async getCachedAlertSummary() {
        const cached = (await offlineSync.getAll('products'))
            .map(normalizeCachedProduct)
            .filter(product => product.is_active !== 0);

        const categories = [...new Set(cached.map(product => product.category).filter(Boolean))]
            .sort((left, right) => left.localeCompare(right));

        const lowStock = cached.filter(product => {
            const stockQuantity = Number(product.stock_quantity ?? 0);
            const lowStockThreshold = Number(product.low_stock_threshold ?? 0);
            return stockQuantity > 0 && stockQuantity <= lowStockThreshold;
        }).length;

        const nearExpiry = cached.filter(product =>
            Number(product.days_until_expiry) >= 0 && Number(product.days_until_expiry) <= 30
        ).length;

        return {
            success: true,
            data: {
                low_stock: lowStock,
                near_expiry: nearExpiry,
                categories
            },
            cached: true
        };
    },

    /**
     * Caches "the cashier's currently open register" (or null, if there
     * isn't one) every time it's successfully fetched online, so Checkout
     * still knows the register is open -- and which session ID to attach
     * the sale to -- once offline. See getCachedSession() for the
     * offline-read side.
     */
    async cacheCurrentSession(session) {
        await offlineSync.put('session', { key: 'current', data: session ?? null, cachedAt: Date.now() });
    },

    async getCachedSession() {
        const record = await offlineSync.get('session', 'current');
        return { success: true, data: record?.data ?? null, cached: true };
    },

    /**
     * Applied when a checkout is queued for later sync (whether truly
     * offline, or the server errored while nominally online -- see
     * OfflineAPI.post below). Decrements the CACHED product-family entry
     * (keyed by product_id, the same id /pos/products groups batches
     * under) by the quantity just sold, so a second offline sale of the
     * same product sees accurate remaining stock instead of the
     * pre-sale number. This is a display-side approximation, not a
     * batch-exact mirror of the server's FEFO consumption -- fine for
     * keeping the offline UI honest; the server still does the real,
     * exact stock deduction once this sale actually syncs.
     */
    async decrementCachedStockForCheckout(items = []) {
        for (const item of items) {
            const cached = await offlineSync.get('products', item.product_id);
            if (!cached) continue;

            const available = Number(cached.stock_quantity) || 0;
            cached.stock_quantity = Math.max(0, available - (Number(item.quantity) || 0));
            delete cached.stock_status; // force normalizeCachedProduct to recompute it from the new quantity

            await offlineSync.put('products', normalizeCachedProduct(cached));
        }
    },

    // -- Pending offline sales (the "Pending" list on the POS page) --

    // A random reference for one sale. The server saves it (orders.client_ref,
    // UNIQUE) so the same sale can never be recorded twice, however many times
    // it is re-sent.
    newSaleRef() {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }
        return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
    },

    // Every checkout that has not reached the server yet (queued) or that the
    // server refused (failed), oldest sale first, shaped for the list.
    async getPendingCheckouts() {
        const queued = (await offlineSync.getAll('sync_queue')).filter(i => isCheckoutEndpoint(i.endpoint));
        const failed = (await offlineSync.getAll('failed_syncs')).filter(i => isCheckoutEndpoint(i.endpoint));

        const shape = (item, source) => ({
            id:          item.id,
            source,                                    // 'queue' | 'failed'
            ref:         item.body?.client_ref || null,
            createdAt:   item.body?.client_created_at || new Date(item.timestamp || Date.now()).toISOString(),
            items:       item.meta?.items
                         || (item.body?.items || []).map(i => ({ name: `Product #${i.product_id}`, quantity: i.quantity })),
            total:       item.meta?.total ?? null,
            cashierId:   item.meta?.cashier_id ?? null,
            cashierName: item.meta?.cashier_name ?? null,
            status:      source === 'failed' ? 'failed' : 'pending',
            reason:      source === 'failed' ? item.reason : (item.lastError || null),
            retries:     item.retries || 0
        });

        return [...queued.map(i => shape(i, 'queue')), ...failed.map(i => shape(i, 'failed'))]
            .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    },

    // How many pending sales THIS account has (queued or failed). A sale made under
    // another account stays on this computer until that account signs in and syncs it;
    // it must not block this account (e.g. Close Register), because this account can
    // never sync it. `others` counts those, for information only.
    async getPendingCheckoutCount(userId = null) {
        const list = await this.getPendingCheckouts();
        const mine = userId == null
            ? list
            : list.filter(i => i.cashierId == null || i.cashierId === userId);   // no recorded owner = treat as this account's
        return {
            total:  mine.length,
            failed: mine.filter(i => i.status === 'failed').length,
            others: list.length - mine.length
        };
    },

    // Puts a refused checkout back in the queue (same reference, same payload)
    // so it can be tried again; returns its new queue id.
    async retryFailedCheckout(failedId) {
        const record = await offlineSync.get('failed_syncs', failedId);
        if (!record) return null;
        const newId = await offlineSync.addToSyncQueue({
            endpoint: record.endpoint,
            method:   record.method || 'POST',
            headers:  buildAuthHeaders(),
            body:     record.body,
            meta:     record.meta || null
        });
        await offlineSync.delete('failed_syncs', failedId);
        return newId;
    },

    // Older queued checkouts (from before this update) have no reference yet.
    // Give each one now so even those are protected against double-sending,
    // and keep the time they were originally queued as the sale time.
    async ensureCheckoutRefs() {
        const queue = await offlineSync.getAll('sync_queue');
        for (const item of queue) {
            if (isCheckoutEndpoint(item.endpoint) && item.body && !item.body.client_ref) {
                item.body = {
                    ...item.body,
                    client_ref:         this.newSaleRef(),
                    client_created_at:  item.body.client_created_at || new Date(item.timestamp || Date.now()).toISOString()
                };
                await offlineSync.put('sync_queue', item);
            }
        }
    },

    // Removes any void request left in the browser's storage (queued or failed).
    // Those carry a manager's password and are no longer allowed to be stored.
    // Returns how many were removed.
    async purgeStoredVoidRequests() {
        let removed = 0;
        for (const store of ['sync_queue', 'failed_syncs']) {
            const all = await offlineSync.getAll(store);
            for (const item of all) {
                if (item.endpoint === '/pos/void' || item.endpoint === '/pos/partial-void') {
                    await offlineSync.delete(store, item.id);
                    removed++;
                }
            }
        }
        return removed;
    },

    async getFailedSyncs() {
        const all = await offlineSync.getAll('failed_syncs');
        return all.sort((a, b) => b.timestamp - a.timestamp);
    },

    async clearFailedSync(id) {
        await offlineSync.delete('failed_syncs', id);
    },

    async clearAllFailedSyncs() {
        const all = await this.getFailedSyncs();
        for (const item of all) await offlineSync.delete('failed_syncs', item.id);
    },

    async getQueueCount() {
        const queue = await offlineSync.getAll('sync_queue');
        return queue.length;
    },

    async get(endpoint) {
        if (offlineSync.isOnline) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000);

            try {
                const response = await fetch(getRequestUrl(endpoint), {
                    headers: buildAuthHeaders(),
                    signal: controller.signal
                });
                const data = await parseJsonSafely(response);

                if (response.status === 401) {
                    handleAuthFailure(data?.message);
                    return null;
                }

                if (!response.ok) {
                    if (response.status < 500) {
                        return data || { success: false, message: `HTTP ${response.status}` };
                    }

                    throw new Error(data?.message || `HTTP ${response.status}`);
                }

                if (isPosProductsEndpoint(endpoint)) {
                    await this.cachePosProducts(data?.data || [], endpoint);
                } else if (isInventoryListEndpoint(endpoint)) {
                    await this.cacheProducts(data?.data || []);
                }

                if (isCashSessionEndpoint(endpoint)) {
                    await this.cacheCurrentSession(data?.data ?? null);
                }

                return data;
            } catch (error) {
                console.warn('Request failed, falling back to cache:', error.message);
                this.showFallbackWarning(
                    error.name === 'AbortError'
                        ? 'Server not responding. Using cached data if available.'
                        : 'Network error. Using cached data if available.'
                );
            } finally {
                clearTimeout(timeoutId);
            }
        }

        if (isInventorySummaryEndpoint(endpoint)) {
            return this.getCachedAlertSummary();
        }

        if (isInventoryListEndpoint(endpoint) || isPosProductsEndpoint(endpoint)) {
            return this.getCachedProducts(endpoint);
        }

        if (isCashSessionEndpoint(endpoint)) {
            return this.getCachedSession();
        }

        throw new Error('Offline and no cache available');
    },

    async post(endpoint, body, meta = null) {
        if (offlineSync.isOnline) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000);

            try {
                const response = await fetch(getRequestUrl(endpoint), {
                    method: 'POST',
                    headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
                    body: JSON.stringify(body),
                    signal: controller.signal
                });
                const data = await parseJsonSafely(response);

                if (response.status === 401) {
                    handleAuthFailure(data?.message);
                    return null;
                }

                if (!response.ok) {
                    if (isTemporaryServerStatus(response.status) || (response.status === 500 && isCheckoutEndpoint(endpoint))) {
                        // Server briefly unavailable (e.g. restarting) -- treat exactly like a
                        // network failure below and queue it for later sync. A SALE is also
                        // queued on a plain 500: it carries a unique reference, so re-sending it
                        // later can never record it twice, and a customer's sale must not be lost.
                        console.warn(`Server error ${response.status} on ${endpoint}, queuing for later sync.`);
                        this.showFallbackWarning('Server error. Request queued for sync.');
                    } else {
                        return data || { success: false, message: `HTTP ${response.status}` };
                    }
                } else {
                    if (endpoint === '/inventory' && data?.id) {
                        await offlineSync.put('products', normalizeCachedProduct({
                            ...body,
                            id: data.id,
                            is_active: 1
                        }));
                    }

                    return data;
                }
            } catch (error) {
                console.warn('Network error, queuing for later:', error.message);
                Toast.show('Network error. Request queued for sync.', 'warning');
            } finally {
                clearTimeout(timeoutId);
            }
        }

        // Voids (full or partial) are NEVER queued. The request carries a manager's
        // email and password, which must not sit in the browser's storage waiting
        // to be sent, and a void needs the live server to check the order anyway.
        if (endpoint === '/pos/void' || endpoint === '/pos/partial-void') {
            return {
                success: false,
                offline: true,
                message: 'Voids need an internet connection. Please reconnect and try again.'
            };
        }

        // A queued checkout carries (a) the reference that makes re-sending it
        // safe and (b) the time the sale was actually made, which the server
        // keeps if it falls inside the open register session. `meta` is for
        // display only (the Pending list) and is never sent to the server.
        let queuedBody = body;
        if (isCheckoutEndpoint(endpoint)) {
            queuedBody = { ...body };
            if (!queuedBody.client_ref) queuedBody.client_ref = this.newSaleRef();
            queuedBody.client_created_at = meta?.created_at || new Date().toISOString();
        }

        await offlineSync.addToSyncQueue({
            endpoint,
            method: 'POST',
            headers: buildAuthHeaders(),
            body: queuedBody,
            meta
        });

        if (endpoint === '/inventory') {
            const tempId = 'temp_' + Date.now();
            await offlineSync.put('products', normalizeCachedProduct({
                ...body,
                id: tempId,
                temp: true,
                is_active: 1
            }));
        }

        if (isCheckoutEndpoint(endpoint) && Array.isArray(body?.items)) {
            await this.decrementCachedStockForCheckout(body.items);
        }

        const queueCount = await this.getQueueCount();
        return { success: true, message: 'Queued for sync', queued: true, queueCount };
    },

    async put(endpoint, body) {
        if (offlineSync.isOnline) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000);

            try {
                const response = await fetch(getRequestUrl(endpoint), {
                    method: 'PUT',
                    headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
                    body: JSON.stringify(body),
                    signal: controller.signal
                });
                const data = await parseJsonSafely(response);

                if (response.status === 401) {
                    handleAuthFailure(data?.message);
                    return null;
                }

                if (!response.ok) {
                    if (isTemporaryServerStatus(response.status)) {
                        console.warn(`Server error ${response.status} on ${endpoint}, queuing for later sync.`);
                        this.showFallbackWarning('Server error. Request queued for sync.');
                    } else {
                        return data || { success: false, message: `HTTP ${response.status}` };
                    }
                } else {
                    if (endpoint.includes('/inventory/')) {
                        const id = endpoint.split('/').pop();
                        await offlineSync.put('products', normalizeCachedProduct({
                            ...body,
                            id: parseInt(id, 10),
                            is_active: 1
                        }));
                    }

                    return data;
                }
            } catch (error) {
                console.warn('Network error, queuing for later:', error.message);
                Toast.show('Network error. Request queued for sync.', 'warning');
            } finally {
                clearTimeout(timeoutId);
            }
        }

        await offlineSync.addToSyncQueue({
            endpoint,
            method: 'PUT',
            headers: buildAuthHeaders(),
            body
        });

        if (endpoint.includes('/inventory/')) {
            const id = endpoint.split('/').pop();
            await offlineSync.put('products', normalizeCachedProduct({
                ...body,
                id: parseInt(id, 10),
                is_active: 1
            }));
        }

        return { success: true, message: 'Queued for sync', queued: true };
    },

    async delete(endpoint) {
        if (offlineSync.isOnline) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000);

            try {
                const response = await fetch(getRequestUrl(endpoint), {
                    method: 'DELETE',
                    headers: buildAuthHeaders(),
                    signal: controller.signal
                });
                const data = await parseJsonSafely(response);

                if (response.status === 401) {
                    handleAuthFailure(data?.message);
                    return null;
                }

                if (!response.ok) {
                    if (isTemporaryServerStatus(response.status)) {
                        console.warn(`Server error ${response.status} on ${endpoint}, queuing for later sync.`);
                        this.showFallbackWarning('Server error. Request queued for sync.');
                    } else {
                        return data || { success: false, message: `HTTP ${response.status}` };
                    }
                } else {
                    if (endpoint.includes('/inventory/')) {
                        const id = endpoint.split('/').pop();
                        const cached = await offlineSync.get('products', parseInt(id, 10));
                        if (cached) {
                            cached.is_active = 0;
                            await offlineSync.put('products', cached);
                        }
                    }

                    return data;
                }
            } catch (error) {
                console.warn('Network error, queuing for later:', error.message);
                Toast.show('Network error. Request queued for sync.', 'warning');
            } finally {
                clearTimeout(timeoutId);
            }
        }

        await offlineSync.addToSyncQueue({
            endpoint,
            method: 'DELETE',
            headers: buildAuthHeaders()
        });

        if (endpoint.includes('/inventory/')) {
            const id = endpoint.split('/').pop();
            const cached = await offlineSync.get('products', parseInt(id, 10));
            if (cached) {
                cached.is_active = 0;
                await offlineSync.put('products', cached);
            }
        }

        return { success: true, message: 'Queued for sync', queued: true };
    }
};

window.OfflineAPI = OfflineAPI;
window.offlineSync = offlineSync;

// ============================================================
// Sync issues: changes that could NOT be saved
// ============================================================
// When the connection drops, a change (a new product, a restock, an edit) is kept on
// this computer and sent to the server later. If the server then REFUSES it, trying
// again can never succeed, so it is moved to a "not saved" list instead of vanishing.
// This is the ONE shared panel for that list -- a pill at the bottom-left and a window
// that explains each item in plain words (what was being done, why it was not saved,
// what to do). Each page shows only the issues that belong to it: the Inventory page
// shows inventory changes, the POS page shows the rest. (A failed SALE has its own
// Pending Sales list on the POS page.)
const SyncIssues = {
    area: null,

    belongsTo(area, item) {
        const ep = String(item.endpoint || '');
        if (ep === '/pos/checkout') return false;
        const isInventory = ep.startsWith('/inventory');
        return area === 'inventory' ? isInventory : !isInventory;
    },

    esc(value) {
        return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    },

    async items() {
        const all = await OfflineAPI.getFailedSyncs();
        return all.filter(i => this.belongsTo(this.area, i));
    },

    // True on the Inventory page only (see mount)
    showWaiting: false,

    // Call once per page: 'inventory' or 'pos'
    mount(area) {
        this.area = area;
        // Changes still WAITING to be sent are shown on the Inventory page. (The POS page has
        // its own Pending Sales list for sales, so it does not show this one.)
        this.showWaiting = area === 'inventory';
        const again = () => this.refresh();
        window.addEventListener('pharmatrack:sync-complete', again);
        window.addEventListener('pharmatrack:queue-changed', again);
        window.addEventListener('online', again);
        window.addEventListener('offline', again);
        return this.refresh();
    },

    async refresh() {
        const items = await this.items();
        this.renderPill(items.length);
        if (document.getElementById('failed-sync-modal')?.classList.contains('active')) {
            await this.renderBody(items);
        }
        if (this.showWaiting) {
            const waiting = await this.queuedItems();
            this.renderWaitingPill(waiting.length);
            if (document.getElementById('waiting-sync-modal')?.classList.contains('active')) {
                await this.renderWaitingBody(waiting);
            }
        }
    },

    // -- Changes waiting to be sent (not refused -- just not delivered yet) --
    // A change made while offline (or while the server was restarting) is kept on this
    // computer and sent automatically later. Until it goes through it exists ONLY here,
    // so a small note says so, and disappears by itself once everything has been sent.
    async queuedItems() {
        const all = await offlineSync.getAll('sync_queue');
        return all
            .filter(i => this.belongsTo(this.area, i))
            .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    },

    renderWaitingPill(count) {
        let pill = document.getElementById('waiting-sync-banner');
        if (count > 0) {
            if (!pill) {
                pill = document.createElement('button');
                pill.id        = 'waiting-sync-banner';
                pill.className = 'waiting-sync-banner';
                pill.type      = 'button';
                pill.addEventListener('click', () => this.openWaitingModal());
                document.body.appendChild(pill);
            }
            pill.textContent = `${count} change${count === 1 ? '' : 's'} waiting to sync \u2013 Tap to view`;
        } else if (pill) {
            pill.remove();
        }
        // lets the red "not saved" pill sit above this one when both are showing
        document.body.classList.toggle('has-waiting-sync', count > 0);
    },

    ensureWaitingModal() {
        if (document.getElementById('waiting-sync-modal')) return;
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'waiting-sync-modal';
        overlay.innerHTML = `
            <div class="modal" style="max-width:520px">
                <div class="modal-header">
                    <h3>Changes Waiting to Sync</h3>
                    <button class="btn-close" id="btn-close-waiting-sync">X</button>
                </div>
                <div class="modal-body" id="waiting-sync-body" style="max-height:62vh;overflow-y:auto"></div>
                <div class="modal-footer">
                    <button class="btn btn-light" id="btn-close-waiting-sync-2">Close</button>
                    <button class="btn btn-primary" id="btn-sync-waiting">Sync Now</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);

        document.getElementById('btn-close-waiting-sync')?.addEventListener('click', () => Modal.close('waiting-sync-modal'));
        document.getElementById('btn-close-waiting-sync-2')?.addEventListener('click', () => Modal.close('waiting-sync-modal'));
        document.getElementById('btn-sync-waiting')?.addEventListener('click', async () => {
            if (!offlineSync.isOnline) {
                Toast.show('There is no connection right now. These will be sent automatically when it returns.', 'warning');
                return;
            }
            const btn = document.getElementById('btn-sync-waiting');
            btn.disabled = true;
            btn.textContent = 'Syncing...';
            const outcome = await offlineSync.processSyncQueue();
            if (outcome?.skipped === 'busy') Toast.show('A sync is already running. Please wait a moment.', 'warning');
            btn.textContent = 'Sync Now';
            await this.refresh();
        });
    },

    async renderWaitingBody(items) {
        const body = document.getElementById('waiting-sync-body');
        if (!body) return;
        const online = offlineSync.isOnline;

        const syncBtn = document.getElementById('btn-sync-waiting');
        if (syncBtn && syncBtn.textContent !== 'Syncing...') syncBtn.disabled = !online || !items.length;

        if (!items.length) {
            body.innerHTML = `<p class="text-muted" style="text-align:center;padding:20px">Nothing is waiting. Every change has reached the server.</p>`;
            return;
        }

        const cards = [];
        for (const item of items) {
            const d = await this.describe(item);
            const since = Fmt.datetime(new Date(item.timestamp).toISOString());
            const tried = item.retries
                ? `Tried ${item.retries} time${item.retries === 1 ? '' : 's'} so far${item.lastError ? `: ${item.lastError}` : '.'}`
                : null;
            cards.push(`
                <div class="failed-sync-item sync-issue waiting-sync-item">
                    <div class="sync-issue-top">
                        <span class="sync-issue-what">${this.esc(d.what)}</span>
                        <span class="sync-issue-when">Waiting since ${this.esc(since)}</span>
                    </div>
                    <div class="sync-issue-subject">${this.esc(d.subject)}</div>
                    ${d.detail ? `<div class="sync-issue-detail">${this.esc(d.detail)}</div>` : ''}
                    ${tried ? `<div class="sync-issue-block sync-issue-wait"><b>Last attempt</b><span>${this.esc(tried)}</span></div>` : ''}
                </div>`);
        }

        body.innerHTML = `
            <p class="sync-issue-intro">
                These changes are saved <b>on this computer only</b> \u2013 they have <b>not reached the server yet</b>,
                so other computers will not see them. ${online
                    ? 'The connection is working, so they are being sent now. If they do not disappear, tap <b>Sync Now</b>.'
                    : 'There is no connection right now. They will be sent <b>automatically</b> when it returns.'}
            </p>${cards.join('')}`;
    },

    async openWaitingModal() {
        this.ensureWaitingModal();
        await this.renderWaitingBody(await this.queuedItems());
        Modal.open('waiting-sync-modal');
    },

    renderPill(count) {
        let pill = document.getElementById('failed-sync-banner');
        if (count > 0) {
            if (!pill) {
                pill = document.createElement('button');
                pill.id        = 'failed-sync-banner';
                pill.className = 'failed-sync-banner';
                pill.type      = 'button';
                pill.addEventListener('click', () => this.openModal());
                document.body.appendChild(pill);
            }
            pill.textContent = `${count} change${count === 1 ? '' : 's'} not saved \u2013 Tap to view`;
        } else if (pill) {
            pill.remove();
        }
    },

    // What was being done, in words (and to which product, where that is known)
    async describe(item) {
        const ep     = String(item.endpoint || '');
        const method = String(item.method || '').toUpperCase();
        const body   = item.body || {};
        const nameOf = async (id) => {
            try {
                const p = await offlineSync.get('products', parseInt(id, 10));
                return p?.name || null;
            } catch (e) { return null; }
        };
        const stock = (b) => (b.stock_quantity !== undefined && b.stock_quantity !== null) ? `${b.stock_quantity} units` : null;
        let m;

        if (method === 'POST' && ep === '/inventory') {
            return { what: 'Add product', subject: body.name || 'a new product', detail: stock(body) };
        }
        if (method === 'POST' && (m = ep.match(/^\/inventory\/(\d+)\/items$/))) {
            return {
                what: 'Add Item No.',
                subject: (await nameOf(m[1])) || 'a product',
                detail: [stock(body), body.expiry_date ? `expires ${body.expiry_date}` : null].filter(Boolean).join(', ') || null
            };
        }
        if (method === 'PUT' && (m = ep.match(/^\/inventory\/items\/(\d+)$/))) {
            return {
                what: 'Edit Item No.',
                subject: (await nameOf(m[1])) || 'an Item No.',
                detail: [stock(body), body.expiry_date ? `expires ${body.expiry_date}` : null].filter(Boolean).join(', ') || null
            };
        }
        if (method === 'DELETE' && (m = ep.match(/^\/inventory\/items\/(\d+)$/))) {
            return { what: 'Delete Item No.', subject: (await nameOf(m[1])) || 'an Item No.', detail: null };
        }
        if (method === 'PUT' && (m = ep.match(/^\/inventory\/(\d+)$/))) {
            return { what: 'Edit product', subject: body.name || (await nameOf(m[1])) || 'a product', detail: null };
        }
        if (method === 'DELETE' && (m = ep.match(/^\/inventory\/(\d+)$/))) {
            return { what: 'Remove product', subject: (await nameOf(m[1])) || 'a product', detail: null };
        }
        return { what: 'Change', subject: `${method} ${ep}`.trim(), detail: null };
    },

    // Why it was not saved, and what to do about it -- in plain words
    explain(item, d) {
        const reason = String(item.reason || '');

        if (/already exists/i.test(reason)) {
            return {
                why: `A product named "${d.subject}" is already in Inventory, so adding it again was refused.`,
                advice: `If it is in your Inventory list, nothing is lost: this was most likely an earlier attempt that was sent again. You can dismiss this. To add stock to that product, open it and use "Add Item No."`
            };
        }
        if (/barcode/i.test(reason) && /already used/i.test(reason)) {
            return {
                why: reason,
                advice: 'Open the product, give it a barcode no other product uses, and save it again. Dismiss this once that is done.'
            };
        }
        if (/categor/i.test(reason)) {
            return {
                why: reason,
                advice: 'Open the product, choose a valid category, and save it again. Dismiss this once that is done.'
            };
        }
        if (/Could not reach the server after 3 attempts/i.test(reason)) {
            return {
                why: 'The server could not be reached, even after trying three times.',
                advice: 'Check the internet connection, then make this change again. It was not saved. Dismiss this once you have.'
            };
        }
        if (/Server kept returning errors/i.test(reason)) {
            return {
                why: 'The server had a problem every time this was tried.',
                advice: 'Make the change again. If it keeps failing, tell whoever looks after the system.'
            };
        }
        if (/Server rejected this/i.test(reason)) {
            return {
                why: 'The server did not accept this change.',
                advice: 'Check the details, then make the change again if it is still needed. Dismiss this once you have.'
            };
        }
        return {
            why: reason || 'The server did not accept this change.',
            advice: 'Check the details, then make the change again if it is still needed. Dismiss this once you have dealt with it.'
        };
    },

    ensureModal() {
        if (document.getElementById('failed-sync-modal')) return;
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'failed-sync-modal';
        overlay.innerHTML = `
            <div class="modal" style="max-width:520px">
                <div class="modal-header">
                    <h3>Changes That Were Not Saved</h3>
                    <button class="btn-close" id="btn-close-failed-sync">X</button>
                </div>
                <div class="modal-body" id="failed-sync-body" style="max-height:62vh;overflow-y:auto"></div>
                <div class="modal-footer">
                    <button class="btn btn-light" id="btn-dismiss-all-failed">Dismiss All</button>
                    <button class="btn btn-primary" id="btn-close-failed-sync-2">Close</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);

        document.getElementById('btn-close-failed-sync')?.addEventListener('click', () => Modal.close('failed-sync-modal'));
        document.getElementById('btn-close-failed-sync-2')?.addEventListener('click', () => Modal.close('failed-sync-modal'));
        document.getElementById('btn-dismiss-all-failed')?.addEventListener('click', async () => {
            const confirmed = await TypedConfirm.show({
                title:       'Dismiss All',
                message:     'Clear this list? None of these changes was saved, and dismissing removes them for good. Only do this after you have checked each one.',
                confirmText: 'Dismiss All'
            });
            if (!confirmed) return;
            // only THIS page's items -- another page's issues are not touched
            for (const item of await this.items()) await OfflineAPI.clearFailedSync(item.id);
            Modal.close('failed-sync-modal');
            this.refresh();
        });
    },

    async renderBody(items) {
        const body = document.getElementById('failed-sync-body');
        if (!body) return;

        if (!items.length) {
            body.innerHTML = `<p class="text-muted" style="text-align:center;padding:20px">Nothing here. Every change has been saved.</p>`;
            return;
        }

        const cards = [];
        for (const item of items) {
            const d = await this.describe(item);
            const e = this.explain(item, d);
            const when = Fmt.datetime(new Date(item.timestamp).toISOString());
            cards.push(`
                <div class="failed-sync-item sync-issue">
                    <div class="sync-issue-top">
                        <span class="sync-issue-what">${this.esc(d.what)}</span>
                        <span class="sync-issue-when">${this.esc(when)}</span>
                    </div>
                    <div class="sync-issue-subject">${this.esc(d.subject)}</div>
                    ${d.detail ? `<div class="sync-issue-detail">${this.esc(d.detail)}</div>` : ''}
                    <div class="sync-issue-block sync-issue-why"><b>Why it was not saved</b><span>${this.esc(e.why)}</span></div>
                    <div class="sync-issue-block sync-issue-todo"><b>What to do</b><span>${this.esc(e.advice)}</span></div>
                    <button class="btn btn-light btn-sm btn-dismiss-failed" data-id="${item.id}">Dismiss</button>
                </div>`);
        }

        body.innerHTML = `
            <p class="sync-issue-intro">
                These changes were kept on this computer to be sent to the server, but the server
                <b>did not accept</b> them, so <b>they were not saved</b>. Nothing else is affected.
                Each one below says what it was, why it failed and what to do.
            </p>${cards.join('')}`;

        body.querySelectorAll('.btn-dismiss-failed').forEach(btn => {
            btn.addEventListener('click', async () => {
                // Dismissing throws the unsaved change away for good, so it gets the same
                // two-step typed confirmation as every delete.
                const confirmed = await TypedConfirm.show({
                    title:       'Dismiss This Item',
                    message:     'This change was never saved on the server. Dismissing removes it from this list for good.',
                    confirmText: 'Dismiss'
                });
                if (!confirmed) return;
                await OfflineAPI.clearFailedSync(parseInt(btn.dataset.id, 10));
                await this.openModal();
                this.refresh();
            });
        });
    },

    async openModal() {
        this.ensureModal();
        await this.renderBody(await this.items());
        Modal.open('failed-sync-modal');
    }
};
window.SyncIssues = SyncIssues;
