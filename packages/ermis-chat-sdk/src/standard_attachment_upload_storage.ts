import type { Attachment, Logger, Message } from './types';
import type { CompletedPresignedPart, StandardPresignedUploadResponse } from './presigned_upload';

export type StandardUploadSession = {
  presign: StandardPresignedUploadResponse;
  expires_at: number;
  completed_parts: CompletedPresignedPart[];
};

export type StandardAttachmentFileState = {
  progress: number;
  session?: StandardUploadSession;
  attachment?: Attachment;
};

export type PendingStandardAttachmentUploadRecord = {
  version: 1;
  message_id: string;
  cid: string;
  channel_type: string;
  channel_id: string;
  created_at: string;
  message: Message;
  files: File[];
  display_overrides?: Array<[number, Record<string, unknown>]>;
  file_states: StandardAttachmentFileState[];
};

/**
 * Key prefix used inside the shared `meta` store of `ermis_data_{userId}`.
 * Format: `std_upload:{message_id}`
 *
 * Using the existing meta store avoids a DB version bump and keeps all
 * per-user state consolidated in one IndexedDB database.
 */
const META_KEY_PREFIX = 'std_upload:';
const STORE_META = 'meta';

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

/**
 * Persists pending standard attachment upload records into the shared
 * `ermis_data_{userId}` IndexedDB database, using the existing `meta`
 * key-value store with the key prefix `std_upload:{message_id}`.
 *
 * This avoids creating a separate database or bumping the DB schema version.
 * The `dbProvider` callback is supplied by `IndexedDBEncryptionStorage.getDB()`.
 */
export class StandardAttachmentUploadStorage {
  constructor(
    private readonly dbProvider: () => Promise<IDBDatabase>,
    private readonly logger?: Logger,
  ) {}

  private open(): Promise<IDBDatabase> {
    return this.dbProvider();
  }

  async save(record: PendingStandardAttachmentUploadRecord): Promise<void> {
    try {
      const db = await this.open();
      const tx = db.transaction(STORE_META, 'readwrite');
      await idbRequest(tx.objectStore(STORE_META).put(record, `${META_KEY_PREFIX}${record.message_id}`));
    } catch (error) {
      this.logger?.('warn', 'StandardAttachmentUploadStorage: failed to save record', {
        messageId: record.message_id,
        err: error,
        tags: ['storage', 'attachment'],
      });
    }
  }

  async delete(messageId: string): Promise<void> {
    try {
      const db = await this.open();
      const tx = db.transaction(STORE_META, 'readwrite');
      await idbRequest(tx.objectStore(STORE_META).delete(`${META_KEY_PREFIX}${messageId}`));
    } catch (error) {
      this.logger?.('warn', 'StandardAttachmentUploadStorage: failed to delete record', {
        messageId,
        err: error,
        tags: ['storage', 'attachment'],
      });
    }
  }

  async list(): Promise<PendingStandardAttachmentUploadRecord[]> {
    try {
      const db = await this.open();
      const tx = db.transaction(STORE_META, 'readonly');
      const store = tx.objectStore(STORE_META);

      // Scan all keys with prefix 'std_upload:' using a key range
      // '\uffff' is the highest Unicode character — acts as an open upper bound
      const range = IDBKeyRange.bound(META_KEY_PREFIX, `${META_KEY_PREFIX}\uffff`);

      return await new Promise<PendingStandardAttachmentUploadRecord[]>((resolve, reject) => {
        const records: PendingStandardAttachmentUploadRecord[] = [];
        const request = store.openCursor(range);
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            resolve(records);
            return;
          }
          // Only include valid records (guard against stale/corrupt entries)
          if (cursor.value && cursor.value.version === 1 && cursor.value.message_id) {
            records.push(cursor.value as PendingStandardAttachmentUploadRecord);
          }
          cursor.continue();
        };
        request.onerror = () => reject(request.error || new Error('Failed to list standard uploads'));
      });
    } catch (error) {
      this.logger?.('warn', 'StandardAttachmentUploadStorage: failed to list records', {
        err: error,
        tags: ['storage', 'attachment'],
      });
      return [];
    }
  }
}
