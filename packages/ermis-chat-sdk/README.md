# @ermis-network/ermis-chat-sdk

The official core SDK for Ermis Chat.

## E2EE Channel Helpers

- `channel.removeMembersE2ee(members, e2eeOptions)` removes other members from an E2EE channel with an MLS commit and sends `self_remove: false`.
- `channel.leaveChannelE2ee(userId)` self-leaves an E2EE channel by sending `self_remove: true`; this path does not include an MLS commit from the leaving user.
- `client.mlsManager.setupRecoveryPin(pin)`, `unlockRecoveryVault(pin)`, and `changeRecoveryPin(oldPin, newPin)` manage the PIN recovery vault for epoch archive restore.
- `client.mlsManager.restoreHistoricalMessages(channelType, channelId, options)` restores accessible historical E2EE ciphertexts from account-owned epoch archives and returns explicit gap entries when archive material is missing.
- `client.mlsManager.getRecoveryStatus()` reports vault existence, memory-only unlock state, incomplete restore channels, and channels that completed with permanent gaps.
- `client.mlsManager.getRestoreProgress(channelType, channelId)` returns the per-device restore progress record for channel UI badges and gap banners.
- Restore progress is persisted per device in IndexedDB so interrupted history restore resumes only missing epochs after the user re-enters their PIN.
- Restore runs sequentially by channel and fetches target epochs in bounded batches/ranges before saving progress per epoch.
- The SDK loads recovery public metadata during MLS initialization, so devices can upload account-owned archives while still locked and only require PIN entry for private-key restore.
- Recovery vault lookup is cached and in-flight de-duplicated inside `MlsManager`; repeated recovery status refreshes read local vault state instead of repeatedly calling `GET /recovery/vault`.
- Fresh epoch archives are exported after channel creation and after every fresh epoch. If no recovery vault exists yet, the archive ADK is stashed locally under a device-local non-extractable WebCrypto AES-GCM key and uploaded after PIN setup/vault discovery.
- Archive failures are best-effort: commit/join/rotate flows keep the MLS epoch change and retain retryable archive work locally.
- `client.mlsManager.bootstrapKnownE2eeChannels()` scans loaded E2EE channels after `channels.queried`, external-joins missing local groups sequentially, emits `e2ee.bootstrap_progress`, and queues restore after PIN unlock.
- The SDK dispatches `e2ee.initialized` after MLS manager initialization, allowing app recovery gates to refresh once E2EE is ready.
- The SDK dispatches `e2ee.restore_progress` after restore progress changes; UI clients can subscribe to refresh status without polling.
- The SDK dispatches `e2ee.bootstrap_progress` while startup external-join preparation is running; UI clients can show non-blocking secure-restore preparation progress.

## Progress Log

### 2026-05-17 - Production

- Goal: expose the E2EE self-leave API path from the SDK so clients do not send remove-member requests without the required self-leave marker.
- Code changed: `Channel.leaveChannelE2ee(userId)` now sends `{ remove_members: [userId], self_remove: true }`.
- Docs changed: this README now documents the difference between E2EE remove-member commits and E2EE self-leave.
- Design decision: self-leave remains membership-only; remaining designated members handle the MLS eviction commit after receiving `member.removed` with `self_remove=true`.
- Follow-up audit: `removeMembersE2ee` now marks admin/member removals with `self_remove: false`, `leaveChannelE2ee` rejects non-current-user targets, and `MlsManager.evictMember` rejects accidental current-user eviction when `selfLeft=false`.
- Recovery fix: pending self-leave evictions drained during `initialize()` now use core MLS readiness instead of the public `initialized` flag, so reconnect/offline recovery can commit evictions before `initialize()` completes.
- Designated-evictor alignment: offline sync now queues and drains self-leave evictions only on the designated evictor. Normal members skip `commit_eviction`, and stale persisted queues are cleared when this client is not designated.
- Verification: `yarn workspace @ermis-network/ermis-chat-sdk build` passed. `./node_modules/.bin/tsc --noEmit -p packages/ermis-chat-sdk/tsconfig.json` still fails on existing WebCodecs audio globals unrelated to this change.

### 2026-05-22 - PIN Epoch Archive V1

- Goal: add web/WASM-first PIN epoch archive restore orchestration.
- Code changed: E2EE client recovery/archive endpoints, IndexedDB archive upload queue, recovery public key cache, `MlsManager` PIN setup/unlock/change, archive upload, and historical restore by `archive_blob_id`.
- Design decision: V1 is account-owned, PIN-only, no recovery key rotation, and returns gap entries for missing archive/wrap/snapshot/decrypt cases.
- Verification: `npm run types` passed for this package.

### 2026-05-22 - PIN Epoch Archive V1 BigInt Fix

- Goal: fix key rotation/PIN archive failures where OpenMLS WASM epoch constructors rejected numeric epochs.
- Code changed: `MlsManager.archiveCurrentEpoch()` now passes `BigInt` epochs to `ArchiveBlobAad` and `ArchiveKeyWrapInfo`, while keeping REST payload epochs as numbers.
- Design decision: the SDK normalizes the WASM epoch at the archive boundary so existing API contracts remain unchanged.
- Verification: `yarn workspace @ermis-network/ermis-chat-sdk types`, `yarn workspace @ermis-network/ermis-chat-sdk build`, and `yarn workspace uhm-chat build` passed.

### 2026-05-29 - PIN Restore Local Sync

- Goal: make PIN restore on a second device persist decrypted history and update the active message list instead of only returning dialog preview rows.
- Code changed: `MlsManager.restoreHistoricalMessages()` now converts archive plaintext into `E2eeStoredMessage` records, saves them to MLS IndexedDB storage, merges restored messages into the active channel state, and dispatches `e2ee.local_messages_loaded`.
- Design decision: restored messages reuse active channel envelopes when present and fall back to archive ciphertext metadata or own-message sender data, so later channel queries can hydrate server envelopes from the local plaintext cache.

### 2026-06-01 - PIN Epoch Archive v2.3 Restore Progress

- Goal: add production restore UX state and archive upload dedup handling.
- Code changed: archive upload responses now include `stored/reason`, upload queues drain on `stored=false`, `MlsManager` exposes `getRecoveryStatus()` and a restore queue, and IndexedDB stores per-device `restore_progress`.
- Design decision: recovery private keys remain memory-only; `done_with_gaps` is terminal and does not prompt for PIN again.
- Verification: `yarn workspace @ermis-network/ermis-chat-sdk types`, `yarn workspace @ermis-network/ermis-chat-sdk build`, `yarn workspace @ermis-network/ermis-chat-react build`, and `yarn workspace uhm-chat build` passed.

### 2026-06-01 - PIN Restore Queue Batching and Progress Events

- Goal: integrate production restore queue progress with app-level recovery gates without overloading browser devices.
- Code changed: `restoreHistoricalMessages()` now splits target epochs into bounded batches, emits `e2ee.restore_progress` after progress writes, emits `e2ee.initialized` after MLS init, and exposes `getRestoreProgress()` for channel UI state.
- Design decision: restore remains one channel at a time; each channel fetches bounded epoch ranges instead of one request per epoch or one unbounded range.
- Verification: `npm run build:uhm` passed, including SDK, React package, and uhm-chat builds.

### 2026-06-01 - PIN Archive Coverage Fixes

- Goal: fix real-app recovery gaps where login did not prompt restore, epoch 1 archives could be missing for new rooms, and members only uploaded the join epoch after sync.
- Code changed: MLS initialization now parses the server recovery vault for public recovery metadata before sync, `setupRecoveryPin()` / `unlockRecoveryVault()` archive known E2EE channels before queueing restore, `_enqueueIncompleteRestores()` also queues known channels with no prior progress record, and `processCommit()` uploads an archive after each successfully processed incoming commit.
- Code changed: archive idempotency keys now include the generated `archive_blob_id`, so intentional re-exports from the same device do not collide with retry idempotency and can be handled by server dedup caps.
- Design decision: only public recovery metadata is cached while locked; the recovery private key remains memory-only and is still required only for decrypt/restore.
- Verification: `npm run build:uhm` passed.

### 2026-06-01 - Recovery Vault Fetch Cache

- Goal: stop recovery UI refreshes from spamming `GET /v1/e2ee/recovery/vault` after reload.
- Code changed: `MlsManager` now caches whether the vault exists, keeps cached vault bytes/public metadata in memory, and de-duplicates concurrent `_loadRecoveryPublicMetadata()` calls with a shared promise.
- Design decision: cached vault bytes are encrypted public/wrapped material only; recovery private key remains memory-only and is still cleared separately.
- Verification: `npm run build:uhm` passed.

### 2026-06-01 - Deferred Archive Before PIN

- Goal: prevent epochs created before PIN setup from losing their future restore archive opportunity.
- Code changed: `MlsManager.archiveCurrentEpoch()` now always exports the epoch archive; without vault metadata it stores a deferred archive record with the ADK encrypted by a device-local non-extractable WebCrypto AES-GCM key, and later flushes those records after vault setup/discovery.
- Code changed: archive upload acknowledgements are persisted per `(cid, epoch, recovery_key_id)`, duplicate-cap/idempotent responses stop future retry noise, and internal commit/join/rotate archive calls use safe wrappers so archive failures never roll back MLS progress.
- Design decision: raw archive bytes and raw ADKs are never stored locally; deferred archive recovery is best-effort for this device's IndexedDB.
- Verification: `npm run build:uhm` passed.

### 2026-06-01 - Login Bootstrap and Known Channel External Join

- Goal: fix first-login channel query auth races and remove the need to click each E2EE channel before external join/restore can begin.
- Code changed: `MlsManager` now listens for `channels.queried`, runs `bootstrapKnownE2eeChannels()` over loaded non-pending E2EE channels sequentially, emits `e2ee.bootstrap_progress`, archives joined epochs, and queues restore for joined channels after PIN unlock.
- Design decision: startup external join remains sequential to avoid Provider/IndexedDB/WASM races; restore still runs through the existing one-channel queue.
- Verification: `npm run build:uhm` passed.

## Documentation

For full documentation, API references, and integration guides, please visit our official documentation website:

👉 **[Ermis Chat Documentation](https://ermisnetwork.github.io/ermis-chat-monorepo/)**
