import type { DefaultGenerics, ExtendableGenerics, UserResponse } from './types';

const DB_NAME_PREFIX = 'ermis_user_cache';
const DB_VERSION = 1;
const STORE_USERS = 'users';

const safeDbPart = (value: string) => value.replace(/[^a-zA-Z0-9._-]/g, '_') || 'default';

type StoredUser<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> = UserResponse<ErmisChatGenerics> & {
  cached_at?: number;
};

export class IndexedDBUserCache<ErmisChatGenerics extends ExtendableGenerics = DefaultGenerics> {
  private dbPromise: Promise<IDBDatabase | null> | null = null;
  private readonly dbName: string;

  constructor(projectId: string, ownerUserId: string) {
    this.dbName = `${DB_NAME_PREFIX}_${safeDbPart(projectId)}_${safeDbPart(ownerUserId)}`;
  }

  private openDB(): Promise<IDBDatabase | null> {
    if (typeof indexedDB === 'undefined') return Promise.resolve(null);
    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = new Promise<IDBDatabase | null>((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = indexedDB.open(this.dbName, DB_VERSION);
      } catch (err) {
        this.dbPromise = null;
        reject(err);
        return;
      }

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_USERS)) {
          const store = db.createObjectStore(STORE_USERS, { keyPath: 'id' });
          store.createIndex('cached_at', 'cached_at', { unique: false });
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

  async close(): Promise<void> {
    if (this.dbPromise) {
      try {
        const db = await this.dbPromise;
        if (db) db.close();
      } catch (err) {
        // Ignore errors
      } finally {
        this.dbPromise = null;
      }
    }
  }

  async saveUsers(users: Array<UserResponse<ErmisChatGenerics>>): Promise<void> {
    const validUsers = users.filter((user) => user?.id);
    if (validUsers.length === 0) return;

    const db = await this.openDB();
    if (!db) return;

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_USERS, 'readwrite');
      const store = tx.objectStore(STORE_USERS);
      const cachedAt = Date.now();

      for (const user of validUsers) {
        store.put({ ...user, cached_at: cachedAt });
      }

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async saveUser(user: UserResponse<ErmisChatGenerics>): Promise<void> {
    await this.saveUsers([user]);
  }

  async loadUsers(): Promise<Array<UserResponse<ErmisChatGenerics>>> {
    const db = await this.openDB();
    if (!db) return [];

    return new Promise<Array<UserResponse<ErmisChatGenerics>>>((resolve, reject) => {
      const tx = db.transaction(STORE_USERS, 'readonly');
      const request = tx.objectStore(STORE_USERS).getAll();

      request.onsuccess = () => {
        const users = (request.result || []).map((record: StoredUser<ErmisChatGenerics>) => {
          const { cached_at: _cachedAt, ...user } = record;
          return user as UserResponse<ErmisChatGenerics>;
        });
        resolve(users);
      };
      request.onerror = () => reject(request.error);
      tx.onerror = () => reject(tx.error);
    });
  }
}
