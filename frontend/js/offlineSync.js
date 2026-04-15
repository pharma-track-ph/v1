// ============================================================
// Offline Sync Module
// IndexedDB-based offline-first data sync for PharmaTrack
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
            const request = indexedDB.open('pharmatrack_offline', 1);

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
            banner = document.createElement('div');
            banner.id = 'offline-banner';
            banner.style.cssText = `
                position: fixed; top: 0; left: 0; right: 0; z-index: 1000;
                background: #f59e0b; color: white; text-align: center; padding: 8px;
                font-size: 14px; font-weight: 500;
            `;
            banner.textContent = 'Offline mode: changes will sync when connection returns.';
            document.body.appendChild(banner);
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
            request.onsuccess = () => resolve(request.result);
        });
    }

    async processSyncQueue() {
        if (!this.isOnline || !this.db) return;

        const queue = await this.getAll('sync_queue');
        if (!queue.length) return;

        let syncedCount = 0;

        for (const item of queue) {
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
                    await this.deleteFromQueue(item.id);
                    syncedCount++;
                    continue;
                }

                if (response.status === 401) {
                    await this.deleteFromQueue(item.id);
                    handleAuthFailure();
                    return;
                }

                if (response.status >= 400 && response.status < 500) {
                    await this.deleteFromQueue(item.id);
                    console.warn('Discarding sync item after client error:', item, response.status);
                    continue;
                }

                item.retries++;
                if (item.retries < 3) {
                    await this.put('sync_queue', item);
                } else {
                    await this.deleteFromQueue(item.id);
                    console.warn('Sync item failed after 3 retries:', item);
                }
            } catch (error) {
                console.warn('Sync failed:', error);
                item.retries++;
                if (item.retries < 3) {
                    await this.put('sync_queue', item);
                } else {
                    await this.deleteFromQueue(item.id);
                }
            }
        }

        if (syncedCount > 0) {
            Toast.show('Data synced successfully!', 'success');
        }
    }

    async deleteFromQueue(id) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['sync_queue'], 'readwrite');
            const store = transaction.objectStore('sync_queue');
            const request = store.delete(id);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });
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

function handleAuthFailure() {
    if (typeof Auth !== 'undefined' && typeof Auth.logout === 'function') {
        Auth.logout();
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
                    handleAuthFailure();
                    return null;
                }

                if (!response.ok) {
                    if (response.status < 500) {
                        return data || { success: false, message: `HTTP ${response.status}` };
                    }

                    throw new Error(data?.message || `HTTP ${response.status}`);
                }

                if (isInventoryListEndpoint(endpoint) || isPosProductsEndpoint(endpoint)) {
                    await this.cacheProducts(data?.data || []);
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

        throw new Error('Offline and no cache available');
    },

    async post(endpoint, body) {
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
                    handleAuthFailure();
                    return null;
                }

                if (!response.ok) {
                    return data || { success: false, message: `HTTP ${response.status}` };
                }

                if (endpoint === '/inventory' && data?.id) {
                    await offlineSync.put('products', normalizeCachedProduct({
                        ...body,
                        id: data.id,
                        is_active: 1
                    }));
                }

                return data;
            } catch (error) {
                console.warn('Network error, queuing for later:', error.message);
                Toast.show('Network error. Request queued for sync.', 'warning');
            } finally {
                clearTimeout(timeoutId);
            }
        }

        await offlineSync.addToSyncQueue({
            endpoint,
            method: 'POST',
            headers: buildAuthHeaders(),
            body
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

        return { success: true, message: 'Queued for sync', queued: true };
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
                    handleAuthFailure();
                    return null;
                }

                if (!response.ok) {
                    return data || { success: false, message: `HTTP ${response.status}` };
                }

                if (endpoint.includes('/inventory/')) {
                    const id = endpoint.split('/').pop();
                    await offlineSync.put('products', normalizeCachedProduct({
                        ...body,
                        id: parseInt(id, 10),
                        is_active: 1
                    }));
                }

                return data;
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
                    handleAuthFailure();
                    return null;
                }

                if (!response.ok) {
                    return data || { success: false, message: `HTTP ${response.status}` };
                }

                if (endpoint.includes('/inventory/')) {
                    const id = endpoint.split('/').pop();
                    const cached = await offlineSync.get('products', parseInt(id, 10));
                    if (cached) {
                        cached.is_active = 0;
                        await offlineSync.put('products', cached);
                    }
                }

                return data;
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
