/**
 * MLS Storage — Persistence layer for MLS (E2EE) state
 *
 * Defines the `MlsStorageAdapter` interface for platform abstraction
 * and provides `IndexedDBMlsStorage` as the default browser implementation.
 *
 * Stores:
 * - Device ID (per browser)
 * - Identity bytes (per user+device)
 * - E2EE messages (per channel)
 * - Group CID markers
 * - Provider key store
 * - Sync timestamps
 */

import { randomId } from './utils';
import MiniSearch from 'minisearch';

// ============================================================
// Storage Adapter Interface
// ============================================================

export interface E2eeStoredMessage {
  // Core identity
  id: string;
  cid: string;
  /** 'mls' for encrypted E2EE messages, 'standard' for plaintext (system messages, etc.) */
  content_type: 'mls' | 'standard';
  /** Message type: 'regular' | 'reply' | 'system' etc. */
  type: string;
  created_at: string;
  updated_at?: string;
  // Sender
  user_id: string;
  user?: { id: string; name?: string; image?: string; [key: string]: unknown };

  // Decrypted content (MessageContent::Standard)
  text: string;
  attachments?: unknown[];
  sticker_url?: string;
  poll_type?: string;
  poll_choice_counts?: Record<string, number>;
  latest_poll_choices?: unknown[];
  is_edited?: boolean;
  old_texts?: Array<{ text: string; created_at: string }>;

  // Thread / reply routing
  parent_id?: string;
  quoted_message_id?: string;
  quoted_message?: unknown;

  // Notification metadata
  mentioned_users?: string[];
  mentioned_all?: boolean;

  // State
  pinned?: boolean;
  pinned_at?: string;
  reaction_counts?: Record<string, number>;
  latest_reactions?: unknown[];

  // Catch-all for future fields
  [key: string]: unknown;
}

/**
 * Platform-agnostic storage adapter for MLS state.
 *
 * Implement this interface to provide custom storage (e.g., SQLite for React Native).
 * The default `IndexedDBMlsStorage` uses browser IndexedDB.
 *
 * NOTE: `getDeviceId()` is a GLOBAL (per-browser) operation and does NOT
 * require a userId — it identifies the physical device, not the user.
 */
export interface MlsStorageAdapter {
  // ---- Device ID (global, per-browser) ----
  getDeviceId(): Promise<string>;

  // ---- Identity ----
  saveIdentity(userId: string, deviceId: string, identityBytes: Uint8Array): Promise<void>;
  loadIdentity(userId: string, deviceId: string): Promise<Uint8Array | null>;

  // ---- E2EE Messages ----
  saveE2eeMessage(message: E2eeStoredMessage): Promise<void>;
  loadE2eeMessage(messageId: string): Promise<E2eeStoredMessage | null>;
  loadE2eeMessages?(messageIds: string[]): Promise<Map<string, E2eeStoredMessage>>;
  deleteE2eeMessage(messageId: string): Promise<void>;
  getE2eeMessages(cid: string, limit?: number): Promise<E2eeStoredMessage[]>;
  clearE2eeMessages(cid: string): Promise<void>;

  // ---- E2EE Message Search ----
  /** Search all E2EE messages across all channels by text content. */
  searchE2eeMessages(searchTerm: string, limit?: number): Promise<E2eeStoredMessage[]>;
  /** Search E2EE messages within a specific channel by text content. */
  searchE2eeMessagesByCid(cid: string, searchTerm: string, limit?: number): Promise<E2eeStoredMessage[]>;

  // ---- Group State ----
  saveGroupState(cid: string, marker: unknown): Promise<void>;
  loadGroupState(cid: string): Promise<unknown | null>;
  listGroupCids(): Promise<string[]>;
  deleteGroup(cid: string): Promise<void>;

  // ---- Provider State ----
  saveProviderState(userId: string, deviceId: string, providerBytes: Uint8Array): Promise<void>;
  loadProviderState(userId: string, deviceId: string): Promise<Uint8Array | null>;

  // ---- Sync Timestamps ----
  saveSyncTimestamp(cid: string, timestamp: string): Promise<void>;
  loadSyncTimestamp(cid: string): Promise<string | null>;

  // ---- Batch Sync Cursors (for unified sync API) ----
  loadAllSyncTimestamps(): Promise<Record<string, string>>;
  saveAllSyncTimestamps(cursors: Record<string, string>): Promise<void>;

  // ---- Pending Evictions (offline recovery persistence) ----
  // Map: cid → array of user_ids to evict
  loadPendingEvictions(): Promise<Record<string, string[]>>;
  savePendingEvictions(data: Record<string, string[]>): Promise<void>;
}

// ============================================================
// IndexedDB Implementation (Browser Default)
// ============================================================

const DB_NAME_PREFIX = 'ermis_mls';
/** Global DB (no userId) — only used for migrating legacy device_id */
const DB_NAME_LEGACY = 'ermis_mls';
const DB_VERSION = 2;

const STORE_IDENTITY = 'identity';
const STORE_MESSAGES = 'messages';
const STORE_META = 'meta';
const STORE_GROUPS = 'groups';

/** localStorage key for device_id — global, per-browser */
const DEVICE_ID_LS_KEY = 'ermis_device_id';

/**
 * Default MLS storage adapter using browser IndexedDB.
 *
 * Each user gets their own IndexedDB database (`ermis_mls_{userId}`) to
 * prevent cross-user state contamination during login/logout cycles.
 * `device_id` is stored in `localStorage` (global, per-browser).
 *
 * @example
 * ```ts
 * const storage = new IndexedDBMlsStorage('user123');
 * const deviceId = await storage.getDeviceId();
 * ```
 */
export class IndexedDBMlsStorage implements MlsStorageAdapter {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private readonly dbName: string;

  /**
   * @param userId - The current user's ID. Used to scope the IndexedDB
   *                 database name so each user's MLS state is isolated.
   *                 Pass empty string for legacy/global access (migration only).
   */
  constructor(userId: string = '') {
    if (userId) {
      this.dbName = `${DB_NAME_PREFIX}_${userId}`;
    } else {
      // Legacy fallback — global DB (used during device_id migration)
      this.dbName = DB_NAME_LEGACY;
    }
  }

  /**
   * Open (or create) the IndexedDB database.
   * Caches the connection promise for reuse.
   */
  private openDB(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.dbName, DB_VERSION);

      request.onupgradeneeded = (event: IDBVersionChangeEvent) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Identity store: key = "userId:deviceId"
        if (!db.objectStoreNames.contains(STORE_IDENTITY)) {
          db.createObjectStore(STORE_IDENTITY);
        }

        // Messages store: key = message id, indexes by cid
        if (!db.objectStoreNames.contains(STORE_MESSAGES)) {
          const msgStore = db.createObjectStore(STORE_MESSAGES, {
            keyPath: 'id',
          });
          msgStore.createIndex('cid', 'cid', { unique: false });
          msgStore.createIndex('cid_created', ['cid', 'created_at'], { unique: false });
        }

        // Meta store: key-value for device_id, provider state, sync timestamps
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META);
        }

        // Groups store: key = cid → marker
        if (!db.objectStoreNames.contains(STORE_GROUPS)) {
          db.createObjectStore(STORE_GROUPS);
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        this.dbPromise = null;
        reject(request.error);
      };
    });

    return this.dbPromise;
  }

  // ---- Device ID (global, per-browser via localStorage) ----

  async getDeviceId(): Promise<string> {
    // 1. Check localStorage first
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem(DEVICE_ID_LS_KEY);
      if (stored) return stored;
    }

    // 2. Backward compat: migrate from legacy global IndexedDB
    try {
      const legacyId = await this._migrateLegacyDeviceId();
      if (legacyId) return legacyId;
    } catch (_) {
      // IndexedDB unavailable — generate new
    }

    // 3. Generate new device ID
    const deviceId = `web-${randomId()}`;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(DEVICE_ID_LS_KEY, deviceId);
    }
    return deviceId;
  }

  /**
   * Migrate device_id from legacy global IndexedDB (`ermis_mls`) to localStorage.
   * Returns the migrated ID or null if not found.
   */
  private async _migrateLegacyDeviceId(): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      const request = indexedDB.open(DB_NAME_LEGACY, DB_VERSION);

      request.onupgradeneeded = (event: IDBVersionChangeEvent) => {
        // Legacy DB doesn't exist yet — nothing to migrate
        const db = (event.target as IDBOpenDBRequest).result;
        // Create stores to avoid errors, but we won't find device_id
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META);
        }
        if (!db.objectStoreNames.contains(STORE_IDENTITY)) {
          db.createObjectStore(STORE_IDENTITY);
        }
        if (!db.objectStoreNames.contains(STORE_MESSAGES)) {
          const msgStore = db.createObjectStore(STORE_MESSAGES, { keyPath: 'id' });
          msgStore.createIndex('cid', 'cid', { unique: false });
          msgStore.createIndex('cid_created', ['cid', 'created_at'], { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_GROUPS)) {
          db.createObjectStore(STORE_GROUPS);
        }
      };

      request.onsuccess = () => {
        const db = request.result;
        try {
          if (!db.objectStoreNames.contains(STORE_META)) {
            db.close();
            resolve(null);
            return;
          }
          const tx = db.transaction(STORE_META, 'readonly');
          const store = tx.objectStore(STORE_META);
          const getReq = store.get('device_id');
          getReq.onsuccess = () => {
            const legacyId = getReq.result as string | undefined;
            db.close();
            if (legacyId && typeof localStorage !== 'undefined') {
              localStorage.setItem(DEVICE_ID_LS_KEY, legacyId);
              console.log('[MLS Storage] Migrated device_id from IndexedDB to localStorage:', legacyId);
              resolve(legacyId);
            } else {
              resolve(null);
            }
          };
          getReq.onerror = () => {
            db.close();
            resolve(null);
          };
        } catch (_) {
          db.close();
          resolve(null);
        }
      };

      request.onerror = () => resolve(null);
    });
  }

  // ---- Identity ----

  async saveIdentity(userId: string, deviceId: string, identityBytes: Uint8Array): Promise<void> {
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_IDENTITY, 'readwrite');
      const store = tx.objectStore(STORE_IDENTITY);
      store.put(identityBytes, `${userId}:${deviceId}`);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async loadIdentity(userId: string, deviceId: string): Promise<Uint8Array | null> {
    const db = await this.openDB();
    return new Promise<Uint8Array | null>((resolve, reject) => {
      const tx = db.transaction(STORE_IDENTITY, 'readonly');
      const store = tx.objectStore(STORE_IDENTITY);
      const request = store.get(`${userId}:${deviceId}`);
      request.onsuccess = () => resolve((request.result as Uint8Array) || null);
      request.onerror = () => reject(request.error);
    });
  }

  // ---- E2EE Messages ----

  async saveE2eeMessage(message: E2eeStoredMessage): Promise<void> {
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_MESSAGES, 'readwrite');
      const store = tx.objectStore(STORE_MESSAGES);
      store.put(message);
      tx.oncomplete = () => {
        // Incrementally update MiniSearch index
        this._indexMessage(message);
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  async loadE2eeMessage(messageId: string): Promise<E2eeStoredMessage | null> {
    const db = await this.openDB();
    return new Promise<E2eeStoredMessage | null>((resolve, reject) => {
      const tx = db.transaction(STORE_MESSAGES, 'readonly');
      const store = tx.objectStore(STORE_MESSAGES);
      const request = store.get(messageId);
      request.onsuccess = () => resolve((request.result as E2eeStoredMessage) || null);
      request.onerror = () => reject(request.error);
    });
  }

  async loadE2eeMessages(messageIds: string[]): Promise<Map<string, E2eeStoredMessage>> {
    const ids = Array.from(new Set(messageIds.filter(Boolean)));
    if (ids.length === 0) return new Map();

    const db = await this.openDB();
    return new Promise<Map<string, E2eeStoredMessage>>((resolve, reject) => {
      const tx = db.transaction(STORE_MESSAGES, 'readonly');
      const store = tx.objectStore(STORE_MESSAGES);
      const results = new Map<string, E2eeStoredMessage>();

      for (const id of ids) {
        const request = store.get(id);
        request.onsuccess = () => {
          if (request.result) {
            results.set(id, request.result as E2eeStoredMessage);
          }
        };
        request.onerror = () => reject(request.error);
      }

      tx.oncomplete = () => resolve(results);
      tx.onerror = () => reject(tx.error);
    });
  }

  async deleteE2eeMessage(messageId: string): Promise<void> {
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_MESSAGES, 'readwrite');
      const store = tx.objectStore(STORE_MESSAGES);
      store.delete(messageId);
      tx.oncomplete = () => {
        if (this._searchIndex && this._indexReady) {
          try {
            this._searchIndex.discard(messageId);
          } catch (_) {
            // Ignore missing records in index
          }
          this._indexedIds.delete(messageId);
        }
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  async getE2eeMessages(cid: string, limit = 50): Promise<E2eeStoredMessage[]> {
    const db = await this.openDB();
    return new Promise<E2eeStoredMessage[]>((resolve, reject) => {
      const tx = db.transaction(STORE_MESSAGES, 'readonly');
      const store = tx.objectStore(STORE_MESSAGES);
      const index = store.index('cid');
      const request = index.getAll(cid);
      request.onsuccess = () => {
        const msgs = (request.result as E2eeStoredMessage[]) || [];
        // Sort by created_at descending, take limit
        msgs.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
        resolve(msgs.slice(0, limit));
      };
      request.onerror = () => reject(request.error);
    });
  }

  async clearE2eeMessages(cid: string): Promise<void> {
    const db = await this.openDB();

    // Collect message IDs for this channel to purge from search index
    const msgIds: string[] = [];

    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_MESSAGES, 'readwrite');
      const store = tx.objectStore(STORE_MESSAGES);
      const index = store.index('cid');
      const request = index.openCursor(cid);
      request.onsuccess = (event: Event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
        if (cursor) {
          msgIds.push((cursor.value as E2eeStoredMessage).id);
          cursor.delete();
          cursor.continue();
        }
      };
      tx.oncomplete = () => {
        // Purge cleared messages from MiniSearch index
        if (this._searchIndex && this._indexReady) {
          for (const id of msgIds) {
            try {
              this._searchIndex.discard(id);
              this._indexedIds.delete(id);
            } catch (_) {
              /* already removed */
            }
          }
        }
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  // ---- E2EE Message Search (MiniSearch-powered) ----

  /** MiniSearch instance — lazily initialized on first search. */
  private _searchIndex: MiniSearch<E2eeStoredMessage> | null = null;
  /** Set of indexed message IDs — for dedup on incremental add. */
  private _indexedIds: Set<string> = new Set();
  /** Whether the full index has been built from IndexedDB. */
  private _indexReady = false;
  /** Promise for the build-in-progress (prevents double-build). */
  private _indexBuildPromise: Promise<void> | null = null;

  /**
   * Create a fresh MiniSearch instance with fields tuned for chat messages.
   */
  private _createSearchIndex(): MiniSearch<E2eeStoredMessage> {
    return new MiniSearch<E2eeStoredMessage>({
      fields: ['text'],
      storeFields: [
        'id',
        'cid',
        'text',
        'user_id',
        'user',
        'created_at',
        'type',
        'content_type',
        'parent_id',
        'quoted_message_id',
        'mentioned_users',
        'mentioned_all',
        'attachments',
        'sticker_url',
        'pinned',
        'reaction_counts',
        'latest_reactions',
        'poll_type',
        'poll_choice_counts',
        'latest_poll_choices',
        'quoted_message',
      ],
      idField: 'id',
      // Vietnamese-friendly: lowercase, strip diacritics for indexing
      processTerm: (term) => {
        if (!term) return null;
        return term
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/đ/g, 'd');
      },
      searchOptions: {
        // Also strip diacritics on search queries for consistent matching
        processTerm: (term) => {
          if (!term) return null;
          return term
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/đ/g, 'd');
        },
        prefix: true,
        fuzzy: 0.2,
        combineWith: 'AND',
      },
    });
  }

  /**
   * Build the search index from all messages in IndexedDB.
   * Called lazily on first search. Subsequent calls are no-ops.
   */
  private async _ensureIndex(): Promise<void> {
    if (this._indexReady) return;
    if (this._indexBuildPromise) return this._indexBuildPromise;

    this._indexBuildPromise = (async () => {
      const db = await this.openDB();
      const allMsgs = await new Promise<E2eeStoredMessage[]>((resolve, reject) => {
        const tx = db.transaction(STORE_MESSAGES, 'readonly');
        const store = tx.objectStore(STORE_MESSAGES);
        const request = store.getAll();
        request.onsuccess = () => resolve((request.result as E2eeStoredMessage[]) || []);
        request.onerror = () => reject(request.error);
      });

      this._searchIndex = this._createSearchIndex();
      this._indexedIds = new Set();

      // Filter messages with searchable text content
      const indexable = allMsgs.filter((msg) => msg.text && msg.text.length > 0);
      if (indexable.length > 0) {
        this._searchIndex.addAll(indexable);
        for (const msg of indexable) {
          this._indexedIds.add(msg.id);
        }
      }

      this._indexReady = true;
      this._indexBuildPromise = null;
      console.log(`[MLS Storage] Search index built: ${indexable.length} messages indexed`);
    })();

    return this._indexBuildPromise;
  }

  /**
   * Incrementally add/update a single message in the search index.
   * Called from saveE2eeMessage() after successful IndexedDB write.
   */
  private _indexMessage(message: E2eeStoredMessage): void {
    if (!this._searchIndex || !this._indexReady) return;
    if (!message.text || message.text.length === 0) return;

    try {
      if (this._indexedIds.has(message.id)) {
        // Update: remove old, add new
        this._searchIndex.discard(message.id);
      }
      this._searchIndex.add(message);
      this._indexedIds.add(message.id);
    } catch (err) {
      console.warn('[MLS Storage] Failed to index message:', message.id, err);
    }
  }

  async searchE2eeMessages(searchTerm: string, limit = 25): Promise<E2eeStoredMessage[]> {
    await this._ensureIndex();
    if (!this._searchIndex) return [];

    const results = this._searchIndex.search(searchTerm);

    // Sort by created_at descending (MiniSearch returns by relevance score)
    const sorted = results
      .sort((a, b) => new Date((b as any).created_at).getTime() - new Date((a as any).created_at).getTime())
      .slice(0, limit);

    return sorted as unknown as E2eeStoredMessage[];
  }

  async searchE2eeMessagesByCid(cid: string, searchTerm: string, limit = 25): Promise<E2eeStoredMessage[]> {
    await this._ensureIndex();
    if (!this._searchIndex) return [];

    const results = this._searchIndex.search(searchTerm, {
      filter: (result) => (result as any).cid === cid,
    });

    const sorted = results
      .sort((a, b) => new Date((b as any).created_at).getTime() - new Date((a as any).created_at).getTime())
      .slice(0, limit);

    return sorted as unknown as E2eeStoredMessage[];
  }

  // ---- Group State ----

  async saveGroupState(cid: string, marker: unknown): Promise<void> {
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_GROUPS, 'readwrite');
      const store = tx.objectStore(STORE_GROUPS);
      store.put(marker, cid);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async loadGroupState(cid: string): Promise<unknown | null> {
    const db = await this.openDB();
    return new Promise<unknown | null>((resolve, reject) => {
      const tx = db.transaction(STORE_GROUPS, 'readonly');
      const store = tx.objectStore(STORE_GROUPS);
      const request = store.get(cid);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  async listGroupCids(): Promise<string[]> {
    const db = await this.openDB();
    return new Promise<string[]>((resolve, reject) => {
      const tx = db.transaction(STORE_GROUPS, 'readonly');
      const store = tx.objectStore(STORE_GROUPS);
      const request = store.getAllKeys();
      request.onsuccess = () => resolve((request.result as string[]) || []);
      request.onerror = () => reject(request.error);
    });
  }

  async deleteGroup(cid: string): Promise<void> {
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_GROUPS, 'readwrite');
      const store = tx.objectStore(STORE_GROUPS);
      store.delete(cid);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ---- Provider State ----

  async saveProviderState(userId: string, deviceId: string, providerBytes: Uint8Array): Promise<void> {
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readwrite');
      const store = tx.objectStore(STORE_META);
      store.put(providerBytes, `provider:${userId}:${deviceId}`);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async loadProviderState(userId: string, deviceId: string): Promise<Uint8Array | null> {
    const db = await this.openDB();
    return new Promise<Uint8Array | null>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readonly');
      const store = tx.objectStore(STORE_META);
      const request = store.get(`provider:${userId}:${deviceId}`);
      request.onsuccess = () => resolve((request.result as Uint8Array) || null);
      request.onerror = () => reject(request.error);
    });
  }

  // ---- Sync Timestamps ----

  async saveSyncTimestamp(cid: string, timestamp: string): Promise<void> {
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readwrite');
      const store = tx.objectStore(STORE_META);
      store.put(timestamp, `sync:${cid}`);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async loadSyncTimestamp(cid: string): Promise<string | null> {
    const db = await this.openDB();
    return new Promise<string | null>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readonly');
      const store = tx.objectStore(STORE_META);
      const request = store.get(`sync:${cid}`);
      request.onsuccess = () => resolve((request.result as string) || null);
      request.onerror = () => reject(request.error);
    });
  }

  // ---- Batch Sync Cursors ----

  async loadAllSyncTimestamps(): Promise<Record<string, string>> {
    const db = await this.openDB();
    return new Promise<Record<string, string>>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readonly');
      const store = tx.objectStore(STORE_META);
      const cursors: Record<string, string> = {};
      const cursorReq = store.openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          const key = cursor.key as string;
          if (key.startsWith('sync:')) {
            const cid = key.slice(5); // Remove 'sync:' prefix
            cursors[cid] = cursor.value as string;
          }
          cursor.continue();
        } else {
          resolve(cursors);
        }
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });
  }

  async saveAllSyncTimestamps(timestamps: Record<string, string>): Promise<void> {
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readwrite');
      const store = tx.objectStore(STORE_META);
      for (const [cid, ts] of Object.entries(timestamps)) {
        store.put(ts, `sync:${cid}`);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ---- Pending Evictions ----

  async loadPendingEvictions(): Promise<Record<string, string[]>> {
    const db = await this.openDB();
    return new Promise<Record<string, string[]>>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readonly');
      const store = tx.objectStore(STORE_META);
      const request = store.get('pending_evictions');
      request.onsuccess = () => resolve((request.result as Record<string, string[]>) || {});
      request.onerror = () => reject(request.error);
    });
  }

  async savePendingEvictions(data: Record<string, string[]>): Promise<void> {
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readwrite');
      const store = tx.objectStore(STORE_META);
      if (Object.keys(data).length === 0) {
        store.delete('pending_evictions');
      } else {
        store.put(data, 'pending_evictions');
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}
