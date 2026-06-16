# @ermis-network/ermis-chat-sdk

The official core SDK for Ermis Chat.

## E2EE Channel Helpers

- `channel.removeMembersE2ee(members, e2eeOptions)` removes other members from an E2EE channel with an MLS commit and sends `self_remove: false`.
- `channel.leaveChannelE2ee(userId)` self-leaves an E2EE channel by sending `self_remove: true`; this path does not include an MLS commit from the leaving user.
- `client.mlsManager.setupRecoveryPin(pin)`, `unlockRecoveryVault(pin)`, `changeUnlockedRecoveryPin(newPin)`, and the compatibility `changeRecoveryPin(oldPin, newPin)` manage the PIN recovery vault. PIN verification and rewrap remain client-side.
- `client.mlsManager.restoreHistoricalMessages(channelType, channelId, options)` restores accessible historical E2EE ciphertexts from account-owned epoch archives and returns explicit gap entries when archive material is missing.
- `client.mlsManager.repairEncryptedChannel(channelType, channelId, { mode: 'replay' })` is the user-facing Channel Info repair API. It replays from the last safe sync cursor, flushes pending encrypted snapshots, and runs chat-history repair if the PIN is unlocked.
- `client.mlsManager.repairEncryptedChannel(channelType, channelId, { mode: 'reset_local_state' })` is an advanced manual fallback after replay failure. It reloads the local MLS state through external join while keeping decrypted message cache and repair issues.
- `client.mlsManager.repairRecoveryChannel(channelType, channelId, { mode })` repairs persisted failed message versions with `failed_only` or rechecks the selected timeline with `recheck_channel`.
- Sync cursors are stored as `{ created_at, event_id }`; the SDK commits the cursor that was actually processed, not the server batch cursor, and IndexedDB checkpoints provider bytes plus cursor in one meta transaction when available.
- During encrypted-state repair, a local group epoch lower than known failed message epochs makes the saved sync cursor untrusted; replay starts from the membership/MLS-enabled boundary, then archive repair is attempted before reset availability is returned if the device is still behind.
- During manual repair, archive epoch listings with no matching epoch mark the affected message-level issues as `no_archive` instead of leaving stale `decrypt_error` reasons.
- For non-gated E2EE topics, historical restore queries parent archive material by `e2ee_group_id` and routes restored plaintext into each timeline by `ciphertext.cid`.
- `client.mlsManager.getRecoveryStatus()` reports vault existence, memory-only unlock state, incomplete restore channels, and channels that completed with permanent gaps.
- `client.mlsManager.getRestoreProgress(channelType, channelId)` returns the per-device restore progress record for channel UI badges and gap banners.
- Restore progress is persisted per device in IndexedDB so interrupted history restore resumes only missing epochs after the user re-enters their PIN.
- Message-level `repair_issues` share that existing progress record, so new failures in completed epochs are not hidden and no IndexedDB version bump is required.
- Restore runs sequentially by channel and fetches target epochs in bounded batches/ranges before saving progress per epoch.
- The SDK loads recovery public metadata during MLS initialization, so devices can upload account-owned archives while still locked and only require PIN entry for private-key restore.
- Recovery vault lookup is cached and in-flight de-duplicated inside `MlsManager`; repeated recovery status refreshes read local vault state instead of repeatedly calling `GET /recovery/vault`.
- Fresh epoch archives are exported after channel creation and after every fresh epoch. If no recovery vault exists yet, the archive ADK is stashed locally under a device-local non-extractable WebCrypto AES-GCM key and uploaded after PIN setup/vault discovery.
- Archive failures are best-effort: commit/join/rotate flows keep the MLS epoch change and retain retryable archive work locally.
- New E2EE channel creation can pass `data.e2ee_recovery_policy` as `member_assisted` or `self_owned_only`. The default server/client behavior remains `member_assisted`.
- `client.mlsManager.bootstrapKnownE2eeChannels()` scans loaded E2EE channels after `channels.queried`, external-joins missing local groups sequentially, emits `e2ee.bootstrap_progress`, and queues restore after PIN unlock.
- E2EE non-gated topics inherit the parent `e2ee_group_id`; gated topics keep a topic-owned MLS group.
- Reconnect catch-up uses `/v1/e2ee/scope_sync` with one `{ created_at, event_id }` cursor per E2EE scope.
- The SDK dispatches `e2ee.initialized` after MLS manager initialization, allowing app recovery gates to refresh once E2EE is ready.
- The SDK dispatches `e2ee.restore_progress` after restore progress changes; UI clients can subscribe to refresh status without polling.
- The SDK dispatches `e2ee.bootstrap_progress` while startup external-join preparation is running; UI clients can show non-blocking secure-restore preparation progress.

## Progress Log

### 2026-06-16 - E2EE Recovery Policy Client Contract

- Goal: wire Bellboy `e2ee_recovery_policy` through the SDK-facing channel data contract.
- Code changed: `ChannelData`, `ChannelResponse`, and `CreateTopicData` now expose `E2eeRecoveryPolicy = 'member_assisted' | 'self_owned_only'`, allowing E2EE create flows to choose member-assisted or self-owned-only recovery coverage.
- Design decision: SDK only transports the policy; Bellboy remains the source of truth for validation, immutability, inherited topic behavior, and sponsored upload rejection.
- Verification: `npm run build:sdk` passed.

### 2026-06-05 - Offline Topic Waterfall Ordering

- Goal: fix offline catch-up where messages in newly-created non-gated topics could remain encrypted with `Generation is too old to be processed`.
- Code changed: `MlsManager` now infers the parent `e2ee_group_id` from `parent_cid + gate=false` when topic channel data has not hydrated `e2ee_group_id`, retries pending snapshots in one scope/global waterfall instead of per-topic batches, and stores mixed-scope decrypt results by each message `cid`.
- Verification: `yarn workspace @ermis-network/ermis-chat-sdk types` passed.

### 2026-06-05 - Scope Sync Runtime Cleanup

- Goal: stop SDK runtime paths from calling legacy `POST /v1/e2ee/sync`.
- Code changed: post-join/channel-ready catch-up now uses `E2eeClient.scopeSync()` with composite `{ created_at, event_id }` cursors and persists `scope_sync:{cid}` cursor state. `E2eeClient.syncAll()` remains as a legacy public API wrapper but is no longer used internally by `MlsManager`.
- Verification: `yarn workspace @ermis-network/ermis-chat-sdk types` passed.

### 2026-06-05 - Topic Archive Restore Routing

- Goal: fix historical restore for inherited E2EE topics so topic messages are decrypted and cached under the topic cid, not only the parent/general cid.
- Code changed: `MlsManager.restoreHistoricalMessages()` resolves the archive target from `e2ee_group_id`, uses `ciphertext.cid` for plaintext storage and active state updates, and dispatches `e2ee.local_messages_loaded` per restored timeline.
- Docs changed: SDK README and core topic docs now document restore routing for non-gated E2EE topics.
- Verification: `yarn workspace @ermis-network/ermis-chat-sdk types` passed.

### 2026-06-05 - Hybrid MLS Topic Scope Sync

- Goal: implement the client side of Bellboy hybrid MLS topic scope sync.
- Code changed: `E2eeClient.scopeSync()` targets `POST /v1/e2ee/scope_sync`, MLS storage persists composite scope cursors with legacy timestamp fallback, and `MlsManager.sync()` processes scope envelopes in server order.
- Code changed: E2EE send/update encrypt with `e2ee_group_id`, non-gated topics delegate readiness to the parent group, and topic MLS batch ops skip inherited non-gated topics.
- Docs changed: core SDK topic docs now describe E2EE inherited topics, gated topic own-group behavior, and scope sync routing.
- Design decision: `/v1/e2ee/sync` remains in the SDK for legacy single-channel helpers while reconnect recovery moves to the long-term scope sync contract.
- Verification: `yarn workspace @ermis-network/ermis-chat-sdk types` passed.

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
- Historical design decision: the initial V1 was account-owned and PIN-only. The current recovery flow keeps account-owned compatibility and adds independently materialized `group_sponsored` coverage from epoch-start checkpoints; recovery key rotation is still unsupported.
- Rollout: initialize `MlsManager` with `{ enableSponsoredArchives: false }` to disable sponsored coverage for that client session while retaining account-owned recovery.
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
- Design decision: recovery private keys remain memory-only; `done_with_gaps` stops automatic restore prompts, while explicit manual repair may recheck non-terminal issues.
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

### 2026-06-05 - PIN Restore In-Flight Dedupe

- Goal: stop duplicate `epoch_archives/query` calls with identical `{ list_epochs: true }` payloads when PIN unlock starts background restore and the active channel simultaneously asks for restore.
- Code changed: restore queue enqueue now skips CIDs already in-flight, and `restoreHistoricalMessages()` reuses an in-flight restore promise for the same CID/options.
- Design decision: background restore for a CID is treated as covering the active restore request for that CID, keeping restore one-channel-at-a-time and avoiding duplicate archive index reads.
- Verification: `yarn workspace @ermis-network/ermis-chat-sdk types`, `yarn workspace @ermis-network/ermis-chat-sdk build`, and `yarn workspace uhm-chat build` passed.

### 2026-06-05 - PIN Restore Terminal Progress Dedupe

- Goal: stop reload/PIN unlock and later channel entry from re-querying epoch lists for channels already restored on this device.
- Code changed: restore enqueue now checks persisted `restore_progress` and skips channels whose status is already `done` or `done_with_gaps`, while still allowing explicit epoch-range restores.
- Design decision: terminal local restore progress is authoritative for automatic background/active enqueue, so app navigation does not re-open archive index reads after history has been synced locally.
- Verification: `yarn workspace @ermis-network/ermis-chat-sdk types`, `yarn workspace @ermis-network/ermis-chat-sdk build`, and `yarn workspace uhm-chat build` passed.

### 2026-06-05 - PIN Restore Status Missing-Progress Detection

- Goal: let apps prompt for PIN on new devices that have known E2EE channels without local restore progress, without prompting again after terminal progress is stored.
- Code changed: `getRecoveryStatus()` now folds joined known E2EE channels with missing or non-terminal `restore_progress` into `hasIncompleteRestore` / `incompleteChannels`.
- Design decision: automatic PIN gates should be driven by restore need, not merely by a locked recovery vault.
- Verification: `yarn workspace @ermis-network/ermis-chat-sdk types`, `yarn workspace @ermis-network/ermis-chat-sdk build`, and `yarn workspace uhm-chat build` passed.

### 2026-06-13 - Message-Level Recovery Repair

- Goal: stop epoch-wide restore counts from reporting already available messages as newly restored and provide explicit repair actions for failed encrypted messages.
- Code changed: restore progress now carries `RepairIssue` records keyed by message version; realtime, sync, pending snapshots, and archive restore update the same issue state.
- Code changed: `repairRecoveryChannel()` supports failed-only retry and selected-timeline recheck, filters inherited topics by their own CID, and skips message versions already covered by local plaintext.
- Code changed: `changeUnlockedRecoveryPin(newPin)` rewraps the in-memory recovery key after unlock while `changeRecoveryPin(oldPin, newPin)` remains compatible and validates the old PIN through WASM unwrap.
- Design decision: `completed_epochs` remains compatibility metadata, `done_with_gaps` prevents automatic loops but not manual repair, and issue fields use the existing restore-progress store.
- Verification: `yarn workspace @ermis-network/ermis-chat-sdk test:repair` passed 5 regression tests; `npm run build:sdk`, `npm run build:react`, and `yarn workspace uhm-chat build` passed.

### 2026-06-13 - Safe Cursor and Encrypted State Repair

- Goal: prevent scope sync from skipping events when processing stops mid-batch and add a recovery path for devices whose local MLS state falls behind the server.
- Code changed: channel sync now carries `processed_event_cursor` through `_processChannelEvents()`, and both batch sync plus per-channel sync use the exact processed `event_id` instead of borrowing `serverNextCursor.event_id`.
- Code changed: default IndexedDB storage now persists `ChannelRepairState`, a 60s soft repair lock, and optional `saveMlsSyncCheckpoint()` for provider bytes plus scope cursor in one `meta` transaction.
- Code changed: `repairEncryptedChannel()` adds replay and manual reset modes; replay gates realtime decrypt/protocol processing for that scope, and reset rolls back provider/group state if external join fails.
- Code changed: replay now detects local epoch drift from repair issues/pending snapshots, ignores potentially over-advanced saved cursors, attempts archive repair, and returns reset availability when replay cannot bring the local epoch up to the failed message epoch.
- Code changed: manual repair now marks message-level issues as `no_archive` when archive epoch listing has no matching material, so UI details distinguish missing backup material from decrypt failure.
- Design decision: message decrypt failures can advance the cursor only after pending snapshots/repair issues are durable; protocol commit failures stop the page and surface retry/reset instead of advancing.
- Verification: `npm run build:sdk`, `npm run build:react`, `yarn workspace uhm-chat build`, and `yarn workspace @ermis-network/ermis-chat-sdk test:repair` passed.

### 2026-06-14 - Archive-First Repair and Group-Sponsored Coverage

- Repair now tries available archives before protocol replay, flushes pending ciphertext after replay, then performs a final archive recheck. Missing archives do not expose local-state reset.
- Restore issues use canonical `cid + message_id + normalized version` identity without epoch. `forward_secrecy_consumed` remains blocked/recoverable because an alternate archive can still decrypt it.
- Archive restore prefers group-sponsored candidates and lazily tries alternate blobs per failed message before marking it unavailable.
- Epoch transitions capture one scope-independent checkpoint encrypted by the device-local non-extractable key. Account-owned and sponsored blobs are materialized separately because their AAD/wrap info bind scope.
- Archive ACK and pending checks are scope-aware. Sponsored capability gracefully disables for the session against old Bellboy versions.
- PIN unlock force-rechecks accepted E2EE timelines once per unlock session, and self invite acceptance triggers archive recheck.
- Verification: SDK build and 9 recovery-repair regression tests pass.

### 2026-06-15 - Archive API V2 and Vault Revision

- `e2ee.ts` exposes cursor-paginated archive availability and bounded material queries. Keep V1 discovery during Bellboy manifest/recipient backfill; switch recovery orchestration to V2 only after server rollout confirms coverage.
- Vault responses carry `revision`; PIN changes send `expected_revision` so concurrent devices cannot silently overwrite recovery metadata.
- Upload queues consume structured `{ status, reason_code }` results. A failed manifest may retry the same idempotency key, while an expired reservation requires a new upload identity.
- Group-sponsored upload remains feature-detected and falls back to account-owned coverage when an older Bellboy returns unsupported endpoint/scope responses.

## Documentation

For full documentation, API references, and integration guides, please visit our official documentation website:

👉 **[Ermis Chat Documentation](https://ermisnetwork.github.io/ermis-chat-monorepo/)**
