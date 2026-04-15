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

                // Products cache
                if (!db.objectStoreNames.contains('products')) {
                    db.createObjectStore('products', { keyPath: 'id' });
                }

                // Sync queue for failed operations
                if (!db.objectStoreNames.contains('sync_queue')) {
                    const queueStore = db.createObjectStore('sync_queue', { keyPath: 'id', autoIncrement: true });
                    queueStore.createIndex('endpoint', 'endpoint', { unique: false });
                    queueStore.createIndex('timestamp', 'timestamp', { unique: false });
                }

                // Orders cache
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
            banner.textContent = '⚠️ You are offline. Changes will sync when connection returns.';
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

        for (const item of queue) {
            try {
                const response = await fetch(item.endpoint, {
                    method: item.method,
                    headers: { 'Content-Type': 'application/json', ...item.headers },
                    body: JSON.stringify(item.body)
                });

                if (response.ok) {
                    // Remove from queue
                    await this.deleteFromQueue(item.id);
                } else {
                    // Increment retry count
                    item.retries++;
                    if (item.retries < 3) {
                        await this.put('sync_queue', item);
                    } else {
                        await this.deleteFromQueue(item.id);
                        console.warn('Sync item failed after 3 retries:', item);
                    }
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

        if (queue.length > 0) {
            Toast.show('✅ Data synced successfully!', 'success');
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

// Global instance
const offlineSync = new OfflineSync();

// Enhanced API wrapper
const OfflineAPI = {
    async get(endpoint) {
        if (offlineSync.isOnline) {
            try {
                // Add timeout: abort after 10 seconds
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 10000);

                const response = await fetch(`${CONFIG.API_BASE}${endpoint}`, {
                    headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` },
                    signal: controller.signal
                });
                clearTimeout(timeoutId);

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }

                const data = await response.json();

                // Cache successful responses
                if (response.ok && (endpoint.includes('/inventory') || endpoint.includes('/pos/products'))) {
                    if (endpoint.includes('/inventory')) {
                        for (const product of (data.data || [])) {
                            await offlineSync.put('products', product);
                        }
                    } else if (endpoint.includes('/pos/products')) {
                        // Cache all products from POS search
                        for (const product of (data.data || [])) {
                            await offlineSync.put('products', product);
                        }
                    }
                }

                return data;
            } catch (error) {
                console.warn('Network error, falling back to cache:', error.message);
                Toast.show('Network error. Using cached data if available.', 'warning');
            }
        }

        // Fallback to cache
        if (endpoint.includes('/inventory') || endpoint.includes('/pos/products')) {
            const cached = await offlineSync.getAll('products');
            // Apply client-side filtering since cache has all data
            const url = new URL(endpoint, window.location.origin);
            const search = url.searchParams.get('search') || '';
            const barcode = url.searchParams.get('barcode') || '';
            const category = url.searchParams.get('category') || '';
            const status = url.searchParams.get('status') || '';

            let filtered = cached.filter(p => p.is_active !== 0); // Exclude soft-deleted

            if (search) {
                const lowerSearch = search.toLowerCase();
                filtered = filtered.filter(p =>
                    p.name?.toLowerCase().includes(lowerSearch) ||
                    p.generic_name?.toLowerCase().includes(lowerSearch) ||
                    p.batch_number?.toLowerCase().includes(lowerSearch) ||
                    p.barcode?.includes(search)
                );
            }

            if (barcode) {
                filtered = filtered.filter(p => p.barcode === barcode);
            }

            if (category) {
                filtered = filtered.filter(p => p.category === category);
            }

            if (status) {
                filtered = filtered.filter(p => p.stock_status === status);
            }

            return { success: true, data: filtered, total: filtered.length, cached: true };
        }

        throw new Error('Offline and no cache available');
    },

    async post(endpoint, body) {
        if (offlineSync.isOnline) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 10000);

                const response = await fetch(`${CONFIG.API_BASE}${endpoint}`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${localStorage.getItem('token')}`
                    },
                    body: JSON.stringify(body),
                    signal: controller.signal
                });
                clearTimeout(timeoutId);

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }

                const data = await response.json();

                if (response.ok) {
                    // Cache new products
                    if (endpoint.includes('/inventory') && data.id) {
                        await offlineSync.put('products', { ...body, id: data.id });
                    }
                }

                return data;
            } catch (error) {
                console.warn('Network error, queuing for later:', error.message);
                Toast.show('Network error. Request queued for sync.', 'warning');
            }
        }

        // Queue for later sync
        await offlineSync.addToSyncQueue({
            endpoint,
            method: 'POST',
            headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` },
            body
        });

        // Optimistic update for inventory
        if (endpoint.includes('/inventory')) {
            const tempId = 'temp_' + Date.now();
            await offlineSync.put('products', { ...body, id: tempId, temp: true });
        }

        return { success: true, message: 'Queued for sync', queued: true };
    },

    async put(endpoint, body) {
        if (offlineSync.isOnline) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 10000);

                const response = await fetch(`${CONFIG.API_BASE}${endpoint}`, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${localStorage.getItem('token')}`
                    },
                    body: JSON.stringify(body),
                    signal: controller.signal
                });
                clearTimeout(timeoutId);

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }

                const data = await response.json();

                if (response.ok && endpoint.includes('/inventory/')) {
                    const id = endpoint.split('/').pop();
                    await offlineSync.put('products', { ...body, id: parseInt(id) });
                }

                return data;
            } catch (error) {
                console.warn('Network error, queuing for later:', error.message);
                Toast.show('Network error. Request queued for sync.', 'warning');
            }
        }

        // Queue for later sync
        await offlineSync.addToSyncQueue({
            endpoint,
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` },
            body
        });

        // Optimistic update
        if (endpoint.includes('/inventory/')) {
            const id = endpoint.split('/').pop();
            await offlineSync.put('products', { ...body, id: parseInt(id) });
        }

        return { success: true, message: 'Queued for sync', queued: true };
    },

    async delete(endpoint) {
        if (offlineSync.isOnline) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 10000);

                const response = await fetch(`${CONFIG.API_BASE}${endpoint}`, {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` },
                    signal: controller.signal
                });
                clearTimeout(timeoutId);

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }

                const data = await response.json();

                if (response.ok && endpoint.includes('/inventory/')) {
                    // Mark as deleted in cache (soft delete)
                    const id = endpoint.split('/').pop();
                    const cached = await offlineSync.get('products', parseInt(id));
                    if (cached) {
                        cached.is_active = 0;
                        await offlineSync.put('products', cached);
                    }
                }

                return data;
            } catch (error) {
                console.warn('Network error, queuing for later:', error.message);
                Toast.show('Network error. Request queued for sync.', 'warning');
            }
        }

        // Queue for later sync
        await offlineSync.addToSyncQueue({
            endpoint,
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
        });

        // Optimistic update
        if (endpoint.includes('/inventory/')) {
            const id = endpoint.split('/').pop();
            const cached = await offlineSync.get('products', parseInt(id));
            if (cached) {
                cached.is_active = 0;
                await offlineSync.put('products', cached);
            }
        }

        return { success: true, message: 'Queued for sync', queued: true };
    }
};

// Make globally available
window.OfflineAPI = OfflineAPI;
window.offlineSync = offlineSync;