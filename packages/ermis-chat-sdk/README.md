# @ermis-network/ermis-chat-sdk

The official core SDK for Ermis Chat.

## Public Module Structure

- Customer integrations should import from the package root, for example `import { ErmisChat, EncryptionManager, loadOpenMlsWasm } from '@ermis-network/ermis-chat-sdk'`.
- Encryption-specific integrations may import from `@ermis-network/ermis-chat-sdk/encryption`, which exposes `E2eeClient`, `EncryptionManager`, `IndexedDBEncryptionStorage`, `loadOpenMlsWasm`, public encryption types, and friendly aliases `EncryptionApiClient` and `BrowserEncryptionStorage`.
- Deep imports from `@ermis-network/ermis-chat-sdk/src/*` are intentionally unsupported. The package publishes `dist/` and runtime assets from `public/`, not TypeScript source files.
- Apps using OpenMLS must publish `openmls_wasm_bg.wasm` with their web assets. The SDK package includes this binary under `public/openmls_wasm_bg.wasm`; `loadOpenMlsWasm('/openmls_wasm_bg.wasm')` loads the bundled JS glue and that public binary.

## E2EE Channel Helpers

- `channel.removeMembersE2ee(members, e2eeOptions)` removes other members from an E2EE channel with an encryption commit and sends `self_remove: false`.
- `channel.leaveChannelE2ee(userId)` self-leaves an E2EE channel by sending `self_remove: true`; this path does not include an encryption commit from the leaving user.
- `client.encryptionManager.setupRecoveryPin(pin)`, `unlockRecoveryVault(pin)`, `changeUnlockedRecoveryPin(newPin)`, and the compatibility `changeRecoveryPin(oldPin, newPin)` manage the PIN recovery vault. PIN verification and rewrap remain client-side.
- `client.encryptionManager.restoreHistoricalMessages(channelType, channelId, options)` restores accessible historical E2EE ciphertexts from account-owned epoch archives and returns explicit gap entries when archive material is missing.
- `client.encryptionManager.repairEncryptedChannel(channelType, channelId, { mode: 'replay' })` is the user-facing Channel Info repair API. It replays from the last safe sync cursor, flushes pending encrypted snapshots, and runs chat-history repair if the PIN is unlocked.
- `client.encryptionManager.repairEncryptedChannel(channelType, channelId, { mode: 'reset_local_state' })` is an advanced manual fallback after replay failure. It reloads the local encryption state through external join while keeping decrypted message cache and repair issues.
- `client.encryptionManager.repairRecoveryChannel(channelType, channelId, { mode })` repairs persisted failed message versions with `failed_only` or rechecks the selected timeline with `recheck_channel`.
- Sync cursors are stored as `{ created_at, event_id }`; the SDK commits the cursor that was actually processed, not the server batch cursor, and IndexedDB checkpoints provider bytes plus cursor in one meta transaction when available.
- During encrypted-state repair, a local group epoch lower than known failed message epochs makes the saved sync cursor untrusted; replay starts from the membership/encryption-enabled boundary, then archive repair is attempted before reset availability is returned if the device is still behind.
- During manual repair, archive epoch listings with no matching epoch mark the affected message-level issues as `no_archive` instead of leaving stale `decrypt_error` reasons.
- For non-gated E2EE topics, historical restore queries parent archive material by `e2ee_group_id` and routes restored plaintext into each timeline by `ciphertext.cid`.
- `client.encryptionManager.getRecoveryStatus()` reports vault existence, memory-only unlock state, incomplete restore channels, and channels that completed with permanent gaps.
- `client.encryptionManager.getRestoreProgress(channelType, channelId)` returns the per-device restore progress record for channel UI badges and gap banners.
- Restore progress is persisted per device in IndexedDB so interrupted history restore resumes only missing epochs after the user re-enters their PIN.
- Message-level `repair_issues` share that existing progress record, so new failures in completed epochs are not hidden and no IndexedDB version bump is required.
- Restore runs sequentially by channel and fetches target epochs in bounded batches/ranges before saving progress per epoch.
- The SDK loads recovery public metadata during encryption initialization, so devices can upload account-owned archives while still locked and only require PIN entry for private-key restore.
- Recovery vault lookup is cached and in-flight de-duplicated inside `EncryptionManager`; repeated recovery status refreshes read local vault state instead of repeatedly calling `GET /recovery/vault`.
- Fresh epoch archives are exported after channel creation and after every fresh epoch. If no recovery vault exists yet, the archive ADK is stashed locally under a device-local non-extractable WebCrypto AES-GCM key and uploaded after PIN setup/vault discovery.
- Archive failures are best-effort: commit/join/rotate flows keep the encryption epoch change and retain retryable archive work locally.
- New E2EE channel creation and `client.encryptionManager.enableE2ee()` can pass `e2ee_recovery_policy` as `member_assisted` or `self_owned_only`. The default server/client behavior remains `member_assisted`.
- `client.encryptionManager.bootstrapKnownE2eeChannels()` scans loaded E2EE channels after `channels.queried`, external-joins missing local groups sequentially, emits `e2ee.bootstrap_progress`, and queues restore after PIN unlock.
- E2EE non-gated topics inherit the parent `e2ee_group_id` and recovery policy; gated topics keep a topic-owned encryption group and their own policy.
- Reconnect catch-up uses `/v1/e2ee/scope_sync` with one `{ created_at, event_id }` cursor per E2EE scope.
- Opening an already-ready E2EE channel reuses the local encryption group, persisted scope cursor, and last `ready` sync state instead of calling `/v1/e2ee/scope_sync` again; reconnect, missing local state, `has_more`, and repair paths still sync.
- The SDK dispatches `e2ee.initialized` after encryption manager initialization, allowing app recovery gates to refresh once E2EE is ready.
- The SDK dispatches `e2ee.restore_progress` after restore progress changes; UI clients can subscribe to refresh status without polling.
- The SDK dispatches `e2ee.bootstrap_progress` while startup external-join preparation is running; UI clients can show non-blocking secure-restore preparation progress.

## SDK Logging

`ErmisChatOptions.logger` is optional. When it is not provided, SDK runtime logs are no-op, including E2EE/encryption storage, OpenMLS WASM wrapper warnings/errors, media/call helpers, and worker messages.

For quick browser integration, pass console levels directly: `logger: ['info', 'warn', 'error']`. `info` uses `console.log`; `warn` uses `console.warn`; `error` uses `console.error`. For custom routing, pass a function logger; it receives `info`, `warn`, or `error` as the first argument, the formatted message as the second argument, and optional structured metadata as the third argument.

## Progress Log

### 2026-06-17 - Inherited Topic Pending Decrypt Replay

- Goal: fix invite-accept flows where non-gated topic messages received while the member is pending can remain as encrypted fallbacks even after the parent E2EE scope becomes ready.
- Code changed: `EncryptionManager` now persists deferred realtime E2EE messages as pending snapshots, loads pending snapshots from the parent scope plus inherited topic route CIDs into one ordered waterfall, ignores stale pending membership on inherited topic routes once the parent scope is accepted, keeps blocked invite messages buffered instead of clearing them, flushes pending snapshots on live commits and ready-open paths, merges replayed plaintext into active or parent-nested topic state, and emits route-specific refresh events after replay.
- Code changed: startup bootstrap now marks old known E2EE channels with missing restore progress as `requires_user_action: 'unlock_recovery_vault'` when a recovery vault exists but is locked, so fresh logins prompt for PIN restore without reverting to the old `hasVault`-only gate; memberships created in the last two minutes are skipped to avoid prompting immediately after accepting an invite.
- Docs/artifacts changed: this README progress log records the client-side behavior fix. SQL, Postman, and Bellboy server docs are unchanged because API/schema/event contracts did not change.
- Design decision: retry remains scope-based for non-gated topics because parent/general and topic timelines share one MLS ratchet; per-topic retry would risk out-of-order generation consumption.
- Performance: pending replay is `O(P + R)` per scope flush, where `P` is pending snapshots and `R` is active route/topic CIDs for the scope; IndexedDB reads/writes are bounded to active inherited routes, with no new network calls, payload growth, database hot partitions, or server contention.
- Verification: `npm run build:sdk` and `yarn workspace @ermis-network/ermis-chat-sdk test:repair` passed, including topic-state publish coverage for inherited topics nested under parent channels and PIN-gated bootstrap marker coverage.

### 2026-06-17 - Encryption Naming API Cleanup

- Goal: replace customer-facing protocol-specific naming with encryption naming across the SDK while keeping OpenMLS/WASM and Bellboy `mls_*` wire fields unchanged.
- Code changed: public manager/storage/checkpoint/operation types are now `EncryptionManager`, `EncryptionStorageAdapter`, `IndexedDBEncryptionStorage`, `EncryptionSyncCheckpoint`, and `EncryptionOperationResponse`; `ErmisChat` now exposes `client.encryptionManager`; the old protocol-named manager property was removed.
- Docs/artifacts changed: this README documents the breaking client API rename. SQL, Postman, and Bellboy server docs are unchanged because API/schema/request payloads still use the existing Bellboy E2EE wire contract.
- Design decision: this is intentionally breaking for the new encryption SDK surface, but persisted local storage keys, OpenMLS names, `content_type: 'mls'`, and `mls_*` fields remain stable to avoid data loss and server contract drift.
- Performance: runtime time complexity, memory complexity, IndexedDB access patterns, network round trips, payload sizes, hot partitions, and scaling behavior are unchanged; this is a symbol/docs rename only.
- Verification: `npm run build:sdk`, `yarn workspace @ermis-network/ermis-chat-sdk test:repair`, `npm run build:react`, `yarn workspace uhm-chat build`, static forbidden-name and wire-field `rg` checks, Node export smoke test, and `npm_config_cache=/private/tmp/npm-cache-codex npm pack --dry-run --json` passed. Targeted UHM ESLint was attempted but is blocked by existing lint errors in app files unrelated to the rename.

### 2026-06-17 - Encryption Public Types Module

- Goal: keep the customer-facing encryption SDK professional by moving public DTOs, storage contracts, sync states, repair results, and manager option types into `src/encryption/types.ts` instead of scattering contracts across implementation files.
- Code changed: `api.ts`, `storage.ts`, and `manager.ts` now import public contracts from `./types`; private manager helper shapes stay local to `manager.ts`, while `encryption/index.ts` exports `./types` first.
- Docs/artifacts changed: this README documents that `@ermis-network/ermis-chat-sdk/encryption` exposes public encryption types. SQL, Postman, and Bellboy server docs are unchanged because API/schema/request shapes did not change.
- Design decision: keep root `src/types.ts` for core chat SDK generics and put encryption-specific contracts in `src/encryption/types.ts` to avoid turning root types into a mixed-domain dump.
- Performance: runtime Big-O, memory behavior, network/database round trips, payload sizes, and hot paths are unchanged; TypeScript interfaces are erased at build time, and runtime bundles remain effectively unchanged.
- Verification: `npm run build:sdk`, `yarn workspace @ermis-network/ermis-chat-sdk test:repair`, Node subpath require smoke test, `yarn workspace uhm-chat build`, and `npm_config_cache=/private/tmp/npm-cache-codex npm pack --dry-run --json` passed.

### 2026-06-17 - SDK Encryption Module Structure

- Goal: make the new E2EE/encryption SDK surface look like a professional customer-facing module instead of flat internal filenames such as `e2ee.ts`, `mls_manager.ts`, and `mls_storage.ts`.
- Code changed: moved E2EE API, manager, storage, encoding, OpenMLS loader, and OpenMLS generated assets under `src/encryption/`; package root now exports through the encryption barrel, and `@ermis-network/ermis-chat-sdk/encryption` is a first-class subpath export.
- Packaging changed: removed `/src` from published files, kept runtime output in `dist/`, and added `public/openmls_wasm_bg.wasm` so published packages still carry the OpenMLS binary needed by `loadOpenMlsWasm()`.
- Design decision: this intentionally breaks deep source imports for the new E2EE area; root package imports remain stable, and call/media worker files stay outside `encryption/` because they are not OpenMLS/E2EE code.
- Performance: runtime complexity, storage operations, database/network round trips, payload sizes, and hot paths are unchanged; this is a module-boundary and packaging change. Build output adds a small encryption subpath bundle generated from the same source graph.
- Verification: `npm run build:sdk`, `yarn workspace @ermis-network/ermis-chat-sdk test:repair`, Node subpath require smoke test, `yarn workspace uhm-chat build`, and `npm_config_cache=/private/tmp/npm-cache-codex npm pack --dry-run --json` passed.

### 2026-06-17 - PIN Lazy Unlock And Open-Channel Sync Guard

- Goal: avoid repeated PIN prompts and redundant `/scope_sync` calls when an E2EE channel is already ready after login/reconnect catch-up.
- Code changed: `EncryptionManager.ensureChannelReady(..., { source: 'open' })` now checks for local group presence, persisted scope cursor, last sync state `ready`, no `has_more`, and no active/broken repair state before deciding to skip bounded scope sync.
- Code changed: added a repair-suite regression test proving open-channel readiness does not call `E2eeClient.scopeSync()`.
- Docs/artifacts changed: this README documents the guard. Bellboy client docs record the matching contract; SQL, Postman, and Bellboy server code are unchanged.
- Design decision: the optimization is conservative; if cursor, repair, local group, or sync state evidence is missing, the SDK keeps the existing sync/join path.
- Performance: repeated ready-channel opens move from one network call plus `O(L)` scope-index/payload work to `O(1)` local state checks. Login/reconnect/offline catch-up complexity is unchanged.
- Verification: `npm run build:sdk`, `yarn workspace @ermis-network/ermis-chat-sdk test:repair`, and `npm run build:uhm` passed. Targeted Uhm ESLint was attempted but is blocked by existing `ChatPage.tsx` lint errors unrelated to this SDK change.

### 2026-06-16 - SDK Logger Console Level Shorthand

- Goal: make SDK logging easier to enable from apps without writing a custom logger switch.
- Code changed: `ErmisChatOptions.logger` now accepts either the existing function logger or a console-level array such as `['info', 'warn', 'error']`; `info` enables SDK info logs, while `warn` and `error` map to their matching console methods.
- Docs/artifacts changed: this README documents the shorthand and records the compatibility behavior. SQL, Bellboy API docs, and Postman artifacts are unchanged because this only changes the SDK client-side integration option.
- Design decision: keep the existing function logger as the advanced API and add the array as sugar, instead of replacing the logger contract or adding a second option name.
- Performance: current and proposed logging remain O(1) per log call with no database/network round trips; array resolution happens once at client/auth initialization, then each log checks a small in-memory set.
- Verification: `npm run build:sdk` passed.

### 2026-06-16 - SDK Logger No-Op Runtime

- Goal: route SDK runtime logs through the optional `logger` integration so apps that do not pass a logger do not emit inspect-console logs.
- Code changed: added the central SDK logger helper, connected `ErmisChat`/`ErmisAuthProvider` options to it, and replaced authored `console.log`/`warn`/`error`/`debug` calls across client/auth/channel/E2EE encryption storage/manager/media/call/worker code with logger-backed calls.
- Code changed: OpenMLS and call WASM JS wrappers now call a no-op global SDK log bridge instead of `console.*`; the call worker forwards wrapper log events back to the main-thread logger.
- Docs/artifacts changed: this README documents logger no-op behavior and records the change. SQL, Bellboy API docs, and Postman artifacts are unchanged because endpoint contracts, schema, and request/response examples did not change.
- Design decision: `Logger` keeps the existing `info | warn | error` public levels; debug-style internal messages are routed as `info` to avoid expanding the public logger contract.
- Performance: current and proposed logging paths remain O(1) per log call with no database/network round trips; without a logger `sdkLog` returns before formatting, and direct WASM wrapper hooks short-circuit before argument evaluation when no bridge is installed. No hot partition, payload, or scaling behavior changes.
- Verification: `rg -n "console\\.(log|warn|error|debug|info)" packages/ermis-chat-sdk/src` returned no matches; `npm run build:sdk` passed.

### 2026-06-16 - E2EE Recovery Policy Client Contract

- Goal: wire Bellboy `e2ee_recovery_policy` through the SDK-facing channel data contract.
- Code changed: `ChannelData`, `ChannelResponse`, and `CreateTopicData` now expose `E2eeRecoveryPolicy = 'member_assisted' | 'self_owned_only'`, allowing E2EE create flows to choose member-assisted or self-owned-only recovery coverage.
- Code changed: `EncryptionManager.enableE2ee()` sends `e2ee_recovery_policy` with default `member_assisted`; `Channel.createTopic()` applies the default only to gated/own-group E2EE topics and strips the field from inherited non-gated topics.
- Design decision: SDK only transports the policy; Bellboy remains the source of truth for validation, immutability, inherited topic behavior, and sponsored upload rejection.
- Verification: `npm run build:sdk` passed.

### 2026-06-05 - Offline Topic Waterfall Ordering

- Goal: fix offline catch-up where messages in newly-created non-gated topics could remain encrypted with `Generation is too old to be processed`.
- Code changed: `EncryptionManager` now infers the parent `e2ee_group_id` from `parent_cid + gate=false` when topic channel data has not hydrated `e2ee_group_id`, retries pending snapshots in one scope/global waterfall instead of per-topic batches, and stores mixed-scope decrypt results by each message `cid`.
- Verification: `yarn workspace @ermis-network/ermis-chat-sdk types` passed.

### 2026-06-05 - Scope Sync Runtime Cleanup

- Goal: stop SDK runtime paths from calling legacy `POST /v1/e2ee/sync`.
- Code changed: post-join/channel-ready catch-up now uses `E2eeClient.scopeSync()` with composite `{ created_at, event_id }` cursors and persists `scope_sync:{cid}` cursor state. `E2eeClient.syncAll()` remains as a legacy public API wrapper but is no longer used internally by `EncryptionManager`.
- Verification: `yarn workspace @ermis-network/ermis-chat-sdk types` passed.

### 2026-06-05 - Topic Archive Restore Routing

- Goal: fix historical restore for inherited E2EE topics so topic messages are decrypted and cached under the topic cid, not only the parent/general cid.
- Code changed: `EncryptionManager.restoreHistoricalMessages()` resolves the archive target from `e2ee_group_id`, uses `ciphertext.cid` for plaintext storage and active state updates, and dispatches `e2ee.local_messages_loaded` per restored timeline.
- Docs changed: SDK README and core topic docs now document restore routing for non-gated E2EE topics.
- Verification: `yarn workspace @ermis-network/ermis-chat-sdk types` passed.

### 2026-06-05 - Hybrid Encryption Topic Scope Sync

- Goal: implement the client side of Bellboy hybrid encryption topic scope sync.
- Code changed: `E2eeClient.scopeSync()` targets `POST /v1/e2ee/scope_sync`, encryption storage persists composite scope cursors with legacy timestamp fallback, and `EncryptionManager.sync()` processes scope envelopes in server order.
- Code changed: E2EE send/update encrypt with `e2ee_group_id`, non-gated topics delegate readiness to the parent group, and topic encryption batch ops skip inherited non-gated topics.
- Docs changed: core SDK topic docs now describe E2EE inherited topics, gated topic own-group behavior, and scope sync routing.
- Design decision: `/v1/e2ee/sync` remains in the SDK for legacy single-channel helpers while reconnect recovery moves to the long-term scope sync contract.
- Verification: `yarn workspace @ermis-network/ermis-chat-sdk types` passed.

### 2026-05-17 - Production

- Goal: expose the E2EE self-leave API path from the SDK so clients do not send remove-member requests without the required self-leave marker.
- Code changed: `Channel.leaveChannelE2ee(userId)` now sends `{ remove_members: [userId], self_remove: true }`.
- Docs changed: this README now documents the difference between E2EE remove-member commits and E2EE self-leave.
- Design decision: self-leave remains membership-only; remaining designated members handle the encryption eviction commit after receiving `member.removed` with `self_remove=true`.
- Follow-up audit: `removeMembersE2ee` now marks admin/member removals with `self_remove: false`, `leaveChannelE2ee` rejects non-current-user targets, and `EncryptionManager.evictMember` rejects accidental current-user eviction when `selfLeft=false`.
- Recovery fix: pending self-leave evictions drained during `initialize()` now use core encryption readiness instead of the public `initialized` flag, so reconnect/offline recovery can commit evictions before `initialize()` completes.
- Designated-evictor alignment: offline sync now queues and drains self-leave evictions only on the designated evictor. Normal members skip `commit_eviction`, and stale persisted queues are cleared when this client is not designated.
- Verification: `yarn workspace @ermis-network/ermis-chat-sdk build` passed. `./node_modules/.bin/tsc --noEmit -p packages/ermis-chat-sdk/tsconfig.json` still fails on existing WebCodecs audio globals unrelated to this change.

### 2026-05-22 - PIN Epoch Archive V1

- Goal: add web/WASM-first PIN epoch archive restore orchestration.
- Code changed: E2EE client recovery/archive endpoints, IndexedDB archive upload queue, recovery public key cache, `EncryptionManager` PIN setup/unlock/change, archive upload, and historical restore by `archive_blob_id`.
- Historical design decision: the initial V1 was account-owned and PIN-only. The current recovery flow keeps account-owned compatibility and adds independently materialized `group_sponsored` coverage from epoch-start checkpoints; recovery key rotation is still unsupported.
- Rollout: initialize `EncryptionManager` with `{ enableSponsoredArchives: false }` to disable sponsored coverage for that client session while retaining account-owned recovery.
- Verification: `npm run types` passed for this package.

### 2026-05-22 - PIN Epoch Archive V1 BigInt Fix

- Goal: fix key rotation/PIN archive failures where OpenMLS WASM epoch constructors rejected numeric epochs.
- Code changed: `EncryptionManager.archiveCurrentEpoch()` now passes `BigInt` epochs to `ArchiveBlobAad` and `ArchiveKeyWrapInfo`, while keeping REST payload epochs as numbers.
- Design decision: the SDK normalizes the WASM epoch at the archive boundary so existing API contracts remain unchanged.
- Verification: `yarn workspace @ermis-network/ermis-chat-sdk types`, `yarn workspace @ermis-network/ermis-chat-sdk build`, and `yarn workspace uhm-chat build` passed.

### 2026-05-29 - PIN Restore Local Sync

- Goal: make PIN restore on a second device persist decrypted history and update the active message list instead of only returning dialog preview rows.
- Code changed: `EncryptionManager.restoreHistoricalMessages()` now converts archive plaintext into `E2eeStoredMessage` records, saves them to encryption IndexedDB storage, merges restored messages into the active channel state, and dispatches `e2ee.local_messages_loaded`.
- Design decision: restored messages reuse active channel envelopes when present and fall back to archive ciphertext metadata or own-message sender data, so later channel queries can hydrate server envelopes from the local plaintext cache.

### 2026-06-01 - PIN Epoch Archive v2.3 Restore Progress

- Goal: add production restore UX state and archive upload dedup handling.
- Code changed: archive upload responses now include `stored/reason`, upload queues drain on `stored=false`, `EncryptionManager` exposes `getRecoveryStatus()` and a restore queue, and IndexedDB stores per-device `restore_progress`.
- Design decision: recovery private keys remain memory-only; `done_with_gaps` stops automatic restore prompts, while explicit manual repair may recheck non-terminal issues.
- Verification: `yarn workspace @ermis-network/ermis-chat-sdk types`, `yarn workspace @ermis-network/ermis-chat-sdk build`, `yarn workspace @ermis-network/ermis-chat-react build`, and `yarn workspace uhm-chat build` passed.

### 2026-06-01 - PIN Restore Queue Batching and Progress Events

- Goal: integrate production restore queue progress with app-level recovery gates without overloading browser devices.
- Code changed: `restoreHistoricalMessages()` now splits target epochs into bounded batches, emits `e2ee.restore_progress` after progress writes, emits `e2ee.initialized` after encryption init, and exposes `getRestoreProgress()` for channel UI state.
- Design decision: restore remains one channel at a time; each channel fetches bounded epoch ranges instead of one request per epoch or one unbounded range.
- Verification: `npm run build:uhm` passed, including SDK, React package, and uhm-chat builds.

### 2026-06-01 - PIN Archive Coverage Fixes

- Goal: fix real-app recovery gaps where login did not prompt restore, epoch 1 archives could be missing for new rooms, and members only uploaded the join epoch after sync.
- Code changed: encryption initialization now parses the server recovery vault for public recovery metadata before sync, `setupRecoveryPin()` / `unlockRecoveryVault()` archive known E2EE channels before queueing restore, `_enqueueIncompleteRestores()` also queues known channels with no prior progress record, and `processCommit()` uploads an archive after each successfully processed incoming commit.
- Code changed: archive idempotency keys now include the generated `archive_blob_id`, so intentional re-exports from the same device do not collide with retry idempotency and can be handled by server dedup caps.
- Design decision: only public recovery metadata is cached while locked; the recovery private key remains memory-only and is still required only for decrypt/restore.
- Verification: `npm run build:uhm` passed.

### 2026-06-01 - Recovery Vault Fetch Cache

- Goal: stop recovery UI refreshes from spamming `GET /v1/e2ee/recovery/vault` after reload.
- Code changed: `EncryptionManager` now caches whether the vault exists, keeps cached vault bytes/public metadata in memory, and de-duplicates concurrent `_loadRecoveryPublicMetadata()` calls with a shared promise.
- Design decision: cached vault bytes are encrypted public/wrapped material only; recovery private key remains memory-only and is still cleared separately.
- Verification: `npm run build:uhm` passed.

### 2026-06-01 - Deferred Archive Before PIN

- Goal: prevent epochs created before PIN setup from losing their future restore archive opportunity.
- Code changed: `EncryptionManager.archiveCurrentEpoch()` now always exports the epoch archive; without vault metadata it stores a deferred archive record with the ADK encrypted by a device-local non-extractable WebCrypto AES-GCM key, and later flushes those records after vault setup/discovery.
- Code changed: archive upload acknowledgements are persisted per `(cid, epoch, recovery_key_id)`, duplicate-cap/idempotent responses stop future retry noise, and internal commit/join/rotate archive calls use safe wrappers so archive failures never roll back encryption progress.
- Design decision: raw archive bytes and raw ADKs are never stored locally; deferred archive recovery is best-effort for this device's IndexedDB.
- Verification: `npm run build:uhm` passed.

### 2026-06-01 - Login Bootstrap and Known Channel External Join

- Goal: fix first-login channel query auth races and remove the need to click each E2EE channel before external join/restore can begin.
- Code changed: `EncryptionManager` now listens for `channels.queried`, runs `bootstrapKnownE2eeChannels()` over loaded non-pending E2EE channels sequentially, emits `e2ee.bootstrap_progress`, archives joined epochs, and queues restore for joined channels after PIN unlock.
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

- Goal: prevent scope sync from skipping events when processing stops mid-batch and add a recovery path for devices whose local encryption state falls behind the server.
- Code changed: channel sync now carries `processed_event_cursor` through `_processChannelEvents()`, and both batch sync plus per-channel sync use the exact processed `event_id` instead of borrowing `serverNextCursor.event_id`.
- Code changed: default IndexedDB storage now persists `ChannelRepairState`, a 60s soft repair lock, and optional `saveEncryptionSyncCheckpoint()` for provider bytes plus scope cursor in one `meta` transaction.
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

- `src/encryption/api.ts` exposes cursor-paginated archive availability and bounded material queries. Keep V1 discovery during Bellboy manifest/recipient backfill; switch recovery orchestration to V2 only after server rollout confirms coverage.
- Vault responses carry `revision`; PIN changes send `expected_revision` so concurrent devices cannot silently overwrite recovery metadata.
- Upload queues consume structured `{ status, reason_code }` results. A failed manifest may retry the same idempotency key, while an expired reservation requires a new upload identity.
- Group-sponsored upload remains feature-detected and falls back to account-owned coverage when an older Bellboy returns unsupported endpoint/scope responses.

## Documentation

For full documentation, API references, and integration guides, please visit our official documentation website:

👉 **[Ermis Chat Documentation](https://ermisnetwork.github.io/ermis-chat-monorepo/)**
