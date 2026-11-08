import type {ChannelEvidenceBase,ChannelEvidenceWork} from "./channel_recovery";
import {channelEvidenceKey,validateChannelEvidence} from "./channel_recovery";
import {validateOwnershipCheckpoint, validateOwnershipLease, ownershipWorkError, ownershipWorkFailure} from './ownership_checkpoint';
import type {KeyPackageOwnershipWorkBase, KeyPackageOwnershipWorkOwner, KeyPackageOwnershipWorkChange, KeyPackageOwnershipLease} from './ownership_checkpoint';
import type {WelcomeHistoryContinuation, WelcomeHistoryPage, WelcomeHistoryWork, WelcomeHistoryWorkBase, WelcomeHistoryWorkSelection} from './welcome_history';
import {validCompletedWelcome, validWelcomeHistoryWork, nextWelcomeHistorySource, welcomeHistoryWorkPrefix, welcomeHistoryWorkKey, welcomeHistoryDueKey, welcomeHistoryPausedKey, welcomeHistorySourceKey} from './welcome_history';
import type {WelcomeWorkChange} from './welcome_work';
import {nextWelcomeWorkBase} from './welcome_work';
import type {ExternalJoinCandidatePage, ExternalJoinCandidatePageRow, ExternalCandidateDisposition} from './external_candidate_scan';
import {classifyExternalCandidate, sameExternalCandidateScanValue, externalCandidateScanComparable} from './external_candidate_scan';
import {sameSyncCheckpointValue} from './checkpoint_value';
import type {RecoveryWorkLane, RecoveryWorkOwner, RecoveryWorkDisposition, RecoveryWorkScanLane, RecoveryWorkScanRows, RecoveryWorkScanCheckpoint} from './recovery_work';
import type {GroupInfoWork, GroupInfoWorkOwner, GroupInfoWorkChange, GroupInfoWorkPage, GroupInfoWorkAdmission, GroupInfoWorkScope} from './group_info_work';
import {recoveryControlError} from './recovery_control';
import {groupInfoWorkKey, groupInfoWorkDueKey, groupInfoWorkCursorKey, validateGroupInfoWork, validateGroupInfoRequest, newGroupInfoWork} from './group_info_work';
import {discoveryWorkKey,discoveryDueKey,validateDiscoveryWork} from './discovery_work';
import type {RecoveryDiscoveryWork, RecoveryDiscoveryOwner, RecoveryDiscoveryChange} from './discovery_work';
import type {MlsGroupGenerationMarker} from './types';
import type {MlsReadyBase, MlsReadyCheckpoint, ValidationAckWorkBase, ValidationAdmissionWorkChange} from './common_state';
/**
 * Encryption Storage — Persistence layer for encryption (E2EE) state
 *
 * Defines the `EncryptionStorageAdapter` interface for platform abstraction
 * and provides `IndexedDBEncryptionStorage` as the default browser implementation.
 *
 * Stores:
 * - Device ID (per browser)
 * - Identity bytes (per user+device)
 * - E2EE messages (per channel)
 * - Group CID markers
 * - Provider key store
 * - Sync timestamps
 */

import { normalizeRequiredBytes } from './encoding';
import { randomId } from '../utils';
import type { Logger, SyncStateRecord } from '../types';
import { setSdkLogger, sdkLog } from '../logger';
import MiniSearch from 'minisearch';
import {acceptsRecoveryEvidence, selectRecoveryControl, validateRecoveryControl,recoveryControlGroupMatches} from './recovery_control';
import type {RecoveryControlCheckpoint} from './recovery_control';
import {sameValidationAckTuple,validateValidationAckCheckpoint,validationAckMarkerMatches,validationAckControlMatches} from './validation_ack';
import type {GroupInfoValidationAckCheckpoint,GroupInfoValidationAdmission} from './validation_ack';
import {validateValidationAdmission,sameValidationAdmission} from './validation_ack';
import {sha256Hex} from './sha256';
import {validateExternalJoinRejection} from './external_join_receipt';
import type {ExternalJoinWorkBase, ExternalJoinWorkChange} from './external_join_work';
import {externalWelcomePrefix, externalWelcomeKey, nextExternalJoinWorkBase, validateExternalJoinReadyBase} from './external_join_work';

import type {
  IdentityCheckpoint,
  ApplicationReceiveCheckpoint,
  ProviderWriteGuard,
  ProviderStorageCheckpoint,
  ArchiveAckRecord,
  ArchiveScope,
  ChannelRepairState,
  EpochArchiveCheckpoint,
  StoredMessage,
  EventCursor,
  EncryptionStorageAdapter,
  EncryptionSyncCheckpoint,
  PendingArchiveUpload,
  ExternalJoinReadinessState,
  JoinPersistenceCheckpoint,
  MlsRebootstrapCandidateCheckpoint,
  MlsRebootstrapClaimIntent,
  StoredGroupInfoRefreshRequest,
  PendingE2eeSendRecord,
  PendingMlsMutation,
  MlsMutationCheckpoint,
  MlsCleanupState,
  MlsCleanupCheckpoint,
  KeyPackageOwnershipCheckpoint,
  PendingKeyPackageUpload,
  KeyPackageUploadOwner,
  ExternalJoinCandidateCheckpoint,
  ExternalJoinReceipt,
  WelcomeRecoveryCheckpoint,
  PendingDeferredArchive,
  PendingE2eeSnapshot,
  RemovedSyncCursor,
  RestoreProgressRecord,
  RestoreStatus,
} from './types';

// ============================================================
// IndexedDB Implementation (Browser Default)
// ============================================================

const DB_NAME_PREFIX = 'ermis_data';
/** Global DB (no userId) — only used for migrating legacy device_id */
const DB_NAME_LEGACY = 'ermis_mls';
const DB_VERSION = 10;
const STORE_WELCOME_HISTORY = 'welcome_history';
const WELCOME_RECOVERY_PREFIX = 'welcome_recovery:v1:';
const WELCOME_PENDING_PREFIX = 'welcome_pending:v1:';
const recoveryControlKey = (cid: string, deviceId: string) => `recovery_control:v1:${encodeURIComponent(deviceId)}:${encodeURIComponent(cid)}`;
const validationAckKey=(cid:string,deviceId:string)=>`gi_validation_ack:v1:${encodeURIComponent(deviceId)}:${encodeURIComponent(cid)}`;
const validationAdmissionPendingPrefix = (deviceId: string) => `gi_validation_admission_pending:v1:${encodeURIComponent(deviceId)}:`;
const validationAdmissionPendingKey = (job: GroupInfoValidationAdmission) => `${validationAdmissionPendingPrefix(job.device_id)}${String(job.retry_at).padStart(16, '0')}:${encodeURIComponent(job.cid)}`;
const validationAckPendingPrefix=(deviceId:string)=>`gi_validation_ack_pending:v1:${encodeURIComponent(deviceId)}:`;
const validationAckPendingKey=(job:GroupInfoValidationAckCheckpoint)=>`${validationAckPendingPrefix(job.device_id)}${String(job.retry_at).padStart(16,'0')}:${encodeURIComponent(job.request.cid)}`;
const recoveryWorkParkedKey=(deviceId:string,primaryKey:string)=>`recovery_work_parked:v1:${encodeURIComponent(deviceId)}:${encodeURIComponent(primaryKey)}`;
const welcomeRecoveryPrefix = (cid: string, deviceId: string, pending = false) =>
  `${pending ? WELCOME_PENDING_PREFIX : WELCOME_RECOVERY_PREFIX}${encodeURIComponent(deviceId)}:${encodeURIComponent(cid)}:`;
const welcomeRecoveryKey = (record: Pick<WelcomeRecoveryCheckpoint, 'cid' | 'device_id' | 'event_cursor'>) =>
  `${welcomeRecoveryPrefix(record.cid, record.device_id)}${encodeURIComponent(record.event_cursor.event_id)}`;
const sameWelcomeBinding = (a: WelcomeRecoveryCheckpoint, b: WelcomeRecoveryCheckpoint) =>
  a.version === b.version && a.user_id === b.user_id && a.device_id === b.device_id && a.cid === b.cid &&
  a.signing_identity_sha256 === b.signing_identity_sha256 && a.group_generation === b.group_generation &&
  a.epoch === b.epoch && a.payload_sha256 === b.payload_sha256 &&
  a.event_cursor.event_id === b.event_cursor.event_id && a.event_cursor.created_at === b.event_cursor.created_at;

const STORE_IDENTITY = 'identity';
const STORE_MESSAGES = 'messages';
const STORE_PENDING_SENDS = 'pending_sends';
const STORE_META = 'meta';
const STORE_GROUPS = 'groups';
const GROUP_INFO_REFRESH_REQUEST_PREFIX = 'group_info_refresh:v1:';
const STORE_ARCHIVE_UPLOADS = 'archive_uploads';
const STORE_DEFERRED_ARCHIVES = 'deferred_archives';
const STORE_ARCHIVE_ACKS = 'archive_acks';
const STORE_RESTORE_PROGRESS = 'restore_progress';
const STORE_RESTORE_PROGRESS_BY_GENERATION = 'restore_progress_by_generation';
const ARCHIVE_STASH_KEY_META = 'archive_stash_key';
const LEGACY_SYNC_PREFIX = 'sync:';
const SCOPE_SYNC_PREFIX = 'scope_sync:';
const CHANNEL_REPAIR_PREFIX = 'channel_repair:';
const CHANNEL_REPAIR_LOCK_PREFIX = 'channel_repair_lock:';
const EPOCH_ARCHIVE_CHECKPOINT_PREFIX = 'epoch_archive_checkpoint:';



function epochArchiveCheckpointKey(scopeCid: string, groupGeneration: number, epoch: number): string {
  // Preserve the generation-0 key byte-for-byte for existing IndexedDB rows.
  return groupGeneration === 0
    ? `${EPOCH_ARCHIVE_CHECKPOINT_PREFIX}${scopeCid}:${epoch}`
    : `${EPOCH_ARCHIVE_CHECKPOINT_PREFIX}${scopeCid}:generation:${groupGeneration}:${epoch}`;
}

function archiveGenerationKeyPrefix(cid: string, groupGeneration: number): string {
  return groupGeneration === 0 ? cid : `${cid}:generation:${groupGeneration}`;
}
const EXTERNAL_JOIN_READINESS_PREFIX = 'external_join_readiness:';
const MLS_REBOOTSTRAP_CLAIM_INTENT_PREFIX = 'mls_rebootstrap_claim_intent:v1:';
const MLS_REBOOTSTRAP_CANDIDATE_PREFIX = 'mls_rebootstrap_candidate:v1:';
const MLS_MUTATION_PREFIX = 'mls_mutation:v1:';
const KP_OWNERSHIP_PREFIX = 'kp_ownership:v1:';
const KP_UPLOAD_PREFIX = 'kp_upload:v1:';
const EXTERNAL_CANDIDATE_PREFIX = 'external_candidate:v1:';
const EXTERNAL_RECEIPT_PREFIX = 'external_receipt:v1:';
const ZERO_EVENT_ID = '00000000-0000-0000-0000-000000000000';

/** localStorage key for device_id — global, per-browser */
const DEVICE_ID_LS_KEY = 'ermis_device_id';

function normalizeDeferredArchiveRecord(record: PendingDeferredArchive): PendingDeferredArchive {
  return {
    ...record,
    group_generation: record.group_generation || 0,
    encrypted_archive: {
      ciphertext: normalizeRequiredBytes(record.encrypted_archive.ciphertext, 'encrypted_archive.ciphertext'),
      nonce: normalizeRequiredBytes(record.encrypted_archive.nonce, 'encrypted_archive.nonce'),
      aead_aad: normalizeRequiredBytes(record.encrypted_archive.aead_aad, 'encrypted_archive.aead_aad'),
    },
    snapshot: {
      ...record.snapshot,
      snapshot_bytes: normalizeRequiredBytes(record.snapshot.snapshot_bytes, 'snapshot.snapshot_bytes'),
    },
    encrypted_adk: {
      ciphertext: normalizeRequiredBytes(record.encrypted_adk.ciphertext, 'encrypted_adk.ciphertext'),
      nonce: normalizeRequiredBytes(record.encrypted_adk.nonce, 'encrypted_adk.nonce'),
    },
  };
}

function normalizeEpochArchiveCheckpoint(record: EpochArchiveCheckpoint): EpochArchiveCheckpoint {
  return {
    ...record,
    group_generation: record.group_generation || 0,
    encrypted_archive_bytes: {
      ciphertext: normalizeRequiredBytes(
        record.encrypted_archive_bytes.ciphertext,
        'encrypted_archive_bytes.ciphertext',
      ),
      nonce: normalizeRequiredBytes(record.encrypted_archive_bytes.nonce, 'encrypted_archive_bytes.nonce'),
    },
    snapshot: {
      ...record.snapshot,
      snapshot_bytes: normalizeRequiredBytes(record.snapshot.snapshot_bytes, 'snapshot.snapshot_bytes'),
    },
  };
}

function eventCursorFromStoredValue(value: unknown): EventCursor | null {
  if (!value) return null;
  if (
    typeof value === 'object' &&
    typeof (value as EventCursor).created_at === 'string' &&
    typeof (value as EventCursor).event_id === 'string'
  ) {
    return value as EventCursor;
  }
  if (typeof value === 'string' && value.length > 0) {
    return { created_at: value, event_id: ZERO_EVENT_ID };
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return { created_at: new Date(value).toISOString(), event_id: ZERO_EVENT_ID };
  }
  return null;
}

/**
 * Default encryption storage adapter using browser IndexedDB.
 *
 * Each user gets their own IndexedDB database (`ermis_mls_{userId}`) to
 * prevent cross-user state contamination during login/logout cycles.
 * `device_id` is stored in `localStorage` (global, per-browser).
 *
 * @example
 * ```ts
 * const storage = new IndexedDBEncryptionStorage('user123');
 * const deviceId = await storage.getDeviceId();
 * ```
 */
export class IndexedDBEncryptionStorage implements EncryptionStorageAdapter {
  readonly identityCheckpointVersion = 1 as const;
  readonly providerCheckpointCASVersion = 1 as const;
  readonly applicationSendCheckpointVersion = 1 as const;
  readonly applicationReceiveCheckpointVersion = 1 as const;
  readonly mlsMutationCheckpointVersion = 1 as const;
  readonly mlsMutationSettlementVersion = 1 as const;
  private dbPromise: Promise<IDBDatabase> | null = null;
  private _storageScopeRevision: object = {};
  get storageScopeRevision(): unknown { return this._storageScopeRevision; }
  private _welcomeHistoryListeners = new Map<string, {listeners: Set<() => void>; channel: BroadcastChannel | null}>();
  subscribeWelcomeHistoryWork(device: string, listener: () => void): () => void {
    let slot = this._welcomeHistoryListeners.get(device);
    if (!slot) {
      let channel: BroadcastChannel | null = null;
      try { if (typeof BroadcastChannel === 'function') channel = new BroadcastChannel(`ermis-welcome-retention:${encodeURIComponent(this.dbName)}:${encodeURIComponent(device)}`); } catch { /* Durable startup/reconnect proof remains independent of unavailable hint transport. */ }
      slot = {listeners: new Set(), channel}; const current = slot;
      if (channel) { channel.onmessage = () => { if (this._welcomeHistoryListeners.get(device) !== current) return;
        for (const callback of current.listeners) { try { callback(); } catch { /* Hint only; durable work remains authoritative. */ } }
      }; (channel as BroadcastChannel & {unref?: () => void}).unref?.(); }
      this._welcomeHistoryListeners.set(device, slot);
    }
    const owned = slot; owned.listeners.add(listener);
    return () => { if (this._welcomeHistoryListeners.get(device) !== owned) return;
      owned.listeners.delete(listener); if (!owned.listeners.size) { this._welcomeHistoryListeners.delete(device); try { owned.channel?.close(); } catch { /* Hint resources do not own storage outcome. */ } }
    };
  }
  private _notifyWelcomeHistoryWork(device: string): void {
    const slot = this._welcomeHistoryListeners.get(device);
    for (const callback of slot?.listeners || []) { try { callback(); } catch { /* Never authority or operation completion. */ } }
    try {
      if (typeof BroadcastChannel !== 'function') return;
      const current = this._welcomeHistoryListeners.get(device), channel = current?.channel || new BroadcastChannel(`ermis-welcome-retention:${encodeURIComponent(this.dbName)}:${encodeURIComponent(device)}`);
      try { channel.postMessage(null); } finally { if (!current?.channel) channel.close(); }
    } catch { /* A lost optional wake cannot turn a fully proved commit into an unknown outcome. */ }
  }
  private readonly dbName: string;
  private readonly accountId: string;

  /**
   * @param userId - The current user's ID. Used to scope the IndexedDB
   *                 database name so each user's encryption state is isolated.
   *                 Pass empty string for legacy/global access (migration only).
   */
  private readonly deviceIdStorageKey: string;
  private readonly hasExplicitNamespace: boolean;

  constructor(userId: string = '', logger?: Logger, namespace?: string) {
    this.accountId=userId;
    const scope = namespace ? sha256Hex(new TextEncoder().encode(namespace)) : null;
    this.hasExplicitNamespace = scope !== null;
    this.deviceIdStorageKey = scope ? `${DEVICE_ID_LS_KEY}:scope:${scope}` : DEVICE_ID_LS_KEY;
    if (logger) setSdkLogger(logger);
    if (userId) {
      this.dbName = scope ? `${DB_NAME_PREFIX}_scope_${scope}_${userId}` : `${DB_NAME_PREFIX}_${userId}`;
    } else {
      // Legacy fallback — global DB (used during device_id migration)
      this.dbName = scope ? `${DB_NAME_PREFIX}_scope_${scope}` : DB_NAME_LEGACY;
    }
  }

  /**
   * Open (or create) the IndexedDB database.
   * Caches the connection promise for reuse.
   */
  private openDB(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;

    let retired = false;
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.dbName, DB_VERSION);

      request.onupgradeneeded = (event: IDBVersionChangeEvent) => {
        if (retired) { request.transaction?.abort(); return; }
        const db = (event.target as IDBOpenDBRequest).result;

        // Additive format floor: older primary-only artifacts must not reopen relocated proof as absent.
        if (!db.objectStoreNames.contains(STORE_WELCOME_HISTORY)) db.createObjectStore(STORE_WELCOME_HISTORY);

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

        if (!db.objectStoreNames.contains(STORE_PENDING_SENDS)) {
          const pendingStore = db.createObjectStore(STORE_PENDING_SENDS, {
            keyPath: 'message_id',
          });
          pendingStore.createIndex('status', 'status', { unique: false });
          pendingStore.createIndex('cid', 'cid', { unique: false });
          pendingStore.createIndex('updated_at', 'updated_at', { unique: false });
        }

        // Meta store: key-value for device_id, snapshot, sync timestamps
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META);
        }

        // Groups store: key = cid → marker
        if (!db.objectStoreNames.contains(STORE_GROUPS)) {
          db.createObjectStore(STORE_GROUPS);
        }

        if (!db.objectStoreNames.contains(STORE_ARCHIVE_UPLOADS)) {
          db.createObjectStore(STORE_ARCHIVE_UPLOADS);
        }

        if (!db.objectStoreNames.contains(STORE_DEFERRED_ARCHIVES)) {
          db.createObjectStore(STORE_DEFERRED_ARCHIVES);
        }

        if (!db.objectStoreNames.contains(STORE_ARCHIVE_ACKS)) {
          db.createObjectStore(STORE_ARCHIVE_ACKS);
        }

        if (!db.objectStoreNames.contains(STORE_RESTORE_PROGRESS)) {
          const restoreStore = db.createObjectStore(STORE_RESTORE_PROGRESS, {
            keyPath: ['device_id', 'cid'],
          });
          restoreStore.createIndex('status', 'status', { unique: false });
          restoreStore.createIndex('device_id', 'device_id', { unique: false });
          restoreStore.createIndex('device_status', ['device_id', 'status'], { unique: false });
        }

        if (!db.objectStoreNames.contains(STORE_RESTORE_PROGRESS_BY_GENERATION)) {
          const restoreStore = db.createObjectStore(STORE_RESTORE_PROGRESS_BY_GENERATION, {
            keyPath: ['device_id', 'cid', 'group_generation'],
          });
          restoreStore.createIndex('status', 'status', { unique: false });
          restoreStore.createIndex('device_id', 'device_id', { unique: false });
          restoreStore.createIndex('device_status', ['device_id', 'status'], { unique: false });
        }

        // DB version 7: Add cid_msg_seq index for offline pagination by msg_seq
        if (event.oldVersion < 7 && db.objectStoreNames.contains(STORE_MESSAGES)) {
          const tx = (event.target as IDBOpenDBRequest).transaction!;
          const msgStore = tx.objectStore(STORE_MESSAGES);
          if (!msgStore.indexNames.contains('cid_msg_seq')) {
            msgStore.createIndex('cid_msg_seq', ['cid', 'msg_seq'], { unique: false });
          }
        }

        // DB version 8: pending standard uploads are stored in the 'meta' store
        // (key prefix 'std_upload:') — no dedicated store needed.
        // Clean up any erroneously created 'pending_standard_uploads' store from dev builds.
        if (event.oldVersion < 9 && db.objectStoreNames.contains('pending_standard_uploads')) {
          db.deleteObjectStore('pending_standard_uploads');
        }
      };

      request.onblocked = () => {
        retired = true;
        if (this.dbPromise === opening) this.dbPromise = null;
        reject(recoveryControlError('storage_upgrade_blocked'));
      };
      request.onsuccess = () => {
        const db = request.result;
        if (retired) { db.close(); return; }
        db.onversionchange = () => {
          db.close(); this._storageScopeRevision = {};
          if (this.dbPromise === opening) this.dbPromise = null;
        };
        resolve(db);
      };
      request.onerror = () => {
        if (this.dbPromise === opening) this.dbPromise = null;
        reject(request.error?.name === 'VersionError' ? Object.assign(recoveryControlError('client_upgrade_required'), {cause: request.error}) : request.error);
      };
    });

    this.dbPromise = opening;
    return opening;
  }

  /**
   * Expose the shared DB connection for reuse by other storage classes
   * (e.g. StandardAttachmentUploadStorage) so they don't create a separate DB.
   */
  getDB(): Promise<IDBDatabase> {
    return this.openDB();
  }

  /**
   * Close the database connection to release locks.
   */
  async close(): Promise<void> {
    for (const slot of this._welcomeHistoryListeners.values()) { try { slot.channel?.close(); } catch { /* Already closed hint. */ } }
    this._welcomeHistoryListeners.clear();
    if (this.dbPromise) {
      try {
        const db = await this.dbPromise;
        db.close();
      } catch (err) {
        // Ignore errors if the database failed to open
      } finally {
        this.dbPromise = null;
      }
    }
  }

  // ---- Device ID: account private state owns binding; preferences are hints ----

  async getDeviceId(): Promise<string> {
    if (this.accountId) {
      const db = await this.openDB();
      const selected = await new Promise<string>((resolve, reject) => {
        // Reserve before identity creation. Concurrent tabs must choose one ID;
        // a surviving preference must never bind a new private identity to an
        // earlier installation. Read keys only, never copy private provider bytes.
        const tx = db.transaction([STORE_META, STORE_IDENTITY], 'readwrite');
        const meta = tx.objectStore(STORE_META), identities = tx.objectStore(STORE_IDENTITY);
        const binding = meta.get(`device_binding:${this.accountId}`);
        let device: string | null = null;
        const valid = (value: unknown): value is string => typeof value === 'string' && value.length > 0 &&
          value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
        const verifyPair = (id: string) => {
          const provider = meta.getKey(`provider:${this.accountId}:${id}`);
          const identity = identities.getKey(`${this.accountId}:${id}`);
          let completed = 0;
          const ready = () => {
            if (++completed !== 2) return;
            if (provider.result === undefined || identity.result === undefined) { tx.abort(); return; }
            device = id;
          };
          provider.onsuccess = ready; identity.onsuccess = ready;
        };
        binding.onsuccess = () => {
          if (binding.result != null) {
            if (!valid(binding.result)) { tx.abort(); return; }
            verifyPair(binding.result); return;
          }
          // Before binding metadata existed, a sole complete private tuple can
          // recover its ID even when the global preference was lost/replaced.
          const prefix = `${this.accountId}:`;
          const keys = identities.getAllKeys(IDBKeyRange.bound(prefix, prefix + '\uffff'), 2);
          keys.onsuccess = () => {
            if (keys.result.length > 1) { tx.abort(); return; }
            if (keys.result.length === 1) {
              const key = keys.result[0];
              const id = typeof key === 'string' ? key.slice(prefix.length) : null;
              if (!valid(id)) { tx.abort(); return; }
              verifyPair(id); return;
            }
            const providerPrefix = `provider:${this.accountId}:`;
            const providers = meta.getAllKeys(IDBKeyRange.bound(providerPrefix, providerPrefix + '\uffff'), 1);
            providers.onsuccess = () => {
              if (providers.result.length) { tx.abort(); return; }
              const reservationKey = `device_installation:${this.accountId}`;
              const reserved = meta.get(reservationKey);
              reserved.onsuccess = () => {
                if (reserved.result != null && !valid(reserved.result)) { tx.abort(); return; }
                device = reserved.result ?? `web-${randomId()}`;
                if (reserved.result == null) meta.put(device, reservationKey);
              };
            };
          };
        };
        tx.oncomplete = () => device ? resolve(device) : reject(recoveryControlError('provider_checkpoint_invalid'));
        tx.onerror = () => reject(tx.error || recoveryControlError('provider_checkpoint_invalid'));
        tx.onabort = () => reject(Object.assign(new Error('MLS device binding is incomplete or ambiguous'), {code:'provider_checkpoint_invalid'}));
      });
      // Preferences cannot prevent recovery of a valid private installation.
      try { if (typeof localStorage !== 'undefined') localStorage.setItem(this.deviceIdStorageKey, selected); } catch { /* Optional cache. */ }
      return selected;
    }
    // 1. Check localStorage first
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem(this.deviceIdStorageKey);
      if (stored) return stored;
    }

    // 2. Backward compat: migrate from legacy global IndexedDB
    try {
      const legacyId = this.hasExplicitNamespace ? null : await this._migrateLegacyDeviceId();
      if (legacyId) return legacyId;
    } catch (_) {
      // IndexedDB unavailable — generate new
    }

    // 3. Generate new device ID
    const deviceId = `web-${randomId()}`;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(this.deviceIdStorageKey, deviceId);
    }
    return deviceId;
  }

  /**
   * Migrate device_id from legacy global IndexedDB (`ermis_mls`) to localStorage.
   * Returns the migrated ID or null if not found.
   */
  private async _migrateLegacyDeviceId(): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      // Read the existing global device ID without upgrading its schema or changing device scope.
      const request = indexedDB.open(DB_NAME_LEGACY);

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
        if (!db.objectStoreNames.contains(STORE_PENDING_SENDS)) {
          const pendingStore = db.createObjectStore(STORE_PENDING_SENDS, { keyPath: 'message_id' });
          pendingStore.createIndex('status', 'status', { unique: false });
          pendingStore.createIndex('cid', 'cid', { unique: false });
          pendingStore.createIndex('updated_at', 'updated_at', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_GROUPS)) {
          db.createObjectStore(STORE_GROUPS);
        }
        if (!db.objectStoreNames.contains(STORE_ARCHIVE_UPLOADS)) {
          db.createObjectStore(STORE_ARCHIVE_UPLOADS);
        }

        if (!db.objectStoreNames.contains(STORE_DEFERRED_ARCHIVES)) {
          db.createObjectStore(STORE_DEFERRED_ARCHIVES);
        }

        if (!db.objectStoreNames.contains(STORE_ARCHIVE_ACKS)) {
          db.createObjectStore(STORE_ARCHIVE_ACKS);
        }

        if (!db.objectStoreNames.contains(STORE_RESTORE_PROGRESS)) {
          const restoreStore = db.createObjectStore(STORE_RESTORE_PROGRESS, {
            keyPath: ['device_id', 'cid'],
          });
          restoreStore.createIndex('status', 'status', { unique: false });
          restoreStore.createIndex('device_id', 'device_id', { unique: false });
          restoreStore.createIndex('device_status', ['device_id', 'status'], { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_RESTORE_PROGRESS_BY_GENERATION)) {
          const restoreStore = db.createObjectStore(STORE_RESTORE_PROGRESS_BY_GENERATION, {
            keyPath: ['device_id', 'cid', 'group_generation'],
          });
          restoreStore.createIndex('status', 'status', { unique: false });
          restoreStore.createIndex('device_id', 'device_id', { unique: false });
          restoreStore.createIndex('device_status', ['device_id', 'status'], { unique: false });
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
              sdkLog('info', '[Encryption Storage] Migrated device_id from IndexedDB to localStorage:', legacyId);
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

  async loadIdentityCheckpoint(userId: string, deviceId: string): Promise<ProviderStorageCheckpoint & {identity_bytes: Uint8Array | null}> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_META, STORE_IDENTITY], 'readonly'), meta = tx.objectStore(STORE_META);
      const bytes = meta.get(`provider:${userId}:${deviceId}`), revision = meta.get(`provider_revision:${userId}:${deviceId}`);
      const identity = tx.objectStore(STORE_IDENTITY).get(`${userId}:${deviceId}`);
      tx.oncomplete = () => {
        const value = revision.result ?? null;
        if (value !== null && (typeof value !== 'string' || !value.length || value.length > 128)) {
          reject(Object.assign(new Error('Identity provider revision invalid'), {code: 'provider_checkpoint_invalid'}));
        } else resolve({provider_bytes: bytes.result ?? null, revision: value, identity_bytes: identity.result ?? null});
      };
      tx.onerror = () => reject(tx.error || new Error('Identity checkpoint read failed'));
      tx.onabort = () => reject(tx.error || new Error('Identity checkpoint read aborted'));
    });
  }

  async saveIdentityCheckpoint(checkpoint: IdentityCheckpoint): Promise<void> {
    const submitted = structuredClone(checkpoint);
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_META, STORE_IDENTITY], 'readwrite');
      const identities = tx.objectStore(STORE_IDENTITY), key = `${submitted.user_id}:${submitted.device_id}`;
      let failure: unknown;
      tx.oncomplete = () => resolve();
      tx.onerror = () => { failure ||= tx.error; };
      tx.onabort = () => {
        const cause = failure || tx.error;
        reject(Object.assign(new Error(cause instanceof Error ? cause.message : 'Identity checkpoint aborted'),
          {cause, code: (cause as {code?: string})?.code, checkpoint_outcome: 'aborted'}));
      };
      const prior = identities.get(key);
      prior.onsuccess = () => {
        try {
          if (!submitted.provider_write_guard || !sameSyncCheckpointValue(prior.result || null, submitted.expected_identity)) {
            failure = Object.assign(new Error('Identity checkpoint owner conflict'), {code: 'provider_checkpoint_conflict'});
            tx.abort(); return;
          }
          this._writeProviderCheckpoint(tx, submitted.user_id, submitted.device_id, submitted.provider_bytes,
            submitted.provider_write_guard, () => {
              identities.put(submitted.identity_bytes, key);
              if (this.accountId === submitted.user_id) tx.objectStore(STORE_META).put(submitted.device_id, `device_binding:${submitted.user_id}`);
            }, error => { failure = error; });
        } catch (error) { failure = error; tx.abort(); }
      };
    });
  }

  async verifyIdentityCheckpoint(checkpoint: IdentityCheckpoint): Promise<boolean> {
    const submitted = structuredClone(checkpoint);
    if (!submitted.provider_write_guard) throw new Error('Identity CAS proof required');
    const db = await this.openDB();
    return new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction([STORE_META, STORE_IDENTITY], 'readonly'), meta = tx.objectStore(STORE_META);
      const bytes = meta.get(`provider:${submitted.user_id}:${submitted.device_id}`);
      const revision = meta.get(`provider_revision:${submitted.user_id}:${submitted.device_id}`);
      const identity = tx.objectStore(STORE_IDENTITY).get(`${submitted.user_id}:${submitted.device_id}`);
      tx.oncomplete = () => resolve(sameSyncCheckpointValue(bytes.result, submitted.provider_bytes) &&
        revision.result === submitted.provider_write_guard.next_revision && sameSyncCheckpointValue(identity.result, submitted.identity_bytes));
      tx.onerror = () => reject(tx.error || new Error('Identity checkpoint readback failed'));
      tx.onabort = () => reject(tx.error || new Error('Identity checkpoint readback aborted'));
    });
  }

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

  // ---- Messages ----

  async saveApplicationReceiveCheckpoint(checkpoint: ApplicationReceiveCheckpoint): Promise<void> {
    // Freeze before openDB can yield to a caller mutating its submitted proof.
    const submitted = structuredClone(checkpoint), message = submitted.message;
    if (!submitted.user_id || !submitted.device_id || !submitted.provider_write_guard ||
        !message.id || !message.cid || !message.mls_ciphertext_hash || message.content_type !== 'standard') {
      throw Object.assign(new Error('Application plaintext proof required'), {code: 'application_receive_checkpoint_invalid'});
    }
    const db = await this.openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_META, STORE_MESSAGES], 'readwrite'), messages = tx.objectStore(STORE_MESSAGES);
      const request = messages.get(message.id);
      request.onsuccess = () => {
        try {
          const existing = request.result as StoredMessage | undefined;
          if (existing && (existing.display_type === 'deleted' || existing.type === 'deleted' || existing.cid !== message.cid ||
              (typeof existing.last_event_seq === 'number' && (typeof message.last_event_seq !== 'number' ||
               message.last_event_seq < existing.last_event_seq)))) {
            throw Object.assign(new Error('Application projection changed; retain ciphertext for reconciliation'), {code: 'application_receive_conflict'});
          }
          this._writeProviderCheckpoint(tx, submitted.user_id, submitted.device_id, submitted.provider_bytes,
            submitted.provider_write_guard, () => messages.put(message), reject);
        } catch (error) { reject(error); tx.abort(); }
      };
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Application receive checkpoint aborted'));
      tx.onabort = () => reject(tx.error || new Error('Application receive checkpoint aborted'));
    });
    this._indexMessage(message);
  }

  async verifyApplicationReceiveCheckpoint(checkpoint: ApplicationReceiveCheckpoint): Promise<boolean> {
    const submitted = structuredClone(checkpoint);
    if (!submitted.provider_write_guard) throw Object.assign(new Error('Application receive CAS proof required'), {code: 'application_receive_checkpoint_invalid'});
    const db = await this.openDB();
    return new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction([STORE_META, STORE_MESSAGES], 'readonly'), meta = tx.objectStore(STORE_META);
      const bytes = meta.get(`provider:${submitted.user_id}:${submitted.device_id}`);
      const revision = meta.get(`provider_revision:${submitted.user_id}:${submitted.device_id}`);
      const message = tx.objectStore(STORE_MESSAGES).get(submitted.message.id);
      tx.oncomplete = () => resolve(sameSyncCheckpointValue(bytes.result, submitted.provider_bytes) &&
        revision.result === submitted.provider_write_guard.next_revision && sameSyncCheckpointValue(message.result, submitted.message));
      tx.onerror = () => reject(tx.error || new Error('Application receive verification aborted'));
      tx.onabort = () => reject(tx.error || new Error('Application receive verification aborted'));
    });
  }

  async saveMessage(message: StoredMessage): Promise<void> {
    if (message && ((message as any).status === 'error' || (message as any).status === 'failed' || (message as any).status === 'failed_offline' || (message as any).type === 'error')) {
      if (message.id) await this.deleteMessage(message.id).catch(() => {});
      return;
    }
    try {
      await this._saveMessageInternal(message);
    } catch (err: any) {
      // If storage is full, evict old messages and retry once
      if (err?.name === 'QuotaExceededError') {
        sdkLog('warn', '[Storage] Quota exceeded, evicting old messages...');
        await this.evictOldMessages(message.cid, 200);
        await this._saveMessageInternal(message);
      } else {
        throw err;
      }
    }
  }

  private async _saveMessageInternal(message: StoredMessage): Promise<void> {
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_MESSAGES, 'readwrite');
      const store = tx.objectStore(STORE_MESSAGES);

      // Idempotency check (Section 5.6): only overwrite if the incoming
      // message has a newer (or equal) last_event_seq than the stored copy.
      let didWrite = false;
      const getReq = store.get(message.id);
      getReq.onsuccess = () => {
        const existing = getReq.result as StoredMessage | undefined;
        const existingIsTombstone = existing?.display_type === 'deleted' || existing?.type === 'deleted';
        const incomingIsTombstone = message.display_type === 'deleted' || message.type === 'deleted';
        if (existingIsTombstone && !incomingIsTombstone) {
          return;
        }
        if (
          existing &&
          typeof existing.last_event_seq === 'number' &&
          typeof message.last_event_seq === 'number' &&
          message.last_event_seq < existing.last_event_seq
        ) {
          // Incoming data is older — skip write
          return;
        }
        store.put(message);
        didWrite = true;
      };

      tx.oncomplete = () => {
        if (didWrite) this._indexMessage(message);
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Evict the oldest messages for a channel to free IndexedDB storage.
   * Keeps the newest `keepCount` messages, deletes the rest.
   * Called automatically on QuotaExceededError, can also be called manually.
   *
   * @param cid - Channel ID to evict from. If empty, evicts across all channels.
   * @param keepCount - Number of newest messages to keep per channel (default: 500)
   */
  async evictOldMessages(cid?: string, keepCount = 500): Promise<number> {
    const db = await this.openDB();
    return new Promise<number>((resolve, reject) => {
      const tx = db.transaction(STORE_MESSAGES, 'readwrite');
      const store = tx.objectStore(STORE_MESSAGES);
      let deletedCount = 0;

      if (cid) {
        // Evict from specific channel
        const index = store.index('cid_created');
        const range = IDBKeyRange.bound([cid], [cid, []]);
        const request = index.openCursor(range);
        const toDelete: string[] = [];
        const allKeys: { id: string; created_at: string }[] = [];

        request.onsuccess = (event: Event) => {
          const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
          if (cursor) {
            const msg = cursor.value as StoredMessage;
            allKeys.push({ id: msg.id, created_at: msg.created_at });
            cursor.continue();
          } else {
            // Sort oldest first, mark excess for deletion
            allKeys.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
            const excess = allKeys.length - keepCount;
            if (excess > 0) {
              for (let i = 0; i < excess; i++) {
                toDelete.push(allKeys[i].id);
              }
              for (const id of toDelete) {
                store.delete(id);
                deletedCount++;
              }
            }
          }
        };
      } else {
        // Evict across all channels: group by cid, keep newest per channel
        const allMsgs: StoredMessage[] = [];
        const request = store.openCursor();

        request.onsuccess = (event: Event) => {
          const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
          if (cursor) {
            allMsgs.push(cursor.value as StoredMessage);
            cursor.continue();
          } else {
            // Group by cid
            const byCid = new Map<string, StoredMessage[]>();
            for (const msg of allMsgs) {
              const list = byCid.get(msg.cid) || [];
              list.push(msg);
              byCid.set(msg.cid, list);
            }
            // Delete oldest per channel
            for (const [, msgs] of byCid) {
              msgs.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
              const excess = msgs.length - keepCount;
              if (excess > 0) {
                for (let i = 0; i < excess; i++) {
                  store.delete(msgs[i].id);
                  deletedCount++;
                }
              }
            }
          }
        };
      }

      tx.oncomplete = () => {
        if (deletedCount > 0) {
          sdkLog('info', `[Storage] Evicted ${deletedCount} old messages to free space`);
        }
        resolve(deletedCount);
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  async loadMessage(messageId: string): Promise<StoredMessage | null> {
    const db = await this.openDB();
    return new Promise<StoredMessage | null>((resolve, reject) => {
      const tx = db.transaction(STORE_MESSAGES, 'readonly');
      const store = tx.objectStore(STORE_MESSAGES);
      const request = store.get(messageId);
      request.onsuccess = () => resolve((request.result as StoredMessage) || null);
      request.onerror = () => reject(request.error);
    });
  }

  async loadMessages(messageIds: string[]): Promise<Map<string, StoredMessage>> {
    const ids = Array.from(new Set(messageIds.filter(Boolean)));
    if (ids.length === 0) return new Map();

    const db = await this.openDB();
    return new Promise<Map<string, StoredMessage>>((resolve, reject) => {
      const tx = db.transaction([STORE_MESSAGES, STORE_PENDING_SENDS], 'readonly');
      const store = tx.objectStore(STORE_MESSAGES);
      const results = new Map<string, StoredMessage>();

      for (const id of ids) {
        const request = store.get(id);
        request.onsuccess = () => {
          if (request.result) {
            const message = request.result as StoredMessage;
            const pending = tx.objectStore(STORE_PENDING_SENDS).get(id);
            pending.onsuccess = () => results.set(id, this._pendingMessagePresentation(message, pending.result));
          }
        };
        request.onerror = () => reject(request.error);
      }

      tx.oncomplete = () => resolve(results);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Message presentation read aborted'));
    });
  }

  private _pendingMessagePresentation(message: StoredMessage, record?: PendingE2eeSendRecord): StoredMessage {
    if (!record || record.message_id !== message.id || record.cid !== message.cid || record.operation_kind === 'update' ||
        record.status === 'sent') return message;
    const failed = record.status === 'failed_retryable' || record.status === 'failed_terminal' || record.status === 'canceled';
    return {...message, status: failed ? 'error' : 'sending'};
  }

  async deleteMessage(messageId: string): Promise<void> {
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

  async getMessages(cid: string, limit = 50): Promise<StoredMessage[]> {
    const db = await this.openDB();
    return new Promise<StoredMessage[]>((resolve, reject) => {
      // Cached plaintext is also used for optimistic presentation. Read the
      // exact outgoing obligations in the same snapshot so a reload cannot
      // turn an unknown/failed send into an accepted message.
      const tx = db.transaction([STORE_MESSAGES, STORE_PENDING_SENDS], 'readonly');
      const store = tx.objectStore(STORE_MESSAGES);
      const index = store.index('cid');
      const request = index.getAll(cid);
      let results: StoredMessage[] = [];
      request.onsuccess = () => {
        const msgs = (request.result as StoredMessage[]) || [];
        // Sort by created_at descending, take limit
        msgs.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
        results = msgs.slice(0, limit);
        for (let n = 0; n < results.length; n++) {
          const message = results[n], pending = tx.objectStore(STORE_PENDING_SENDS).get(message.id);
          pending.onsuccess = () => {
            results[n] = this._pendingMessagePresentation(message, pending.result);
          };
        }
      };
      tx.oncomplete = () => resolve(results);
      tx.onerror = () => reject(tx.error || new Error('Message presentation read failed'));
      tx.onabort = () => reject(tx.error || new Error('Message presentation read aborted'));
    });
  }

  async clearMessages(cid: string): Promise<void> {
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
          msgIds.push((cursor.value as StoredMessage).id);
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

  // ---- Offline Pagination & Truncation ----

  /**
   * Get messages for a channel within a msg_seq range, sorted ascending.
   * Used for offline pagination (scroll up / scroll down).
   */
  async getMessagesBySeqRange(cid: string, anchorSeq: number, before = 0, after = 0): Promise<StoredMessage[]> {
    const db = await this.openDB();
    return new Promise<StoredMessage[]>((resolve, reject) => {
      const tx = db.transaction(STORE_MESSAGES, 'readonly');
      const store = tx.objectStore(STORE_MESSAGES);

      // Use the cid_msg_seq compound index
      if (store.indexNames.contains('cid_msg_seq')) {
        const index = store.index('cid_msg_seq');
        const lowerSeq = Math.max(1, anchorSeq - before);
        const upperSeq = anchorSeq + after;
        const range = IDBKeyRange.bound([cid, lowerSeq], [cid, upperSeq]);
        const request = index.getAll(range);
        request.onsuccess = () => {
          const msgs = (request.result as StoredMessage[]) || [];
          const valid = msgs.filter((m: any) =>
            m && m.status !== 'error' && m.status !== 'failed' && m.status !== 'failed_offline' && m.type !== 'error'
          );
          valid.sort((a, b) => (a.msg_seq ?? 0) - (b.msg_seq ?? 0));
          resolve(valid);
        };
        request.onerror = () => reject(request.error);
      } else {
        // Fallback: filter by cid and msg_seq manually
        const index = store.index('cid');
        const request = index.getAll(cid);
        request.onsuccess = () => {
          const all = (request.result as StoredMessage[]) || [];
          const lowerSeq = Math.max(1, anchorSeq - before);
          const upperSeq = anchorSeq + after;
          const filtered = all.filter(
            (m) =>
              typeof m.msg_seq === 'number' &&
              m.msg_seq >= lowerSeq &&
              m.msg_seq <= upperSeq &&
              (m as any).status !== 'error' &&
              (m as any).status !== 'failed' &&
              (m as any).status !== 'failed_offline' &&
              (m as any).type !== 'error',
          );
          filtered.sort((a, b) => (a.msg_seq ?? 0) - (b.msg_seq ?? 0));
          resolve(filtered);
        };
        request.onerror = () => reject(request.error);
      }
    });
  }

  /**
   * Delete all messages in a channel with msg_seq <= threshold.
   * Used when server returns `last_msg_seq_before_chat_deleted`.
   */
  async deleteMessagesBefore(cid: string, seqThreshold: number): Promise<void> {
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_MESSAGES, 'readwrite');
      const store = tx.objectStore(STORE_MESSAGES);
      const index = store.index('cid');
      const request = index.openCursor(cid);
      request.onsuccess = (event: Event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
        if (cursor) {
          const msg = cursor.value as StoredMessage;
          if (typeof msg.msg_seq === 'number' && msg.msg_seq <= seqThreshold) {
            cursor.delete();
          }
          cursor.continue();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ---- Pending E2EE Sends ----

  readonly applicationIntentCheckpointVersion = 1 as const;
  async reserveApplicationIntent(record: PendingE2eeSendRecord, owner: ProviderStorageCheckpoint & {identity_bytes: Uint8Array}, assertOwner: () => void): Promise<PendingE2eeSendRecord> {
    const row = structuredClone(record), expected = structuredClone(owner);
    const user = row.checkpoint_user_id, device = row.checkpoint_device_id;
    if (row.unsealed_intent_version !== 1 || row.mls_ciphertext || !user || user !== this.accountId || !device ||
        !row.message_id || !row.payload || !row.channel_type || !row.channel_id || !expected.provider_bytes || !expected.identity_bytes)
      throw recoveryControlError('pending_send_checkpoint_invalid');
    const db = await this.openDB(); assertOwner();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_META, STORE_IDENTITY, STORE_PENDING_SENDS], 'readwrite'), store = tx.objectStore(STORE_PENDING_SENDS);
      const requests = [store.get(row.message_id), tx.objectStore(STORE_META).get(`provider:${user}:${device}`),
        tx.objectStore(STORE_META).get(`provider_revision:${user}:${device}`), tx.objectStore(STORE_IDENTITY).get(`${user}:${device}`)];
      let remaining = requests.length, selected: PendingE2eeSendRecord, failure: unknown;
      const intent = (v: PendingE2eeSendRecord) => ({message_id:v.message_id,cid:v.cid,e2ee_group_id:v.e2ee_group_id,
        channel_type:v.channel_type,channel_id:v.channel_id,operation_kind:v.operation_kind||'send',payload:v.payload,
        send_envelope:v.send_envelope||{},aad_metadata:v.aad_metadata||{},checkpoint_user_id:v.checkpoint_user_id,
        checkpoint_device_id:v.checkpoint_device_id,signing_identity_sha256:v.signing_identity_sha256});
      for (const q of requests) q.onsuccess = () => {
        if (--remaining) return;
        try {
          assertOwner();
          if (!sameSyncCheckpointValue(requests[1].result, expected.provider_bytes) || requests[2].result !== expected.revision ||
              !sameSyncCheckpointValue(requests[3].result, expected.identity_bytes)) throw recoveryControlError('provider_checkpoint_conflict');
          const prior = requests[0].result as PendingE2eeSendRecord | undefined;
          if (prior) {
            // An accepted version may become one fresh edit intent. The same
            // transaction rejects any competing unresolved version; reserve it
            // before Ready/crypto so restart cannot lose the caption snapshot.
            const freshEdit = prior.status === 'sent' && row.operation_kind === 'update' &&
              prior.cid === row.cid && prior.e2ee_group_id === row.e2ee_group_id &&
              prior.channel_type === row.channel_type && prior.channel_id === row.channel_id &&
              prior.checkpoint_user_id === row.checkpoint_user_id && prior.checkpoint_device_id === row.checkpoint_device_id &&
              prior.signing_identity_sha256 === row.signing_identity_sha256;
            if (freshEdit) { selected = row; store.put(row); }
            else {
              if (!sameSyncCheckpointValue(intent(prior), intent(row))) throw recoveryControlError('pending_send_conflict');
              selected = structuredClone(prior);
            }
          } else { selected = row; store.add(row); }
        } catch (error) { failure = error; tx.abort(); }
      };
      tx.oncomplete = () => resolve(selected);
      tx.onerror = () => {failure ||= tx.error;};
      tx.onabort = () => reject(Object.assign(recoveryControlError((failure as {code?: string})?.code || 'storage_checkpoint_failed'), {cause:failure,checkpoint_outcome:'aborted'}));
    });
  }

  async savePendingE2eeSend(record: PendingE2eeSendRecord): Promise<void> {
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_PENDING_SENDS, 'readwrite');
      tx.objectStore(STORE_PENDING_SENDS).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async loadPendingE2eeSend(messageId: string): Promise<PendingE2eeSendRecord | null> {
    const db = await this.openDB();
    return new Promise<PendingE2eeSendRecord | null>((resolve, reject) => {
      const tx = db.transaction(STORE_PENDING_SENDS, 'readonly');
      const request = tx.objectStore(STORE_PENDING_SENDS).get(messageId);
      request.onsuccess = () => resolve((request.result as PendingE2eeSendRecord) || null);
      request.onerror = () => reject(request.error);
    });
  }

  async savePendingE2eeSendOutcome(expected: PendingE2eeSendRecord, next: PendingE2eeSendRecord | null, message?: StoredMessage): Promise<boolean> {
    const db = await this.openDB();
    const binding = (record: PendingE2eeSendRecord) => ({message_id: record.message_id, cid: record.cid,
      e2ee_group_id: record.e2ee_group_id, channel_type: record.channel_type, channel_id: record.channel_id,
      operation_kind: record.operation_kind || 'send', mls_ciphertext: record.mls_ciphertext, mls_ciphertext_sha256: record.mls_ciphertext_sha256,
      mls_epoch: record.mls_epoch, group_generation: record.group_generation || 0,
      checkpoint_user_id: record.checkpoint_user_id, checkpoint_device_id: record.checkpoint_device_id,
      signing_identity_sha256: record.signing_identity_sha256,
      ...(record.unsealed_intent_version === 1 ? {unsealed_intent_version:1,payload:record.payload,send_envelope:record.send_envelope,aad_metadata:record.aad_metadata} : {})});
    const submitted = structuredClone(expected), replacement = next && structuredClone(next);
    const projection = message && structuredClone(message);
    if (projection && (projection.id !== submitted.message_id || projection.cid !== submitted.cid || !replacement)) throw new Error('Pending outcome projection scope mismatch');
    if (replacement && !sameSyncCheckpointValue(binding(submitted), binding(replacement))) throw new Error('Pending outcome cannot replace ciphertext');
    return new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction(projection ? [STORE_PENDING_SENDS, STORE_MESSAGES] : STORE_PENDING_SENDS, 'readwrite'), store = tx.objectStore(STORE_PENDING_SENDS);
      let updated = false, didWrite = false;
      const request = store.get(submitted.message_id);
      request.onsuccess = () => {
        try {
          if (!request.result || !sameSyncCheckpointValue(binding(submitted), binding(request.result))) return;
          const currentRecord = request.result as PendingE2eeSendRecord;
          if (replacement?.application_http_started === true && submitted.application_http_started === false &&
              currentRecord.application_http_started !== false) return;
          if (replacement && currentRecord.application_http_started === true) replacement.application_http_started = true;
          const currentStatus = currentRecord.status;
          if (replacement && ((currentStatus === 'sent' && replacement.status !== 'sent') ||
              (currentStatus === 'canceled' && replacement.status !== 'canceled' && replacement.status !== 'sent') ||
              (currentStatus === 'failed_terminal' && replacement.status !== 'failed_terminal' && replacement.status !== 'sent'))) return;
          if (replacement) store.put(replacement); else store.delete(submitted.message_id);
          updated = true;
          if (projection) {
            const messages = tx.objectStore(STORE_MESSAGES), previous = messages.get(projection.id);
            previous.onsuccess = () => {
              try {
                const existing = previous.result as StoredMessage | undefined;
                if ((existing?.display_type === 'deleted' || existing?.type === 'deleted') && projection.display_type !== 'deleted' && projection.type !== 'deleted') return;
                if (typeof existing?.last_event_seq === 'number' && typeof projection.last_event_seq === 'number' && projection.last_event_seq < existing.last_event_seq) return;
                messages.put(projection); didWrite = true;
              } catch (error) { reject(error); tx.abort(); }
            };
            previous.onerror = () => reject(previous.error);
          }
        } catch (error) { reject(error); tx.abort(); }
      };
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => { if (didWrite && projection) this._indexMessage(projection); resolve(updated); };
      tx.onerror = () => reject(tx.error || new Error('Pending outcome transaction aborted'));
      tx.onabort = () => reject(tx.error || new Error('Pending outcome transaction aborted'));
    });
  }

  async listPendingE2eeSends(statuses?: string[]): Promise<PendingE2eeSendRecord[]> {
    const db = await this.openDB();
    return new Promise<PendingE2eeSendRecord[]>((resolve, reject) => {
      const tx = db.transaction(STORE_PENDING_SENDS, 'readonly');
      const store = tx.objectStore(STORE_PENDING_SENDS);
      const results: PendingE2eeSendRecord[] = [];
      // Accepted journals can outnumber active work by thousands. Use the
      // existing status index when selecting resumable work before a new send.
      const selected = statuses?.length ? [...new Set(statuses)] : null;
      const read = (statusIndex: number) => {
      const request = selected ? store.index('status').openCursor(IDBKeyRange.only(selected[statusIndex])) : store.openCursor();
      request.onsuccess = (event: Event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
        if (cursor) {
          const value = cursor.value as PendingE2eeSendRecord;
          results.push(value);
          cursor.continue();
        } else if (selected && statusIndex + 1 < selected.length) {
          read(statusIndex + 1);
        }
      };
      request.onerror = () => reject(request.error);
      };
      read(0);
      tx.oncomplete = () => {
        results.sort((a, b) => a.updated_at - b.updated_at);
        resolve(results);
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  async deletePendingE2eeSend(messageId: string): Promise<void> {
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_PENDING_SENDS, 'readwrite');
      tx.objectStore(STORE_PENDING_SENDS).delete(messageId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ---- E2EE Message Search (MiniSearch-powered) ----

  /** MiniSearch instance — lazily initialized on first search. */
  private _searchIndex: MiniSearch<StoredMessage> | null = null;
  /** Set of indexed message IDs — for dedup on incremental add. */
  private _indexedIds: Set<string> = new Set();
  /** Whether the full index has been built from IndexedDB. */
  private _indexReady = false;
  /** Promise for the build-in-progress (prevents double-build). */
  private _indexBuildPromise: Promise<void> | null = null;

  /**
   * Create a fresh MiniSearch instance with fields tuned for chat messages.
   */
  private _createSearchIndex(): MiniSearch<StoredMessage> {
    return new MiniSearch<StoredMessage>({
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
      const allMsgs = await new Promise<StoredMessage[]>((resolve, reject) => {
        const tx = db.transaction(STORE_MESSAGES, 'readonly');
        const store = tx.objectStore(STORE_MESSAGES);
        const request = store.getAll();
        request.onsuccess = () => resolve((request.result as StoredMessage[]) || []);
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
      sdkLog('info', `[Encryption Storage] Search index built: ${indexable.length} messages indexed`);
    })();

    return this._indexBuildPromise;
  }

  /**
   * Incrementally add/update a single message in the search index.
   * Called from saveMessage() after successful IndexedDB write.
   */
  private _indexMessage(message: StoredMessage): void {
    if (!this._searchIndex || !this._indexReady) return;

    try {
      if (this._indexedIds.has(message.id)) {
        this._searchIndex.discard(message.id);
        this._indexedIds.delete(message.id);
      }
      if (!message.text || message.text.length === 0) return;
      this._searchIndex.add(message);
      this._indexedIds.add(message.id);
    } catch (err) {
      sdkLog('warn', '[Encryption Storage] Failed to index message:', message.id, err);
    }
  }

  async searchMessages(searchTerm: string, limit = 25): Promise<StoredMessage[]> {
    await this._ensureIndex();
    if (!this._searchIndex) return [];

    const results = this._searchIndex.search(searchTerm);

    // Sort by created_at descending (MiniSearch returns by relevance score)
    const sorted = results
      .sort((a, b) => new Date((b as any).created_at).getTime() - new Date((a as any).created_at).getTime())
      .slice(0, limit);

    return sorted as unknown as StoredMessage[];
  }

  async searchMessagesByCid(cid: string, searchTerm: string, limit = 25): Promise<StoredMessage[]> {
    await this._ensureIndex();
    if (!this._searchIndex) return [];

    const results = this._searchIndex.search(searchTerm, {
      filter: (result) => (result as any).cid === cid,
    });

    const sorted = results
      .sort((a, b) => new Date((b as any).created_at).getTime() - new Date((a as any).created_at).getTime())
      .slice(0, limit);

    return sorted as unknown as StoredMessage[];
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

  /** The revision read and all writes stay in one IndexedDB transaction. */
  private _writeProviderCheckpoint(
    tx: IDBTransaction, userId: string, deviceId: string, bytes: Uint8Array,
    guard: ProviderWriteGuard | undefined, writeMetadata: () => void, reject: (error: unknown) => void,
  ): void {
    const meta = tx.objectStore(STORE_META), revisionKey = `provider_revision:${userId}:${deviceId}`;
    const fence = guard && {...guard};
    const request = meta.get(revisionKey);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      try {
        const current = request.result ?? null;
        if (current !== null && (typeof current !== 'string' || !current.length || current.length > 128)) {
          throw Object.assign(new Error('Provider checkpoint revision is invalid'), {code: 'provider_checkpoint_invalid'});
        }
        if (fence && (fence.expected_revision !== current || typeof fence.next_revision !== 'string' ||
            !fence.next_revision.length || fence.next_revision.length > 128 || fence.next_revision === current)) {
          throw Object.assign(new Error('Provider checkpoint base changed; reconcile durable state'), {code: 'provider_checkpoint_conflict'});
        }
        meta.put(bytes, `provider:${userId}:${deviceId}`);
        meta.put(fence ? fence.next_revision : randomId(), revisionKey);
        writeMetadata();
      } catch (error) { reject(error); tx.abort(); }
    };
  }

  async loadProviderCheckpoint(userId: string, deviceId: string): Promise<ProviderStorageCheckpoint> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readonly'), meta = tx.objectStore(STORE_META);
      const bytes = meta.get(`provider:${userId}:${deviceId}`), revision = meta.get(`provider_revision:${userId}:${deviceId}`);
      tx.oncomplete = () => {
        const value = revision.result ?? null;
        if (value !== null && (typeof value !== 'string' || !value.length || value.length > 128)) {
          reject(Object.assign(new Error('Provider checkpoint revision is invalid'), {code: 'provider_checkpoint_invalid'}));
        } else resolve({provider_bytes: bytes.result ?? null, revision: value});
      };
      tx.onerror = () => reject(tx.error || new Error('Provider checkpoint read aborted'));
      tx.onabort = () => reject(tx.error || new Error('Provider checkpoint read aborted'));
    });
  }

  async saveProviderState(userId: string, deviceId: string, providerBytes: Uint8Array, guard?: ProviderWriteGuard): Promise<void> {
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Provider checkpoint save aborted'));
      tx.onabort = () => reject(tx.error || new Error('Provider checkpoint save aborted'));
      this._writeProviderCheckpoint(tx, userId, deviceId, providerBytes, guard, () => {}, reject);
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

  readonly keyPackageOwnershipWorkVersion = 1 as const;

  private _readKeyPackageOwnershipWorkBase(tx: IDBTransaction, user: string, device: string,
    done: (base: KeyPackageOwnershipWorkBase) => void): void {
    const meta = tx.objectStore(STORE_META), identity = tx.objectStore(STORE_IDENTITY);
    const base: KeyPackageOwnershipWorkBase = {provider_bytes: null, identity_bytes: null, revision: null,
      checkpoint: null, lease: null, present: {provider_bytes: false, identity_bytes: false, revision: false, checkpoint: false, lease: false}};
    let left = 10;
    const finish = () => { if (--left === 0) done(base); };
    for (const [field, store, key] of [
      ['provider_bytes', meta, `provider:${user}:${device}`], ['revision', meta, `provider_revision:${user}:${device}`],
      ['identity_bytes', identity, `${user}:${device}`], ['checkpoint', meta, `${KP_OWNERSHIP_PREFIX}${user}:${device}`],
      ['lease', meta, `kp_ownership_lease:v1:${user}:${device}`],
    ] as const) {
      const value = store.get(key), presence = store.getKey(key);
      value.onsuccess = () => {
        (base as unknown as Record<string, unknown>)[field] = value.result === undefined ? null : value.result;
        if (field === 'lease' && typeof value.result?.retained_key === 'string' && value.result.retained_key.length <= 2048) {
          const retained: NonNullable<KeyPackageOwnershipWorkBase['retained']> = {key: value.result.retained_key, value: null, present: false}; base.retained = retained; left += 2;
          const record = meta.get(retained.key), exists = meta.getKey(retained.key);
          record.onsuccess = () => { retained.value = record.result === undefined ? null : record.result; finish(); };
          exists.onsuccess = () => { retained.present = exists.result !== undefined; finish(); };
        }
        finish();
      };
      presence.onsuccess = () => { base.present[field] = presence.result !== undefined; finish(); };
    }
  }

  async loadKeyPackageOwnershipWorkBase(user: string, device: string): Promise<KeyPackageOwnershipWorkBase> {
    if (this.accountId !== user) throw ownershipWorkError('recovery_scope_changed');
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_META, STORE_IDENTITY], 'readonly'); let base: KeyPackageOwnershipWorkBase;
      this._readKeyPackageOwnershipWorkBase(tx, user, device, value => { base = value; });
      tx.oncomplete = () => resolve(base);
      tx.onabort = () => reject(ownershipWorkFailure(tx.error, 'key_package_ownership_checkpoint_uncertain', 'uncertain'));
      tx.onerror = () => reject(ownershipWorkFailure(tx.error, 'key_package_ownership_checkpoint_uncertain', 'uncertain'));
    });
  }

  private _ownershipPrivateMatches(base: KeyPackageOwnershipWorkBase, owner: KeyPackageOwnershipWorkOwner): boolean {
    return base.present.provider_bytes && base.present.identity_bytes && base.present.revision &&
      base.provider_bytes instanceof Uint8Array && base.identity_bytes instanceof Uint8Array &&
      sameSyncCheckpointValue(base.provider_bytes, owner.provider_bytes) && sameSyncCheckpointValue(base.identity_bytes, owner.identity_bytes) &&
      base.revision === owner.revision;
  }
  private _ownershipWorkConflict(actual: KeyPackageOwnershipWorkBase, expected: KeyPackageOwnershipWorkBase): Error {
    const privateChanged = ['provider_bytes', 'identity_bytes', 'revision'].some(field =>
      !sameSyncCheckpointValue((actual as unknown as Record<string, unknown>)[field], (expected as unknown as Record<string, unknown>)[field]) ||
      actual.present[field as keyof typeof actual.present] !== expected.present[field as keyof typeof expected.present]);
    return Object.assign(ownershipWorkError('key_package_ownership_checkpoint_conflict'), {recovery_owner_conflict: privateChanged ? 'provider' : undefined});
  }
  private _assertOwnershipLeaseOwner(user: string, device: string, owner: KeyPackageOwnershipWorkOwner, value: unknown): asserts value is KeyPackageOwnershipLease {
    validateOwnershipLease(value);
    if (value.user_id !== user || value.device_id !== device || value.signing_identity_sha256 !== owner.signer || value.artifact_sha256 !== owner.artifact ||
        (value.retained_key !== undefined && !value.retained_key.startsWith(`kp_ownership_retained:v1:${user}:${device}:`)) ||
        value.provider_revision !== owner.revision || value.provider_sha256 !== sha256Hex(owner.provider_bytes) || value.identity_sha256 !== sha256Hex(owner.identity_bytes)) {
      throw ownershipWorkError('key_package_ownership_lease_conflict');
    }
  }

  private _assertOwnershipRetained(base: KeyPackageOwnershipWorkBase, user: string, device: string): void {
    const key = (base.lease as KeyPackageOwnershipLease | null)?.retained_key;
    if (!key) return;
    const row = base.retained?.value as {version?: number; reason?: string; source?: unknown} | null;
    if (!base.retained?.present || base.retained.key !== key || !row || row.version !== 1 || row.reason !== 'obsolete_signer_retained') throw ownershipWorkError('key_package_ownership_checkpoint_invalid');
    validateOwnershipCheckpoint(row.source);
    if (row.source.user_id !== user || row.source.device_id !== device) throw ownershipWorkError('key_package_ownership_checkpoint_invalid');
  }

  async verifyKeyPackageOwnershipWork(user: string, device: string, expected: KeyPackageOwnershipWorkBase,
    owner: KeyPackageOwnershipWorkOwner, assertOwner: () => void): Promise<void> {
    const captured = structuredClone(expected), original = structuredClone(owner); assertOwner();
    if (this.accountId !== user) throw ownershipWorkError('recovery_scope_changed');
    const db = await this.openDB(); assertOwner();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_META, STORE_IDENTITY], 'readonly'); let actual: KeyPackageOwnershipWorkBase;
      this._readKeyPackageOwnershipWorkBase(tx, user, device, value => { actual = value; });
      tx.oncomplete = () => { try {
        assertOwner();
        if (!this._ownershipPrivateMatches(actual, original)) throw Object.assign(ownershipWorkError('key_package_ownership_checkpoint_conflict'), {recovery_owner_conflict: 'provider'});
        if (!sameSyncCheckpointValue(actual, captured)) throw this._ownershipWorkConflict(actual, captured);
        this._assertOwnershipLeaseOwner(user, device, original, actual.lease);
        this._assertOwnershipRetained(actual, user, device);
        if (Date.now() < actual.lease.started_at || Date.now() >= actual.lease.lease_until) throw ownershipWorkError('key_package_ownership_lease_expired');
        resolve();
      } catch (error) { reject(error); } };
      tx.onabort = () => reject(ownershipWorkFailure(tx.error, 'key_package_ownership_checkpoint_uncertain', 'uncertain'));
      tx.onerror = () => reject(ownershipWorkFailure(tx.error, 'key_package_ownership_checkpoint_uncertain', 'uncertain'));
    }); assertOwner();
  }

  async saveKeyPackageOwnershipWork(user: string, device: string, expected: KeyPackageOwnershipWorkBase,
    owner: KeyPackageOwnershipWorkOwner, change: KeyPackageOwnershipWorkChange, assertOwner: () => void): Promise<KeyPackageOwnershipWorkBase> {
    const captured = structuredClone(expected), original = structuredClone(owner), next = structuredClone(change);
    if (this.accountId !== user) throw ownershipWorkError('recovery_scope_changed');
    validateOwnershipCheckpoint(next.checkpoint); this._assertOwnershipLeaseOwner(user, device, original, next.lease);
    if (next.checkpoint.user_id !== user || next.checkpoint.device_id !== device || next.checkpoint.signing_identity_sha256 !== owner.signer) throw ownershipWorkError('recovery_scope_changed');
    const wanted = {...captured, checkpoint: next.checkpoint, lease: next.lease, present: {...captured.present, checkpoint: true, lease: true}};
    const retainedKey = next.retain ? `kp_ownership_retained:v1:${user}:${device}:${sha256Hex(new TextEncoder().encode(JSON.stringify(next.retain)))}` : null;
    if (retainedKey !== (next.lease.retained_key || null) && next.retain) throw ownershipWorkError('key_package_ownership_checkpoint_invalid');
    if (!next.retain && next.lease.retained_key !== (captured.lease as KeyPackageOwnershipLease | null)?.retained_key) throw ownershipWorkError('key_package_ownership_checkpoint_invalid');
    if (next.retain) {
      validateOwnershipCheckpoint(next.retain);
      if (!captured.present.checkpoint || !sameSyncCheckpointValue(next.retain, captured.checkpoint) || next.retain.signing_identity_sha256 === owner.signer ||
          next.retain.user_id !== user || next.retain.device_id !== device) throw ownershipWorkError('key_package_ownership_checkpoint_invalid');
    }
    assertOwner(); const db = await this.openDB(); assertOwner();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_META, STORE_IDENTITY], 'readwrite'); let cause: unknown;
      const fail = (error: unknown) => { cause = error; tx.abort(); };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(ownershipWorkFailure(cause || tx.error, 'key_package_ownership_checkpoint_aborted', 'aborted'));
      tx.onerror = () => { cause ??= tx.error; };
      this._readKeyPackageOwnershipWorkBase(tx, user, device, actual => { try {
        assertOwner();
        if (!this._ownershipPrivateMatches(actual, original)) throw Object.assign(ownershipWorkError('key_package_ownership_checkpoint_conflict'), {recovery_owner_conflict: 'provider'});
        if (!sameSyncCheckpointValue(actual, captured)) throw this._ownershipWorkConflict(actual, captured);
        this._assertOwnershipRetained(actual, user, device);
        const now = Date.now();
        if (!Number.isSafeInteger(now) || now < next.lease.started_at || now >= next.lease.lease_until) throw ownershipWorkError('key_package_ownership_lease_expired');
        if (actual.present.lease) {
          validateOwnershipLease(actual.lease); const prior = actual.lease;
          if (prior.started_at > now) throw ownershipWorkError('key_package_ownership_clock_uncertain');
          if (prior.operation_id === next.lease.operation_id) {
            if (prior.status !== 'active' || prior.lease_until <= now || !sameSyncCheckpointValue({...prior, status: 'active'}, {...next.lease, status: 'active'})) throw ownershipWorkError('key_package_ownership_lease_conflict');
          } else if (prior.status === 'active' && prior.lease_until > now) throw ownershipWorkError('key_package_ownership_busy');
        }
        const meta = tx.objectStore(STORE_META);
        const put = () => { assertOwner(); meta.put(next.checkpoint, `${KP_OWNERSHIP_PREFIX}${user}:${device}`); meta.put(next.lease, `kp_ownership_lease:v1:${user}:${device}`); };
        if (!retainedKey) { put(); return; }
        const previous = meta.get(retainedKey), presence = meta.getKey(retainedKey); let left = 2;
        const retained = () => { if (--left) return; try {
          assertOwner();
          if (presence.result !== undefined) { if (!sameSyncCheckpointValue(previous.result?.source, next.retain)) throw ownershipWorkError('key_package_ownership_checkpoint_conflict'); }
          const retainedValue = presence.result !== undefined ? previous.result : {version: 1, reason: 'obsolete_signer_retained', source: next.retain, previous_lease: captured.lease, previous_lease_present: captured.present.lease, operation_id: next.lease.operation_id, observed_at: now};
          if (presence.result === undefined) meta.add(retainedValue, retainedKey);
          wanted.retained = {key: retainedKey, value: retainedValue, present: true};
          put();
        } catch (error) { fail(error); } };
        previous.onsuccess = retained; presence.onsuccess = retained;
      } catch (error) { fail(error); } });
    });
    try { assertOwner(); await this.verifyKeyPackageOwnershipWork(user, device, wanted, original, assertOwner); assertOwner(); }
    catch (error) { throw ownershipWorkFailure(error, 'key_package_ownership_checkpoint_uncertain', 'uncertain'); }
    return structuredClone(wanted);
  }

  async loadKeyPackageOwnershipCheckpoint(userId: string, deviceId: string): Promise<unknown | null> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readonly');
      const request = tx.objectStore(STORE_META).get(`${KP_OWNERSHIP_PREFIX}${userId}:${deviceId}`);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
      tx.onabort = () => reject(tx.error || new Error('Ownership checkpoint read aborted'));
    });
  }

  async saveKeyPackageOwnershipCheckpoint(checkpoint: KeyPackageOwnershipCheckpoint): Promise<void> {
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readwrite');
      tx.objectStore(STORE_META).put(checkpoint, `${KP_OWNERSHIP_PREFIX}${checkpoint.user_id}:${checkpoint.device_id}`);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Ownership checkpoint write aborted'));
    });
  }

  readonly keyPackageUploadWorkVersion = 1 as const;
  private async _keyPackageUploadWork(user: string, device: string, expected: PendingKeyPackageUpload | null,
    owner: KeyPackageUploadOwner, replacement: PendingKeyPackageUpload | null | undefined, assertCurrent: () => void): Promise<void> {
    assertCurrent(); const db = await this.openDB(); assertCurrent();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_META, STORE_IDENTITY], replacement === undefined ? 'readonly' : 'readwrite');
      const meta = tx.objectStore(STORE_META), key = `${KP_UPLOAD_PREFIX}${user}:${device}`;
      const rows = [meta.get(`provider:${user}:${device}`), tx.objectStore(STORE_IDENTITY).get(`${user}:${device}`), meta.get(`provider_revision:${user}:${device}`), meta.get(key)];
      let remaining = rows.length;
      const validate = () => {
        assertCurrent();
        if (!sameSyncCheckpointValue(rows[0].result, owner.provider_bytes) || !sameSyncCheckpointValue(rows[1].result, owner.identity_bytes) || rows[2].result !== owner.revision) {
          throw Object.assign(new Error('KeyPackage private checkpoint changed'), {code:'key_package_upload_checkpoint_conflict', recovery_owner_conflict:'provider'});
        }
        if (!sameSyncCheckpointValue(rows[3].result ?? null, expected)) throw Object.assign(new Error('KeyPackage upload work changed'), {code:'key_package_upload_checkpoint_conflict'});
      };
      for (const row of rows) row.onsuccess = () => {
        if (--remaining) return;
        try { validate(); if (replacement !== undefined) { if (replacement === null) meta.delete(key); else meta.put(replacement, key); } }
        catch (error) { reject(error); tx.abort(); }
      };
      tx.oncomplete = () => { try { assertCurrent(); resolve(); } catch (error) { reject(error); } };
      tx.onabort = tx.onerror = () => reject(Object.assign(new Error('KeyPackage work storage uncertain'), {code:'key_package_upload_checkpoint_uncertain'}));
    });
  }
  async verifyKeyPackageUploadWork(user: string, device: string, pending: PendingKeyPackageUpload, owner: KeyPackageUploadOwner, assertCurrent: () => void): Promise<void> {
    await this._keyPackageUploadWork(user, device, pending, owner, undefined, assertCurrent);
  }
  async settleKeyPackageUploadWork(user: string, device: string, pending: PendingKeyPackageUpload, owner: KeyPackageUploadOwner,
    replacement: PendingKeyPackageUpload | null, assertCurrent: () => void): Promise<void> {
    await this._keyPackageUploadWork(user, device, pending, owner, replacement, assertCurrent);
    await this._keyPackageUploadWork(user, device, replacement, owner, undefined, assertCurrent);
  }

  async loadPendingKeyPackageUpload(userId: string, deviceId: string): Promise<PendingKeyPackageUpload | null> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readonly');
      const request = tx.objectStore(STORE_META).get(`${KP_UPLOAD_PREFIX}${userId}:${deviceId}`);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
      tx.onabort = () => reject(tx.error || new Error('KeyPackage upload journal read aborted'));
    });
  }

  async saveKeyPackageUploadCheckpoint(userId: string, deviceId: string, providerBytes: Uint8Array, pending: PendingKeyPackageUpload, guard?: ProviderWriteGuard): Promise<void> {
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('KeyPackage upload checkpoint aborted'));
      try {
        const store = tx.objectStore(STORE_META);
        this._writeProviderCheckpoint(tx, userId, deviceId, providerBytes, guard,
          () => store.put(pending, `${KP_UPLOAD_PREFIX}${userId}:${deviceId}`), reject);
      } catch (error) { tx.abort(); reject(error); }
    });
  }

  async clearPendingKeyPackageUpload(userId: string, deviceId: string, operationId: string): Promise<void> {
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readwrite');
      const store = tx.objectStore(STORE_META), key = `${KP_UPLOAD_PREFIX}${userId}:${deviceId}`;
      const request = store.get(key);
      request.onsuccess = () => { if (request.result?.operation_id === operationId) store.delete(key); };
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('KeyPackage upload journal deletion aborted'));
    });
  }

  async loadExternalJoinCandidateCheckpoint(cid: string): Promise<ExternalJoinCandidateCheckpoint | null> {
    const db = await this.openDB();
    return new Promise((resolve,reject) => {
      const tx=db.transaction(STORE_META,'readonly');
      const req=tx.objectStore(STORE_META).get(`${EXTERNAL_CANDIDATE_PREFIX}${cid}`);
      req.onsuccess=()=>resolve(req.result || null); req.onerror=()=>reject(req.error);
      tx.onabort=()=>reject(tx.error || new Error('External candidate read aborted'));
    });
  }

  async loadRecoveryControlCheckpoint(cid: string, deviceId: string): Promise<RecoveryControlCheckpoint | null> {
    const db=await this.openDB();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE_META,'readonly'),request=tx.objectStore(STORE_META).get(recoveryControlKey(cid,deviceId));
      request.onsuccess=()=>resolve(request.result || null);request.onerror=()=>reject(request.error);
      tx.onabort=()=>reject(tx.error || new Error('Recovery control read aborted'));
    });
  }

  async listDueGroupInfoValidationAdmissions(deviceId: string, now: number, limit: number): Promise<GroupInfoValidationAdmission[]> {
    if (!Number.isSafeInteger(now) || now <= 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('Validation admission scan bounds invalid');
    const db = await this.openDB(), prefix = validationAdmissionPendingPrefix(deviceId);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readonly'), rows: GroupInfoValidationAdmission[] = [];
      const read = tx.objectStore(STORE_META).openCursor(IDBKeyRange.bound(prefix, `${prefix}${String(now).padStart(16, '0')}:\uffff`));
      read.onsuccess = () => { if(read.result && rows.length < limit) { rows.push(read.result.value); read.result.continue(); } };
      tx.oncomplete = () => resolve(rows); tx.onabort = () => reject(tx.error || new Error('Validation admission scan aborted')); tx.onerror = () => reject(tx.error);
    });
  }

  async loadGroupInfoValidationAdmission(cid:string,deviceId:string):Promise<GroupInfoValidationAdmission|null> {
    const db=await this.openDB();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE_META,'readonly'),request=tx.objectStore(STORE_META).get(`gi_validation_admission:v1:${encodeURIComponent(deviceId)}:${encodeURIComponent(cid)}`);
      request.onsuccess=()=>resolve(request.result || null);request.onerror=()=>reject(request.error);
      tx.onabort=()=>reject(tx.error || new Error('Validation admission read aborted'));
    });
  }

  readonly validationAdmissionSchedulingVersion = 1 as const;

  /** Scheduling disposition only; retain the exact admission and never consume an attempt. */
  async deferGroupInfoValidationAdmission(job: GroupInfoValidationAdmission, now: number, pause: boolean,
    owner: {provider_revision: string | null; marker: unknown; control: RecoveryControlCheckpoint | null}, assertOwner: () => void): Promise<boolean> {
    validateValidationAdmission(job);
    if (job.user_id !== this.accountId || !Number.isSafeInteger(now) || now <= 0 || !Number.isSafeInteger(now + 30_000)) throw new Error('Validation admission defer scope/clock invalid');
    const expected = structuredClone(job), captured = structuredClone(owner), db = await this.openDB();
    const key = `gi_validation_admission:v1:${encodeURIComponent(job.device_id)}:${encodeURIComponent(job.cid)}`,
      pausedKey = `gi_validation_admission_paused:v1:${encodeURIComponent(job.device_id)}:${encodeURIComponent(job.cid)}`;
    if (pause && captured.control?.recovery_action !== 'manual_intervention_required') throw new Error('Validation admission pause requires durable manual authority');
    const next = pause ? expected : {...expected, retry_at: Math.max(expected.retry_at, now + 30_000)}, paused = pause ? {job_id: job.job_id, reason: 'manual_intervention_required'} : null;
    let changed = false;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_META, STORE_GROUPS], 'readwrite'), meta = tx.objectStore(STORE_META);
      const read = meta.get(key), revision = meta.get(`provider_revision:${job.user_id}:${job.device_id}`),
        marker = tx.objectStore(STORE_GROUPS).get(job.cid), control = meta.get(recoveryControlKey(job.cid, job.device_id));
      let remaining = 4, failure: unknown;
      const finish = () => { if (--remaining) return; try {
        assertOwner();
        if (!sameSyncCheckpointValue(read.result || null, expected) || expected.outcome !== 'pending') return;
        if ((revision.result ?? null) !== captured.provider_revision || !sameSyncCheckpointValue(marker.result || null, captured.marker) ||
            !sameSyncCheckpointValue(control.result || null, captured.control)) throw Object.assign(new Error('Validation admission owner CAS conflict'), {code: 'recovery_checkpoint_conflict'});
        meta.delete(validationAdmissionPendingKey(expected)); meta.put(next, key);
        if (pause) meta.put(paused, pausedKey); else { meta.delete(pausedKey); meta.put(next, validationAdmissionPendingKey(next)); }
        changed = true;
      } catch (error) { failure = error; tx.abort(); } };
      for (const request of [read, revision, marker, control]) request.onsuccess = finish;
      tx.oncomplete = () => resolve(); tx.onerror = () => { failure ||= tx.error; };
      tx.onabort = () => reject(Object.assign(new Error('Validation admission defer aborted'), {cause: failure || tx.error, code: (failure as {code?: string})?.code, checkpoint_outcome: 'aborted'}));
    });
    assertOwner(); if (!changed) return false;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_META, STORE_GROUPS], 'readonly'), meta = tx.objectStore(STORE_META);
      const primary = meta.get(key), index = meta.get(validationAdmissionPendingKey(next)), oldIndex = meta.get(validationAdmissionPendingKey(expected)), disposition = meta.get(pausedKey),
        revision = meta.get(`provider_revision:${job.user_id}:${job.device_id}`), marker = tx.objectStore(STORE_GROUPS).get(job.cid),
        control = meta.get(recoveryControlKey(job.cid, job.device_id));
      tx.oncomplete = () => { try { assertOwner();
        if (!sameSyncCheckpointValue(primary.result || null, next) || !sameSyncCheckpointValue(index.result || null, pause ? null : next) ||
            !sameSyncCheckpointValue(oldIndex.result || null, !pause && validationAdmissionPendingKey(next) === validationAdmissionPendingKey(expected) ? next : null) ||
            !sameSyncCheckpointValue(disposition.result || null, paused) || (revision.result ?? null) !== captured.provider_revision ||
            !sameSyncCheckpointValue(marker.result || null, captured.marker) || !sameSyncCheckpointValue(control.result || null, captured.control))
          throw Object.assign(new Error('Validation admission defer proof mismatch'), {code: 'validation_ack_checkpoint_uncertain'});
        resolve();
      } catch (error) { reject(error); } };
      tx.onabort = () => reject(Object.assign(new Error('Validation admission defer proof aborted'), {code: 'validation_ack_checkpoint_uncertain'}));
      tx.onerror = () => reject(tx.error);
    });
    return true;
  }

  async reserveGroupInfoValidationAdmission(next:GroupInfoValidationAdmission,now:number,assertOwner?:()=>void):Promise<GroupInfoValidationAdmission|null> {
    validateValidationAdmission(next);
    if(next.user_id!==this.accountId || !Number.isSafeInteger(now) || now<=0 || !Number.isSafeInteger(now+30_000))throw new Error('Validation admission scope/clock invalid');
    const db=await this.openDB();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction([STORE_META,STORE_GROUPS],'readwrite'),meta=tx.objectStore(STORE_META);
      const key=`gi_validation_admission:v1:${encodeURIComponent(next.device_id)}:${encodeURIComponent(next.cid)}`;
      let selected:GroupInfoValidationAdmission|null=null;
      tx.oncomplete=()=>resolve(selected);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error || new Error('Validation admission reservation aborted'));
      const priorRead=meta.get(key);priorRead.onerror=()=>reject(priorRead.error);
      priorRead.onsuccess=()=>{try{
        const prior=priorRead.result as GroupInfoValidationAdmission|null;if(prior)validateValidationAdmission(prior);
        const same=!!prior && sameValidationAdmission(prior,next);
        if(same && ((prior.outcome!=='pending' && !(next.trigger==='manual' && prior.outcome==='prepared')) || prior.attempts>=3 || prior.retry_at>now))return;
        const controlRead=meta.get(recoveryControlKey(next.cid,next.device_id));controlRead.onerror=()=>reject(controlRead.error);
        controlRead.onsuccess=()=>{try{
          const control=controlRead.result as RecoveryControlCheckpoint|null;
          if(!control || control.cid!==next.cid || control.user_id!==next.user_id || control.device_id!==next.device_id || control.signing_identity_sha256!==next.signing_identity_sha256 ||
              control.group_generation!==next.group_generation || control.incident_id!==next.incident_id || control.recovery_revision!==next.recovery_revision ||
              !(next.trigger==='manual'?control.recovery_action==='manual_intervention_required':acceptsRecoveryEvidence(control.recovery_action)))return;
          const markerRead=tx.objectStore(STORE_GROUPS).get(next.cid);markerRead.onerror=()=>reject(markerRead.error);
          markerRead.onsuccess=()=>{try{
            const marker=markerRead.result;if(!marker || marker.cid!==next.cid || marker.status!=='active' || marker.group_generation!==next.group_generation || marker.current_epoch!==next.epoch)return;
            assertOwner?.();selected={...next,job_id:same?prior.job_id:next.job_id,attempts:(same?prior.attempts:0)+1,retry_at:now+30_000,outcome:'pending'};
            if(prior)meta.delete(validationAdmissionPendingKey(prior));
            meta.put(selected,key);meta.put(selected,validationAdmissionPendingKey(selected));meta.delete(`gi_validation_admission_paused:v1:${encodeURIComponent(next.device_id)}:${encodeURIComponent(next.cid)}`);
          }catch(error){tx.abort();reject(error);}};
        }catch(error){tx.abort();reject(error);}};
      }catch(error){tx.abort();reject(error);}};
    });
  }

  async finishGroupInfoValidationAdmission(cid:string,deviceId:string,jobId:string,attempt:number,prepared:boolean,assertOwner?:()=>void):Promise<void> {
    const db=await this.openDB();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE_META,'readwrite'),meta=tx.objectStore(STORE_META),key=`gi_validation_admission:v1:${encodeURIComponent(deviceId)}:${encodeURIComponent(cid)}`;
      tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error || new Error('Validation admission completion aborted'));
      const request=meta.get(key);request.onerror=()=>reject(request.error);
      request.onsuccess=()=>{try{
        const prior=request.result as GroupInfoValidationAdmission|null;if(!prior || prior.job_id!==jobId || prior.attempts!==attempt)return;
        validateValidationAdmission(prior);assertOwner?.();const next={...prior,outcome:prepared?'prepared' as const:prior.attempts>=3?'exhausted' as const:'pending' as const};
        meta.delete(validationAdmissionPendingKey(prior));meta.put(next,key);if(next.outcome==='pending')meta.put(next,validationAdmissionPendingKey(next));
      }catch(error){tx.abort();reject(error);}};
    });
  }

  readonly validationAdmissionWorkCheckpointVersion = 1 as const;

  /** Admission scheduling writes public metadata only against one frozen complete owned base. */
  async saveValidationAdmissionWork(userId:string,deviceId:string,cid:string,expected:MlsReadyBase,
    change:ValidationAdmissionWorkChange,assertOwner:()=>void):Promise<MlsReadyBase|null> {
    const captured=structuredClone(expected),request=structuredClone(change),prior=captured.admission;
    if(userId!==this.accountId || !captured.provider_bytes)throw recoveryControlError('validation_ack_scope_invalid');
    if(prior){validateValidationAdmission(prior);if(prior.user_id!==userId || prior.device_id!==deviceId || prior.cid!==cid)throw recoveryControlError('storage_corruption');}
    const paused=captured.admission_paused;
    if(paused && (!prior || prior.outcome!=='pending' || paused.job_id!==prior.job_id || paused.reason!=='manual_intervention_required'))throw recoveryControlError('storage_corruption');
    if(!sameSyncCheckpointValue(captured.admission_pending,prior?.outcome==='pending'&&!paused?prior:null))throw recoveryControlError('storage_corruption');
    let next=prior,nextPause=paused,apply=false;
    const blocked=[`mls_mutation:v1:${cid}`,`external_candidate:v1:${cid}`,`mls_removal:v1:${cid}`,`mls_rebootstrap_candidate:v1:${cid}`].some(k=>!!captured.cleanup.metadata[k]);
    if(request.kind==='reserve'){
      const job=request.job,now=request.now;validateValidationAdmission(job);
      if(job.user_id!==userId || job.device_id!==deviceId || job.cid!==cid || !Number.isSafeInteger(now) || now<=0 || !Number.isSafeInteger(now+30_000))throw recoveryControlError('validation_ack_admission_invalid');
      const control=captured.control,marker=captured.cleanup.marker as MlsGroupGenerationMarker|null,same=!!prior&&sameValidationAdmission(prior,job);
      if(control && marker && !blocked && control.user_id===userId && control.device_id===deviceId && control.cid===cid && control.signing_identity_sha256===job.signing_identity_sha256 &&
        control.group_generation===job.group_generation && control.incident_id===job.incident_id && control.recovery_revision===job.recovery_revision &&
        (job.trigger==='manual'?control.recovery_action==='manual_intervention_required':acceptsRecoveryEvidence(control.recovery_action)) && marker.status==='active' && marker.cid===cid && marker.group_generation===job.group_generation && marker.current_epoch===job.epoch &&
        !(same && ((prior!.outcome!=='pending' && !(job.trigger==='manual'&&prior!.outcome==='prepared')) || prior!.attempts>=3 || prior!.retry_at>now)) &&
        (!paused || job.trigger==='manual')){
        next={...job,job_id:same?prior!.job_id:job.job_id,attempts:(same?prior!.attempts:0)+1,retry_at:now+30_000,outcome:'pending'};nextPause=null;apply=true;
      }
    }else if(request.kind==='finish'){
      if(!Number.isSafeInteger(request.attempt)||request.attempt<0||request.attempt>3)throw recoveryControlError('validation_ack_admission_invalid');
      if(prior && prior.job_id===request.job_id && prior.attempts===request.attempt && prior.outcome==='pending'){
        if(request.prepared){const ack=captured.ack;
          if(!ack || !validationAckControlMatches(ack,captured.control) || !validationAckMarkerMatches(ack,captured.cleanup.marker as MlsGroupGenerationMarker|null) ||
            ack.request.incident_id!==prior.incident_id || ack.recovery_revision!==prior.recovery_revision || ack.request.epoch!==prior.epoch || ack.request.group_generation!==prior.group_generation ||
            ack.artifact_sha256!==prior.artifact_sha256 || ack.policy!==prior.policy || ack.trigger!==prior.trigger || ack.outcome==='stale')throw recoveryControlError('validation_ack_checkpoint_uncertain');
        }
        next={...prior,outcome:request.prepared?'prepared':prior.attempts>=3?'exhausted':'pending'};if(next.outcome!=='pending')nextPause=null;apply=true;
      }
    }else if(request.kind==='defer'){
      if(!Number.isSafeInteger(request.now)||request.now<=0||!Number.isSafeInteger(request.now+30_000))throw recoveryControlError('invalid_clock');
      if(request.pause && captured.control?.recovery_action!=='manual_intervention_required')throw recoveryControlError('validation_ack_admission_invalid');
      if(prior?.outcome==='pending'){
        if(!request.pause && paused)throw recoveryControlError('validation_ack_retry_deferred');
        next=request.pause?prior:{...prior,retry_at:Math.max(prior.retry_at,request.now+30_000)};
        nextPause=request.pause?{job_id:prior.job_id,reason:'manual_intervention_required'}:null;apply=true;
      }
    }else throw recoveryControlError('validation_ack_admission_invalid');
    const conflict=(actual:MlsReadyBase)=>this._groupInfoOwnerConflict(actual,captured,cid)||(!sameSyncCheckpointValue(actual.cleanup.metadata[`mls_rebootstrap_candidate:v1:${cid}`],captured.cleanup.metadata[`mls_rebootstrap_candidate:v1:${cid}`])?'scope':undefined);
    const db=await this.openDB();let selected=false,wanted:MlsReadyBase;
    await new Promise<void>((resolve,reject)=>{
      const tx=db.transaction([STORE_META,STORE_IDENTITY,STORE_GROUPS,STORE_PENDING_SENDS],'readwrite');let failure:unknown;
      tx.oncomplete=()=>resolve();tx.onerror=()=>{failure ||=tx.error;};tx.onabort=()=>reject(Object.assign(recoveryControlError('validation_ack_checkpoint_uncertain'),{cause:failure||tx.error,checkpoint_outcome:'aborted',recovery_owner_conflict:(failure as {recovery_owner_conflict?:string})?.recovery_owner_conflict}));
      this._readMlsReadyBase(tx,userId,deviceId,cid,actual=>{try{
        assertOwner();const kind=conflict(actual);if(kind)throw Object.assign(recoveryControlError('recovery_checkpoint_conflict'),{recovery_owner_conflict:kind});
        if(!sameSyncCheckpointValue(actual.admission,captured.admission)||!sameSyncCheckpointValue(actual.admission_pending,captured.admission_pending)||!sameSyncCheckpointValue(actual.admission_paused,captured.admission_paused)){wanted=actual;return;}
        if(!sameSyncCheckpointValue(actual,captured))throw recoveryControlError('recovery_checkpoint_conflict');
        wanted=actual;if(!apply || !next)return;
        const meta=tx.objectStore(STORE_META);if(prior)meta.delete(validationAdmissionPendingKey(prior));
        meta.put(next,`gi_validation_admission:v1:${encodeURIComponent(deviceId)}:${encodeURIComponent(cid)}`);
        const pauseKey=`gi_validation_admission_paused:v1:${encodeURIComponent(deviceId)}:${encodeURIComponent(cid)}`;
        if(nextPause)meta.put(nextPause,pauseKey);else meta.delete(pauseKey);
        const due=next.outcome==='pending'&&!nextPause?next:null;if(due)meta.put(due,validationAdmissionPendingKey(due));
        wanted={...captured,admission:structuredClone(next),admission_pending:due?structuredClone(due):null,admission_paused:structuredClone(nextPause)};selected=true;
      }catch(error){failure=error;tx.abort();}});
    });
    await new Promise<void>((resolve,reject)=>{
      const tx=db.transaction([STORE_META,STORE_IDENTITY,STORE_GROUPS,STORE_PENDING_SENDS],'readonly');let matches=false,oldMatches=true,kind:string|undefined;
      this._readMlsReadyBase(tx,userId,deviceId,cid,actual=>{matches=sameSyncCheckpointValue(actual,wanted);kind=conflict(actual);});
      if(selected && prior){const key=validationAdmissionPendingKey(prior),q=tx.objectStore(STORE_META).get(key);q.onsuccess=()=>{oldMatches=sameSyncCheckpointValue(q.result??null,wanted.admission_pending&&validationAdmissionPendingKey(wanted.admission_pending)===key?wanted.admission_pending:null);};}
      tx.oncomplete=()=>{try{assertOwner();if(!matches||!oldMatches)throw Object.assign(recoveryControlError('validation_ack_checkpoint_uncertain'),{recovery_owner_conflict:kind});resolve();}catch(error){reject(error);}};
      tx.onabort=()=>reject(Object.assign(recoveryControlError('validation_ack_checkpoint_uncertain'),{checkpoint_outcome:'uncertain'}));tx.onerror=()=>{};
    });
    assertOwner();return selected?structuredClone(wanted!):null;
  }

  readonly validationAckWorkCheckpointVersion = 1 as const;

  private _readValidationAckWorkBase(tx:IDBTransaction,userId:string,deviceId:string,cid:string,done:(base:ValidationAckWorkBase)=>void):void {
    this._readMlsReadyBase(tx,userId,deviceId,cid,state=>{
      if(!state.ack){done({state,pending:null});return;}
      const due=tx.objectStore(STORE_META).get(validationAckPendingKey(state.ack));
      due.onsuccess=()=>done({state,pending:due.result??null});
    });
  }

  async loadValidationAckWorkBase(userId:string,deviceId:string,cid:string):Promise<ValidationAckWorkBase> {
    if(userId!==this.accountId)throw recoveryControlError('recovery_scope_changed');
    const db=await this.openDB();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction([STORE_META,STORE_IDENTITY,STORE_GROUPS,STORE_PENDING_SENDS],'readonly');let value:ValidationAckWorkBase;
      this._readValidationAckWorkBase(tx,userId,deviceId,cid,base=>{value=base;});
      tx.oncomplete=()=>resolve(value);tx.onabort=()=>reject(recoveryControlError('validation_ack_checkpoint_uncertain'));tx.onerror=()=>{};
    });
  }

  /** Exact owned read-set CAS plus one consistent proof; never writes private provider/revision. */
  async saveValidationAckWork(userId:string,deviceId:string,cid:string,expected:ValidationAckWorkBase,
    next:GroupInfoValidationAckCheckpoint,assertOwner:()=>void):Promise<GroupInfoValidationAckCheckpoint|null> {
    const captured=structuredClone(expected),job=structuredClone(next);validateValidationAckCheckpoint(job);
    if(userId!==this.accountId || job.user_id!==userId || job.device_id!==deviceId || job.request.cid!==cid || !captured.state.provider_bytes)
      throw recoveryControlError('validation_ack_scope_invalid');
    if(captured.state.ack)validateValidationAckCheckpoint(captured.state.ack);
    if(!sameSyncCheckpointValue(captured.pending,captured.state.ack?.outcome==='pending'?captured.state.ack:null))throw recoveryControlError('storage_corruption');
    // A new validated tuple is not proof that an older submitted ACK was rejected.
    if(captured.state.ack?.outcome==='pending' && !sameValidationAckTuple(captured.state.ack,job))throw recoveryControlError('validation_ack_retry_deferred');
    const continuing=!!captured.state.ack && sameValidationAckTuple(captured.state.ack,job);
    if(!continuing){
      if(!validationAckMarkerMatches(job,captured.state.cleanup.marker as MlsGroupGenerationMarker|null) || !validationAckControlMatches(job,captured.state.control) ||
        sha256Hex(captured.state.provider_bytes)!==job.provider_sha256)throw recoveryControlError('validation_ack_checkpoint_invalid');
      if(job.trigger==='manual'){
        const a=captured.state.admission;if(!a)throw recoveryControlError('validation_ack_checkpoint_invalid');validateValidationAdmission(a);
        if(a.trigger!=='manual' || a.attempts<1 || a.outcome==='exhausted' || a.user_id!==job.user_id || a.device_id!==job.device_id ||
          a.signing_identity_sha256!==job.signing_identity_sha256 || a.cid!==cid || a.group_generation!==job.request.group_generation || a.epoch!==job.request.epoch ||
          a.incident_id!==job.request.incident_id || a.recovery_revision!==job.recovery_revision || a.artifact_sha256!==job.artifact_sha256 || a.policy!==job.policy)
          throw recoveryControlError('validation_ack_checkpoint_invalid');
      }
    }
    const db=await this.openDB();let selected:GroupInfoValidationAckCheckpoint|null=null,wanted:ValidationAckWorkBase;
    await new Promise<void>((resolve,reject)=>{
      const tx=db.transaction([STORE_META,STORE_IDENTITY,STORE_GROUPS,STORE_PENDING_SENDS],'readwrite');let failure:unknown;
      tx.oncomplete=()=>resolve();tx.onerror=()=>{failure ||=tx.error;};tx.onabort=()=>reject(Object.assign(recoveryControlError('validation_ack_checkpoint_uncertain'),
        {cause:failure||tx.error,checkpoint_outcome:'aborted',recovery_owner_conflict:(failure as {recovery_owner_conflict?:string})?.recovery_owner_conflict}));
      this._readValidationAckWorkBase(tx,userId,deviceId,cid,actual=>{try{
        assertOwner();
        const kind=this._groupInfoOwnerConflict(actual.state,captured.state,cid);
        if(kind)throw Object.assign(recoveryControlError('recovery_checkpoint_conflict'),{recovery_owner_conflict:kind});
        // Another public job owns this key. Preserve it and prove the no-op without adopting a private revision.
        if(!sameSyncCheckpointValue(actual.state.ack,captured.state.ack)){wanted=actual;return;}
        if(!sameSyncCheckpointValue(actual,captured))throw recoveryControlError('recovery_checkpoint_conflict');
        const meta=tx.objectStore(STORE_META);if(actual.state.ack)meta.delete(validationAckPendingKey(actual.state.ack));
        meta.put(job,validationAckKey(cid,deviceId));if(job.outcome==='pending')meta.put(job,validationAckPendingKey(job));
        selected=job;wanted={state:{...captured.state,ack:job},pending:job.outcome==='pending'?job:null};
      }catch(error){failure=error;tx.abort();}});
    });
    await new Promise<void>((resolve,reject)=>{
      const tx=db.transaction([STORE_META,STORE_IDENTITY,STORE_GROUPS,STORE_PENDING_SENDS],'readonly');let matches=false,oldIndexMatches=true,kind:string|undefined;
      this._readValidationAckWorkBase(tx,userId,deviceId,cid,actual=>{matches=sameSyncCheckpointValue(actual,wanted);kind=this._groupInfoOwnerConflict(actual.state,captured.state,cid);});
      if(selected && captured.state.ack?.outcome==='pending'){
        const oldKey=validationAckPendingKey(captured.state.ack),old=tx.objectStore(STORE_META).get(oldKey);
        old.onsuccess=()=>{oldIndexMatches=sameSyncCheckpointValue(old.result??null,wanted.pending && validationAckPendingKey(wanted.pending)===oldKey?wanted.pending:null);};
      }
      tx.oncomplete=()=>{try{assertOwner();if(!matches || !oldIndexMatches)throw Object.assign(recoveryControlError('validation_ack_checkpoint_uncertain'),{recovery_owner_conflict:kind});resolve();}catch(error){reject(error);}};
      tx.onabort=()=>reject(Object.assign(recoveryControlError('validation_ack_checkpoint_uncertain'),{checkpoint_outcome:'uncertain'}));tx.onerror=()=>{};
    });
    assertOwner();return selected;
  }

  async loadGroupInfoValidationAckCheckpoint(cid: string,deviceId: string): Promise<GroupInfoValidationAckCheckpoint | null> {
    const db=await this.openDB();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE_META,'readonly'),request=tx.objectStore(STORE_META).get(validationAckKey(cid,deviceId));
      request.onsuccess=()=>resolve(request.result || null);request.onerror=()=>reject(request.error);
      tx.onabort=()=>reject(tx.error || new Error('Validation ACK read aborted'));
    });
  }

  async saveGroupInfoValidationAckCheckpoint(next:GroupInfoValidationAckCheckpoint,providerBytes:Uint8Array,previousJobId:string|null,assertOwner?:()=>void):Promise<GroupInfoValidationAckCheckpoint> {
    validateValidationAckCheckpoint(next);
    if (next.user_id!==this.accountId || next.attempts!==0 || next.outcome!=='pending' || sha256Hex(providerBytes)!==next.provider_sha256) throw new Error('Validation ACK initial scope invalid');
    const db=await this.openDB();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction([STORE_META,STORE_GROUPS],'readwrite'),meta=tx.objectStore(STORE_META),key=validationAckKey(next.request.cid,next.device_id);
      let selected:GroupInfoValidationAckCheckpoint;
      tx.oncomplete=()=>resolve(selected);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error || new Error('Validation ACK checkpoint aborted'));
      const request=meta.get(key);
      request.onsuccess=()=>{try{
        const prior=request.result as GroupInfoValidationAckCheckpoint|null;
        if(prior)validateValidationAckCheckpoint(prior);
        if(prior && sameValidationAckTuple(prior,next)){
          if(prior.outcome==='accepted' || prior.outcome==='exhausted'){selected=prior;return;}
          next={...next,job_id:prior.outcome==='pending'?prior.job_id:next.job_id,attempts:prior.attempts,retry_at:Math.max(next.retry_at,prior.retry_at)};
        }
        if((prior?.job_id || null)!==previousJobId)throw new Error('Validation ACK job CAS failed');
        const provider=meta.get(`provider:${next.user_id}:${next.device_id}`);
        provider.onerror=()=>reject(provider.error);provider.onsuccess=()=>{try{
          const bytes=provider.result;
          if(!(bytes instanceof Uint8Array) || bytes.length!==providerBytes.length || !bytes.every((v:number,i:number)=>v===providerBytes[i]))throw new Error('Validation ACK provider CAS failed');
          const marker=tx.objectStore(STORE_GROUPS).get(next.request.cid);
          marker.onerror=()=>reject(marker.error);marker.onsuccess=()=>{try{
            if(!validationAckMarkerMatches(next,marker.result))throw new Error('Validation ACK durable group mismatch');
            const control=meta.get(recoveryControlKey(next.request.cid,next.device_id));
            control.onerror=()=>reject(control.error);control.onsuccess=()=>{try{
              if(!validationAckControlMatches(next,control.result))throw new Error('Validation ACK control CAS failed');
              assertOwner?.();
              if(prior?.outcome==='pending')meta.delete(validationAckPendingKey(prior));
              selected=next;meta.put(next,key);meta.put(next,validationAckPendingKey(next));
            }catch(error){tx.abort();reject(error);}};
          }catch(error){tx.abort();reject(error);}};
        }catch(error){tx.abort();reject(error);}};
      }catch(error){tx.abort();reject(error);}};
      request.onerror=()=>reject(request.error);
    });
  }

  async listDueGroupInfoValidationAcks(deviceId:string,now:number,limit:number):Promise<GroupInfoValidationAckCheckpoint[]> {
    if(!Number.isSafeInteger(now) || now<=0 || !Number.isSafeInteger(limit) || limit<1 || limit>50)throw new Error('Validation ACK scan bounds invalid');
    const db=await this.openDB(),prefix=validationAckPendingPrefix(deviceId);
    return new Promise((resolve,reject)=>{
      const result:GroupInfoValidationAckCheckpoint[]=[],tx=db.transaction(STORE_META,'readonly');
      const request=tx.objectStore(STORE_META).openCursor(IDBKeyRange.bound(prefix,`${prefix}${String(now).padStart(16,'0')}:\uffff`));
      request.onsuccess=()=>{const cursor=request.result;if(cursor && result.length<limit){result.push(cursor.value);cursor.continue();}};
      request.onerror=()=>reject(request.error);tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(tx.error || new Error('Validation ACK scan aborted'));
    });
  }

  /** Move blocked work behind due peers, preserving tuple, body and attempt budget. */
  async deferGroupInfoValidationAck(job: GroupInfoValidationAckCheckpoint, now: number, assertOwner: () => void): Promise<void> {
    validateValidationAckCheckpoint(job);
    if (job.user_id !== this.accountId || !Number.isSafeInteger(now) || now <= 0 || !Number.isSafeInteger(now + 30_000)) throw new Error('Validation ACK defer scope/clock invalid');
    const expected = structuredClone(job), db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readwrite'), meta = tx.objectStore(STORE_META), key = validationAckKey(job.request.cid, job.device_id);
      let failure: unknown;
      const read = meta.get(key);
      read.onsuccess = () => { try {
        assertOwner(); const prior = read.result as GroupInfoValidationAckCheckpoint | null;
        if (!prior || !sameSyncCheckpointValue(prior, expected) || prior.outcome !== 'pending') return;
        const next = {...prior, retry_at: Math.max(prior.retry_at, now + 30_000)};
        meta.delete(validationAckPendingKey(prior)); meta.put(next, key); meta.put(next, validationAckPendingKey(next));
      } catch (error) { failure = error; tx.abort(); } };
      tx.oncomplete = () => resolve(); tx.onerror = () => { failure ||= tx.error; };
      tx.onabort = () => reject(failure || tx.error || new Error('Validation ACK defer aborted'));
    });
  }

  async reserveGroupInfoValidationAckAttempt(cid:string,deviceId:string,jobId:string,now:number,assertOwner?:()=>void):Promise<GroupInfoValidationAckCheckpoint|null> {
    if(!Number.isSafeInteger(now) || now<=0 || !Number.isSafeInteger(now+30_000))throw new Error('Validation ACK clock invalid');
    const db=await this.openDB();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction([STORE_META,STORE_GROUPS],'readwrite'),meta=tx.objectStore(STORE_META),key=validationAckKey(cid,deviceId);
      let selected:GroupInfoValidationAckCheckpoint|null=null;
      tx.oncomplete=()=>resolve(selected);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error || new Error('Validation ACK reservation aborted'));
      const request=meta.get(key);request.onerror=()=>reject(request.error);
      request.onsuccess=()=>{try{
        const prior=request.result as GroupInfoValidationAckCheckpoint|null;if(!prior || prior.job_id!==jobId)return;
        validateValidationAckCheckpoint(prior);if(prior.user_id!==this.accountId)throw new Error('Validation ACK account mismatch');
        if(prior.outcome!=='pending' || prior.retry_at>now)return;
        if(prior.attempts>=3){meta.delete(validationAckPendingKey(prior));meta.put({...prior,outcome:'exhausted'},key);return;}
        const marker=tx.objectStore(STORE_GROUPS).get(cid);marker.onerror=()=>reject(marker.error);
        marker.onsuccess=()=>{try{
          if(!validationAckMarkerMatches(prior,marker.result)){
            return;
          }
          const control=meta.get(recoveryControlKey(cid,deviceId));control.onerror=()=>reject(control.error);
          control.onsuccess=()=>{try{
            if(!validationAckControlMatches(prior,control.result)){
              return;
            }
            const provider=meta.get(`provider:${prior.user_id}:${prior.device_id}`);provider.onerror=()=>reject(provider.error);
            provider.onsuccess=()=>{try{
              if(!(provider.result instanceof Uint8Array) || sha256Hex(provider.result)!==prior.provider_sha256){
                return;
              }
              assertOwner?.();selected={...prior,attempts:prior.attempts+1,retry_at:now+30_000};
              meta.delete(validationAckPendingKey(prior));meta.put(selected,key);meta.put(selected,validationAckPendingKey(selected));
            }catch(error){tx.abort();reject(error);}};
          }catch(error){tx.abort();reject(error);}};
        }catch(error){tx.abort();reject(error);}};
      }catch(error){tx.abort();reject(error);}};
    });
  }

  async finishGroupInfoValidationAckAttempt(cid:string,deviceId:string,jobId:string,outcome:GroupInfoValidationAckCheckpoint['outcome'],attempt?:number,assertOwner?:()=>void):Promise<void> {
    if(!['pending','accepted','stale','exhausted'].includes(outcome))throw new Error('Validation ACK outcome invalid');
    const db=await this.openDB();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE_META,'readwrite'),meta=tx.objectStore(STORE_META),key=validationAckKey(cid,deviceId);
      tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error || new Error('Validation ACK completion aborted'));
      const request=meta.get(key);request.onerror=()=>reject(request.error);request.onsuccess=()=>{try{
        const prior=request.result as GroupInfoValidationAckCheckpoint|null;if(!prior || prior.job_id!==jobId)return;
        validateValidationAckCheckpoint(prior);if(prior.user_id!==this.accountId)throw new Error('Validation ACK account mismatch');
        if(prior.outcome!=='pending' || (attempt!==undefined && prior.attempts!==attempt))return;assertOwner?.();
        const next={...prior,outcome:outcome==='pending' && prior.attempts>=3 ? 'exhausted' as const : outcome};
        meta.delete(validationAckPendingKey(prior));meta.put(next,key);
        if(next.outcome==='pending')meta.put(next,validationAckPendingKey(next));
      }catch(error){tx.abort();reject(error);}};
    });
  }

  async saveRecoveryControlCheckpoint(next: RecoveryControlCheckpoint,
    owner?: {provider_revision: string | null; marker: unknown}, assertOwner?: () => void): Promise<RecoveryControlCheckpoint> {
    if (next.user_id!==this.accountId) throw new Error('Recovery control account mismatch');
    const db=await this.openDB();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction([STORE_META,STORE_GROUPS],'readwrite'),meta=tx.objectStore(STORE_META),key=recoveryControlKey(next.cid,next.device_id);
      let selected: RecoveryControlCheckpoint;
      const request=meta.get(key),revision=meta.get(`provider_revision:${next.user_id}:${next.device_id}`),marker=tx.objectStore(STORE_GROUPS).get(next.cid);
      let remaining=3;
      const finish=()=>{if(--remaining)return;try {
        assertOwner?.();
        if(owner && (revision.result!==owner.provider_revision || !sameSyncCheckpointValue(marker.result || null,owner.marker))) throw Object.assign(new Error('Recovery owner CAS conflict'),{code:'recovery_checkpoint_conflict'});
        selected=selectRecoveryControl(request.result || null,next);meta.put(selected,key);
      }catch(error){tx.abort();reject(error);}};
      request.onsuccess=finish;revision.onsuccess=finish;marker.onsuccess=finish;
      tx.oncomplete=()=>resolve(selected);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error || new Error('Recovery control save aborted'));
    });
  }

  readonly recoveryControlWorkCheckpointVersion = 1 as const;

  readonly channelEvidenceWorkVersion=1 as const;
  private _readChannelEvidence(tx:IDBTransaction,user:string,device:string,cid:string,evidence:string,done:(base:ChannelEvidenceBase)=>void):void {
    let state:MlsReadyBase,work:ChannelEvidenceWork|null=null,left=2;
    const finish=()=>{if(!--left)done({state,work});};
    this._readMlsReadyBase(tx,user,device,cid,value=>{state=value;finish();});
    const request=tx.objectStore(STORE_META).get(channelEvidenceKey(device,cid,evidence));
    request.onsuccess=()=>{work=request.result??null;finish();};
  }
  async loadChannelEvidenceWork(user:string,device:string,cid:string,evidence:string):Promise<ChannelEvidenceBase> {
    if(user!==this.accountId)throw recoveryControlError('recovery_scope_changed');
    const db=await this.openDB();return new Promise((resolve,reject)=>{
      const tx=db.transaction([STORE_META,STORE_IDENTITY,STORE_GROUPS,STORE_PENDING_SENDS],'readonly');let result:ChannelEvidenceBase;
      this._readChannelEvidence(tx,user,device,cid,evidence,base=>{result=base;});
      tx.oncomplete=()=>{try{if(result.work)validateChannelEvidence(result.work);resolve(result);}catch(error){reject(error);}};tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
    });
  }
  async saveChannelEvidenceWork(user:string,device:string,cid:string,expected:ChannelEvidenceBase,next:ChannelEvidenceWork,assertOwner:()=>void):Promise<ChannelEvidenceBase> {
    const captured=structuredClone(expected),row=structuredClone(next);validateChannelEvidence(row);
    if(user!==this.accountId || row.user_id!==user || row.device_id!==device || row.cid!==cid ||
      !captured.state.provider_bytes || !captured.state.identity_bytes)throw recoveryControlError('recovery_scope_changed');
    const wanted={...captured,work:row};assertOwner();const db=await this.openDB();assertOwner();
    await new Promise<void>((resolve,reject)=>{
      const tx=db.transaction([STORE_META,STORE_IDENTITY,STORE_GROUPS,STORE_PENDING_SENDS],'readwrite');let failure:unknown;
      this._readChannelEvidence(tx,user,device,cid,row.evidence,actual=>{try{assertOwner();
        if(!sameSyncCheckpointValue(actual,captured))throw Object.assign(recoveryControlError('recovery_checkpoint_conflict'),
          {recovery_owner_conflict:this._groupInfoOwnerConflict(actual.state,captured.state,cid)});
        if(captured.work && row.job_id!==captured.work.job_id){
          if(!row.observation||row.observation===captured.work.observation||row.attempts!==1 ||
            !((captured.work.outcome==='exhausted'&&!['client_upgrade_required','mls_device_unauthorized','group_info_claimant_removed'].includes(captured.work.last_reason||'')&&!!row.resume_transport_id&&row.resume_transport_id!==captured.work.transport_id&&row.resume_transport_id!==captured.work.resume_transport_id&&sameSyncCheckpointValue(captured.work.request,row.request)) ||
              (captured.work.outcome==='finished'&&captured.state.control?.recovery_action==='waiting_for_evidence'&&row.transport_id!==captured.work.transport_id&&row.request?.trigger==='transport_recovered'&&row.request.trigger_id===row.transport_id)))
            throw recoveryControlError('recovery_checkpoint_conflict');
          tx.objectStore(STORE_META).put(captured.work,`channel_evidence_history:v1:${encodeURIComponent(device)}:${encodeURIComponent(cid)}:${captured.work.job_id||captured.work.evidence}`);
        }
        tx.objectStore(STORE_META).put(row,channelEvidenceKey(device,cid,row.evidence));
      }catch(error){failure=error;tx.abort();}});
      tx.oncomplete=()=>resolve();tx.onerror=()=>{failure ||=tx.error;};tx.onabort=()=>reject(failure||tx.error);
    });assertOwner();
    const actual=await this.loadChannelEvidenceWork(user,device,cid,row.evidence);assertOwner();
    if(!sameSyncCheckpointValue(actual,wanted))throw Object.assign(recoveryControlError('recovery_checkpoint_uncertain'),
      {recovery_owner_conflict:this._groupInfoOwnerConflict(actual.state,wanted.state,cid)});
    const previousWork=captured.work;
    if(previousWork && row.job_id!==previousWork.job_id){
      const archived=await new Promise<unknown>((resolve,reject)=>{const tx=db.transaction(STORE_META,'readonly');
        const read=tx.objectStore(STORE_META).get(`channel_evidence_history:v1:${encodeURIComponent(device)}:${encodeURIComponent(cid)}:${previousWork.job_id||previousWork.evidence}`);
        tx.oncomplete=()=>resolve(read.result);tx.onabort=()=>reject(tx.error);});assertOwner();
      if(!sameSyncCheckpointValue(archived,captured.work))throw recoveryControlError('recovery_checkpoint_uncertain');
    }
    return structuredClone(wanted);
  }

  async saveRecoveryControlWork(userId:string,deviceId:string,cid:string,expected:MlsReadyBase,
    next:RecoveryControlCheckpoint,assertOwner:()=>void):Promise<MlsReadyBase> {
    const captured=structuredClone(expected),submitted=structuredClone(next);
    validateRecoveryControl(submitted);
    if(userId!==this.accountId || submitted.user_id!==userId || submitted.device_id!==deviceId || submitted.cid!==cid ||
      !captured.provider_bytes || !captured.identity_bytes)throw recoveryControlError('recovery_scope_changed');
    const selected=selectRecoveryControl(captured.control,submitted),wanted={...captured,control:selected};
    assertOwner();const db=await this.openDB();assertOwner();
    await new Promise<void>((resolve,reject)=>{
      const tx=db.transaction([STORE_META,STORE_IDENTITY,STORE_GROUPS,STORE_PENDING_SENDS],'readwrite');let failure:unknown;
      tx.oncomplete=()=>resolve();tx.onerror=()=>{failure ||=tx.error;};tx.onabort=()=>reject(Object.assign(recoveryControlError('recovery_checkpoint_uncertain'),
        {cause:failure||tx.error,checkpoint_outcome:'aborted',recovery_owner_conflict:(failure as {recovery_owner_conflict?:string})?.recovery_owner_conflict}));
      this._readMlsReadyBase(tx,userId,deviceId,cid,actual=>{try{assertOwner();
        if(!sameSyncCheckpointValue(actual,captured))throw Object.assign(recoveryControlError('recovery_checkpoint_conflict'),
          {recovery_owner_conflict:this._groupInfoOwnerConflict(actual,captured,cid)});
        tx.objectStore(STORE_META).put(selected,recoveryControlKey(cid,deviceId));
      }catch(error){failure=error;tx.abort();}});
    });
    assertOwner();
    await new Promise<void>((resolve,reject)=>{
      const tx=db.transaction([STORE_META,STORE_IDENTITY,STORE_GROUPS,STORE_PENDING_SENDS],'readonly');let matches=false,kind:string|undefined;
      this._readMlsReadyBase(tx,userId,deviceId,cid,actual=>{matches=sameSyncCheckpointValue(actual,wanted);kind=this._groupInfoOwnerConflict(actual,wanted,cid);});
      tx.oncomplete=()=>{try{assertOwner();if(!matches)throw Object.assign(recoveryControlError('recovery_checkpoint_uncertain'),{recovery_owner_conflict:kind});resolve();}catch(error){reject(error);}};
      tx.onabort=()=>reject(Object.assign(recoveryControlError('recovery_checkpoint_uncertain'),{checkpoint_outcome:'uncertain'}));tx.onerror=()=>{};
    });
    assertOwner();return structuredClone(wanted);
  }

  readonly welcomeHistoryWorkVersion = 1 as const;

  private _readWelcomeHistoryWork(tx: IDBTransaction, device: string, cid: string, done: (base: WelcomeHistoryWorkBase) => void): void {
    const meta = tx.objectStore(STORE_META), base: WelcomeHistoryWorkBase = {work: null, due: null, paused: null, source_revision: null, cursor: null, present: {work: false, due: false, paused: false, source_revision: false, cursor: false}}; let left = 10;
    for (const [field, key] of [['work', welcomeHistoryWorkKey(device, cid)], ['due', welcomeHistoryDueKey(device, cid)],
      ['paused', welcomeHistoryPausedKey(device, cid)], ['source_revision', welcomeHistorySourceKey(device, cid)],
      ['cursor', `welcome_retention_cursor:v1:${encodeURIComponent(device)}:${encodeURIComponent(cid)}`]] as const) {
      const read = meta.get(key); read.onsuccess = () => { (base as unknown as Record<string, unknown>)[field] = read.result ?? null; if (!--left) done(base); };
      const present = meta.getKey(key); present.onsuccess = () => { base.present[field] = present.result !== undefined; if (!--left) done(base); };
    }
  }

  async loadWelcomeHistoryWork(user: string, device: string, cid: string): Promise<WelcomeHistoryWorkBase> {
    if (user !== this.accountId || !device || !cid) throw recoveryControlError('recovery_scope_changed');
    const db = await this.openDB(); return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readonly'); let result: WelcomeHistoryWorkBase;
      this._readWelcomeHistoryWork(tx, device, cid, value => { result = value; });
      tx.oncomplete = () => resolve(result); tx.onabort = () => reject(recoveryControlError('recovery_checkpoint_uncertain')); tx.onerror = () => {};
    });
  }

  private _assertWelcomeHistoryOriginal(actual: MlsReadyBase, owner: WelcomeHistoryContinuation['owner'], cid: string): void {
    if (!sameSyncCheckpointValue(actual.provider_bytes, owner.provider_bytes) || !sameSyncCheckpointValue(actual.identity_bytes, owner.identity_bytes) || actual.revision !== owner.revision)
      throw Object.assign(recoveryControlError('recovery_checkpoint_conflict'), {recovery_owner_conflict: 'provider'});
    if (!sameSyncCheckpointValue(actual.cleanup.marker, owner.marker) || !sameSyncCheckpointValue(actual.control, owner.control) ||
        !sameSyncCheckpointValue(actual.cleanup.metadata[`mls_mutation:v1:${cid}`], owner.pending) || !sameSyncCheckpointValue(actual.cleanup.metadata[`external_candidate:v1:${cid}`], owner.external))
      throw Object.assign(recoveryControlError('recovery_checkpoint_conflict'), {recovery_owner_conflict: 'scope'});
  }

  private _validateWelcomeHistoryWorkBase(base: WelcomeHistoryWorkBase, user: string, device: string, cid: string, owner: WelcomeHistoryContinuation['owner']): void {
    if (!base.present || Object.values(base.present).some(value => typeof value !== 'boolean')) throw recoveryControlError('storage_corruption');
    for (const field of ['work', 'due', 'paused', 'source_revision', 'cursor'] as const) if (base.present[field] && base[field] === null) throw recoveryControlError('storage_corruption');
    if (base.source_revision !== null && (typeof base.source_revision !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(base.source_revision))) throw recoveryControlError('client_upgrade_required');
    const row = base.work;
    if (!row) { if (base.due || base.paused) throw recoveryControlError('storage_corruption'); return; }
    if (!externalCandidateScanComparable(row) || !validWelcomeHistoryWork(row)) throw recoveryControlError(row?.version !== 1 ? 'client_upgrade_required' : 'storage_corruption');
    if (row.user_id !== user || row.device_id !== device || row.cid !== cid || row.signing_identity_sha256 !== owner.signer || row.artifact_sha256 !== owner.artifact) throw recoveryControlError('recovery_scope_changed');
    const prefix = externalWelcomePrefix(cid, device);
    if (row.after !== null && (!row.after.startsWith(prefix) || row.after >= prefix + '\uffff') || row.upper_fence !== null && (!row.upper_fence.startsWith(prefix) || row.upper_fence >= prefix + '\uffff') ||
        row.after !== null && row.upper_fence !== null && row.after > row.upper_fence) throw recoveryControlError('storage_corruption');
    if (!sameSyncCheckpointValue(base.due, row.status === 'pending' ? row : null) || !sameSyncCheckpointValue(base.paused, row.status === 'paused' ? row : null)) throw recoveryControlError('storage_corruption');
  }

  private _putWelcomeHistoryWork(meta: IDBObjectStore, device: string, cid: string, work: WelcomeHistoryWork): void {
    meta.put(work, welcomeHistoryWorkKey(device, cid));
    if (work.status === 'pending') meta.put(work, welcomeHistoryDueKey(device, cid)); else meta.delete(welcomeHistoryDueKey(device, cid));
    if (work.status === 'paused') meta.put(work, welcomeHistoryPausedKey(device, cid)); else meta.delete(welcomeHistoryPausedKey(device, cid));
  }

  /** Intake coalesces stable source identity. Fresh attempt UUIDs do not reopen a stopped pass. */
  async saveWelcomeHistoryWork(user: string, device: string, cid: string, expected: WelcomeHistoryWorkBase,
    continuation: WelcomeHistoryContinuation, now: number): Promise<WelcomeHistoryWorkBase> {
    const captured = structuredClone(expected), owner = structuredClone(continuation.owner), operation = continuation.operation_id,
      intent = continuation.intent_key || '', assertOwner = continuation.assertOwner;
    if (typeof operation !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(operation)) throw recoveryControlError('storage_corruption');
    if (user !== this.accountId || !device || cid.indexOf(':') <= 0 || cid.length > 512 || !/^[0-9a-f]{64}$/.test(owner.signer) || !/^[0-9a-f]{64}$/.test(owner.artifact) || intent.length > 2048) throw recoveryControlError('recovery_scope_changed');
    if (!Number.isSafeInteger(now) || now <= 0 || !Number.isSafeInteger(now + 30_000)) throw recoveryControlError('invalid_clock');
    this._validateWelcomeHistoryWorkBase(captured, user, device, cid, owner);
    assertOwner(); const original = await this.loadMlsReadyBase(user, device, cid); assertOwner(); this._assertWelcomeHistoryOriginal(original, owner, cid);
    const control = original.control; if (control) { validateRecoveryControl(control);
      if (control.user_id !== user || control.device_id !== device || control.cid !== cid || control.signing_identity_sha256 !== owner.signer) throw recoveryControlError('recovery_scope_changed'); }
    const prior = captured.work, generation = control?.group_generation ?? (original.cleanup.marker as MlsGroupGenerationMarker | null)?.group_generation ?? 0,
      revision = control?.recovery_revision ?? null;
    const newer = !!control && (!prior || generation > prior.group_generation || generation === prior.group_generation && revision !== null && (prior.control_revision === null || BigInt(revision) > BigInt(prior.control_revision)));
    const policy = control?.recovery_action === 'manual_intervention_required' ? 'manual_intervention_required' :
      control?.recovery_action === 'repair' && now >= Date.parse(control.repair_retry_until!) ? 'authoritative_deadline_pending' : null;
    let next: WelcomeHistoryWork | null = prior ? structuredClone(prior) : null, begin = !prior || prior.status === 'complete' || newer;
    if (prior?.status === 'paused') begin = prior.reason === 'welcome_history_blocked' ? newer || prior.source_revision !== captured.source_revision : newer;
    if (prior?.status === 'pending' && !begin && captured.source_revision !== prior.source_revision) next = {...prior, intent_id: operation, intent_key: intent, dirty: true};
    if (begin) next = {version: 1, job_id: operation, intent_id: operation, intent_key: intent, user_id: user, device_id: device, cid,
      signing_identity_sha256: owner.signer, artifact_sha256: owner.artifact, group_generation: generation, control_revision: revision,
      source_revision: captured.source_revision, status: 'pending', reason: null, retry_at: now, after: null, upper_fence: null, dirty: false, pages: 0, moved: 0};
    if (next && policy && (next.status !== 'paused' || next.reason !== policy || newer)) next = {...next, status: 'paused', reason: policy, group_generation: generation, control_revision: revision};
    if (!next) throw recoveryControlError('storage_corruption');
    const db = await this.openDB(); assertOwner(); const stores = [STORE_META, STORE_IDENTITY, STORE_GROUPS, STORE_PENDING_SENDS]; let wanted: WelcomeHistoryWorkBase;
    const predecessor = begin && prior ? {key: `welcome_retention_work_previous:v1:${encodeURIComponent(device)}:${encodeURIComponent(cid)}:${operation}`, value: {version: 1, reason: newer ? 'newer_authority' : 'new_source', previous: captured}} : null;
    const failure = (cause: unknown, outcome: 'aborted' | 'uncertain') => Object.assign(recoveryControlError((cause as {code?: string})?.code || 'recovery_checkpoint_uncertain'),
      {cause, checkpoint_outcome: outcome, recovery_owner_conflict: (cause as {recovery_owner_conflict?: string})?.recovery_owner_conflict});
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(stores, 'readwrite'), meta = tx.objectStore(STORE_META); let cause: unknown, state: MlsReadyBase, actual: WelcomeHistoryWorkBase, left = 2;
      const fail = (error: unknown) => { cause = error; tx.abort(); };
      const ready = () => { if (--left) return; try {
        assertOwner(); this._assertWelcomeHistoryOriginal(state, owner, cid);
        if (!sameSyncCheckpointValue(state, original) || !sameExternalCandidateScanValue(actual, captured)) throw Object.assign(recoveryControlError('recovery_checkpoint_conflict'), {recovery_owner_conflict: 'scope'});
        const put = () => { assertOwner(); if (!validWelcomeHistoryWork(next)) throw recoveryControlError('storage_corruption'); this._putWelcomeHistoryWork(meta, device, cid, next!); if (predecessor) meta.add(predecessor.value, predecessor.key); wanted = {...captured, work: next, due: next!.status === 'pending' ? structuredClone(next) : null, paused: next!.status === 'paused' ? structuredClone(next) : null, present: {...captured.present, work: true, due: next!.status === 'pending', paused: next!.status === 'paused'}}; };
        if (begin && next!.status === 'pending') { const last = meta.openKeyCursor(IDBKeyRange.bound(externalWelcomePrefix(cid, device), externalWelcomePrefix(cid, device) + '\uffff'), 'prev');
          last.onsuccess = () => { try { next!.upper_fence = last.result ? String(last.result.key) : null; put(); } catch (error) { fail(error); } };
        } else put();
      } catch (error) { fail(error); } };
      this._readMlsReadyBase(tx, user, device, cid, value => { state = value; ready(); }); this._readWelcomeHistoryWork(tx, device, cid, value => { actual = value; ready(); });
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(failure(cause || tx.error, 'aborted')); tx.onerror = () => {};
    });
    assertOwner(); await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(stores, 'readonly'); let cause: unknown, matches = true, proved = 0;
      this._readMlsReadyBase(tx, user, device, cid, actual => { try { assertOwner(); this._assertWelcomeHistoryOriginal(actual, owner, cid); if (!sameSyncCheckpointValue(actual, original)) throw Object.assign(recoveryControlError('recovery_checkpoint_uncertain'), {recovery_owner_conflict: this._groupInfoOwnerConflict(actual, original, cid) || 'scope'}); proved++; } catch (error) { cause = error; tx.abort(); } });
      this._readWelcomeHistoryWork(tx, device, cid, actual => { matches = matches && sameExternalCandidateScanValue(actual, wanted); proved++; });
      if (predecessor) { const read = tx.objectStore(STORE_META).get(predecessor.key); read.onsuccess = () => { matches = matches && sameExternalCandidateScanValue(read.result, predecessor.value); }; }
      tx.oncomplete = () => { try { assertOwner(); if (proved !== 2 || !matches) throw recoveryControlError('recovery_checkpoint_uncertain'); resolve(); } catch (error) { reject(failure(error, 'uncertain')); } };
      tx.onabort = () => reject(failure(cause || tx.error, 'uncertain')); tx.onerror = () => {};
    });
    assertOwner(); if (!sameExternalCandidateScanValue(captured, wanted!)) this._notifyWelcomeHistoryWork(device);
    return structuredClone(wanted!);
  }

  /** Bounded fair selection only; actual pages capture their own original private/target owner. */
  async takeWelcomeHistoryWorkPage(user: string, device: string, owner: RecoveryWorkOwner, assertOwner: () => void, now: number): Promise<WelcomeHistoryWorkSelection> {
    const captured = structuredClone(owner), operation = crypto.randomUUID(), prefix = welcomeHistoryWorkPrefix(device), upper = prefix + '\uffff',
      selectionKey = `welcome_retention_selection:v1:${encodeURIComponent(device)}`;
    if (user !== this.accountId || !device || !Number.isSafeInteger(now) || now <= 0) throw recoveryControlError('recovery_scope_changed');
    assertOwner(); const db = await this.openDB(); assertOwner();
    const result: WelcomeHistoryWorkSelection = {rows: [], more: false, retry_at: null, held: []},
      witnesses: Array<{key: string; value: unknown; opaque?: boolean; store?: string}> = [];
    let checkpoint: unknown;
    const failure = (cause: unknown, outcome: 'aborted' | 'uncertain') => Object.assign(recoveryControlError((cause as {code?: string})?.code || 'recovery_checkpoint_uncertain'),
      {cause, checkpoint_outcome: outcome, recovery_owner_conflict: (cause as {recovery_owner_conflict?: string})?.recovery_owner_conflict});
    const privateProof = (tx: IDBTransaction, done: () => void, fail: (error: unknown) => void) => {
      const meta = tx.objectStore(STORE_META), p = meta.get(`provider:${user}:${device}`), r = meta.get(`provider_revision:${user}:${device}`),
        i = tx.objectStore(STORE_IDENTITY).get(`${user}:${device}`); let left = 3;
      const ready = () => { if (--left) return; try { assertOwner();
        if (!sameSyncCheckpointValue(p.result, captured.provider_bytes) || (r.result ?? null) !== captured.revision || !sameSyncCheckpointValue(i.result, captured.identity_bytes))
          throw Object.assign(recoveryControlError('recovery_checkpoint_conflict'), {recovery_owner_conflict: 'provider'});
        done(); } catch (error) { fail(error); } }; p.onsuccess = r.onsuccess = i.onsuccess = ready;
    };
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_META, STORE_IDENTITY, STORE_GROUPS], 'readwrite'), meta = tx.objectStore(STORE_META); let cause: unknown;
      const fail = (error: unknown) => { cause = error; tx.abort(); };
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(failure(cause || tx.error, 'aborted')); tx.onerror = () => {};
      privateProof(tx, () => { const read = meta.get(selectionKey); read.onsuccess = () => { try {
        assertOwner(); const prior = read.result; let after: string | null = null, fence: string | null = null, future: number | null = null, scanned = 0;
        if (prior !== undefined) {
          if (!externalCandidateScanComparable(prior) || prior?.version !== 1) throw recoveryControlError('client_upgrade_required');
          if (prior.user_id !== user || prior.device_id !== device || prior.signing_identity_sha256 !== captured.signer || prior.artifact_sha256 !== captured.artifact ||
              prior.after !== null && (typeof prior.after !== 'string' || !prior.after.startsWith(prefix) || prior.after >= upper) ||
              prior.upper_fence !== null && (typeof prior.upper_fence !== 'string' || !prior.upper_fence.startsWith(prefix) || prior.upper_fence >= upper) ||
              prior.retry_at !== null && (!Number.isSafeInteger(prior.retry_at) || prior.retry_at <= 0)) throw recoveryControlError('storage_corruption');
          after = prior.after; fence = prior.upper_fence; future = prior.retry_at;
        }
        const finish = (more: boolean) => { assertOwner(); result.more = more; result.retry_at = future;
          checkpoint = {version: 1, user_id: user, device_id: device, signing_identity_sha256: captured.signer, artifact_sha256: captured.artifact,
            operation_id: operation, after: more ? after : null, upper_fence: more ? fence : null, retry_at: more ? future : null};
          meta.put(checkpoint, selectionKey); witnesses.push({key: selectionKey, value: checkpoint});
        };
        const scan = () => {
          if (!fence || after && after >= fence) { finish(false); return; }
          const cursorRead = meta.openCursor(IDBKeyRange.bound(after || prefix, fence, !!after));
          cursorRead.onsuccess = () => { try {
            assertOwner(); const cursor = cursorRead.result; if (!cursor) { finish(false); return; }
            const key = String(cursor.key), row = cursor.value; after = key; scanned++;
            let cid: string | null = null; try { const decoded = decodeURIComponent(key.slice(prefix.length)); if (decoded.length <= 512 && decoded.indexOf(':') > 0) cid = decoded; } catch { /* preserve malformed key */ }
            const done = () => { if (key === fence) finish(false); else if (scanned === 50 || result.rows.length === 3) finish(true); else cursor.continue(); };
            const hold = (reason: WelcomeHistoryWorkSelection['held'][number]['reason'], sources: unknown[]) => {
              result.held.push({cid, reason}); const holdKey = `welcome_retention_work_disposition:v1:${encodeURIComponent(key)}`,
                exact = sources.every(value => externalCandidateScanComparable(value)), disposition = {version: 1, source_key: key, reason,
                  source_proof: exact ? 'exact' : 'retained_unverified', ...(exact ? {sources} : {})};
              const old = meta.get(holdKey); old.onsuccess = () => { try { assertOwner();
                if (!externalCandidateScanComparable(old.result)) {
                  witnesses.push({key: holdKey, value: null, opaque: true});
                  const fallbackKey = `${holdKey}:opaque`, fallback = {version: 1, source_key: key, reason, source_proof: 'retained_unverified'}, previous = meta.get(fallbackKey);
                  previous.onsuccess = () => { try { assertOwner();
                    if (previous.result === undefined) { meta.add(fallback, fallbackKey); witnesses.push({key: fallbackKey, value: fallback}); }
                    else if (externalCandidateScanComparable(previous.result) && sameExternalCandidateScanValue(previous.result, fallback)) witnesses.push({key: fallbackKey, value: fallback});
                    else witnesses.push({key: fallbackKey, value: null, opaque: true});
                    done(); } catch (error) { fail(error); } }; return;
                }
                if (!sameExternalCandidateScanValue(old.result, disposition)) {
                  if (old.result !== undefined) { const previousKey = `${holdKey}:previous:${operation}`; meta.add(old.result, previousKey); witnesses.push({key: previousKey, value: old.result}); }
                  meta.put(disposition, holdKey);
                }
                witnesses.push({key: holdKey, value: disposition}); done();
              } catch (error) { fail(error); } };
            };
            witnesses.push({key, value: row, opaque: !externalCandidateScanComparable(row)});
            if (!cid || !externalCandidateScanComparable(row) || !validWelcomeHistoryWork(row)) { hold(row?.version !== 1 || !externalCandidateScanComparable(row) ? 'upgrade' : 'corrupt', [row]); return; }
            if (row.user_id !== user || row.device_id !== device || row.cid !== cid || row.signing_identity_sha256 !== captured.signer || row.artifact_sha256 !== captured.artifact) { hold('scope', [row]); return; }
            const due = meta.get(welcomeHistoryDueKey(device, cid)), paused = meta.get(welcomeHistoryPausedKey(device, cid)),
              controlKey = recoveryControlKey(cid, device), control = meta.get(controlKey), duePresent = meta.getKey(welcomeHistoryDueKey(device, cid)),
              pausedPresent = meta.getKey(welcomeHistoryPausedKey(device, cid)), controlPresent = meta.getKey(controlKey), marker = tx.objectStore(STORE_GROUPS).get(cid); let left = 7;
            const ready = () => { if (--left) return; try {
              assertOwner(); witnesses.push({key: cid!, value: marker.result, store: STORE_GROUPS, opaque: !externalCandidateScanComparable(marker.result)});
              for (const [address, value] of [[welcomeHistoryDueKey(device, cid!), due.result], [welcomeHistoryPausedKey(device, cid!), paused.result], [controlKey, control.result]] as const)
                witnesses.push({key: address, value, opaque: !externalCandidateScanComparable(value)});
              if (duePresent.result !== undefined && due.result === null || pausedPresent.result !== undefined && paused.result === null || controlPresent.result !== undefined && control.result === null) { hold('index_mismatch', [row, due.result, paused.result, control.result]); return; }
              if (!sameSyncCheckpointValue(due.result ?? null, row.status === 'pending' ? row : null) || !sameSyncCheckpointValue(paused.result ?? null, row.status === 'paused' ? row : null)) { hold('index_mismatch', [row, due.result, paused.result]); return; }
              let newer = false; if (control.result) { try { const c = control.result; validateRecoveryControl(c);
                if (c.user_id !== user || c.device_id !== device || c.cid !== cid || c.signing_identity_sha256 !== captured.signer) { hold('scope', [row, c]); return; }
                if (marker.result && (marker.result.status !== 'active' || marker.result.group_generation !== c.group_generation || c.group_generation > 0 && !sameSyncCheckpointValue(marker.result.group_id, c.group_id))) { hold('scope', [row, c, marker.result]); return; }
                if (row.group_generation > c.group_generation || row.group_generation === c.group_generation && row.control_revision !== null && BigInt(row.control_revision) > BigInt(c.recovery_revision)) { hold('obsolete', [row, c]); return; }
                newer = c.group_generation > row.group_generation || c.group_generation === row.group_generation && (row.control_revision === null || BigInt(c.recovery_revision) > BigInt(row.control_revision));
              } catch { hold(control.result?.version !== 1 ? 'upgrade' : 'corrupt', [row, control.result]); return; } }
              else if (row.control_revision !== null || marker.result && (marker.result.status !== 'active' || marker.result.group_generation !== row.group_generation)) { hold('scope', [row, marker.result]); return; }
              if (row.status === 'pending' || row.status === 'paused' && newer) {
                if (row.retry_at <= now || row.status === 'paused') result.rows.push(row);
                else future = Math.min(future ?? row.retry_at, row.retry_at);
              }
              done();
            } catch (error) { fail(error); } }; due.onsuccess = paused.onsuccess = control.onsuccess = duePresent.onsuccess = pausedPresent.onsuccess = controlPresent.onsuccess = marker.onsuccess = ready;
          } catch (error) { fail(error); } };
        };
        if (!fence) { const last = meta.openKeyCursor(IDBKeyRange.bound(prefix, upper), 'prev'); last.onsuccess = () => { fence = last.result ? String(last.result.key) : null; scan(); }; } else scan();
      } catch (error) { fail(error); } }; }, fail);
    });
    assertOwner(); await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_META, STORE_IDENTITY, STORE_GROUPS], 'readonly'), meta = tx.objectStore(STORE_META); let cause: unknown, matches = true, proved = false;
      privateProof(tx, () => { proved = true; for (const row of witnesses) {
        if (row.opaque) { const read = tx.objectStore(row.store || STORE_META).getKey(row.key); read.onsuccess = () => { matches = matches && read.result !== undefined; }; }
        else { const read = tx.objectStore(row.store || STORE_META).get(row.key); read.onsuccess = () => { matches = matches && sameExternalCandidateScanValue(read.result, row.value); }; }
      } }, error => { cause = error; tx.abort(); });
      tx.oncomplete = () => { try { assertOwner(); if (!proved || !matches) throw recoveryControlError('recovery_checkpoint_uncertain'); resolve(); } catch (error) { reject(failure(error, 'uncertain')); } };
      tx.onabort = () => reject(failure(cause || tx.error, 'uncertain')); tx.onerror = () => {};
    });
    assertOwner(); return result;
  }

  readonly welcomeHistoryCheckpointVersion = 1 as const;

  /** Bounded exact relocation only; this never completes a Welcome or changes private/protocol state. */
  async compactWelcomeHistory(user: string, device: string, cid: string, continuation: WelcomeHistoryContinuation): Promise<WelcomeHistoryPage> {
    const owner = structuredClone(continuation.owner), operation = continuation.operation_id, assertOwner = continuation.assertOwner,
      workBase = continuation.work ? structuredClone(continuation.work) : undefined, workNow = Date.now(),
      prefix = externalWelcomePrefix(cid, device), upper = prefix + '\uffff', cursorKey = `welcome_retention_cursor:v1:${encodeURIComponent(device)}:${encodeURIComponent(cid)}`;
    if (user !== this.accountId || !device || !cid || cid.length > 512 || !/^[0-9a-f]{64}$/.test(owner.signer) ||
        !/^[0-9a-f]{64}$/.test(owner.artifact) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(operation)) throw recoveryControlError('recovery_scope_changed');
    if (workBase && (!Number.isSafeInteger(workNow) || workNow <= 0 || !Number.isSafeInteger(workNow + 30_000))) throw recoveryControlError('invalid_clock');
    if (workBase) { this._validateWelcomeHistoryWorkBase(workBase, user, device, cid, owner); if (workBase.work?.status !== 'pending') throw recoveryControlError('welcome_history_blocked'); }
    assertOwner(); const expected = await this.loadMlsReadyBase(user, device, cid); assertOwner();
    const assertOriginal = (actual: MlsReadyBase) => {
      if (!sameSyncCheckpointValue(actual.provider_bytes, owner.provider_bytes) || !sameSyncCheckpointValue(actual.identity_bytes, owner.identity_bytes) || actual.revision !== owner.revision)
        throw Object.assign(recoveryControlError('recovery_checkpoint_conflict'), {recovery_owner_conflict: 'provider'});
      if (!sameSyncCheckpointValue(actual.cleanup.marker, owner.marker) || !sameSyncCheckpointValue(actual.control, owner.control) ||
          !sameSyncCheckpointValue(actual.cleanup.metadata[`mls_mutation:v1:${cid}`], owner.pending) ||
          !sameSyncCheckpointValue(actual.cleanup.metadata[`external_candidate:v1:${cid}`], owner.external))
        throw Object.assign(recoveryControlError('recovery_checkpoint_conflict'), {recovery_owner_conflict: 'scope'});
    };
    assertOriginal(expected);
    if (workBase) {
      const work = workBase.work!, control = expected.control, marker = expected.cleanup.marker as MlsGroupGenerationMarker | null;
      if (control) { validateRecoveryControl(control); if (control.user_id !== user || control.device_id !== device || control.cid !== cid || control.signing_identity_sha256 !== owner.signer) throw recoveryControlError('recovery_scope_changed'); }
      if (work.group_generation !== (control?.group_generation ?? marker?.group_generation ?? 0) || work.control_revision !== (control?.recovery_revision ?? null)) throw recoveryControlError('welcome_history_authority_changed');
      if (control?.recovery_action === 'manual_intervention_required' || control?.recovery_action === 'repair' && workNow >= Date.parse(control.repair_retry_until!)) throw recoveryControlError('welcome_history_authority_changed');
    }
    const db = await this.openDB(); assertOwner();
    const witnesses: Array<{store: string; key: string; value: unknown; present: boolean; opaque?: boolean}> = [],
      page: WelcomeHistoryPage = {scanned: 0, moved: 0, next: null, held: []}, probes: Array<{prefix: string; keys: IDBValidKey[]}> = [];
    let passEnd = false;
    const failure = (cause: unknown, outcome: 'aborted' | 'uncertain') => Object.assign(
      recoveryControlError((cause as {code?: string})?.code || 'recovery_checkpoint_uncertain'),
      {cause, checkpoint_outcome: outcome, recovery_owner_conflict: (cause as {recovery_owner_conflict?: string})?.recovery_owner_conflict});
    const stores = [STORE_META, STORE_IDENTITY, STORE_GROUPS, STORE_PENDING_SENDS, STORE_WELCOME_HISTORY];
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(stores, 'readwrite'), meta = tx.objectStore(STORE_META), history = tx.objectStore(STORE_WELCOME_HISTORY);
      let cause: unknown, aborted = false;
      const fail = (error: unknown) => { cause ||= error; if (!aborted) { aborted = true; tx.abort(); } };
      const witness = (store: string, key: string, value: unknown, present: boolean, opaque = false) => { witnesses.push({store, key, value, present, opaque}); };
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(failure(cause || tx.error, 'aborted')); tx.onerror = () => { cause ||= tx.error; };
      this._readMlsReadyBase(tx, user, device, cid, actual => { try {
        assertOwner(); assertOriginal(actual);
        if (!sameSyncCheckpointValue(actual, expected)) throw Object.assign(recoveryControlError('recovery_checkpoint_conflict'), {recovery_owner_conflict: this._groupInfoOwnerConflict(actual, expected, cid)});
        const begin = () => { const readiness = expected.cleanup.metadata[`external_join_readiness:${cid}`] as ExternalJoinReadinessState | null;
        if (readiness && !['pending_external_join', 'joined_external'].includes(readiness.status)) throw recoveryControlError('storage_corruption');
        const linked = typeof readiness?.welcome_event_cursor?.event_id === 'string' ? prefix + encodeURIComponent(readiness.welcome_event_cursor.event_id) : null;
        const cursorRead = meta.get(cursorKey);
        cursorRead.onsuccess = () => { try {
          assertOwner(); const prior = cursorRead.result; let after: string | null = null;
          if (prior !== undefined) {
            if (!externalCandidateScanComparable(prior) || prior?.version !== 1) throw recoveryControlError('client_upgrade_required');
            if (prior.user_id !== user || prior.device_id !== device || prior.cid !== cid || prior.signing_identity_sha256 !== owner.signer ||
                prior.artifact_sha256 !== owner.artifact || prior.after !== null && (typeof prior.after !== 'string' || !prior.after.startsWith(prefix) || prior.after >= upper) ||
                typeof prior.operation_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(prior.operation_id)) {
              const key = `${cursorKey}:disposition:${operation}`, disposition = {version: 1, source_key: cursorKey, source: prior, reason: 'scope_or_corrupt'};
              meta.add(disposition, key); witness(STORE_META, key, disposition, true);
            } else after = prior.after;
          }
          if (workBase) after = workBase.work!.after;
          const finish = () => { assertOwner(); const checkpoint = {version: 1, user_id: user, device_id: device, cid,
            signing_identity_sha256: owner.signer, artifact_sha256: owner.artifact, operation_id: operation, after: page.next};
            meta.put(checkpoint, cursorKey); witness(STORE_META, cursorKey, checkpoint, true);
            if (!workBase) return;
            const primary = meta.getAllKeys(IDBKeyRange.bound(prefix, upper), 101), pendingPrefix = externalWelcomePrefix(cid, device, true),
              pending = meta.getAllKeys(IDBKeyRange.bound(pendingPrefix, pendingPrefix + '\uffff'), 101); let left = 2;
            const proved = () => { if (--left) return; try { assertOwner();
              probes.push({prefix, keys: primary.result}, {prefix: pendingPrefix, keys: pending.result});
              const prior = workBase.work!; let work: WelcomeHistoryWork = {...prior, intent_id: operation, after: page.next || prior.after,
                pages: prior.pages + 1, moved: prior.moved + page.moved, retry_at: prior.retry_at + 30_000};
              const put = () => { if (!validWelcomeHistoryWork(work)) throw recoveryControlError('storage_corruption'); this._putWelcomeHistoryWork(meta, device, cid, work); page.work = work;
                witness(STORE_META, welcomeHistoryWorkKey(device, cid), work, true);
                witness(STORE_META, welcomeHistoryDueKey(device, cid), work.status === 'pending' ? work : undefined, work.status === 'pending');
                witness(STORE_META, welcomeHistoryPausedKey(device, cid), work.status === 'paused' ? work : undefined, work.status === 'paused');
                witness(STORE_META, welcomeHistorySourceKey(device, cid), workBase.source_revision ?? undefined, workBase.source_revision !== null);
              };
              if (primary.result.length <= 100 && pending.result.length <= 100) work = {...work, status: 'complete', reason: null, dirty: false, source_revision: workBase.source_revision};
              else if (passEnd) {
                if (prior.dirty || prior.source_revision !== workBase.source_revision) {
                  work = {...work, after: null, dirty: false, source_revision: workBase.source_revision};
                  const fence = meta.openKeyCursor(IDBKeyRange.bound(prefix, upper), 'prev');
                  fence.onsuccess = () => { try { assertOwner(); work.upper_fence = fence.result ? String(fence.result.key) : null; put(); } catch (error) { fail(error); } }; return;
                }
                work = {...work, status: 'paused', reason: 'welcome_history_blocked'};
              }
              put();
            } catch (error) { fail(error); } }; primary.onsuccess = pending.onsuccess = proved;
          };
          const scan = (lower: string | null, wrap: boolean) => {
            const fence = workBase?.work?.upper_fence;
            if (workBase && (!fence || lower && lower >= fence)) { passEnd = true; finish(); return; }
            const scanRead = meta.openCursor(IDBKeyRange.bound(lower || prefix, fence || upper, !!lower));
            scanRead.onsuccess = () => { try {
              assertOwner(); const cursor = scanRead.result;
              if (!cursor) { if (!workBase && wrap && !page.scanned) { scan(null, false); return; } passEnd = true; finish(); return; }
              const key = String(cursor.key), row = cursor.value, dueKey = externalWelcomePrefix(cid, device, true) + key.slice(prefix.length),
                due = meta.get(dueKey), retained = history.get(key); let left = 2;
              const rowReady = () => { if (--left) return; try {
                assertOwner(); page.scanned++; page.next = key;
                const exact = [row, due.result, retained.result].every(value => externalCandidateScanComparable(value));
                let reason: WelcomeHistoryPage['held'][number]['reason'] | null = null;
                if (!exact || row?.version !== 1) reason = 'upgrade';
                else if (key === linked) reason = 'linked';
                else if (row?.status === 'pending_external_join') reason = 'pending';
                else if (due.result !== undefined || !validCompletedWelcome(key, row, user, device, cid, owner.signer)) reason = 'corrupt';
                else if (retained.result !== undefined && !sameExternalCandidateScanValue(retained.result, row)) reason = 'conflict';
                if (reason) {
                  page.held.push({key, reason});
                  if (!['pending', 'linked'].includes(reason)) {
                    const holdKey = `${cursorKey}:hold:${encodeURIComponent(key)}`, disposition = {version: 1, source_key: key, reason,
                      source_proof: exact ? 'exact' : 'retained_unverified', ...(exact ? {source: row, pending: due.result ?? null, retained: retained.result ?? null} : {})};
                    const previous = meta.get(holdKey); previous.onsuccess = () => { try { assertOwner();
                      if (!externalCandidateScanComparable(previous.result)) throw recoveryControlError('client_upgrade_required');
                      if (!sameExternalCandidateScanValue(previous.result, disposition)) {
                        if (previous.result !== undefined) { const oldKey = `${holdKey}:previous:${operation}`; meta.add(previous.result, oldKey); witness(STORE_META, oldKey, previous.result, true); }
                        meta.put(disposition, holdKey);
                      }
                      witness(STORE_META, holdKey, disposition, true);
                    } catch (error) { fail(error); } };
                  }
                  witness(STORE_META, key, row, true, !externalCandidateScanComparable(row));
                  witness(STORE_META, dueKey, due.result, due.result !== undefined, !externalCandidateScanComparable(due.result));
                  witness(STORE_WELCOME_HISTORY, key, retained.result, retained.result !== undefined, !externalCandidateScanComparable(retained.result));
                } else {
                  history.put(row, key); meta.delete(key); page.moved++;
                  witness(STORE_META, key, undefined, false); witness(STORE_META, dueKey, undefined, false); witness(STORE_WELCOME_HISTORY, key, row, true);
                }
                if (workBase?.work?.upper_fence === key) { passEnd = true; finish(); } else if (page.scanned === 50) finish(); else cursor.continue();
              } catch (error) { fail(error); } };
              due.onsuccess = retained.onsuccess = rowReady;
            } catch (error) { fail(error); } };
          };
          scan(after, !!after);
        } catch (error) { fail(error); } }; };
        if (workBase) this._readWelcomeHistoryWork(tx, device, cid, actual => { try { assertOwner();
          if (!sameExternalCandidateScanValue(actual, workBase)) throw Object.assign(recoveryControlError('recovery_checkpoint_conflict'), {recovery_owner_conflict: 'scope'});
          begin(); } catch (error) { fail(error); } }); else begin();
      } catch (error) { fail(error); } });
    });
    assertOwner();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(stores, 'readonly'); let cause: unknown, matches = true, proved = false, kind: string | undefined;
      this._readMlsReadyBase(tx, user, device, cid, actual => { try {
        assertOwner(); assertOriginal(actual); proved = true; matches = matches && sameSyncCheckpointValue(actual, expected); kind = this._groupInfoOwnerConflict(actual, expected, cid);
      } catch (error) { cause = error; tx.abort(); } });
      for (const row of witnesses) {
        const store = tx.objectStore(row.store), key = store.getKey(row.key); key.onsuccess = () => { matches = matches && (key.result !== undefined) === row.present; };
        if (!row.opaque) { const read = store.get(row.key); read.onsuccess = () => { matches = matches && sameExternalCandidateScanValue(read.result, row.value); }; }
      }
      for (const probe of probes) { const read = tx.objectStore(STORE_META).getAllKeys(IDBKeyRange.bound(probe.prefix, probe.prefix + '\uffff'), 101);
        read.onsuccess = () => { matches = matches && sameSyncCheckpointValue(read.result, probe.keys); }; }
      tx.oncomplete = () => { try { assertOwner(); if (!proved || !matches) throw Object.assign(recoveryControlError('recovery_checkpoint_uncertain'), {checkpoint_outcome: 'uncertain', recovery_owner_conflict: kind}); resolve(); } catch (error) { reject(error); } };
      tx.onabort = () => reject(failure(cause || tx.error, 'uncertain')); tx.onerror = () => { cause ||= tx.error; };
    });
    assertOwner(); return structuredClone(page);
  }

  async loadWelcomeRecoveryCheckpoint(cid: string, deviceId: string, eventId: string): Promise<WelcomeRecoveryCheckpoint | null> {
    const db = await this.openDB(), key = `${welcomeRecoveryPrefix(cid, deviceId)}${encodeURIComponent(eventId)}`;
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_META, STORE_WELCOME_HISTORY], 'readonly'), primary = tx.objectStore(STORE_META).get(key),
        retained = tx.objectStore(STORE_WELCOME_HISTORY).get(key),
        pending = tx.objectStore(STORE_META).get(`${welcomeRecoveryPrefix(cid, deviceId, true)}${encodeURIComponent(eventId)}`);
      tx.oncomplete = () => { try {
        const row = retained.result;
        if (row !== undefined && (pending.result !== undefined || !validCompletedWelcome(key, row, this.accountId, deviceId, cid, row?.signing_identity_sha256) ||
            primary.result !== undefined && !sameSyncCheckpointValue(primary.result, row))) throw recoveryControlError('welcome_checkpoint_invalid');
        resolve(primary.result ?? row ?? null);
      } catch (error) { reject(error); } };
      tx.onabort = () => reject(tx.error || recoveryControlError('recovery_checkpoint_uncertain')); tx.onerror = () => {};
    });
  }

  async listWelcomeRecoveryCheckpoints(cid: string, deviceId: string, limit: number): Promise<WelcomeRecoveryCheckpoint[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Welcome disposition limit must be 1..100');
    const db = await this.openDB(), prefix = welcomeRecoveryPrefix(cid, deviceId, true);
    return new Promise((resolve, reject) => {
      const result: WelcomeRecoveryCheckpoint[] = [], tx = db.transaction(STORE_META, 'readonly');
      const request = tx.objectStore(STORE_META).openCursor(IDBKeyRange.bound(prefix, prefix + '\uffff'));
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor && result.length < limit) { result.push(cursor.value); cursor.continue(); }
      };
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error || new Error('Welcome disposition scan aborted'));
    });
  }

  async saveWelcomeFailureCheckpoint(record: WelcomeRecoveryCheckpoint, readiness: ExternalJoinReadinessState): Promise<void> {
    if (record.status !== 'pending_external_join' || record.checkpoint || record.cid !== readiness.cid) {
      throw new Error('Invalid pending Welcome disposition');
    }
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_META, STORE_WELCOME_HISTORY], 'readwrite'), meta = tx.objectStore(STORE_META);
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Welcome failure checkpoint aborted'));
      const key = welcomeRecoveryKey(record), request = meta.get(key), retained = tx.objectStore(STORE_WELCOME_HISTORY).get(key);
      const work = meta.getKey(welcomeHistoryWorkKey(record.device_id, record.cid));
      let left = 3;
      request.onerror = () => reject(request.error);
      request.onsuccess = retained.onsuccess = work.onsuccess = () => {
        if (--left) return;
        try {
          if (work.result !== undefined) throw recoveryControlError('client_upgrade_required');
          if (retained.result !== undefined) throw recoveryControlError('welcome_disposition_required');
          const prior = request.result as WelcomeRecoveryCheckpoint | undefined;
          if (prior && !sameWelcomeBinding(prior, record)) throw new Error('Welcome disposition binding changed');
          // A repeated live/history failure must never demote a committed disposition.
          if (prior && prior.status !== 'pending_external_join') return;
          meta.put(record, welcomeRecoveryKey(record));
          meta.put(record, `${welcomeRecoveryPrefix(record.cid, record.device_id, true)}${encodeURIComponent(record.event_cursor.event_id)}`);
          meta.put(readiness, `${EXTERNAL_JOIN_READINESS_PREFIX}${record.cid}`);
        } catch (error) { tx.abort(); reject(error); }
      };
    });
  }

  private _writeWelcomeDispositions(tx: IDBTransaction, meta: IDBObjectStore, checkpoint: JoinPersistenceCheckpoint,
    reject: (reason: unknown) => void): void {
    const records = checkpoint.welcome_dispositions || [];
    if (records.length > 100) throw new Error('Welcome checkpoint exceeds record bound');
    for (const record of records) {
      if (record.user_id !== checkpoint.user_id || record.device_id !== checkpoint.device_id || record.cid !== checkpoint.cid ||
          record.status === 'pending_external_join' || !record.checkpoint ||
          record.checkpoint.marker.cid !== checkpoint.cid ||
          record.checkpoint.marker.group_generation !== checkpoint.generation?.group_generation) {
        throw new Error('Welcome checkpoint scope changed');
      }
      const key = welcomeRecoveryKey(record), request = meta.get(key), retained = tx.objectStore(STORE_WELCOME_HISTORY).get(key);
      const work = meta.getKey(welcomeHistoryWorkKey(record.device_id, record.cid));
      let left = 3;
      request.onerror = () => reject(request.error);
      request.onsuccess = retained.onsuccess = work.onsuccess = () => {
        if (--left) return;
        try {
          if (work.result !== undefined) throw recoveryControlError('client_upgrade_required');
          if (retained.result !== undefined) {
            if (!sameSyncCheckpointValue(retained.result, record) || request.result !== undefined && !sameSyncCheckpointValue(request.result, record)) throw recoveryControlError('welcome_disposition_required');
            return; // Preserve its exact retained location; never resurrect a completed primary.
          }
          const prior = request.result as WelcomeRecoveryCheckpoint | undefined;
          if ((record.status === 'superseded_by_recovery' && !prior) || (prior && !sameWelcomeBinding(prior, record)) ||
              (prior && prior.status !== 'pending_external_join' && JSON.stringify(prior) !== JSON.stringify(record))) {
            throw new Error('Welcome disposition CAS failed');
          }
          meta.put(record, key);
          meta.delete(`${welcomeRecoveryPrefix(record.cid, record.device_id, true)}${encodeURIComponent(record.event_cursor.event_id)}`);
        } catch (error) { tx.abort(); reject(error); }
      };
    }
  }

  async listExternalJoinCandidateCheckpoints(): Promise<ExternalJoinCandidateCheckpoint[]> {
    const db=await this.openDB();
    return new Promise((resolve,reject) => {
      const result: ExternalJoinCandidateCheckpoint[]=[];
      const tx=db.transaction(STORE_META,'readonly');
      const req=tx.objectStore(STORE_META).openCursor(IDBKeyRange.bound(EXTERNAL_CANDIDATE_PREFIX,EXTERNAL_CANDIDATE_PREFIX+'\uffff'));
      req.onsuccess=()=>{const cursor=req.result;if(cursor){result.push(cursor.value);cursor.continue();}};
      req.onerror=()=>reject(req.error);tx.oncomplete=()=>resolve(result);
      tx.onabort=()=>reject(tx.error || new Error('External candidate scan aborted'));
    });
  }

  readonly externalJoinCandidateScanVersion = 1 as const;

  /** Selection and private scheduling disposition only. Never mutates a candidate or private owner. */
  async takeExternalJoinCandidatePage(user: string, device: string, owner: RecoveryWorkOwner,
    assertOwner: (cid?: string) => void, restoreAfter?: string | null): Promise<ExternalJoinCandidatePage> {
    if (user !== this.accountId || !device) throw recoveryControlError('recovery_scope_changed');
    const captured = structuredClone(owner), prefix = EXTERNAL_CANDIDATE_PREFIX, upper = prefix + '\uffff',
      key = `external_candidate_scan:v1:${encodeURIComponent(device)}`, operation = crypto.randomUUID();
    if (restoreAfter !== undefined && restoreAfter !== null && (!restoreAfter.startsWith(prefix) || restoreAfter >= upper)) throw recoveryControlError('storage_corruption');
    const db = await this.openDB(); assertOwner();
    const witnesses: Array<{store: string; key: string; value: unknown; present?: boolean; presenceOnly?: boolean}> = [];
    const rows: ExternalJoinCandidatePageRow[] = []; let last: string | null = null;
    const failure = (cause: unknown, outcome: 'aborted' | 'uncertain') => Object.assign(
      recoveryControlError((cause as {code?: string})?.code === 'client_upgrade_required' ? 'client_upgrade_required' : 'recovery_checkpoint_uncertain'),
      {cause, checkpoint_outcome: outcome, recovery_owner_conflict: (cause as {recovery_owner_conflict?: string})?.recovery_owner_conflict,
        external_candidate_cursor_deferred: (cause as {external_candidate_cursor_deferred?: boolean})?.external_candidate_cursor_deferred});
    const provePrivate = (tx: IDBTransaction, done: () => void, fail: (error: unknown) => void) => {
      const meta = tx.objectStore(STORE_META), p = meta.get(`provider:${user}:${device}`),
        r = meta.get(`provider_revision:${user}:${device}`), i = tx.objectStore(STORE_IDENTITY).get(`${user}:${device}`); let left = 3;
      const finish = () => { if (--left) return; try {
        assertOwner();
        if (!sameSyncCheckpointValue(p.result, captured.provider_bytes) || (r.result ?? null) !== captured.revision ||
            !sameSyncCheckpointValue(i.result, captured.identity_bytes)) throw Object.assign(recoveryControlError('recovery_checkpoint_conflict'), {recovery_owner_conflict: 'provider'});
        done();
      } catch (error) { fail(error); } };
      p.onsuccess = r.onsuccess = i.onsuccess = finish;
    };
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_META, STORE_IDENTITY, STORE_GROUPS], 'readwrite'), meta = tx.objectStore(STORE_META); let cause: unknown;
      const fail = (error: unknown) => { cause = error; tx.abort(); };
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(failure(cause || tx.error, 'aborted')); tx.onerror = () => {};
      const retain = (address: string, value: unknown, store = STORE_META, present?: boolean) => { witnesses.push({store, key: address, value, present}); };
      const retainOpaque = (address: string, store = STORE_META) => { witnesses.push({store, key: address, value: null, present: true, presenceOnly: true}); };
      provePrivate(tx, () => {
        const begin = (after: string | null, prior?: unknown, cursorReason?: 'corrupt' | 'scope') => {
          const finish = () => { try {
            assertOwner(); for (const row of rows) if (row.cid) assertOwner(row.cid);
            if (restoreAfter !== undefined) return;
            const next = {version: 1, user_id: user, device_id: device, signing_identity_sha256: captured.signer,
              artifact_sha256: captured.artifact, operation_id: operation, after: last};
            if (cursorReason) {
              const address = `external_candidate_scan_disposition:v1:${encodeURIComponent(device)}:${operation}`,
                record = {version: 1, source_key: key, source: prior, reason: cursorReason, replacement: next};
              meta.add(record, address); retain(address, record);
            }
            meta.put(next, key); retain(key, next);
          } catch (error) { fail(error); } };
          const scan = (lower: string | null, wrap: boolean) => {
            const request = meta.openCursor(IDBKeyRange.bound(lower || prefix, upper, !!lower));
            request.onsuccess = () => { try {
              assertOwner(); const cursor = request.result;
              if (!cursor) { if (wrap && !rows.length) { scan(null, false); return; } finish(); return; }
              const address = String(cursor.key), source = cursor.value, suffix = address.slice(prefix.length),
                cid = suffix.length <= 512 && suffix.indexOf(':') > 0 ? suffix : null;
              last = address;
              const controlKey = cid ? `recovery_control:v1:${encodeURIComponent(device)}:${encodeURIComponent(cid)}` : null;
              const control = controlKey ? meta.get(controlKey) : null, marker = cid ? tx.objectStore(STORE_GROUPS).get(cid) : null;
              let left = Number(!!control) + Number(!!marker);
              const classify = () => { try {
                assertOwner(cid || undefined); const c = control?.result ?? null, m = marker?.result ?? null;
                const row = classifyExternalCandidate(address, source, c, m, user, device, captured.signer);
                const holdKey = `external_candidate_disposition:v1:${encodeURIComponent(address)}`, read = meta.get(holdKey);
                read.onsuccess = () => { try {
                  assertOwner(cid || undefined); const previous = read.result ?? null;
                  const exact = [source, c, m, previous].every(value => externalCandidateScanComparable(value));
                  const continuePage = () => { rows.push(row); if (rows.length === 50) finish(); else cursor.continue(); };
                  if (!exact) {
                    row.candidate = null; row.reason = 'upgrade'; row.source_proof = 'retained_unverified';
                    // Only existence of opaque records is proved. Their bytes remain untouched and unadmitted.
                    for (const [recordKey, value, store] of [[address, source, STORE_META], [controlKey, c, STORE_META],
                      [cid, m, STORE_GROUPS], [holdKey, previous, STORE_META]] as const) {
                      if (!recordKey) continue;
                      if (externalCandidateScanComparable(value)) retain(recordKey, value, store, recordKey === address || undefined);
                      else retainOpaque(recordKey, store);
                    }
                    const descriptorKey = `external_candidate_deferred:v1:${encodeURIComponent(device)}:${encodeURIComponent(address)}`,
                      descriptor = {version: 1, user_id: user, device_id: device, signing_identity_sha256: captured.signer,
                        artifact_sha256: captured.artifact, source_key: address, reason: 'opaque', source_proof: 'retained_unverified'},
                      descriptorRead = meta.get(descriptorKey);
                    descriptorRead.onsuccess = () => { try {
                      assertOwner(cid || undefined); const priorDescriptor = descriptorRead.result;
                      if (priorDescriptor === undefined || sameExternalCandidateScanValue(priorDescriptor, descriptor)) {
                        if (priorDescriptor === undefined) meta.add(descriptor, descriptorKey);
                        retain(descriptorKey, descriptor);
                      } else {
                        // An unknown descriptor is retained in place. Immutable fallback carries only this deferral.
                        const fallback = `${descriptorKey}:${operation}`; meta.add(descriptor, fallback); retain(fallback, descriptor);
                        if (externalCandidateScanComparable(priorDescriptor)) retain(descriptorKey, priorDescriptor);
                        else retainOpaque(descriptorKey);
                      }
                      continuePage();
                    } catch (error) { fail(error); } };
                    return;
                  }
                  retain(address, source, STORE_META, true);
                  if (controlKey) retain(controlKey, c); if (cid) retain(cid, m, STORE_GROUPS);
                  if (previous && previous.version !== 1) { row.reason = 'upgrade'; row.candidate = null; retain(holdKey, previous); }
                  else if (row.reason) {
                    const record: ExternalCandidateDisposition = {version: 1, source_key: address, source, reason: row.reason, control: c, marker: m};
                    if (!sameExternalCandidateScanValue(previous, record)) {
                      if (previous !== null) { const history = `${holdKey}:${crypto.randomUUID()}`; meta.add(previous, history); retain(history, previous); }
                      meta.put(record, holdKey);
                    }
                    retain(holdKey, record);
                  } else retain(holdKey, previous);
                  continuePage();
                } catch (error) { fail(error); } };
              } catch (error) { fail(error); } };
              const ready = () => { if (--left === 0) classify(); };
              if (control) control.onsuccess = ready; if (marker) marker.onsuccess = ready;
              if (!left) classify();
            } catch (error) { fail(error); } };
          };
          scan(after, restoreAfter === undefined && !!after);
        };
        if (restoreAfter !== undefined) { begin(restoreAfter); return; }
        const read = meta.get(key); read.onsuccess = () => { try {
          assertOwner(); const prior = read.result ?? null; let after: string | null = null, reason: 'corrupt' | 'scope' | undefined;
          if (prior !== null) {
            if (!externalCandidateScanComparable(prior) || prior.version !== undefined && prior.version !== 1)
              throw Object.assign(recoveryControlError('client_upgrade_required'), {external_candidate_cursor_deferred: true});
            if (prior.version !== 1 || typeof prior.operation_id !== 'string' ||
                !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(prior.operation_id) ||
                prior.after !== null && (typeof prior.after !== 'string' || !prior.after.startsWith(prefix) || prior.after >= upper)) reason = 'corrupt';
            else if (prior.user_id !== user || prior.device_id !== device || prior.signing_identity_sha256 !== captured.signer || prior.artifact_sha256 !== captured.artifact) reason = 'scope';
            else after = prior.after;
          }
          begin(after, prior, reason);
        } catch (error) { fail(error); } };
      }, fail);
    });
    assertOwner();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_META, STORE_IDENTITY, STORE_GROUPS], 'readonly'); let cause: unknown, matches = true;
      const fail = (error: unknown) => { cause = error; tx.abort(); };
      provePrivate(tx, () => {
        for (const witness of witnesses) {
          const store = tx.objectStore(witness.store);
          if (!witness.presenceOnly) { const read = store.get(witness.key);
            read.onsuccess = () => { matches = matches && sameExternalCandidateScanValue(read.result ?? null, witness.value ?? null); };
          }
          if (witness.present) { const keyRead = store.getKey(witness.key); keyRead.onsuccess = () => { matches = matches && keyRead.result === witness.key; }; }
        }
      }, fail);
      tx.oncomplete = () => { try { assertOwner(); if (!matches) throw recoveryControlError('recovery_checkpoint_uncertain'); resolve(); } catch (error) { reject(error); } };
      tx.onabort = () => reject(failure(cause || tx.error, 'uncertain')); tx.onerror = () => {};
    });
    assertOwner(); for (const row of rows) if (row.cid) assertOwner(row.cid); return structuredClone({rows, next: rows.length === 50 ? last : null});
  }

  readonly externalJoinWorkCheckpointVersion = 1 as const;
  readonly externalJoinReadyCheckpointVersion = 1 as const;

  private _readExternalJoinWorkBase(tx: IDBTransaction, user: string, device: string, cid: string, operation: string,
    done: (base: ExternalJoinWorkBase) => void, fail: (error: unknown) => void, eventId?: string): void {
    const base: ExternalJoinWorkBase = {state: undefined as unknown as MlsReadyBase, accepted: null, rejected: null,
      welcome_primary: {}, welcome_pending: {}};
    if (eventId !== undefined) {
      if (typeof eventId !== 'string' || !eventId.length || eventId.length > 128) { fail(recoveryControlError('acceptance_metadata_invalid')); return; }
      base.welcome_event_id = eventId; base.welcome_retained = {};
    }
    let remaining = eventId === undefined ? 6 : 7;
    const finish = () => { if (--remaining === 0) {
      const row = Object.values(base.welcome_retained || {})[0];
      if (row && (base.welcome_pending[externalWelcomeKey(row, true)] !== undefined ||
          base.welcome_primary[externalWelcomeKey(row)] !== undefined && !sameSyncCheckpointValue(base.welcome_primary[externalWelcomeKey(row)], row))) {
        fail(recoveryControlError('welcome_checkpoint_invalid')); return;
      }
      done(base);
    } };
    const history = tx.objectStore(STORE_WELCOME_HISTORY);
    if (eventId !== undefined) {
      const key = externalWelcomePrefix(cid, device) + encodeURIComponent(eventId), point = history.get(key);
      point.onsuccess = () => {
        const row = point.result;
        if (row !== undefined) {
          if (!validCompletedWelcome(key, row, user, device, cid, row?.signing_identity_sha256)) { fail(recoveryControlError('welcome_checkpoint_invalid')); return; }
          base.welcome_retained![key] = row;
        }
        finish();
      };
    }
    this._readMlsReadyBase(tx, user, device, cid, state => { base.state = state; finish(); });
    this._readWelcomeHistoryWork(tx, device, cid, work => { base.welcome_history_work = work; finish(); });
    const meta = tx.objectStore(STORE_META);
    const accepted = meta.get(`${EXTERNAL_RECEIPT_PREFIX}${cid}`);
    accepted.onsuccess = () => {
      base.accepted = accepted.result ?? null; finish();
      const op = operation || base.accepted?.operation_id || '';
      if (typeof op !== 'string' || op.length > 128) { fail(recoveryControlError('acceptance_metadata_invalid')); return; }
      const rejected = meta.get(`external_rejection:v1:${encodeURIComponent(cid)}:${op}`);
      rejected.onsuccess = () => { base.rejected = rejected.result ?? null; finish(); };
    };
    for (const [field, pending] of [['welcome_primary', false], ['welcome_pending', true]] as const) {
      const prefix = externalWelcomePrefix(cid, device, pending), read = meta.openCursor(IDBKeyRange.bound(prefix, prefix + '\uffff')); let count = 0;
      read.onsuccess = () => { const cursor = read.result; if (!cursor) { finish(); return; }
        if (++count > 100) { fail(recoveryControlError('external_join_work_backlog')); return; }
        base[field][String(cursor.key)] = cursor.value;
        const row = cursor.value, key = externalWelcomePrefix(cid, device) + String(cursor.key).slice(prefix.length), retained = history.get(key);
        remaining++; retained.onsuccess = () => {
          if (retained.result !== undefined && (pending || !sameSyncCheckpointValue(retained.result, row) ||
              !validCompletedWelcome(key, retained.result, user, device, cid, retained.result?.signing_identity_sha256))) {
            fail(recoveryControlError('welcome_checkpoint_invalid')); return;
          }
          finish();
        };
        cursor.continue();
      };
    }
  }

  async loadExternalJoinWorkBase(user: string, device: string, cid: string, operation: string, eventId?: string,
    continuation?: WelcomeHistoryContinuation): Promise<ExternalJoinWorkBase> {
    // Freeze before the first await. A newer unrelated read cannot authorize an old continuation.
    const captured = continuation ? {...continuation, owner: structuredClone(continuation.owner)} : undefined;
    if (this.accountId !== user) throw recoveryControlError('recovery_scope_changed');
    captured?.assertOwner(); const db = await this.openDB(); captured?.assertOwner();
    const read = () => new Promise<ExternalJoinWorkBase>((resolve, reject) => {
      const tx = db.transaction([STORE_META, STORE_IDENTITY, STORE_GROUPS, STORE_PENDING_SENDS, STORE_WELCOME_HISTORY], 'readonly'); let base: ExternalJoinWorkBase, failure: unknown;
      this._readExternalJoinWorkBase(tx, user, device, cid, operation, value => { base = value; }, error => { failure = error; tx.abort(); }, eventId);
      tx.oncomplete = () => { try { captured?.assertOwner(); resolve(base); } catch (error) { reject(error); } }; tx.onerror = () => { failure ||= tx.error; };
      tx.onabort = () => reject(failure || recoveryControlError('recovery_checkpoint_uncertain'));
    });
    try { return await read(); } catch (error) {
      if (!captured || (error as {code?: string})?.code !== 'external_join_work_backlog') throw error;
      try { captured.assertOwner(); const prior = await this.loadWelcomeHistoryWork(user, device, cid); captured.assertOwner();
      const work = await this.saveWelcomeHistoryWork(user, device, cid, prior, captured, Date.now()); captured.assertOwner();
      if (work.work!.status !== 'pending') throw recoveryControlError(work.work!.reason || 'welcome_history_blocked');
      await this.compactWelcomeHistory(user, device, cid, {...captured, work}); captured.assertOwner();
      try { return await read(); } catch (retryError) {
        if ((retryError as {code?: string})?.code === 'external_join_work_backlog') throw Object.assign(recoveryControlError('welcome_history_backlog'), {recovery_owner_conflict: 'scope'});
        throw retryError;
      } } catch (cause) { throw Object.assign(cause as object, {welcome_history_work_pending: true}); }
    }
  }

  /** One original full read set, one atomic transition, one consistent full readback. */
  async saveExternalJoinWork(user: string, device: string, cid: string, expected: ExternalJoinWorkBase,
    change: ExternalJoinWorkChange, assertOwner: () => void): Promise<ExternalJoinWorkBase> {
    let captured: ExternalJoinWorkBase, submitted: ExternalJoinWorkChange, wanted: ExternalJoinWorkBase, db: IDBDatabase;
    try {
      captured = structuredClone(expected); submitted = structuredClone(change);
      if (this.accountId !== user) throw recoveryControlError('recovery_scope_changed');
      wanted = nextExternalJoinWorkBase(captured, submitted, user, device, cid);
      assertOwner(); db = await this.openDB(); assertOwner();
    } catch (cause) { throw Object.assign(recoveryControlError((cause as {code?: string})?.code || 'recovery_checkpoint_uncertain'), {cause, checkpoint_outcome: 'aborted'}); }
    const operation = submitted.candidate.body.operation_id;
    const oldWork = captured.welcome_history_work?.work, newWork = wanted.welcome_history_work?.work;
    const predecessor = oldWork && newWork && oldWork.status !== 'pending' && newWork.status === 'pending' ?
      {key: `welcome_retention_work_previous:v1:${encodeURIComponent(device)}:${encodeURIComponent(cid)}:${newWork.intent_id}`, value: {version: 1, reason: 'new_source', previous: captured.welcome_history_work}} : null;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_META, STORE_IDENTITY, STORE_GROUPS, STORE_PENDING_SENDS, STORE_WELCOME_HISTORY], 'readwrite'); let failure: unknown;
      const fail = (error: unknown) => { failure = error; tx.abort(); };
      tx.oncomplete = () => resolve(); tx.onerror = () => { failure ||= tx.error; };
      tx.onabort = () => reject(Object.assign(recoveryControlError('recovery_checkpoint_uncertain'), {cause: failure || tx.error,
        checkpoint_outcome: 'aborted', recovery_owner_conflict: (failure as {recovery_owner_conflict?: string})?.recovery_owner_conflict}));
      this._readExternalJoinWorkBase(tx, user, device, cid, operation, actual => { try {
        assertOwner();
        if (!sameSyncCheckpointValue(actual, captured)) throw Object.assign(recoveryControlError('recovery_checkpoint_conflict'),
          {recovery_owner_conflict: this._groupInfoOwnerConflict(actual.state, captured.state, cid)});
        const meta = tx.objectStore(STORE_META);
        if (submitted.kind === 'prepare') { meta.put(submitted.candidate, `${EXTERNAL_CANDIDATE_PREFIX}${cid}`); return; }
        const cp = submitted.checkpoint;
        this._writeProviderCheckpoint(tx, user, device, cp.provider_bytes, cp.provider_write_guard, () => {
          assertOwner(); tx.objectStore(STORE_GROUPS).put(cp.generation, cid);
          meta.put(cp.readiness, `${EXTERNAL_JOIN_READINESS_PREFIX}${cid}`); meta.put(submitted.receipt, `${EXTERNAL_RECEIPT_PREFIX}${cid}`);
          meta.delete(`${EXTERNAL_CANDIDATE_PREFIX}${cid}`);
          for (const row of cp.welcome_dispositions || []) { meta.put(row, externalWelcomeKey(row)); meta.delete(externalWelcomeKey(row, true)); }
          if (wanted.welcome_history_work && !sameSyncCheckpointValue(wanted.welcome_history_work, captured.welcome_history_work)) {
            const work = wanted.welcome_history_work; meta.put(work.source_revision, welcomeHistorySourceKey(device, cid));
            if (work.work) this._putWelcomeHistoryWork(meta, device, cid, work.work);
          if (predecessor) meta.add(predecessor.value, predecessor.key);
          }
        }, error => { failure = error; });
      } catch (error) { fail(error); } }, fail, captured.welcome_event_id);
    });
    assertOwner();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_META, STORE_IDENTITY, STORE_GROUPS, STORE_PENDING_SENDS, STORE_WELCOME_HISTORY], 'readonly'); let matches = false, predecessorMatches = true, kind: string | undefined, failure: unknown;
      this._readExternalJoinWorkBase(tx, user, device, cid, operation, actual => {
        matches = sameSyncCheckpointValue(actual, wanted); kind = this._groupInfoOwnerConflict(actual.state, wanted.state, cid);
      }, error => { failure = error; tx.abort(); }, captured.welcome_event_id);
      if (predecessor) { const read = tx.objectStore(STORE_META).get(predecessor.key); read.onsuccess = () => { predecessorMatches = sameExternalCandidateScanValue(read.result, predecessor.value); }; }
      tx.oncomplete = () => { try { assertOwner();
        if (!matches || !predecessorMatches) throw Object.assign(recoveryControlError('recovery_checkpoint_uncertain'), {recovery_owner_conflict: kind}); resolve();
      } catch (error) { reject(error); } };
      tx.onerror = () => { failure ||= tx.error; };
      tx.onabort = () => reject(Object.assign(recoveryControlError('recovery_checkpoint_uncertain'), {cause: failure || tx.error, checkpoint_outcome: 'uncertain'}));
    });
    assertOwner(); if (!sameSyncCheckpointValue(captured.welcome_history_work, wanted.welcome_history_work)) this._notifyWelcomeHistoryWork(device);
    return structuredClone(wanted);
  }

  readonly welcomeWorkCheckpointVersion = 1 as const;
  readonly welcomeAuthoredDispositionVersion = 1 as const;
  readonly welcomeGenerationDispositionVersion = 1 as const;
  readonly welcomeManualWorkCheckpointVersion = 1 as const;

  /** One original full read set, one atomic transition, one consistent full readback. */
  async saveWelcomeWork(user: string, device: string, cid: string, expected: ExternalJoinWorkBase,
    change: WelcomeWorkChange, assertOwner: () => void): Promise<ExternalJoinWorkBase> {
    let captured: ExternalJoinWorkBase, submitted: WelcomeWorkChange, wanted: ExternalJoinWorkBase, db: IDBDatabase;
    try {
      captured = structuredClone(expected); submitted = structuredClone(change);
      if (this.accountId !== user) throw recoveryControlError('recovery_scope_changed');
      wanted = nextWelcomeWorkBase(captured, submitted, user, device, cid);
      assertOwner(); db = await this.openDB(); assertOwner();
    } catch (cause) { throw Object.assign(recoveryControlError((cause as {code?: string})?.code || 'recovery_checkpoint_uncertain'), {cause, checkpoint_outcome: 'aborted'}); }
    const operation = '';
    const oldWork = captured.welcome_history_work?.work, newWork = wanted.welcome_history_work?.work;
    const predecessor = oldWork && newWork && oldWork.status !== 'pending' && newWork.status === 'pending' ?
      {key: `welcome_retention_work_previous:v1:${encodeURIComponent(device)}:${encodeURIComponent(cid)}:${newWork.intent_id}`, value: {version: 1, reason: 'new_source', previous: captured.welcome_history_work}} : null;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_META, STORE_IDENTITY, STORE_GROUPS, STORE_PENDING_SENDS, STORE_WELCOME_HISTORY], 'readwrite'); let failure: unknown;
      const fail = (error: unknown) => { failure = error; tx.abort(); };
      tx.oncomplete = () => resolve(); tx.onerror = () => { failure ||= tx.error; };
      tx.onabort = () => reject(Object.assign(recoveryControlError('recovery_checkpoint_uncertain'), {cause: failure || tx.error,
        checkpoint_outcome: 'aborted', recovery_owner_conflict: (failure as {recovery_owner_conflict?: string})?.recovery_owner_conflict}));
      this._readExternalJoinWorkBase(tx, user, device, cid, operation, actual => { try {
        assertOwner();
        if (!sameSyncCheckpointValue(actual, captured)) throw Object.assign(recoveryControlError('recovery_checkpoint_conflict'),
          {recovery_owner_conflict: this._groupInfoOwnerConflict(actual.state, captured.state, cid)});
        const meta = tx.objectStore(STORE_META);
        const apply = () => { try {
        if (wanted.welcome_history_work && !sameSyncCheckpointValue(wanted.welcome_history_work, captured.welcome_history_work)) {
          const work = wanted.welcome_history_work; meta.put(work.source_revision, welcomeHistorySourceKey(device, cid));
          if (work.work) this._putWelcomeHistoryWork(meta, device, cid, work.work);
          if (predecessor) meta.add(predecessor.value, predecessor.key);
        }
        if (submitted.kind === 'pending') {
          meta.put(submitted.record, externalWelcomeKey(submitted.record)); meta.put(submitted.record, externalWelcomeKey(submitted.record, true));
          meta.put(submitted.readiness, `${EXTERNAL_JOIN_READINESS_PREFIX}${cid}`); return;
        }
        const cp = submitted.checkpoint;
        this._writeProviderCheckpoint(tx, user, device, cp.provider_bytes, cp.provider_write_guard, () => {
          assertOwner(); tx.objectStore(STORE_GROUPS).put(cp.generation, cid);
          if (submitted.kind === 'apply') {
            meta.delete(`${EXTERNAL_JOIN_READINESS_PREFIX}${cid}`);
            if (submitted.record.checkpoint?.rejoin) meta.delete(`mls_removal:v1:${cid}`);
            meta.put(submitted.record, externalWelcomeKey(submitted.record)); meta.delete(externalWelcomeKey(submitted.record, true));
          }
          // Manual processing preserves all existing readiness/event/index/receipt/candidate obligations.

        }, error => { failure = error; });
        } catch (error) { fail(error); } };
        if (submitted.kind === 'manual') apply();
        else {
          const point = tx.objectStore(STORE_WELCOME_HISTORY).get(externalWelcomeKey(submitted.record));
          point.onsuccess = () => { if (point.result !== undefined) fail(recoveryControlError('welcome_disposition_required')); else apply(); };
        }
      } catch (error) { fail(error); } }, fail, captured.welcome_event_id);
    });
    assertOwner();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_META, STORE_IDENTITY, STORE_GROUPS, STORE_PENDING_SENDS, STORE_WELCOME_HISTORY], 'readonly'); let matches = false, predecessorMatches = true, kind: string | undefined, failure: unknown;
      this._readExternalJoinWorkBase(tx, user, device, cid, operation, actual => {
        matches = sameSyncCheckpointValue(actual, wanted); kind = this._groupInfoOwnerConflict(actual.state, wanted.state, cid);
      }, error => { failure = error; tx.abort(); }, captured.welcome_event_id);
      if (predecessor) { const read = tx.objectStore(STORE_META).get(predecessor.key); read.onsuccess = () => { predecessorMatches = sameExternalCandidateScanValue(read.result, predecessor.value); }; }
      tx.oncomplete = () => { try { assertOwner();
        if (!matches || !predecessorMatches) throw Object.assign(recoveryControlError('recovery_checkpoint_uncertain'), {recovery_owner_conflict: kind}); resolve();
      } catch (error) { reject(error); } };
      tx.onerror = () => { failure ||= tx.error; };
      tx.onabort = () => reject(Object.assign(recoveryControlError('recovery_checkpoint_uncertain'), {cause: failure || tx.error, checkpoint_outcome: 'uncertain'}));
    });
    assertOwner(); if (!sameSyncCheckpointValue(captured.welcome_history_work, wanted.welcome_history_work)) this._notifyWelcomeHistoryWork(device);
    return structuredClone(wanted);
  }

  async saveExternalJoinCandidateCheckpoint(checkpoint: ExternalJoinCandidateCheckpoint): Promise<void> {
    const db=await this.openDB();
    return new Promise((resolve,reject) => {
      const tx=db.transaction(STORE_META,'readwrite'),store=tx.objectStore(STORE_META),key=`${EXTERNAL_CANDIDATE_PREFIX}${checkpoint.cid}`;
      const req=store.get(key);
      tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);
      tx.onabort=()=>reject(tx.error || new Error('External candidate save aborted'));
      req.onsuccess=()=>{
        try {
          if (req.result && req.result.body?.operation_id!==checkpoint.body.operation_id) {
            throw new Error('A different External Join candidate is pending');
          }
          store.put(checkpoint,key);
        } catch(error){tx.abort();reject(error);}
      };
      req.onerror=()=>reject(req.error);
    });
  }

  async saveExternalJoinActivationCheckpoint(checkpoint: JoinPersistenceCheckpoint, receipt: ExternalJoinReceipt, expectedActiveProvider: Uint8Array): Promise<void> {
    const db=await this.openDB();
    return new Promise((resolve,reject) => {
      const tx=db.transaction([STORE_META,STORE_GROUPS,STORE_WELCOME_HISTORY],'readwrite'),meta=tx.objectStore(STORE_META),key=`${EXTERNAL_CANDIDATE_PREFIX}${checkpoint.cid}`;
      const req=meta.get(key);
      tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);
      tx.onabort=()=>reject(tx.error || new Error('External activation checkpoint aborted'));
      req.onsuccess=()=>{
        try {
          const pending=req.result;
          if (!pending || pending.user_id!==checkpoint.user_id || pending.device_id!==checkpoint.device_id ||
              pending.body?.operation_id!==receipt.operation_id || receipt.cid!==checkpoint.cid || receipt.state!=='accepted') {
            throw new Error('External activation scope/operation changed');
          }
          const providerRequest=meta.get(`provider:${checkpoint.user_id}:${checkpoint.device_id}`);
          providerRequest.onerror=()=>reject(providerRequest.error);
          providerRequest.onsuccess=()=>{
          try {
          const stored=providerRequest.result;
          if (!checkpoint.provider_write_guard && (!(stored instanceof Uint8Array) || stored.length!==expectedActiveProvider.length ||
              !stored.every((byte:number,index:number)=>byte===expectedActiveProvider[index]))) {
            throw new Error('External activation active-provider CAS failed');
          }
          this._writeProviderCheckpoint(tx, checkpoint.user_id, checkpoint.device_id, checkpoint.provider_bytes,
            checkpoint.provider_write_guard, () => {
          tx.objectStore(STORE_GROUPS).put(checkpoint.generation || true,checkpoint.cid);
          if (checkpoint.readiness) meta.put(checkpoint.readiness,`${EXTERNAL_JOIN_READINESS_PREFIX}${checkpoint.cid}`);
          else meta.delete(`${EXTERNAL_JOIN_READINESS_PREFIX}${checkpoint.cid}`);
          meta.put(receipt,`${EXTERNAL_RECEIPT_PREFIX}${checkpoint.cid}`);
          meta.delete(key);
          this._writeWelcomeDispositions(tx,meta,checkpoint,reject);
          }, reject);
          } catch(error){tx.abort();reject(error);}
          };
        } catch(error){tx.abort();reject(error);}
      };
      req.onerror=()=>reject(req.error);
    });
  }

  async saveExternalJoinRejectionCheckpoint(job: ExternalJoinCandidateCheckpoint, receipt: ExternalJoinReceipt): Promise<void> {
    validateExternalJoinRejection(job,receipt);
    if(job.user_id!==this.accountId)throw new Error('External rejection account mismatch');
    const db=await this.openDB();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE_META,'readwrite'),meta=tx.objectStore(STORE_META),key=`${EXTERNAL_CANDIDATE_PREFIX}${job.cid}`;
      tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error || new Error('External rejection aborted'));
      const req=meta.get(key);req.onerror=()=>reject(req.error);
      req.onsuccess=()=>{
        try {
          const stored=req.result as ExternalJoinCandidateCheckpoint | undefined;
          if(!stored || stored.user_id!==job.user_id || stored.device_id!==job.device_id ||
              stored.signing_identity_sha256!==job.signing_identity_sha256 || stored.base_sha256!==job.base_sha256 ||
              stored.candidate_sha256!==job.candidate_sha256 || stored.commit_sha256!==job.commit_sha256)throw new Error('External rejection candidate CAS failed');
          validateExternalJoinRejection(stored,receipt);
          meta.put(receipt,`external_rejection:v1:${encodeURIComponent(job.cid)}:${receipt.operation_id}`);
          meta.delete(key);
        }catch(error){tx.abort();reject(error);}
      };
    });
  }

  readonly externalJoinRejectionWorkVersion = 1 as const;

  /** Retire only an exact candidate under the captured private and full scoped read set. */
  async saveExternalJoinRejectionWork(userId: string, deviceId: string, cid: string, expected: MlsReadyBase,
    job: ExternalJoinCandidateCheckpoint, receipt: ExternalJoinReceipt, assertOwner: () => void): Promise<MlsReadyBase> {
    const captured = structuredClone(expected), candidate = structuredClone(job), rejected = structuredClone(receipt);
    validateExternalJoinRejection(candidate, rejected);
    const candidateKey = `${EXTERNAL_CANDIDATE_PREFIX}${cid}`;
    const rejectionKey = `external_rejection:v1:${encodeURIComponent(cid)}:${rejected.operation_id}`;
    if (this.accountId !== userId || candidate.user_id !== userId || candidate.device_id !== deviceId || candidate.cid !== cid ||
        !captured.provider_bytes || !captured.identity_bytes || !sameSyncCheckpointValue(captured.cleanup.metadata[candidateKey], candidate)) {
      throw recoveryControlError('recovery_scope_changed');
    }
    const wanted = structuredClone(captured); wanted.cleanup.metadata[candidateKey] = null;
    assertOwner(); const db = await this.openDB(); assertOwner();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_META, STORE_IDENTITY, STORE_GROUPS, STORE_PENDING_SENDS], 'readwrite'); let failure: unknown;
      tx.oncomplete = () => resolve(); tx.onerror = () => { failure ||= tx.error; };
      tx.onabort = () => reject(Object.assign(recoveryControlError('recovery_checkpoint_uncertain'),
        {cause: failure || tx.error, checkpoint_outcome: 'aborted', recovery_owner_conflict: (failure as {recovery_owner_conflict?: string})?.recovery_owner_conflict}));
      this._readMlsReadyBase(tx, userId, deviceId, cid, actual => { try {
        assertOwner();
        if (!sameSyncCheckpointValue(actual, captured)) throw Object.assign(recoveryControlError('recovery_checkpoint_conflict'),
          {recovery_owner_conflict: this._groupInfoOwnerConflict(actual, captured, cid)});
        const meta = tx.objectStore(STORE_META), prior = meta.get(rejectionKey);
        prior.onsuccess = () => { try {
          assertOwner();
          if (prior.result !== undefined && !sameSyncCheckpointValue(prior.result, rejected)) throw recoveryControlError('recovery_checkpoint_conflict');
          meta.put(rejected, rejectionKey); meta.delete(candidateKey);
        } catch (error) { failure = error; tx.abort(); } };
      } catch (error) { failure = error; tx.abort(); } });
    });
    assertOwner();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_META, STORE_IDENTITY, STORE_GROUPS, STORE_PENDING_SENDS], 'readonly');
      let matches = false, receiptMatches = false, kind: string | undefined;
      this._readMlsReadyBase(tx, userId, deviceId, cid, actual => {
        matches = sameSyncCheckpointValue(actual, wanted); kind = this._groupInfoOwnerConflict(actual, wanted, cid);
      });
      const read = tx.objectStore(STORE_META).get(rejectionKey);
      read.onsuccess = () => { receiptMatches = sameSyncCheckpointValue(read.result, rejected); };
      tx.oncomplete = () => { try { assertOwner();
        if (!matches || !receiptMatches) throw Object.assign(recoveryControlError('recovery_checkpoint_uncertain'), {recovery_owner_conflict: kind});
        resolve();
      } catch (error) { reject(error); } };
      tx.onerror = () => {};
      tx.onabort = () => reject(Object.assign(recoveryControlError('recovery_checkpoint_uncertain'), {checkpoint_outcome: 'uncertain'}));
    });
    assertOwner(); return structuredClone(wanted);
  }

  async loadExternalJoinRejectionCheckpoint(cid: string, operationId: string): Promise<ExternalJoinReceipt | null> {
    const db=await this.openDB();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE_META,'readonly'),req=tx.objectStore(STORE_META).get(`external_rejection:v1:${encodeURIComponent(cid)}:${operationId}`);
      req.onsuccess=()=>resolve(req.result || null);req.onerror=()=>reject(req.error);tx.onabort=()=>reject(tx.error || new Error('External rejection read aborted'));
    });
  }

  async loadExternalJoinReceipt(cid: string): Promise<ExternalJoinReceipt | null> {
    const db=await this.openDB();
    return new Promise((resolve,reject) => {
      const tx=db.transaction(STORE_META,'readonly'),req=tx.objectStore(STORE_META).get(`${EXTERNAL_RECEIPT_PREFIX}${cid}`);
      req.onsuccess=()=>resolve(req.result || null);req.onerror=()=>reject(req.error);
      tx.onabort=()=>reject(tx.error || new Error('External receipt read aborted'));
    });
  }

  readonly groupInfoRefreshCheckpointVersion = 1 as const;

  readonly recoveryDiscoveryWorkVersion = 1 as const;

  readonly recoveryWorkDispositionVersion = 1 as const;

  /** A bounded scheduling transaction. Original public evidence survives every disposition. */
  readonly recoveryWorkScanVersion = 1 as const;

  /** Select a fair bounded page. Selection never completes, reserves or deletes a job. */
  async takeRecoveryWorkPage<L extends RecoveryWorkScanLane>(userId: string, deviceId: string, lane: L,
    now: number, owner: RecoveryWorkOwner, assertOwner: () => void): Promise<RecoveryWorkScanRows[L][]> {
    if(userId!==this.accountId || !deviceId || !['admission','ack'].includes(lane))throw recoveryControlError('recovery_scope_changed');
    if(!Number.isSafeInteger(now) || now<=0)throw recoveryControlError('invalid_clock');
    const captured=structuredClone(owner),operation=crypto.randomUUID();assertOwner();
    const db=await this.openDB();assertOwner();
    const prefix=lane==='admission'?validationAdmissionPendingPrefix(deviceId):validationAckPendingPrefix(deviceId);
    const upper=`${prefix}${String(now).padStart(16,'0')}:\uffff`,key=`recovery_work_scan:v1:${encodeURIComponent(deviceId)}:${lane}`;
    const selected:Array<{key:string;value:RecoveryWorkScanRows[L]}>=[];
    let checkpoint:RecoveryWorkScanCheckpoint,disposition:{key:string;record:RecoveryWorkDisposition}|null=null;
    const fail=(tx:IDBTransaction,error:unknown)=>{(tx as IDBTransaction&{workFailure?:unknown}).workFailure=error;tx.abort();};
    const failure=(tx:IDBTransaction,outcome:'aborted'|'uncertain')=>{
      const cause=(tx as IDBTransaction&{workFailure?:unknown}).workFailure || tx.error;
      return Object.assign(recoveryControlError((cause as {code?:string})?.code==='client_upgrade_required'?'client_upgrade_required':'recovery_checkpoint_uncertain'),
        {cause,checkpoint_outcome:outcome,recovery_owner_conflict:(cause as {recovery_owner_conflict?:string})?.recovery_owner_conflict});
    };
    const privateProof=(tx:IDBTransaction,done:()=>void)=>{
      const meta=tx.objectStore(STORE_META),p=meta.get(`provider:${userId}:${deviceId}`),r=meta.get(`provider_revision:${userId}:${deviceId}`),
        i=tx.objectStore(STORE_IDENTITY).get(`${userId}:${deviceId}`);let left=3;
      const finish=()=>{if(--left)return;try{assertOwner();
        if(!sameSyncCheckpointValue(p.result,captured.provider_bytes) || (r.result??null)!==captured.revision || !sameSyncCheckpointValue(i.result,captured.identity_bytes))
          throw Object.assign(recoveryControlError('recovery_checkpoint_conflict'),{recovery_owner_conflict:'provider'});
        done();
      }catch(error){fail(tx,error);}};
      p.onsuccess=r.onsuccess=i.onsuccess=finish;
    };
    await new Promise<void>((resolve,reject)=>{
      const tx=db.transaction([STORE_META,STORE_IDENTITY],'readwrite'),meta=tx.objectStore(STORE_META);
      tx.oncomplete=()=>resolve();tx.onabort=()=>reject(failure(tx,'aborted'));tx.onerror=()=>{};
      privateProof(tx,()=>{const read=meta.get(key);read.onsuccess=()=>{try{
        assertOwner();const prior=read.result??null;let after:string|null=null,reason:RecoveryWorkDisposition['reason']|null=null;
        if(prior!==null){
          if(prior?.version!==undefined && prior.version!==1)throw recoveryControlError('client_upgrade_required');
          if(!prior || prior.version!==1 || typeof prior.operation_id!=='string' ||
              !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(prior.operation_id) ||
              (prior.after!==null && (typeof prior.after!=='string' || !prior.after.startsWith(prefix))))reason='corrupt';
          else if(prior.user_id!==userId || prior.device_id!==deviceId || prior.lane!==lane ||
              prior.signing_identity_sha256!==captured.signer || prior.artifact_sha256!==captured.artifact)reason='scope';
          else after=prior.after;
        }
        const finish=()=>{assertOwner();checkpoint={version:1,user_id:userId,device_id:deviceId,signing_identity_sha256:captured.signer,
          artifact_sha256:captured.artifact,lane,operation_id:operation,after:selected.length?selected[selected.length-1].key:null};
          if(reason){const record:RecoveryWorkDisposition={version:1,lane,source_key:key,primary_key:null,reason,source:prior,
              primary:null,control:null,marker:null,replacement:checkpoint};
            disposition={key:`recovery_work_disposition:v1:${encodeURIComponent(deviceId)}:${crypto.randomUUID()}`,record};
            meta.add(record,disposition.key);
          }
          meta.put(checkpoint,key);
        };
        const scan=(lower:string|null,wrap:boolean)=>{
          const range=IDBKeyRange.bound(lower||prefix,upper,!!lower),request=meta.openCursor(range);
          request.onsuccess=()=>{try{assertOwner();const cursor=request.result;
            if(!cursor){if(wrap && !selected.length){scan(null,false);return;}finish();return;}
            selected.push({key:String(cursor.key),value:cursor.value});
            if(selected.length===50)finish();else cursor.continue();
          }catch(error){fail(tx,error);}};
        };
        scan(after && after<upper?after:null,!!after && after<upper);
      }catch(error){fail(tx,error);}};});
    });
    assertOwner();
    await new Promise<void>((resolve,reject)=>{
      const tx=db.transaction([STORE_META,STORE_IDENTITY],'readonly'),meta=tx.objectStore(STORE_META);let matches=true;
      privateProof(tx,()=>{
        const checks:Array<[string,unknown]>=[[key,checkpoint],...selected.map(row=>[row.key,row.value] as [string,unknown])];
        if(disposition)checks.push([disposition.key,disposition.record]);
        for(const[address,value]of checks){const read=meta.get(address);read.onsuccess=()=>{matches=matches&&sameSyncCheckpointValue(read.result??null,value);};}
      });
      tx.oncomplete=()=>{try{assertOwner();if(!matches)throw recoveryControlError('recovery_checkpoint_uncertain');resolve();}catch(error){reject(error);}};
      tx.onabort=()=>reject(failure(tx,'uncertain'));tx.onerror=()=>{};
    });
    assertOwner();return selected.map(row=>row.value);
  }

  async maintainRecoveryWork(userId: string, deviceId: string, lane: RecoveryWorkLane,
    owner: RecoveryWorkOwner, assertOwner: () => void): Promise<number> {
    if (userId !== this.accountId || !deviceId) throw recoveryControlError('recovery_scope_changed');
    const captured = structuredClone(owner), db = await this.openDB();
    assertOwner();
    const prefix = lane === 'discovery' ? `mls_discovery_due:v1:${encodeURIComponent(deviceId)}:` :
      lane === 'gi' ? `gi_work_due:v1:${encodeURIComponent(deviceId)}:` :
      lane === 'ack' ? validationAckPendingPrefix(deviceId) :
      lane === 'admission' ? validationAdmissionPendingPrefix(deviceId) : GROUP_INFO_REFRESH_REQUEST_PREFIX;
    const limit = lane === 'discovery' ? 200 : 50;
    const witnesses: Array<{key: string; cid: string | null; record: RecoveryWorkDisposition; pausedKey: string | null; paused: unknown}> = [];
    const readPrivate = (tx: IDBTransaction, done: () => void) => {
      const meta = tx.objectStore(STORE_META), p = meta.get(`provider:${userId}:${deviceId}`),
        r = meta.get(`provider_revision:${userId}:${deviceId}`), i = tx.objectStore(STORE_IDENTITY).get(`${userId}:${deviceId}`);
      let left = 3;
      const finish = () => { if (--left) return;
        try { assertOwner();
          if (!sameSyncCheckpointValue(p.result, captured.provider_bytes) || (r.result ?? null) !== captured.revision ||
              !sameSyncCheckpointValue(i.result, captured.identity_bytes)) throw Object.assign(recoveryControlError('recovery_checkpoint_conflict'), {recovery_owner_conflict: 'provider'});
          done();
        } catch (error) { (tx as IDBTransaction & {workFailure?: unknown}).workFailure = error; tx.abort(); }
      };
      p.onsuccess = r.onsuccess = i.onsuccess = finish;
    };
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_META, STORE_IDENTITY, STORE_GROUPS], 'readwrite'), meta = tx.objectStore(STORE_META);
      let failure: unknown;
      const abort = (error: unknown) => { failure = error; tx.abort(); };
      tx.oncomplete = () => resolve(); tx.onerror = () => { failure ||= tx.error; };
      tx.onabort = () => { const cause = (tx as IDBTransaction & {workFailure?: unknown}).workFailure || failure || tx.error;
        reject(Object.assign(recoveryControlError('recovery_checkpoint_uncertain'), {cause, checkpoint_outcome: 'aborted', recovery_owner_conflict: (cause as {recovery_owner_conflict?: string})?.recovery_owner_conflict})); };
      readPrivate(tx, () => {
        const scan = (after: string | null) => {
          let count = 0;
          const scanRead = meta.openCursor(IDBKeyRange.bound(after || prefix, `${prefix}\uffff`, !!after));
          scanRead.onsuccess = () => { const cursor = scanRead.result; if (!cursor || count++ >= limit) return;
            const sourceKey = String(cursor.key), source: any = cursor.value;
            let cid: string | null = null, primaryKey: string | null = null, expectedKey: string | null = null;
            let reason: RecoveryWorkDisposition['reason'] | null = null;
            try {
              if (lane === 'legacy_gi') {
                validateGroupInfoRequest(source); cid = source.cid;
                if (!cid || cid.indexOf(':') <= 0 || cid.length > 512) throw recoveryControlError('storage_corruption');
                expectedKey = `${prefix}${cid}:${source.request_id}`;
              } else {
                // Address the primary from the scheduling key, never from untrusted job fields.
                const parts = sourceKey.slice(prefix.length).split(':');
                if (!/^\d{16}$/.test(parts[0]) || parts.length !== (lane === 'gi' ? 3 : 2)) throw recoveryControlError('storage_corruption');
                cid = decodeURIComponent(parts[1]);
                primaryKey = lane === 'gi' ? groupInfoWorkKey(deviceId, cid, decodeURIComponent(parts[2])) :
                  lane === 'discovery' ? discoveryWorkKey(deviceId, cid) : lane === 'ack' ? validationAckKey(cid, deviceId) :
                  `gi_validation_admission:v1:${encodeURIComponent(deviceId)}:${encodeURIComponent(cid)}`;
                if (source?.version !== 1) reason = 'upgrade';
                else {
                  if (lane === 'gi') { validateGroupInfoWork(source); expectedKey = groupInfoWorkDueKey(source); }
                  if (lane === 'discovery') { validateDiscoveryWork(source); expectedKey = discoveryDueKey(source); }
                  if (lane === 'ack') { validateValidationAckCheckpoint(source); expectedKey = validationAckPendingKey(source); }
                  if (lane === 'admission') { validateValidationAdmission(source); expectedKey = validationAdmissionPendingKey(source); }
                  if (source.user_id !== userId || source.device_id !== deviceId || source.signing_identity_sha256 !== captured.signer) reason = 'scope';
                  else if (source.artifact_sha256 !== captured.artifact) reason = 'upgrade';
                  else if ((lane === 'gi' || lane === 'discovery' ? source.disposition : source.outcome) !== 'pending') reason = 'index_mismatch';
                }
              }
              if (expectedKey && expectedKey !== sourceKey) reason = 'index_mismatch';
            } catch { reason ||= 'corrupt'; }
            const primary = primaryKey ? meta.get(primaryKey) : null;
            const control = cid ? meta.get(recoveryControlKey(cid, deviceId)) : null;
            const marker = cid ? tx.objectStore(STORE_GROUPS).get(cid) : null;
            const pausedKey = lane === 'admission' && cid ? `gi_validation_admission_paused:v1:${encodeURIComponent(deviceId)}:${encodeURIComponent(cid)}` : null;
            const paused = pausedKey ? meta.get(pausedKey) : null;
            let left = Number(!!primary) + Number(!!control) + Number(!!marker) + Number(!!paused);
            const finish = () => { try {
              assertOwner();
              const primaryValue = primary?.result ?? null, controlValue = control?.result ?? null, markerValue = marker?.result ?? null;
              if (primary && !sameSyncCheckpointValue(primaryValue, source)) reason ||= 'index_mismatch';
              if (paused?.result) reason ||= 'index_mismatch';
              if (!reason && lane === 'ack' && controlValue && markerValue &&
                  sameSyncCheckpointValue(captured.controls[cid!] ?? null, controlValue) && sameSyncCheckpointValue(captured.markers[cid!] ?? null, markerValue)) {
                validateRecoveryControl(controlValue);
                if (controlValue.user_id === userId && controlValue.device_id === deviceId && controlValue.signing_identity_sha256 === captured.signer &&
                    controlValue.group_generation === source.request.group_generation && markerValue.group_generation === controlValue.group_generation &&
                    BigInt(controlValue.recovery_revision) > BigInt(source.recovery_revision)) reason = 'superseded';
              }
              if (reason) {
                const record: RecoveryWorkDisposition = {version: 1, lane, source_key: sourceKey, primary_key: primaryKey, reason,
                  source, primary: primaryValue, control: controlValue, marker: markerValue};
                const key = `recovery_work_disposition:v1:${encodeURIComponent(deviceId)}:${crypto.randomUUID()}`;
                meta.add(record, key); meta.delete(sourceKey);
                if(primaryKey && reason!=='superseded')meta.put({record,disposition_key:key},recoveryWorkParkedKey(deviceId,primaryKey));
                // Only a proved newer authoritative control releases the ACK primary slot.
                if (reason === 'superseded' && primaryKey) meta.delete(primaryKey);
                witnesses.push({key, cid, record, pausedKey, paused: paused?.result ?? null});
              }
              cursor.continue();
            } catch (error) { abort(error); } };
            if (!left) finish(); else for (const read of [primary, control, marker, paused]) if (read) read.onsuccess = () => { if (--left === 0) finish(); };
          };
        };
        if (lane !== 'legacy_gi') { scan(null); return; }
        const read = meta.get(groupInfoWorkCursorKey(deviceId));
        read.onsuccess = () => { const after = read.result ?? null;
          if (after !== null && (typeof after !== 'string' || !after.startsWith(prefix))) { abort(recoveryControlError('storage_corruption')); return; }
          scan(after);
        };
      });
    });
    assertOwner();
    if (!witnesses.length) return 0;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_META, STORE_IDENTITY, STORE_GROUPS], 'readonly'), meta = tx.objectStore(STORE_META);
      let matches = true;
      readPrivate(tx, () => {
        for (const {key, cid, record, pausedKey, paused} of witnesses) {
          for (const [store, address, expected] of [
            [meta, key, record], [meta, record.source_key, null],
            ...(record.primary_key ? [[meta, record.primary_key, record.reason === 'superseded' ? null : record.primary]] : []),
            ...(record.primary_key && record.reason!=='superseded' ? [[meta,recoveryWorkParkedKey(deviceId,record.primary_key),{record,disposition_key:key}]] : []),
            ...(cid ? [[tx.objectStore(STORE_GROUPS), cid, record.marker], [meta, recoveryControlKey(cid, deviceId), record.control]] : []),
            ...(pausedKey ? [[meta, pausedKey, paused]] : []),
          ] as Array<[IDBObjectStore, string, unknown]>) {
            const read = store.get(address); read.onsuccess = () => { matches = matches && sameSyncCheckpointValue(read.result ?? null, expected); };
          }
        }
      });
      tx.oncomplete = () => { try { assertOwner(); if (!matches) throw recoveryControlError('recovery_checkpoint_uncertain'); resolve(); } catch (error) { reject(error); } };
      tx.onabort = () => reject(Object.assign(recoveryControlError('recovery_checkpoint_uncertain'), {checkpoint_outcome: 'uncertain',
        recovery_owner_conflict: ((tx as IDBTransaction & {workFailure?: {recovery_owner_conflict?: string}}).workFailure)?.recovery_owner_conflict}));
      tx.onerror = () => {};
    });
    return witnesses.length;
  }

  readonly groupInfoRepairWorkVersion = 1 as const;

  async loadGroupInfoWorkObligations(cids:string[]):Promise<Record<string,{mutation:unknown;external:unknown;removal:unknown}>> {
    if(cids.length>50)throw new Error('GI obligation page exceeds bound');const db=await this.openDB();return new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE_META,'readonly'),meta=tx.objectStore(STORE_META),result:Record<string,{mutation:unknown;external:unknown;removal:unknown}>={};
      for(const cid of cids){result[cid]={mutation:null,external:null,removal:null};for(const [field,key]of [['mutation',`${MLS_MUTATION_PREFIX}${cid}`],['external',`${EXTERNAL_CANDIDATE_PREFIX}${cid}`],['removal',`mls_removal:v1:${cid}`]]as const){
        const read=meta.get(key);read.onsuccess=()=>{result[cid][field]=read.result??null;};}}
      tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(Object.assign(new Error('GI obligations read aborted'),{code:'storage_read_failed'}));tx.onerror=()=>{};
    });
  }

  async loadGroupInfoWorkPage(deviceId:string):Promise<GroupInfoWorkPage> {
    const db=await this.openDB();return new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE_META,'readonly'),meta=tx.objectStore(STORE_META);
      const page:GroupInfoWorkPage={cursor:null,next_cursor:null,requests:[],more:false};
      const read=meta.get(groupInfoWorkCursorKey(deviceId));read.onsuccess=()=>{
        page.cursor=read.result??null;
        if(page.cursor!==null && (typeof page.cursor!=='string'||!page.cursor.startsWith(GROUP_INFO_REFRESH_REQUEST_PREFIX))){tx.abort();return;}
        const cursor=meta.openCursor(IDBKeyRange.bound(page.cursor||GROUP_INFO_REFRESH_REQUEST_PREFIX,`${GROUP_INFO_REFRESH_REQUEST_PREFIX}\uffff`,!!page.cursor));
        cursor.onsuccess=()=>{const row=cursor.result;if(!row)return;
          if(page.requests.length===50){page.more=true;return;}
          page.requests.push(row.value);page.next_cursor=String(row.key);row.continue();};
      };
      tx.oncomplete=()=>{if(!page.more)page.next_cursor=null;resolve(page);};tx.onerror=()=>{};tx.onabort=()=>reject(Object.assign(new Error('GI legacy page read aborted'),{code:'storage_read_failed'}));
    });
  }

  async loadGroupInfoWork(deviceId: string, requests: Array<{cid:string;request_id:string}>): Promise<Array<GroupInfoWork | null>> {
    if (requests.length > 50) throw new Error('GI work page exceeds bound');
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readonly'), rows: Array<GroupInfoWork | null> = [];
      for (const [i,r] of requests.entries()) { const read = tx.objectStore(STORE_META).get(groupInfoWorkKey(deviceId,r.cid,r.request_id));read.onsuccess=()=>{rows[i]=read.result??null;}; }
      tx.oncomplete=()=>resolve(rows);tx.onabort=()=>reject(tx.error||new Error('GI work primary read aborted'));tx.onerror=()=>{};
    });
  }

  async listDueGroupInfoWork(deviceId: string, now: number, limit: number): Promise<GroupInfoWork[]> {
    if (!Number.isSafeInteger(now) || now <= 0 || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('GI work due page invalid');
    const db = await this.openDB(),prefix=`gi_work_due:v1:${encodeURIComponent(deviceId)}:`;
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE_META,'readonly'),meta=tx.objectStore(STORE_META);let rows:GroupInfoWork[]=[];let failure:unknown;
      const read=meta.getAll(IDBKeyRange.bound(prefix,`${prefix}${String(now).padStart(16,'0')}:\uffff`),limit);
      read.onsuccess=()=>{rows=read.result;for(const row of rows){try{validateGroupInfoWork(row);if(row.device_id!==deviceId || row.disposition!=='pending')throw recoveryControlError('storage_corruption');}
        catch(error){failure=error;tx.abort();return;}
        const primary=meta.get(groupInfoWorkKey(deviceId,row.cid,row.request.request_id));primary.onsuccess=()=>{if(!sameSyncCheckpointValue(primary.result,row)){failure=Object.assign(new Error('GI work due primary mismatch'),{code:'storage_corruption'});tx.abort();}};
      }};
      tx.oncomplete=()=>resolve(rows);tx.onabort=()=>reject(failure||tx.error||new Error('GI work due read aborted'));tx.onerror=()=>{};
    });
  }

  /** Exact intent CAS plus provider/marker owner proof; never writes private provider state. */
  async saveGroupInfoWork(userId: string, deviceId: string, changes: GroupInfoWorkChange[], owner: GroupInfoWorkOwner,
    assertOwner: () => void, admission?: GroupInfoWorkAdmission): Promise<boolean[]> {
    const submitted=structuredClone(changes),captured=structuredClone(owner);
    if(this.accountId!==userId || submitted.length>50 || new Set(submitted.map(c=>`${c.cid}\0${c.request_id}`)).size!==submitted.length)throw new Error('GI work CAS scope invalid');
    for(const change of submitted){if(!admission || !sameSyncCheckpointValue(change.next,change.expected)){validateGroupInfoWork(change.next);if(change.expected)validateGroupInfoWork(change.expected);}
      if(!(change.cid in captured.markers) || ((!admission || !sameSyncCheckpointValue(change.next,change.expected)) &&
        (change.next.user_id!==userId || change.next.device_id!==deviceId || change.next.cid!==change.cid || change.next.request.request_id!==change.request_id)))throw new Error('GI work CAS binding invalid');}
    const page=admission?structuredClone(admission.page):null;
    if(page && (page.requests.length>50 || page.requests.length!==submitted.length || page.requests.some((r,i)=>r.cid!==submitted[i].cid || r.request_id!==submitted[i].request_id)))throw new Error('GI admission page invalid');
    const db=await this.openDB(),applied=submitted.map(()=>false),wanted:Array<GroupInfoWork|null>=[],parked:Record<number,{record:RecoveryWorkDisposition;disposition_key:string}>={};
    const readOwner=(tx:IDBTransaction,done:()=>void)=>{
      let count=submitted.length*(captured.obligations?5:2)+1,failure:unknown;const finish=()=>{if(--count===0){try{assertOwner();if(failure)throw failure;done();}catch(error){(tx as IDBTransaction&{giWorkFailure?:unknown}).giWorkFailure=error;tx.abort();}}};
      const rev=tx.objectStore(STORE_META).get(`provider_revision:${userId}:${deviceId}`);rev.onsuccess=()=>{if((rev.result??null)!==captured.provider_revision)failure=Object.assign(new Error('GI work provider owner conflict'),{code:'recovery_checkpoint_conflict',gi_owner_conflict:'provider'});finish();};
      for(const change of submitted){const marker=tx.objectStore(STORE_GROUPS).get(change.cid);marker.onsuccess=()=>{if(!sameSyncCheckpointValue(marker.result??null,captured.markers[change.cid]))failure ||=Object.assign(new Error('GI work marker owner conflict'),{code:'recovery_checkpoint_conflict',gi_owner_conflict:'scope'});finish();};}
      for(const change of submitted){const control=tx.objectStore(STORE_META).get(recoveryControlKey(change.cid,deviceId));control.onsuccess=()=>{if(!sameSyncCheckpointValue(control.result??null,captured.controls[change.cid]))failure ||=Object.assign(new Error('GI work control owner conflict'),{code:'recovery_checkpoint_conflict',gi_owner_conflict:'scope'});finish();};}
      if(captured.obligations)for(const change of submitted){for(const [field,key]of [['mutation',`${MLS_MUTATION_PREFIX}${change.cid}`],['external',`${EXTERNAL_CANDIDATE_PREFIX}${change.cid}`],['removal',`mls_removal:v1:${change.cid}`]]as const){
        const read=tx.objectStore(STORE_META).get(key);read.onsuccess=()=>{if(!sameSyncCheckpointValue(read.result??null,captured.obligations![change.cid]?.[field]))failure ||=Object.assign(new Error('GI obligation owner conflict'),{code:'recovery_checkpoint_conflict',gi_owner_conflict:'scope'});finish();};}}

    };
    await new Promise<void>((resolve,reject)=>{
      const tx=db.transaction([STORE_META,STORE_GROUPS],'readwrite'),meta=tx.objectStore(STORE_META);let failure:unknown;
      tx.oncomplete=()=>resolve();tx.onerror=()=>{failure ||=tx.error;};tx.onabort=()=>{const cause=(tx as IDBTransaction&{giWorkFailure?:unknown}).giWorkFailure||failure||tx.error;reject(Object.assign(new Error('GI work CAS aborted'),{cause,code:(cause as {code?:string})?.code,gi_owner_conflict:(cause as {gi_owner_conflict?:string})?.gi_owner_conflict,checkpoint_outcome:'aborted'}));};
      readOwner(tx,()=>{
        const writeChanges=()=>{
        if(page)meta.put(page.next_cursor,groupInfoWorkCursorKey(deviceId));
        for(const [i,change]of submitted.entries()){
          const read=meta.get(groupInfoWorkKey(deviceId,change.cid,change.request_id));read.onsuccess=()=>{
            try{assertOwner();const prior=read.result??null;wanted[i]=prior;
              if(!sameSyncCheckpointValue(prior,change.expected))return;
              const address=groupInfoWorkKey(deviceId,change.cid,change.request_id),park=meta.get(recoveryWorkParkedKey(deviceId,address));
              park.onsuccess=()=>{try{
              const retained=park.result;
              if(page && retained?.record?.primary_key===address && retained.record.lane==='gi' && sameSyncCheckpointValue(retained.record.primary,prior)){
                // A journaled scheduling fault is retained work, not a new intake attempt.
                const evidence=meta.get(retained.disposition_key);evidence.onsuccess=()=>{try{
                  if(!sameSyncCheckpointValue(evidence.result,retained.record))throw recoveryControlError('storage_corruption');
                  parked[i]=retained;
                }catch(error){failure=error;tx.abort();}};return;
              }
              validateGroupInfoWork(change.next);if(prior)validateGroupInfoWork(prior);
              const index=prior?.disposition==='pending'?meta.get(groupInfoWorkDueKey(prior)):null;
              const write=()=>{assertOwner();if(prior?.disposition==='pending')meta.delete(groupInfoWorkDueKey(prior));
                meta.put(change.next,groupInfoWorkKey(deviceId,change.cid,change.request_id));if(change.next.disposition==='pending')meta.put(change.next,groupInfoWorkDueKey(change.next));applied[i]=true;wanted[i]=change.next;};
              if(index)index.onsuccess=()=>{try{if(!sameSyncCheckpointValue(index.result,prior))throw Object.assign(new Error('GI work index CAS mismatch'),{code:'storage_corruption'});write();}catch(error){failure=error;tx.abort();}};else write();
              }catch(error){failure=error;tx.abort();}};
            }catch(error){failure=error;tx.abort();}
          };
        }
        };
        if(!page){writeChanges();return;}
        let remaining=page.requests.length+1;
        const finish=()=>{if(--remaining===0)writeChanges();};
        const cursor=meta.get(groupInfoWorkCursorKey(deviceId));cursor.onsuccess=()=>{if((cursor.result??null)!==page.cursor){failure=Object.assign(new Error('GI admission cursor conflict'),{code:'recovery_checkpoint_conflict'});tx.abort();return;}finish();};
        for(const row of page.requests){const read=meta.get(`${GROUP_INFO_REFRESH_REQUEST_PREFIX}${row.cid}:${row.request_id}`);read.onsuccess=()=>{if(!sameSyncCheckpointValue(read.result,row)){failure=Object.assign(new Error('GI admission request conflict'),{code:'recovery_checkpoint_conflict'});tx.abort();return;}finish();};}
      });
    });
    await new Promise<void>((resolve,reject)=>{
      const tx=db.transaction([STORE_META,STORE_GROUPS],'readonly'),meta=tx.objectStore(STORE_META);let matches=true;
      tx.oncomplete=()=>{try{assertOwner();if(!matches)throw Object.assign(new Error('GI work committed proof mismatch'),{code:'recovery_checkpoint_uncertain'});resolve();}catch(error){reject(error);}};
      tx.onabort=()=>{const cause=(tx as IDBTransaction&{giWorkFailure?:unknown}).giWorkFailure||tx.error;reject(Object.assign(new Error('GI work committed readback aborted'),{cause,gi_owner_conflict:(cause as {gi_owner_conflict?:string})?.gi_owner_conflict,code:'recovery_checkpoint_uncertain',checkpoint_outcome:'uncertain'}));};tx.onerror=()=>{};
      readOwner(tx,()=>{
        if(page){const cursor=meta.get(groupInfoWorkCursorKey(deviceId));cursor.onsuccess=()=>{matches=matches&&(cursor.result??null)===page.next_cursor;};
          for(const row of page.requests){const read=meta.get(`${GROUP_INFO_REFRESH_REQUEST_PREFIX}${row.cid}:${row.request_id}`);read.onsuccess=()=>{matches=matches&&sameSyncCheckpointValue(read.result,row);};}}
        for(const [i,change]of submitted.entries()){
          const primary=meta.get(groupInfoWorkKey(deviceId,change.cid,change.request_id));primary.onsuccess=()=>{matches=matches&&sameSyncCheckpointValue(primary.result??null,wanted[i]);};
          const retained=parked[i];
          if(retained){for(const [key,value]of [[recoveryWorkParkedKey(deviceId,groupInfoWorkKey(deviceId,change.cid,change.request_id)),retained],[retained.disposition_key,retained.record],[retained.record.source_key,null]]as const){const read=meta.get(key);read.onsuccess=()=>{matches=matches&&sameSyncCheckpointValue(read.result??null,value);};}}
          const next=wanted[i];if(next&&!retained){const due=meta.get(groupInfoWorkDueKey(next));due.onsuccess=()=>{matches=matches&&sameSyncCheckpointValue(due.result??null,next.disposition==='pending'?next:null);};}
          if(applied[i]&&change.expected && (!next || groupInfoWorkDueKey(change.expected)!==groupInfoWorkDueKey(next))){const old=meta.get(groupInfoWorkDueKey(change.expected));old.onsuccess=()=>{matches=matches&&old.result===undefined;};}
        }
      });
    });
    return applied;
  }

  async loadRecoveryDiscoveryWork(deviceId: string, cids: string[]): Promise<Record<string, RecoveryDiscoveryWork | null>> {
    if (cids.length > 200) throw new Error('Discovery page exceeds bound');
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readonly'), rows: Record<string, RecoveryDiscoveryWork | null> = {};
      for (const cid of cids) { const read = tx.objectStore(STORE_META).get(discoveryWorkKey(deviceId,cid));read.onsuccess=()=>{rows[cid]=read.result??null;}; }
      tx.oncomplete=()=>resolve(rows);tx.onabort=()=>reject(tx.error||new Error('Discovery primary read aborted'));tx.onerror=()=>{};
    });
  }

  async listDueRecoveryDiscoveryWork(deviceId: string, now: number, limit: number): Promise<RecoveryDiscoveryWork[]> {
    if (!Number.isSafeInteger(now) || now <= 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('Discovery due page invalid');
    const db = await this.openDB(),prefix=`mls_discovery_due:v1:${encodeURIComponent(deviceId)}:`;
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE_META,'readonly'),meta=tx.objectStore(STORE_META);let rows:RecoveryDiscoveryWork[]=[];let failure:unknown;
      const read=meta.getAll(IDBKeyRange.bound(prefix,`${prefix}${String(now).padStart(16,'0')}:\uffff`),limit);
      read.onsuccess=()=>{rows=read.result;for(const row of rows){try{validateDiscoveryWork(row);if(row.device_id!==deviceId || row.disposition!=='pending')throw recoveryControlError('storage_corruption');}
        catch(error){failure=error;tx.abort();return;}
        const primary=meta.get(discoveryWorkKey(deviceId,row.cid));primary.onsuccess=()=>{if(!sameSyncCheckpointValue(primary.result,row)){failure=Object.assign(new Error('Discovery due primary mismatch'),{code:'storage_corruption'});tx.abort();}};
      }};
      tx.oncomplete=()=>resolve(rows);tx.onabort=()=>reject(failure||tx.error||new Error('Discovery due read aborted'));tx.onerror=()=>{};
    });
  }

  /** Exact intent CAS plus provider/marker owner proof; never writes private provider state. */
  async saveRecoveryDiscoveryWork(userId: string, deviceId: string, changes: RecoveryDiscoveryChange[], owner: RecoveryDiscoveryOwner,
    assertOwner: () => void): Promise<boolean[]> {
    const submitted=structuredClone(changes),captured=structuredClone(owner);
    if(this.accountId!==userId || submitted.length>200 || new Set(submitted.map(c=>c.cid)).size!==submitted.length)throw new Error('Discovery CAS scope invalid');
    for(const change of submitted){validateDiscoveryWork(change.next);if(change.expected)validateDiscoveryWork(change.expected);
      if(change.next.user_id!==userId || change.next.device_id!==deviceId || change.next.cid!==change.cid || !(change.cid in captured.markers))throw new Error('Discovery CAS binding invalid');}
    const db=await this.openDB(),applied=submitted.map(()=>false),wanted:Array<RecoveryDiscoveryWork|null>=[];
    const readOwner=(tx:IDBTransaction,done:()=>void)=>{
      let count=submitted.length+1,failure:unknown;const finish=()=>{if(--count===0){try{assertOwner();if(failure)throw failure;done();}catch(error){(tx as IDBTransaction&{discoveryFailure?:unknown}).discoveryFailure=error;tx.abort();}}};
      const rev=tx.objectStore(STORE_META).get(`provider_revision:${userId}:${deviceId}`);rev.onsuccess=()=>{if((rev.result??null)!==captured.provider_revision)failure=Object.assign(new Error('Discovery provider owner conflict'),{code:'recovery_checkpoint_conflict',recovery_owner_conflict:'provider'});finish();};
      for(const change of submitted){const marker=tx.objectStore(STORE_GROUPS).get(change.cid);marker.onsuccess=()=>{if(!sameSyncCheckpointValue(marker.result??null,captured.markers[change.cid]))failure ||=Object.assign(new Error('Discovery marker owner conflict'),{code:'recovery_checkpoint_conflict',recovery_owner_conflict:'scope'});finish();};}
    };
    await new Promise<void>((resolve,reject)=>{
      const tx=db.transaction([STORE_META,STORE_GROUPS],'readwrite'),meta=tx.objectStore(STORE_META);let failure:unknown;
      tx.oncomplete=()=>resolve();tx.onerror=()=>{failure ||=tx.error;};tx.onabort=()=>{const cause=(tx as IDBTransaction&{discoveryFailure?:unknown}).discoveryFailure||failure||tx.error;reject(Object.assign(new Error('Discovery CAS aborted'),{cause,code:(cause as {code?:string})?.code,recovery_owner_conflict:(cause as {recovery_owner_conflict?:string})?.recovery_owner_conflict,checkpoint_outcome:'aborted'}));};
      readOwner(tx,()=>{
        for(const [i,change]of submitted.entries()){
          const read=meta.get(discoveryWorkKey(deviceId,change.cid));read.onsuccess=()=>{
            try{assertOwner();const prior=read.result??null;wanted[i]=prior;
              if(!sameSyncCheckpointValue(prior,change.expected))return;
              const index=prior?.disposition==='pending'?meta.get(discoveryDueKey(prior)):null;
              const write=()=>{assertOwner();if(prior?.disposition==='pending')meta.delete(discoveryDueKey(prior));
                meta.put(change.next,discoveryWorkKey(deviceId,change.cid));if(change.next.disposition==='pending')meta.put(change.next,discoveryDueKey(change.next));applied[i]=true;wanted[i]=change.next;};
              if(index)index.onsuccess=()=>{try{if(!sameSyncCheckpointValue(index.result,prior))throw Object.assign(new Error('Discovery index CAS mismatch'),{code:'storage_corruption'});write();}catch(error){failure=error;tx.abort();}};else write();
            }catch(error){failure=error;tx.abort();}
          };
        }
      });
    });
    await new Promise<void>((resolve,reject)=>{
      const tx=db.transaction([STORE_META,STORE_GROUPS],'readonly'),meta=tx.objectStore(STORE_META);let matches=true;
      tx.oncomplete=()=>{try{assertOwner();if(!matches)throw Object.assign(new Error('Discovery committed proof mismatch'),{code:'recovery_checkpoint_uncertain'});resolve();}catch(error){reject(error);}};
      tx.onabort=()=>reject((tx as IDBTransaction&{discoveryFailure?:unknown}).discoveryFailure||Object.assign(new Error('Discovery committed readback aborted'),{code:'recovery_checkpoint_uncertain'}));tx.onerror=()=>{};
      readOwner(tx,()=>{
        for(const [i,change]of submitted.entries()){
          const primary=meta.get(discoveryWorkKey(deviceId,change.cid));primary.onsuccess=()=>{matches=matches&&sameSyncCheckpointValue(primary.result??null,wanted[i]);};
          const next=wanted[i];if(next){const due=meta.get(discoveryDueKey(next));due.onsuccess=()=>{matches=matches&&sameSyncCheckpointValue(due.result??null,next.disposition==='pending'?next:null);};}
          if(applied[i]&&change.expected && (!next || discoveryDueKey(change.expected)!==discoveryDueKey(next))){const old=meta.get(discoveryDueKey(change.expected));old.onsuccess=()=>{matches=matches&&old.result===undefined;};}
        }
      });
    });
    return applied;
  }

  readonly groupInfoRefreshSnapshotVersion = 1 as const;

  async loadGroupInfoRefreshSnapshot(cids: string[]): Promise<Record<string, StoredGroupInfoRefreshRequest[]>> {
    const requested = [...new Set(cids)];
    if (requested.length > 200 || requested.some(cid => !cid || typeof cid !== 'string')) throw new Error('GI snapshot scope invalid');
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readonly'), result: Record<string, StoredGroupInfoRefreshRequest[]> = {};
      let failure: unknown;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => { failure ||= tx.error; };
      tx.onabort = () => reject(failure || Object.assign(new Error('GI snapshot read aborted'), {code: 'storage_read_failed'}));
      for (const cid of requested) {
        const prefix = `${GROUP_INFO_REFRESH_REQUEST_PREFIX}${cid}:`, rows: StoredGroupInfoRefreshRequest[] = [];
        result[cid] = rows;
        const read = tx.objectStore(STORE_META).openCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
        read.onsuccess = () => {
          const cursor = read.result;
          if (!cursor) return;
          if (rows.length === 100) {
            failure = Object.assign(new Error('GI snapshot exceeds bounded request page'), {code: 'group_info_refresh_backlog'});
            tx.abort(); return;
          }
          rows.push(cursor.value); cursor.continue();
        };
      }
    });
  }

  private _groupInfoOwnerConflict(actual:MlsReadyBase,owned:MlsReadyBase,cid:string):'provider'|'scope'|undefined {
    if(actual.revision!==owned.revision || !sameSyncCheckpointValue(actual.provider_bytes,owned.provider_bytes) || !sameSyncCheckpointValue(actual.identity_bytes,owned.identity_bytes))return 'provider';
    if(!sameSyncCheckpointValue(actual.cleanup.marker,owned.cleanup.marker) || !sameSyncCheckpointValue(actual.control,owned.control) ||
      [`${MLS_MUTATION_PREFIX}${cid}`,`${EXTERNAL_CANDIDATE_PREFIX}${cid}`,`mls_removal:v1:${cid}`].some(key=>!sameSyncCheckpointValue(actual.cleanup.metadata[key],owned.cleanup.metadata[key])))return 'scope';
    return undefined;
  }

  async saveGroupInfoRefreshCheckpoint(userId: string, deviceId: string, cid: string, expected: MlsReadyBase,
    next: StoredGroupInfoRefreshRequest[], assertOwner: () => void, workScope?:GroupInfoWorkScope): Promise<void> {
    const base = structuredClone(expected), records = structuredClone(next), prefix = `${GROUP_INFO_REFRESH_REQUEST_PREFIX}${cid}:`;
    if (this.accountId !== userId || records.length > 100 || records.some(r => r.cid !== cid ||
        !r.request_id || !Number.isSafeInteger(r.minimum_epoch) || r.minimum_epoch < 0 || !Number.isFinite(Date.parse(r.expires_at)))) throw new Error('GI conditional checkpoint invalid');
    const scope=workScope?{user_id:workScope.user_id,device_id:workScope.device_id,signing_identity_sha256:workScope.signing_identity_sha256,artifact_sha256:workScope.artifact_sha256}:null;
    if(scope && (scope.user_id!==userId||scope.device_id!==deviceId))throw new Error('GI journal scope invalid');
    const admitted:Array<GroupInfoWork>=[],retained:Array<{key:string;primary:unknown;parked:{record:RecoveryWorkDisposition;disposition_key:string}}>=[];
    const db = await this.openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_META, STORE_IDENTITY, STORE_GROUPS, STORE_PENDING_SENDS], 'readwrite');
      let failure: unknown;
      tx.oncomplete = () => resolve(); tx.onerror = () => { failure ||= tx.error; };
      tx.onabort = () => reject(Object.assign(new Error('GI owner checkpoint aborted'),
        {cause: failure || tx.error, code: (failure as {code?: string})?.code, gi_owner_conflict:(failure as {gi_owner_conflict?:string})?.gi_owner_conflict, checkpoint_outcome: 'aborted'}));
      this._readMlsReadyBase(tx, userId, deviceId, cid, current => {
        try {
          assertOwner();
          if (!sameSyncCheckpointValue(current, base)) throw Object.assign(new Error('GI exact owner/read-set conflict'), {code: 'recovery_checkpoint_conflict',gi_owner_conflict:this._groupInfoOwnerConflict(current,base,cid)});
          const meta = tx.objectStore(STORE_META);
          for (const key of Object.keys(base.cleanup.metadata)) if (key.startsWith(prefix)) meta.delete(key);
          for (const row of records) meta.put(row, `${prefix}${row.request_id}`);
          if(scope)for(const row of records){
            const key=groupInfoWorkKey(deviceId,cid,row.request_id),read=meta.get(key);
            read.onsuccess=()=>{try{
              const park=meta.get(recoveryWorkParkedKey(deviceId,key));
              park.onsuccess=()=>{try{
              const held=park.result;
              if(held?.record?.primary_key===key && held.record.lane==='gi' && sameSyncCheckpointValue(held.record.primary,read.result??null)){
                const evidence=meta.get(held.disposition_key);evidence.onsuccess=()=>{try{
                  assertOwner();if(!sameSyncCheckpointValue(evidence.result,held.record))throw recoveryControlError('storage_corruption');
                  retained.push({key,primary:read.result??null,parked:held});
                }catch(error){failure=error;tx.abort();}};return;
              }
              assertOwner();let job:GroupInfoWork=read.result || newGroupInfoWork(scope,row,{provider_revision:base.revision,markers:{[cid]:base.cleanup.marker as MlsGroupGenerationMarker|null},controls:{[cid]:base.control}},Date.now());
              validateGroupInfoWork(job);
              if(job.disposition==='deferred' && job.reason==='manual' && base.control && BigInt(base.control.recovery_revision)>BigInt(job.control_revision||'0') &&
                base.control && base.control.recovery_action!=='manual_intervention_required' && base.control.group_generation===job.generation){
                job={...job,control_revision:base.control.recovery_revision,disposition:'pending',retry_at:Date.now(),reason:'requested'};
              }
              if(job.disposition==='deferred' && job.reason==='binding' && base.control && base.control.recovery_action!=='manual_intervention_required' &&
                base.cleanup.marker && job.generation===(job.request.group_generation??0) &&
                recoveryControlGroupMatches(base.control,base.cleanup.marker as MlsGroupGenerationMarker) && base.control.group_generation===job.generation &&
                sameSyncCheckpointValue(job.group_id,(base.cleanup.marker as MlsGroupGenerationMarker).group_id) &&
                BigInt(base.control.recovery_revision)>=BigInt(job.control_revision||'0')){
                job={...job,control_revision:base.control.recovery_revision,disposition:'pending',retry_at:Math.max(job.retry_at,Date.now()),reason:'requested'};
              }
              const persist=()=>{assertOwner();admitted.push(job);meta.put(job,key);if(job.disposition==='pending')meta.put(job,groupInfoWorkDueKey(job));};
              const prior=read.result as GroupInfoWork|undefined;
              if(prior){const index=meta.get(groupInfoWorkDueKey(prior));index.onsuccess=()=>{try{
                assertOwner();if(!sameSyncCheckpointValue(index.result??null,prior.disposition==='pending'?prior:null))throw recoveryControlError('storage_corruption');
                if(groupInfoWorkDueKey(prior)!==groupInfoWorkDueKey(job))meta.delete(groupInfoWorkDueKey(prior));persist();
              }catch(error){failure=error;tx.abort();}};}else persist();
              }catch(error){failure=error;tx.abort();}};
            }catch(error){failure=error;tx.abort();}};
          }
        } catch (error) { failure = error; tx.abort(); }
      });
    });
    const wanted = structuredClone(base);
    for (const key of Object.keys(wanted.cleanup.metadata)) if (key.startsWith(prefix)) delete wanted.cleanup.metadata[key];
    for (const row of records) wanted.cleanup.metadata[`${prefix}${row.request_id}`] = row;
    await new Promise<void>((resolve,reject)=>{
      const tx=db.transaction([STORE_META,STORE_IDENTITY,STORE_GROUPS,STORE_PENDING_SENDS],'readonly'),meta=tx.objectStore(STORE_META);let matches=true,ownerConflict:string|undefined;
      this._readMlsReadyBase(tx,userId,deviceId,cid,proof=>{
        matches=matches&&sameSyncCheckpointValue(proof,wanted);
        ownerConflict=this._groupInfoOwnerConflict(proof,wanted,cid);
      });
      for(const job of admitted){const read=meta.get(groupInfoWorkKey(deviceId,cid,job.request.request_id));read.onsuccess=()=>{matches=matches&&sameSyncCheckpointValue(read.result,job);};
        const due=meta.get(groupInfoWorkDueKey(job));due.onsuccess=()=>{matches=matches&&sameSyncCheckpointValue(due.result??null,job.disposition==='pending'?job:null);};}
      for(const held of retained)for(const [key,value]of [[held.key,held.primary],[recoveryWorkParkedKey(deviceId,held.key),held.parked],
        [held.parked.disposition_key,held.parked.record],[held.parked.record.source_key,null]]as const){const read=meta.get(key);read.onsuccess=()=>{matches=matches&&sameSyncCheckpointValue(read.result??null,value);};}
      tx.oncomplete=()=>{try{assertOwner();if(!matches)throw Object.assign(recoveryControlError('recovery_checkpoint_uncertain'),{gi_owner_conflict:ownerConflict});resolve();}catch(error){reject(error);}};
      tx.onabort=()=>reject(Object.assign(new Error('GI committed readback aborted'),{code:'recovery_checkpoint_uncertain',checkpoint_outcome:'uncertain'}));tx.onerror=()=>{};
    });
  }

  readonly readyCheckpointVersion = 2 as const;
  readonly readyObservationVersion = 1 as const;

  private _readMlsReadyBase(tx: IDBTransaction, userId: string, deviceId: string, cid: string,
    done: (base: MlsReadyBase) => void): void {
    const meta = tx.objectStore(STORE_META);
    const base: MlsReadyBase = {provider_bytes: null, revision: null, identity_bytes: null,
      cleanup: {marker: null, metadata: {}, pending_sends: []}, control: null, ack: null, admission: null, admission_pending: null, admission_paused: null, ready: null};
    let remaining = 10;
    const finish = () => { if (--remaining === 0) done(base); };
    for (const [field, store, key] of [
      ['provider_bytes', meta, `provider:${userId}:${deviceId}`],
      ['revision', meta, `provider_revision:${userId}:${deviceId}`],
      ['identity_bytes', tx.objectStore(STORE_IDENTITY), `${userId}:${deviceId}`],
      ['control', meta, recoveryControlKey(cid, deviceId)],
      ['ack', meta, validationAckKey(cid, deviceId)],
      ['admission', meta, `gi_validation_admission:v1:${encodeURIComponent(deviceId)}:${encodeURIComponent(cid)}`],
      ['admission_paused', meta, `gi_validation_admission_paused:v1:${encodeURIComponent(deviceId)}:${encodeURIComponent(cid)}`],
      ['ready', meta, `mls_ready:v1:${encodeURIComponent(deviceId)}:${encodeURIComponent(cid)}`],
    ] as const) {
      const request = store.get(key);
      request.onsuccess = () => {
        (base as unknown as Record<string, unknown>)[field] = request.result ?? null;
        if (field === 'admission') {
          const admission = request.result as GroupInfoValidationAdmission | null;
          if (admission && typeof admission.cid === 'string' && typeof admission.device_id === 'string') {
            const index = meta.get(validationAdmissionPendingKey(admission));
            index.onsuccess = () => { base.admission_pending = index.result || null; finish(); };
          } else finish();
        }
        finish();
      };
    }
    // Application jobs have their own exact per-UUID checkpoint/CAS at send.
    // They do not establish MLS Ready. Including them here would reject opaque
    // File clones and permanently block Ready after 100 retained sent outcomes.
    // MLS candidate/mutation/control/receipt guards remain in this read set;
    // destructive cleanup still reads the complete pending rows, including files.
    this._readMlsCleanupState(tx, cid, value => { base.cleanup = value; finish(); }, false);
  }

  async loadMlsReadyBase(userId: string, deviceId: string, cid: string): Promise<MlsReadyBase> {
    if (this.accountId !== userId) throw new Error('Ready account mismatch');
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_META, STORE_IDENTITY, STORE_GROUPS, STORE_PENDING_SENDS], 'readonly');
      let base: MlsReadyBase;
      this._readMlsReadyBase(tx, userId, deviceId, cid, value => { base = value; });
      tx.oncomplete = () => resolve(base);
      tx.onerror = () => reject(tx.error || new Error('Ready read failed'));
      tx.onabort = () => reject(tx.error || new Error('Ready backlog exceeds bound or read aborted'));
    });
  }

  async saveMlsReadyCheckpoint(checkpoint: MlsReadyCheckpoint, assertOwner: () => void): Promise<void> {
    const cp = structuredClone(checkpoint), marker = cp.expected.cleanup.marker as MlsGroupGenerationMarker | null;
    if (cp.provider_observation && (this.readyObservationVersion !== 1 ||
        typeof cp.expected.revision !== 'string' || !cp.expected.revision.length ||
        cp.provider_write_guard.next_revision !== cp.expected.revision)) throw new Error('Ready observation revision invalid');
    if (cp.user_id !== this.accountId || !cp.provider_write_guard || !cp.expected.provider_bytes || !marker ||
        marker.status !== 'active' || cp.snapshot.state !== 'ready' || cp.snapshot.cid !== cp.cid ||
        cp.snapshot.group_generation !== marker.group_generation || cp.snapshot.epoch !== marker.current_epoch ||
        cp.snapshot.provider_revision !== cp.provider_write_guard.next_revision ||
        cp.expected.revision !== cp.provider_write_guard.expected_revision) throw new Error('Ready checkpoint binding invalid');
    const joined = (cp.expected.cleanup.metadata[`external_join_readiness:${cp.cid}`] as {status?: string} | null)?.status === 'joined_external';
    if (joined && (!cp.external_join_base || !sameSyncCheckpointValue(cp.external_join_base.state, cp.expected))) throw recoveryControlError('client_upgrade_required');
    if (cp.external_join_base) validateExternalJoinReadyBase(cp.external_join_base, cp.user_id, cp.device_id, cp.cid,
      cp.expected.control?.signing_identity_sha256 || Object.values(cp.external_join_base.welcome_primary)[0]?.signing_identity_sha256 || '');
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_META, STORE_IDENTITY, STORE_GROUPS, STORE_PENDING_SENDS, STORE_WELCOME_HISTORY], 'readwrite');
      let failure: unknown;
      tx.oncomplete = () => resolve();
      tx.onerror = () => { failure ||= tx.error; };
      tx.onabort = () => reject(Object.assign(new Error('Ready checkpoint aborted'),
        {cause: failure || tx.error, code: (failure as {code?: string})?.code, checkpoint_outcome: 'aborted'}));
      const apply = (base: MlsReadyBase) => {
        try {
          assertOwner();
          if (!sameSyncCheckpointValue(base, cp.expected)) {
            const samePrivateBase = base.revision === cp.expected.revision &&
              sameSyncCheckpointValue(base.provider_bytes, cp.expected.provider_bytes) &&
              sameSyncCheckpointValue(base.identity_bytes, cp.expected.identity_bytes);
            throw Object.assign(new Error('Ready owner/read set conflict'),
              {code: samePrivateBase ? 'local_checkpoint_pending' : 'provider_checkpoint_conflict'});
          }
          const writeMetadata = () => { assertOwner(); if (cp.admission) { validateValidationAdmission(cp.admission);
              if(cp.expected.admission)tx.objectStore(STORE_META).delete(validationAdmissionPendingKey(cp.expected.admission));
              if(cp.admission.outcome==='pending'){tx.objectStore(STORE_META).put(cp.admission,validationAdmissionPendingKey(cp.admission));tx.objectStore(STORE_META).delete(`gi_validation_admission_paused:v1:${encodeURIComponent(cp.device_id)}:${encodeURIComponent(cp.cid)}`);}
              tx.objectStore(STORE_META).put(cp.admission, `gi_validation_admission:v1:${encodeURIComponent(cp.device_id)}:${encodeURIComponent(cp.cid)}`); }
              tx.objectStore(STORE_META).put(cp.snapshot,
              `mls_ready:v1:${encodeURIComponent(cp.device_id)}:${encodeURIComponent(cp.cid)}`); };
          // The full private/scoped readset above is compared in this SAME write
          // transaction. Observation cannot replace provider/identity authority.
          if (cp.provider_observation) writeMetadata();
          else this._writeProviderCheckpoint(tx, cp.user_id, cp.device_id, cp.expected.provider_bytes!,
            cp.provider_write_guard, writeMetadata, error => { failure = error; });
        } catch (error) { failure = error; tx.abort(); }
      };
      if (cp.external_join_base) this._readExternalJoinWorkBase(tx, cp.user_id, cp.device_id, cp.cid,
        cp.external_join_base.accepted?.operation_id || '', actual => {
          if (!sameSyncCheckpointValue(actual, cp.external_join_base)) { failure = recoveryControlError('recovery_checkpoint_conflict'); tx.abort(); return; }
          apply(actual.state);
        }, error => { failure = error; tx.abort(); });
      else this._readMlsReadyBase(tx, cp.user_id, cp.device_id, cp.cid, apply);
    });
  }

  async verifyMlsReadyCheckpoint(checkpoint: MlsReadyCheckpoint): Promise<boolean> {
    const cp=structuredClone(checkpoint),db=await this.openDB();
    if ((cp.expected.cleanup.metadata[`external_join_readiness:${cp.cid}`] as {status?: string} | null)?.status === 'joined_external' && !cp.external_join_base) return false;
    const wanted={...cp.expected,revision:cp.provider_write_guard.next_revision,ready:cp.snapshot,admission:cp.admission||cp.expected.admission,
      admission_pending:cp.admission?(cp.admission.outcome==='pending'?cp.admission:null):cp.expected.admission_pending,
      admission_paused:cp.admission?.outcome==='pending'?null:cp.expected.admission_paused};
    return new Promise((resolve,reject)=>{
      const tx=db.transaction([STORE_META,STORE_IDENTITY,STORE_GROUPS,STORE_PENDING_SENDS,STORE_WELCOME_HISTORY],'readonly');let matches=false,oldMatches=true;
      if (cp.external_join_base) this._readExternalJoinWorkBase(tx, cp.user_id, cp.device_id, cp.cid,
        cp.external_join_base.accepted?.operation_id || '', actual => {
          matches = sameSyncCheckpointValue(actual, {...cp.external_join_base!, state: wanted});
        }, () => { tx.abort(); });
      else this._readMlsReadyBase(tx,cp.user_id,cp.device_id,cp.cid,actual=>{matches=sameSyncCheckpointValue(actual,wanted);});
      if(cp.admission && cp.expected.admission){const oldKey=validationAdmissionPendingKey(cp.expected.admission),q=tx.objectStore(STORE_META).get(oldKey);
        q.onsuccess=()=>{oldMatches=sameSyncCheckpointValue(q.result??null,wanted.admission_pending&&validationAdmissionPendingKey(wanted.admission_pending)===oldKey?wanted.admission_pending:null);};}
      tx.oncomplete=()=>resolve(matches&&oldMatches);tx.onabort=()=>reject(recoveryControlError('validation_ack_checkpoint_uncertain'));tx.onerror=()=>{};
    });
  }

  readonly mlsCleanupCheckpointVersion = 1 as const;

  /** Point reads plus bounded CID index/prefix reads, in the caller's transaction. */
  private _readMlsCleanupState(tx: IDBTransaction, cid: string, done: (state: MlsCleanupState) => void,
    includePendingSends = true): void {
    const meta = tx.objectStore(STORE_META), state: MlsCleanupState = {marker: null, metadata: {}, pending_sends: []};
    const keys = [`${MLS_MUTATION_PREFIX}${cid}`, `${EXTERNAL_CANDIDATE_PREFIX}${cid}`,
      `${MLS_REBOOTSTRAP_CANDIDATE_PREFIX}${cid}`, `pending_e2ee_snapshots:${cid}`,
      `${SCOPE_SYNC_PREFIX}${cid}`, `${LEGACY_SYNC_PREFIX}${cid}`, `${CHANNEL_REPAIR_PREFIX}${cid}`,
      `${CHANNEL_REPAIR_LOCK_PREFIX}${cid}`, `${EXTERNAL_JOIN_READINESS_PREFIX}${cid}`, `mls_removal:v1:${cid}`];
    let remaining = keys.length + 3 + (includePendingSends ? 1 : 0);
    const finish = () => { if (--remaining === 0) done(state); };
    for (const key of keys) {
      const read = meta.get(key);
      read.onsuccess = () => { state.metadata[key] = read.result ?? null; finish(); };
    }
    const marker = tx.objectStore(STORE_GROUPS).get(cid);
    marker.onsuccess = () => { state.marker = marker.result ?? null; finish(); };
    const evictions = meta.get('pending_evictions');
    evictions.onsuccess = () => { state.metadata[`pending_evictions:${cid}`] = evictions.result?.[cid] ?? null; finish(); };
    const prefix = `${GROUP_INFO_REFRESH_REQUEST_PREFIX}${cid}:`;
    const requests = meta.openCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`)); let rows = 0;
    requests.onsuccess = () => {
      const cursor = requests.result;
      if (!cursor) { finish(); return; }
      if (++rows > 100) { tx.abort(); return; }
      state.metadata[String(cursor.key)] = cursor.value; cursor.continue();
    };
    if (includePendingSends) {
      const sends = tx.objectStore(STORE_PENDING_SENDS).index('cid').getAll(cid, 101);
      sends.onsuccess = () => { if (sends.result.length > 100) { tx.abort(); return; }
        // Canonically accepted sends remain durable for idempotent reuse. Only
        // unresolved outcomes fence removal; retain every audit row in storage.
        state.pending_sends = sends.result.filter(record => record.status !== 'sent'); finish(); };
    }
  }

  async loadMlsCleanupState(cid: string): Promise<MlsCleanupState> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_META, STORE_GROUPS, STORE_PENDING_SENDS], 'readonly'); let state: MlsCleanupState;
      this._readMlsCleanupState(tx, cid, value => { state = value; });
      tx.oncomplete = () => resolve(state);
      tx.onerror = () => reject(tx.error || new Error('Cleanup metadata read failed'));
      tx.onabort = () => reject(tx.error || new Error('Cleanup metadata unavailable or exceeds bound'));
    });
  }

  async saveMlsCleanupCheckpoint(checkpoint: MlsCleanupCheckpoint, assertOwner: () => void): Promise<void> {
    const cp = structuredClone(checkpoint);
    if (cp.user_id !== this.accountId || cp.marker.cid !== cp.cid || cp.marker.status !== 'historical' ||
        cp.marker.group_generation !== cp.removal.group_generation ||
        !sameSyncCheckpointValue(cp.marker.group_id, cp.removal.group_id)) throw new Error('Cleanup checkpoint scope invalid');
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_META, STORE_GROUPS, STORE_PENDING_SENDS], 'readwrite'); let failure: unknown;
      tx.oncomplete = () => resolve(); tx.onerror = () => { failure ||= tx.error; };
      tx.onabort = () => reject(Object.assign(new Error(failure instanceof Error ? failure.message : 'Cleanup checkpoint aborted'),
        {cause: failure || tx.error, code: (failure as {code?: string})?.code, checkpoint_outcome: 'aborted'}));
      this._readMlsCleanupState(tx, cp.cid, state => {
        try {
        assertOwner();
        if (!sameSyncCheckpointValue(state, cp.expected)) {
          failure = Object.assign(new Error('Cleanup owner conflict'), {code: 'provider_checkpoint_conflict'}); tx.abort(); return;
        }
        if (state.pending_sends.length || state.metadata[`${MLS_MUTATION_PREFIX}${cp.cid}`] ||
            state.metadata[`${EXTERNAL_CANDIDATE_PREFIX}${cp.cid}`] || state.metadata[`${MLS_REBOOTSTRAP_CANDIDATE_PREFIX}${cp.cid}`]) {
          failure = Object.assign(new Error('Cleanup pending obligations'), {code: 'mls_cleanup_pending_obligations'}); tx.abort(); return;
        }
        this._writeProviderCheckpoint(tx, cp.user_id, cp.device_id, cp.provider_bytes, cp.provider_write_guard, () => {
          tx.objectStore(STORE_GROUPS).put(cp.marker, cp.cid);
          const meta = tx.objectStore(STORE_META);
          meta.delete(`${EXTERNAL_JOIN_READINESS_PREFIX}${cp.cid}`);
          meta.put(cp.removal, `mls_removal:v1:${cp.cid}`);
        }, error => { failure = error; });
        } catch (error) { failure = error; tx.abort(); }
      });
    });
  }

  async verifyMlsCleanupCheckpoint(checkpoint: MlsCleanupCheckpoint): Promise<boolean> {
    const cp = structuredClone(checkpoint), db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_META, STORE_GROUPS, STORE_PENDING_SENDS], 'readonly'), meta = tx.objectStore(STORE_META);
      const bytes = meta.get(`provider:${cp.user_id}:${cp.device_id}`), revision = meta.get(`provider_revision:${cp.user_id}:${cp.device_id}`);
      const expected = structuredClone(cp.expected); expected.marker = cp.marker;
      expected.metadata[`${EXTERNAL_JOIN_READINESS_PREFIX}${cp.cid}`] = null;
      expected.metadata[`mls_removal:v1:${cp.cid}`] = cp.removal;
      let matches = false;
      this._readMlsCleanupState(tx, cp.cid, state => { matches = sameSyncCheckpointValue(state, expected); });
      tx.oncomplete = () => resolve(matches && sameSyncCheckpointValue(bytes.result, cp.provider_bytes) &&
        revision.result === cp.provider_write_guard.next_revision);
      tx.onerror = () => reject(tx.error || new Error('Cleanup readback failed'));
      tx.onabort = () => reject(tx.error || new Error('Cleanup readback aborted'));
    });
  }

  async saveMlsMutationCheckpoint(checkpoint: MlsMutationCheckpoint): Promise<void> {
    checkpoint = structuredClone(checkpoint);
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_META, STORE_GROUPS], 'readwrite');
      const meta = tx.objectStore(STORE_META);
      let failure: unknown;
      tx.oncomplete = () => resolve();
      // Report a known abort only after the transaction has actually aborted.
      // An arbitrary adapter rejection cannot prove that its write did not commit.
      tx.onerror = () => { failure ||= tx.error; };
      tx.onabort = () => {
        const cause = failure || tx.error;
        reject(Object.assign(new Error(cause instanceof Error ? cause.message : 'MLS mutation checkpoint transaction aborted'),
          {cause, code: (cause as {code?: string})?.code, checkpoint_outcome: 'aborted'}));
      };
      try {
        const write = () => this._writeProviderCheckpoint(tx, checkpoint.user_id, checkpoint.device_id, checkpoint.provider_bytes,
          checkpoint.provider_write_guard, () => {
        if (checkpoint.marker === null) tx.objectStore(STORE_GROUPS).delete(checkpoint.cid);
        else tx.objectStore(STORE_GROUPS).put(checkpoint.marker, checkpoint.cid);
        const key = `${MLS_MUTATION_PREFIX}${checkpoint.cid}`;
        if (checkpoint.pending) meta.put(checkpoint.pending, key);
        else meta.delete(key);
        if (checkpoint.readiness !== undefined) {
          const readinessKey = `${EXTERNAL_JOIN_READINESS_PREFIX}${checkpoint.cid}`;
          if (checkpoint.readiness) meta.put(checkpoint.readiness, readinessKey);
          else meta.delete(readinessKey);
        }
        }, error => { failure = error; });
        if (checkpoint.expected_mutation) {
          const priorMarker = tx.objectStore(STORE_GROUPS).get(checkpoint.cid);
          const priorPending = meta.get(`${MLS_MUTATION_PREFIX}${checkpoint.cid}`);
          priorPending.onsuccess = () => {
            if (!sameSyncCheckpointValue(priorMarker.result || null, checkpoint.expected_mutation!.marker) ||
                !sameSyncCheckpointValue(priorPending.result || null, checkpoint.expected_mutation!.pending)) {
              failure = Object.assign(new Error('MLS mutation owner conflict'), {code: 'provider_checkpoint_conflict'});
              tx.abort(); return;
            }
            write();
          };
        } else write();
      } catch (error) {
        failure = error;
        tx.abort();
      }
    });
  }

  async verifyMlsMutationCheckpoint(checkpoint: MlsMutationCheckpoint): Promise<boolean> {
    const submitted = structuredClone(checkpoint);
    if (!submitted.provider_write_guard) throw new Error('MLS mutation CAS proof required');
    const db = await this.openDB();
    return new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction([STORE_META, STORE_GROUPS], 'readonly'), meta = tx.objectStore(STORE_META);
      const bytes = meta.get(`provider:${submitted.user_id}:${submitted.device_id}`);
      const revision = meta.get(`provider_revision:${submitted.user_id}:${submitted.device_id}`);
      const marker = tx.objectStore(STORE_GROUPS).get(submitted.cid);
      const pending = meta.get(`${MLS_MUTATION_PREFIX}${submitted.cid}`);
      const readiness = submitted.readiness === undefined ? null : meta.get(`${EXTERNAL_JOIN_READINESS_PREFIX}${submitted.cid}`);
      tx.oncomplete = () => resolve(sameSyncCheckpointValue(bytes.result, submitted.provider_bytes) &&
        revision.result === submitted.provider_write_guard!.next_revision &&
        sameSyncCheckpointValue(marker.result || null, submitted.marker) &&
        sameSyncCheckpointValue(pending.result || null, submitted.pending) &&
        (!readiness || sameSyncCheckpointValue(readiness.result || null, submitted.readiness)));
      tx.onerror = () => reject(tx.error || new Error('MLS mutation readback failed'));
      tx.onabort = () => reject(tx.error || new Error('MLS mutation readback aborted'));
    });
  }

  async listPendingMlsMutations(): Promise<PendingMlsMutation[]> {
    const db = await this.openDB();
    return new Promise<PendingMlsMutation[]>((resolve, reject) => {
      const result: PendingMlsMutation[] = [];
      const tx = db.transaction(STORE_META, 'readonly');
      const request = tx.objectStore(STORE_META).openCursor(
        IDBKeyRange.bound(MLS_MUTATION_PREFIX, `${MLS_MUTATION_PREFIX}\uffff`),
      );
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) { result.push(cursor.value as PendingMlsMutation); cursor.continue(); }
      };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('MLS mutation checkpoint read aborted'));
    });
  }

  // ---- Sync Timestamps ----

  async saveSyncTimestamp(cid: string, timestamp: string): Promise<void> {
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readwrite');
      const store = tx.objectStore(STORE_META);
      store.put(timestamp, `${LEGACY_SYNC_PREFIX}${cid}`);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async loadSyncTimestamp(cid: string): Promise<string | null> {
    const db = await this.openDB();
    return new Promise<string | null>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readonly');
      const store = tx.objectStore(STORE_META);
      const request = store.get(`${LEGACY_SYNC_PREFIX}${cid}`);
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
          if (key.startsWith(LEGACY_SYNC_PREFIX) && key !== 'sync:removed_channels') {
            const cid = key.slice(LEGACY_SYNC_PREFIX.length);
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

  async loadScopeSyncCursor(scopeCid: string): Promise<EventCursor | null> {
    const db = await this.openDB();
    return new Promise<EventCursor | null>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readonly');
      const store = tx.objectStore(STORE_META);
      const scopeReq = store.get(`${SCOPE_SYNC_PREFIX}${scopeCid}`);
      scopeReq.onsuccess = () => {
        const scopeCursor = eventCursorFromStoredValue(scopeReq.result);
        if (scopeCursor) {
          resolve(scopeCursor);
          return;
        }

        const legacyReq = store.get(`${LEGACY_SYNC_PREFIX}${scopeCid}`);
        legacyReq.onsuccess = () => resolve(eventCursorFromStoredValue(legacyReq.result));
        legacyReq.onerror = () => reject(legacyReq.error);
      };
      scopeReq.onerror = () => reject(scopeReq.error);
    });
  }

  async saveScopeSyncCursor(scopeCid: string, cursor: EventCursor): Promise<void> {
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readwrite');
      const store = tx.objectStore(STORE_META);
      store.put(cursor, `${SCOPE_SYNC_PREFIX}${scopeCid}`);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async loadAllScopeSyncCursors(): Promise<Record<string, EventCursor>> {
    const db = await this.openDB();
    return new Promise<Record<string, EventCursor>>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readonly');
      const store = tx.objectStore(STORE_META);
      const legacyCursors: Record<string, EventCursor> = {};
      const scopeCursors: Record<string, EventCursor> = {};
      const cursorReq = store.openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          const key = cursor.key as string;
          if (key.startsWith(SCOPE_SYNC_PREFIX)) {
            const scopeCid = key.slice(SCOPE_SYNC_PREFIX.length);
            const value = eventCursorFromStoredValue(cursor.value);
            if (value) scopeCursors[scopeCid] = value;
          } else if (key.startsWith(LEGACY_SYNC_PREFIX) && key !== 'sync:removed_channels') {
            const scopeCid = key.slice(LEGACY_SYNC_PREFIX.length);
            const value = eventCursorFromStoredValue(cursor.value);
            if (value) legacyCursors[scopeCid] = value;
          }
          cursor.continue();
        } else {
          resolve({ ...legacyCursors, ...scopeCursors });
        }
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });
  }

  async saveAllScopeSyncCursors(cursors: Record<string, EventCursor>): Promise<void> {
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readwrite');
      const store = tx.objectStore(STORE_META);
      for (const [scopeCid, cursor] of Object.entries(cursors)) {
        store.put(cursor, `${SCOPE_SYNC_PREFIX}${scopeCid}`);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async loadChannelRepairState(scopeCid: string): Promise<ChannelRepairState | null> {
    const db = await this.openDB();
    return new Promise<ChannelRepairState | null>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readonly');
      const store = tx.objectStore(STORE_META);
      const request = store.get(`${CHANNEL_REPAIR_PREFIX}${scopeCid}`);
      request.onsuccess = () => resolve((request.result as ChannelRepairState) || null);
      request.onerror = () => reject(request.error);
    });
  }

  async saveChannelRepairState(state: ChannelRepairState): Promise<void> {
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readwrite');
      const store = tx.objectStore(STORE_META);
      store.put(state, `${CHANNEL_REPAIR_PREFIX}${state.scope_cid}`);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async deleteChannelRepairState(scopeCid: string): Promise<void> {
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readwrite');
      const store = tx.objectStore(STORE_META);
      store.delete(`${CHANNEL_REPAIR_PREFIX}${scopeCid}`);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async loadExternalJoinReadiness(cid: string): Promise<ExternalJoinReadinessState | null> {
    const db = await this.openDB();
    return new Promise<ExternalJoinReadinessState | null>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readonly');
      const request = tx.objectStore(STORE_META).get(`${EXTERNAL_JOIN_READINESS_PREFIX}${cid}`);
      request.onsuccess = () => resolve((request.result as ExternalJoinReadinessState) || null);
      request.onerror = () => reject(request.error);
    });
  }
  async saveExternalJoinReadiness(state: ExternalJoinReadinessState): Promise<void> {
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readwrite');
      tx.objectStore(STORE_META).put(state, `${EXTERNAL_JOIN_READINESS_PREFIX}${state.cid}`);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async deleteExternalJoinReadiness(cid: string): Promise<void> {
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readwrite');
      tx.objectStore(STORE_META).delete(`${EXTERNAL_JOIN_READINESS_PREFIX}${cid}`);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async listGroupInfoRefreshRequests(): Promise<StoredGroupInfoRefreshRequest[]> {
    const db = await this.openDB();
    return new Promise<StoredGroupInfoRefreshRequest[]>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readonly');
      const store = tx.objectStore(STORE_META);
      const values: StoredGroupInfoRefreshRequest[] = [];
      const request = store.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(values);
          return;
        }
        if (typeof cursor.key === 'string' && cursor.key.startsWith(GROUP_INFO_REFRESH_REQUEST_PREFIX)) {
          values.push(cursor.value as StoredGroupInfoRefreshRequest);
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
  }
  async saveGroupInfoRefreshRequest(request: StoredGroupInfoRefreshRequest): Promise<void> {
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readwrite');
      tx.objectStore(STORE_META).put(
        request,
        `${GROUP_INFO_REFRESH_REQUEST_PREFIX}${request.cid}:${request.request_id}`,
      );
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async deleteGroupInfoRefreshRequests(cid: string, throughEpoch?: number, requestId?: string): Promise<void> {
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readwrite');
      const store = tx.objectStore(STORE_META);
      const cursorRequest = store.openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        const value = cursor.value as StoredGroupInfoRefreshRequest;
        const isRefreshKey = typeof cursor.key === 'string' && cursor.key.startsWith(GROUP_INFO_REFRESH_REQUEST_PREFIX);
        const matchesCid = isRefreshKey && value.cid === cid;
        const matchesSelection =
          throughEpoch !== undefined
            ? value.minimum_epoch <= throughEpoch
            : requestId === undefined || value.request_id === requestId;
        if (matchesCid && matchesSelection) cursor.delete();
        cursor.continue();
      };
      cursorRequest.onerror = () => reject(cursorRequest.error);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async saveJoinCheckpoint(checkpoint: JoinPersistenceCheckpoint): Promise<void> {
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_META, STORE_GROUPS, STORE_WELCOME_HISTORY], 'readwrite');
      const meta = tx.objectStore(STORE_META);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('JOIN checkpoint transaction aborted'));
      try {
        this._writeProviderCheckpoint(tx, checkpoint.user_id, checkpoint.device_id, checkpoint.provider_bytes,
          checkpoint.provider_write_guard, () => {
        if (checkpoint.readiness) {
          meta.put(checkpoint.readiness, `${EXTERNAL_JOIN_READINESS_PREFIX}${checkpoint.cid}`);
        } else {
          meta.delete(`${EXTERNAL_JOIN_READINESS_PREFIX}${checkpoint.cid}`);
        }
        tx.objectStore(STORE_GROUPS).put(checkpoint.generation || true, checkpoint.cid);
        this._writeWelcomeDispositions(tx, meta, checkpoint, reject);
        }, reject);
      } catch (error) {
        // Synchronous clone/write failures otherwise allow earlier requests
        // to commit despite the rejected Promise.
        tx.abort();
        reject(error);
      }
    });
  }
  async saveRebootstrapClaimIntent(intent: MlsRebootstrapClaimIntent): Promise<void> {
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readwrite');
      tx.objectStore(STORE_META).put(intent, `${MLS_REBOOTSTRAP_CLAIM_INTENT_PREFIX}${intent.cid}`);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('rebootstrap claim intent transaction aborted'));
    });
  }
  async loadRebootstrapClaimIntent(cid: string): Promise<MlsRebootstrapClaimIntent | null> {
    const db = await this.openDB();
    return new Promise<MlsRebootstrapClaimIntent | null>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readonly');
      const request = tx.objectStore(STORE_META).get(`${MLS_REBOOTSTRAP_CLAIM_INTENT_PREFIX}${cid}`);
      request.onsuccess = () => resolve((request.result as MlsRebootstrapClaimIntent) || null);
      request.onerror = () => reject(request.error);
    });
  }
  async deleteRebootstrapClaimIntent(cid: string): Promise<void> {
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readwrite');
      tx.objectStore(STORE_META).delete(`${MLS_REBOOTSTRAP_CLAIM_INTENT_PREFIX}${cid}`);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async saveRebootstrapCandidateCheckpoint(checkpoint: MlsRebootstrapCandidateCheckpoint): Promise<void> {
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readwrite');
      const store = tx.objectStore(STORE_META);
      this._writeProviderCheckpoint(tx, checkpoint.user_id, checkpoint.device_id, checkpoint.provider_bytes,
        checkpoint.provider_write_guard, () => {
          store.put(checkpoint, `${MLS_REBOOTSTRAP_CANDIDATE_PREFIX}${checkpoint.marker.cid}`);
          store.delete(`${MLS_REBOOTSTRAP_CLAIM_INTENT_PREFIX}${checkpoint.marker.cid}`);
        }, reject);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('rebootstrap candidate checkpoint transaction aborted'));
    });
  }
  async loadRebootstrapCandidateCheckpoint(cid: string): Promise<MlsRebootstrapCandidateCheckpoint | null> {
    const db = await this.openDB();
    return new Promise<MlsRebootstrapCandidateCheckpoint | null>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readonly');
      const request = tx.objectStore(STORE_META).get(`${MLS_REBOOTSTRAP_CANDIDATE_PREFIX}${cid}`);
      request.onsuccess = () => resolve((request.result as MlsRebootstrapCandidateCheckpoint) || null);
      request.onerror = () => reject(request.error);
    });
  }
  async deleteRebootstrapCandidateCheckpoint(cid: string): Promise<void> {
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readwrite');
      tx.objectStore(STORE_META).delete(`${MLS_REBOOTSTRAP_CANDIDATE_PREFIX}${cid}`);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async saveEncryptionSyncCheckpoint(checkpoint: EncryptionSyncCheckpoint): Promise<void> {
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(checkpoint.pending_sends?.length || checkpoint.pending_send_guards ? [STORE_META, STORE_PENDING_SENDS] : STORE_META, 'readwrite');
      const store = tx.objectStore(STORE_META);

      this._writeProviderCheckpoint(tx, checkpoint.user_id, checkpoint.device_id, checkpoint.provider_bytes,
        checkpoint.provider_write_guard, () => {

      for (const [scopeCid, cursor] of Object.entries(checkpoint.scope_cursors || {})) {
        store.put(cursor, `${SCOPE_SYNC_PREFIX}${scopeCid}`);
      }

      for (const [cid, snapshots] of Object.entries(checkpoint.pending_snapshots || {})) {
        const key = `pending_e2ee_snapshots:${cid}`;
        if (snapshots.length === 0) {
          store.delete(key);
        } else {
          store.put(snapshots, key);
        }
      }

      for (const state of checkpoint.repair_states || []) {
        store.put(state, `${CHANNEL_REPAIR_PREFIX}${state.scope_cid}`);
      }

      for (const [id, expected] of Object.entries(checkpoint.pending_send_guards || {})) {
        const request = tx.objectStore(STORE_PENDING_SENDS).get(id);
        request.onsuccess = () => {
          if (!sameSyncCheckpointValue(request.result ?? null, expected)) {
            reject(recoveryControlError('pending_send_conflict'));
            tx.abort();
          }
        };
        request.onerror = () => {reject(request.error); tx.abort();};
      }
      for (const record of checkpoint.pending_sends || []) tx.objectStore(STORE_PENDING_SENDS).put(record);

      }, reject);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Sync checkpoint save aborted'));
      tx.onabort = () => reject(tx.error || new Error('Sync checkpoint save aborted'));
    });
  }

  async verifyEncryptionSyncCheckpoint(checkpoint: EncryptionSyncCheckpoint): Promise<boolean> {
    const db = await this.openDB();
    return new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction(checkpoint.pending_sends?.length ? [STORE_META, STORE_PENDING_SENDS] : STORE_META, 'readonly'), store = tx.objectStore(STORE_META);
      let matches = true;
      const compare = (key: string, expected: unknown, absentIsEmpty = false) => {
        const request = store.get(key);
        request.onsuccess = () => {
          try {
            const actual = absentIsEmpty && request.result === undefined ? [] : request.result;
            matches = sameSyncCheckpointValue(expected, actual) && matches;
          } catch (error) { reject(error); tx.abort(); }
        };
        request.onerror = () => reject(request.error);
      };
      compare(`provider:${checkpoint.user_id}:${checkpoint.device_id}`, checkpoint.provider_bytes);
      if (checkpoint.provider_write_guard) compare(`provider_revision:${checkpoint.user_id}:${checkpoint.device_id}`, checkpoint.provider_write_guard.next_revision);
      for (const [cid, cursor] of Object.entries(checkpoint.scope_cursors || {})) compare(`${SCOPE_SYNC_PREFIX}${cid}`, cursor);
      for (const [cid, snapshots] of Object.entries(checkpoint.pending_snapshots || {})) compare(`pending_e2ee_snapshots:${cid}`, snapshots, true);
      for (const state of checkpoint.repair_states || []) compare(`${CHANNEL_REPAIR_PREFIX}${state.scope_cid}`, state);
      for (const record of checkpoint.pending_sends || []) {
        const request = tx.objectStore(STORE_PENDING_SENDS).get(record.message_id);
        request.onsuccess = () => {
          try { matches = sameSyncCheckpointValue(record, request.result) && matches; }
          catch (error) { reject(error); tx.abort(); }
        };
        request.onerror = () => reject(request.error);
      }
      tx.oncomplete = () => resolve(matches);
      tx.onerror = () => reject(tx.error || new Error('Sync checkpoint verification aborted'));
      tx.onabort = () => reject(tx.error || new Error('Sync checkpoint verification aborted'));
    });
  }

  async tryAcquireRepairLock(scopeCid: string, ownerId: string, ttlMs: number): Promise<boolean> {
    const db = await this.openDB();
    return new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readwrite');
      const store = tx.objectStore(STORE_META);
      const key = `${CHANNEL_REPAIR_LOCK_PREFIX}${scopeCid}`;
      const request = store.get(key);
      let acquired = false;

      request.onsuccess = () => {
        const now = Date.now();
        const current = request.result as { owner_id?: string; expires_at?: number } | undefined;
        if (current?.owner_id && current.expires_at && current.expires_at > now && current.owner_id !== ownerId) {
          acquired = false;
          return;
        }
        acquired = true;
        store.put({ scope_cid: scopeCid, owner_id: ownerId, expires_at: now + ttlMs, updated_at: now }, key);
      };
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => resolve(acquired);
      tx.onerror = () => reject(tx.error);
    });
  }

  async releaseRepairLock(scopeCid: string, ownerId: string): Promise<void> {
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readwrite');
      const store = tx.objectStore(STORE_META);
      const key = `${CHANNEL_REPAIR_LOCK_PREFIX}${scopeCid}`;
      const request = store.get(key);

      request.onsuccess = () => {
        const current = request.result as { owner_id?: string } | undefined;
        if (!current || current.owner_id === ownerId) {
          store.delete(key);
        }
      };
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async saveAllSyncTimestamps(timestamps: Record<string, string>): Promise<void> {
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readwrite');
      const store = tx.objectStore(STORE_META);
      for (const [cid, ts] of Object.entries(timestamps)) {
        store.put(ts, `${LEGACY_SYNC_PREFIX}${cid}`);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async loadRemovedSyncCursor(): Promise<RemovedSyncCursor | null> {
    const db = await this.openDB();
    return new Promise<RemovedSyncCursor | null>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readonly');
      const store = tx.objectStore(STORE_META);
      const request = store.get('sync:removed_channels');
      request.onsuccess = () => {
        const value = request.result;
        if (!value) {
          resolve(null);
          return;
        }
        if (typeof value === 'object' && typeof value.removed_at === 'string' && typeof value.event_id === 'string') {
          resolve(value as RemovedSyncCursor);
          return;
        }
        // Legacy storage may hold a numeric millisecond cursor, or the first
        // composite cursor shape may hold removed_at as a number.
        const legacyMs = typeof value === 'object' ? Number(value.removed_at) : Number(value);
        if (Number.isFinite(legacyMs) && legacyMs > 0) {
          resolve({
            removed_at: new Date(legacyMs).toISOString(),
            event_id:
              typeof value === 'object' && typeof value.event_id === 'string'
                ? value.event_id
                : '00000000-0000-0000-0000-000000000000',
          });
          return;
        }
        resolve(null);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async saveRemovedSyncCursor(cursor: RemovedSyncCursor): Promise<void> {
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readwrite');
      const store = tx.objectStore(STORE_META);
      store.put(cursor, 'sync:removed_channels');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ---- Pending E2EE encrypted snapshots ----

  async loadPendingE2eeSnapshots(cid: string): Promise<PendingE2eeSnapshot[]> {
    const db = await this.openDB();
    return new Promise<PendingE2eeSnapshot[]>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readonly');
      const store = tx.objectStore(STORE_META);
      const request = store.get(`pending_e2ee_snapshots:${cid}`);
      request.onsuccess = () => resolve((request.result as PendingE2eeSnapshot[]) || []);
      request.onerror = () => reject(request.error);
    });
  }

  async savePendingE2eeSnapshots(cid: string, messages: PendingE2eeSnapshot[]): Promise<void> {
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readwrite');
      const store = tx.objectStore(STORE_META);
      const key = `pending_e2ee_snapshots:${cid}`;
      if (messages.length === 0) {
        store.delete(key);
      } else {
        store.put(messages, key);
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

  // ---- PIN Epoch Archive recovery ----

  async saveArchiveUpload(upload: PendingArchiveUpload): Promise<void> {
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_ARCHIVE_UPLOADS, 'readwrite');
      const store = tx.objectStore(STORE_ARCHIVE_UPLOADS);
      const archiveBlobId = (upload.upload as any)?.archive_blob_id || 'unknown';
      store.put(
        upload,
        `${archiveGenerationKeyPrefix(upload.cid, upload.group_generation || 0)}:${upload.epoch}:${archiveBlobId}`,
      );
      tx.oncomplete = () => resolve();
      tx.onerror = (event) => reject(tx.error || (event.target as IDBRequest | null)?.error || new Error('IndexedDB archive transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB archive transaction aborted'));
    });
  }

  async loadPendingArchiveUploads(): Promise<PendingArchiveUpload[]> {
    const db = await this.openDB();
    return new Promise<PendingArchiveUpload[]>((resolve, reject) => {
      const tx = db.transaction(STORE_ARCHIVE_UPLOADS, 'readonly');
      const store = tx.objectStore(STORE_ARCHIVE_UPLOADS);
      const request = store.getAll();
      request.onsuccess = () =>
        resolve(
          ((request.result as PendingArchiveUpload[]) || []).map((record) => ({
            ...record,
            group_generation: record.group_generation || 0,
          })),
        );
      request.onerror = () => reject(request.error);
    });
  }

  async deleteArchiveUpload(
    cid: string,
    epoch: number,
    archiveBlobId?: string,
    groupGeneration = 0,
  ): Promise<void> {
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_ARCHIVE_UPLOADS, 'readwrite');
      const store = tx.objectStore(STORE_ARCHIVE_UPLOADS);
      if (archiveBlobId) {
        store.delete(`${archiveGenerationKeyPrefix(cid, groupGeneration)}:${epoch}:${archiveBlobId}`);
      } else {
        const prefix = `${archiveGenerationKeyPrefix(cid, groupGeneration)}:${epoch}:`;
        const cursorReq = store.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor) {
            if (String(cursor.key).startsWith(prefix)) cursor.delete();
            cursor.continue();
          }
        };
      }
      tx.oncomplete = () => resolve();
      tx.onerror = (event) => reject(tx.error || (event.target as IDBRequest | null)?.error || new Error('IndexedDB archive transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB archive transaction aborted'));
    });
  }

  async saveDeferredArchive(archive: PendingDeferredArchive): Promise<void> {
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_DEFERRED_ARCHIVES, 'readwrite');
      const store = tx.objectStore(STORE_DEFERRED_ARCHIVES);
      store.put(
        archive,
        `${archiveGenerationKeyPrefix(archive.cid, archive.group_generation || 0)}:${archive.epoch}:${archive.archive_blob_id}`,
      );
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async loadPendingDeferredArchives(): Promise<PendingDeferredArchive[]> {
    const db = await this.openDB();
    return new Promise<PendingDeferredArchive[]>((resolve, reject) => {
      const tx = db.transaction(STORE_DEFERRED_ARCHIVES, 'readonly');
      const store = tx.objectStore(STORE_DEFERRED_ARCHIVES);
      const request = store.getAll();
      request.onsuccess = () =>
        resolve(((request.result as PendingDeferredArchive[]) || []).map(normalizeDeferredArchiveRecord));
      request.onerror = () => reject(request.error);
    });
  }

  async deleteDeferredArchive(
    cid: string,
    epoch: number,
    archiveBlobId?: string,
    groupGeneration = 0,
  ): Promise<void> {
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_DEFERRED_ARCHIVES, 'readwrite');
      const store = tx.objectStore(STORE_DEFERRED_ARCHIVES);
      if (archiveBlobId) {
        store.delete(`${archiveGenerationKeyPrefix(cid, groupGeneration)}:${epoch}:${archiveBlobId}`);
      } else {
        const prefix = `${archiveGenerationKeyPrefix(cid, groupGeneration)}:${epoch}:`;
        const cursorReq = store.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor) {
            if (String(cursor.key).startsWith(prefix)) cursor.delete();
            cursor.continue();
          }
        };
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async saveArchiveAck(record: ArchiveAckRecord): Promise<void> {
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_ARCHIVE_ACKS, 'readwrite');
      const store = tx.objectStore(STORE_ARCHIVE_ACKS);
      store.put(
        record,
        `${archiveGenerationKeyPrefix(record.cid, record.group_generation || 0)}:${record.epoch}:${record.scope}:${record.coverage_key}`,
      );
      tx.oncomplete = () => resolve();
      tx.onerror = (event) => reject(tx.error || (event.target as IDBRequest | null)?.error || new Error('IndexedDB archive transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB archive transaction aborted'));
    });
  }

  async loadArchiveAck(
    cid: string,
    groupGeneration: number,
    epoch: number,
    scope: ArchiveScope,
    coverageKey: string,
  ): Promise<ArchiveAckRecord | null> {
    const db = await this.openDB();
    return new Promise<ArchiveAckRecord | null>((resolve, reject) => {
      const tx = db.transaction(STORE_ARCHIVE_ACKS, 'readonly');
      const store = tx.objectStore(STORE_ARCHIVE_ACKS);
      const request = store.get(
        `${archiveGenerationKeyPrefix(cid, groupGeneration)}:${epoch}:${scope}:${coverageKey}`,
      );
      request.onsuccess = () => {
        if (request.result || scope !== 'account_owned' || groupGeneration !== 0) {
          const result = request.result as ArchiveAckRecord | undefined;
          resolve(result ? { ...result, group_generation: result.group_generation || 0 } : null);
          return;
        }
        const legacyRequest = store.get(`${cid}:${epoch}:${coverageKey}`);
        legacyRequest.onsuccess = () => {
          const legacy = legacyRequest.result as ArchiveAckRecord | undefined;
          resolve(
            legacy
              ? {
                  ...legacy,
                  group_generation: 0,
                  scope: 'account_owned',
                  coverage_key: coverageKey,
                  recovery_key_id: legacy.recovery_key_id || coverageKey,
                }
              : null,
          );
        };
        legacyRequest.onerror = () => reject(legacyRequest.error);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async saveEpochArchiveCheckpoint(checkpoint: EpochArchiveCheckpoint): Promise<void> {
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readwrite');
      tx.objectStore(STORE_META).put(
        checkpoint,
        epochArchiveCheckpointKey(checkpoint.scope_cid, checkpoint.group_generation || 0, checkpoint.epoch),
      );
      tx.oncomplete = () => resolve();
      tx.onerror = (event) => reject(tx.error || (event.target as IDBRequest | null)?.error || new Error('IndexedDB archive transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB archive transaction aborted'));
    });
  }

  async loadEpochArchiveCheckpoint(
    scopeCid: string,
    epoch: number,
    groupGeneration = 0,
  ): Promise<EpochArchiveCheckpoint | null> {
    const db = await this.openDB();
    return new Promise<EpochArchiveCheckpoint | null>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readonly');
      const request = tx.objectStore(STORE_META).get(epochArchiveCheckpointKey(scopeCid, groupGeneration, epoch));
      request.onsuccess = () =>
        resolve(request.result ? normalizeEpochArchiveCheckpoint(request.result as EpochArchiveCheckpoint) : null);
      request.onerror = () => reject(request.error);
    });
  }

  async loadEpochArchiveCheckpoints(): Promise<EpochArchiveCheckpoint[]> {
    const db = await this.openDB();
    return new Promise<EpochArchiveCheckpoint[]>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readonly');
      const store = tx.objectStore(STORE_META);
      const checkpoints: EpochArchiveCheckpoint[] = [];
      const request = store.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(checkpoints);
          return;
        }
        if (String(cursor.key).startsWith(EPOCH_ARCHIVE_CHECKPOINT_PREFIX)) {
          checkpoints.push(normalizeEpochArchiveCheckpoint(cursor.value as EpochArchiveCheckpoint));
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
  }

  async deleteEpochArchiveCheckpoint(scopeCid: string, epoch: number, groupGeneration = 0): Promise<void> {
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readwrite');
      tx.objectStore(STORE_META).delete(epochArchiveCheckpointKey(scopeCid, groupGeneration, epoch));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ---- Sync State (Offline-First Event Sourcing) ----

  async saveSyncStateBatch(records: SyncStateRecord[]): Promise<void> {
    if (records.length === 0) return;
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readwrite');
      const store = tx.objectStore(STORE_META);
      for (const record of records) {
        store.put(record, `sync_state:${record.cid}`);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async loadSyncState(cid: string): Promise<SyncStateRecord | null> {
    const db = await this.openDB();
    return new Promise<SyncStateRecord | null>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readonly');
      const store = tx.objectStore(STORE_META);
      const request = store.get(`sync_state:${cid}`);
      request.onsuccess = () => resolve((request.result as SyncStateRecord) || null);
      request.onerror = () => reject(request.error);
    });
  }

  async loadAllSyncStates(): Promise<SyncStateRecord[]> {
    const db = await this.openDB();
    return new Promise<SyncStateRecord[]>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readonly');
      const store = tx.objectStore(STORE_META);
      const records: SyncStateRecord[] = [];
      const request = store.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(records);
          return;
        }
        if (String(cursor.key).startsWith('sync_state:')) {
          records.push(cursor.value as SyncStateRecord);
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
  }

  async deleteSyncState(cid: string): Promise<void> {
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readwrite');
      const store = tx.objectStore(STORE_META);
      store.delete(`sync_state:${cid}`);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async clearAllSyncState(): Promise<void> {
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readwrite');
      const store = tx.objectStore(STORE_META);
      const request = store.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (String(cursor.key).startsWith('sync_state:')) {
          cursor.delete();
        }
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async saveArchiveStashKey(key: CryptoKey): Promise<void> {
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readwrite');
      const store = tx.objectStore(STORE_META);
      store.put(key, ARCHIVE_STASH_KEY_META);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async loadArchiveStashKey(): Promise<CryptoKey | null> {
    const db = await this.openDB();
    return new Promise<CryptoKey | null>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readonly');
      const store = tx.objectStore(STORE_META);
      const request = store.get(ARCHIVE_STASH_KEY_META);
      request.onsuccess = () => resolve((request.result as CryptoKey) || null);
      request.onerror = () => reject(request.error);
    });
  }

  async saveRecoveryPublicKey(userId: string, publicKey: Uint8Array): Promise<void> {
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readwrite');
      const store = tx.objectStore(STORE_META);
      store.put(publicKey, `recovery_public_key:${userId}`);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async loadRecoveryPublicKey(userId: string): Promise<Uint8Array | null> {
    const db = await this.openDB();
    return new Promise<Uint8Array | null>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readonly');
      const store = tx.objectStore(STORE_META);
      const request = store.get(`recovery_public_key:${userId}`);
      request.onsuccess = () => resolve((request.result as Uint8Array) || null);
      request.onerror = () => reject(request.error);
    });
  }

  async saveRestoreProgress(record: RestoreProgressRecord): Promise<void> {
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const normalized = { ...record, group_generation: record.group_generation || 0 };
      const storeName = normalized.group_generation === 0
        ? STORE_RESTORE_PROGRESS
        : STORE_RESTORE_PROGRESS_BY_GENERATION;
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      store.put(normalized);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async loadRestoreProgress(
    userId: string,
    deviceId: string,
    cid: string,
    groupGeneration = 0,
  ): Promise<RestoreProgressRecord | null> {
    const db = await this.openDB();
    return new Promise<RestoreProgressRecord | null>((resolve, reject) => {
      const storeName = groupGeneration === 0 ? STORE_RESTORE_PROGRESS : STORE_RESTORE_PROGRESS_BY_GENERATION;
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const request = store.get(groupGeneration === 0 ? [deviceId, cid] : [deviceId, cid, groupGeneration]);
      request.onsuccess = () => {
        const record = request.result as RestoreProgressRecord | undefined;
        resolve(record && record.user_id === userId ? { ...record, group_generation: record.group_generation || 0 } : null);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async loadIncompleteRestores(userId: string, deviceId: string): Promise<RestoreProgressRecord[]> {
    const statuses: RestoreStatus[] = ['pending', 'running', 'partial', 'failed'];
    const groups = await Promise.all(
      statuses.flatMap((status) => [
        this._loadRestoreProgressByDeviceStatus(userId, deviceId, status, STORE_RESTORE_PROGRESS),
        this._loadRestoreProgressByDeviceStatus(userId, deviceId, status, STORE_RESTORE_PROGRESS_BY_GENERATION),
      ]),
    );
    return groups.flat();
  }

  async loadRestoresWithPermanentGaps(userId: string, deviceId: string): Promise<RestoreProgressRecord[]> {
    const records = await Promise.all([
      this._loadRestoreProgressByDeviceStatus(userId, deviceId, 'done_with_gaps', STORE_RESTORE_PROGRESS),
      this._loadRestoreProgressByDeviceStatus(userId, deviceId, 'done_with_gaps', STORE_RESTORE_PROGRESS_BY_GENERATION),
    ]);
    return records.flat();
  }

  async deleteRestoreProgress(userId: string, deviceId: string, cid: string, groupGeneration = 0): Promise<void> {
    const existing = await this.loadRestoreProgress(userId, deviceId, cid, groupGeneration);
    if (!existing) return;
    const db = await this.openDB();
    return new Promise<void>((resolve, reject) => {
      const storeName = groupGeneration === 0 ? STORE_RESTORE_PROGRESS : STORE_RESTORE_PROGRESS_BY_GENERATION;
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      store.delete(groupGeneration === 0 ? [deviceId, cid] : [deviceId, cid, groupGeneration]);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  private async _loadRestoreProgressByDeviceStatus(
    userId: string,
    deviceId: string,
    status: RestoreStatus,
    storeName: string,
  ): Promise<RestoreProgressRecord[]> {
    const db = await this.openDB();
    return new Promise<RestoreProgressRecord[]>((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const index = store.index('device_status');
      const request = index.getAll(IDBKeyRange.only([deviceId, status]));
      request.onsuccess = () => {
        const records = ((request.result as RestoreProgressRecord[]) || []).filter(
          (record) => record.user_id === userId,
        ).map((record) => ({ ...record, group_generation: record.group_generation || 0 }));
        resolve(records);
      };
      request.onerror = () => reject(request.error);
    });
  }
}
