# @ermis-network/ermis-chat-sdk

The official core SDK for Ermis Chat.

MLS source/artifact upgrade and TEST adoption:
[repository handoff runbook](../../MLS_UPGRADE_HANDOFF.md).

## Public Module Structure

- Customer integrations should import from the package root, for example `import { ErmisChat, EncryptionManager, loadOpenMlsWasm } from '@ermis-network/ermis-chat-sdk'`.
- Encryption-specific integrations may import from `@ermis-network/ermis-chat-sdk/encryption`, which exposes `E2eeClient`, `EncryptionManager`, `IndexedDBEncryptionStorage`, `loadOpenMlsWasm`, public encryption types, and friendly aliases `EncryptionApiClient` and `BrowserEncryptionStorage`.
- Deep imports from `@ermis-network/ermis-chat-sdk/src/*` are intentionally unsupported. The package publishes `dist/` and runtime assets from `public/`, not TypeScript source files.
- Apps using OpenMLS must publish `openmls_wasm_bg.wasm` with their web assets. The SDK package includes this binary under `public/openmls_wasm_bg.wasm`; `loadOpenMlsWasm('/openmls_wasm_bg.wasm')` loads the bundled JS glue and that public binary.

## Release Line

Starting with `2.1.0`, one SDK line supports both the legacy USS contract and End User v1. Install SDK and React at the same version:

```bash
npm install @ermis-network/ermis-chat-sdk@2.1.0
npm install @ermis-network/ermis-chat-react@2.1.0
```

Backend contract selection is runtime configuration through `endUserApiMode`, not an npm channel or an API probe. Existing `self-host` and `user-service` dist-tags may remain available for older releases, but new integrations should use the unified `2.x` line.

## Durable GroupInfo repair

The SDK treats `group_info.refresh_requested` and `group_info.uploaded` as
best-effort wake-ups over Bellboy's authoritative PostgreSQL refresh state. The
default IndexedDB adapter persists metadata-only refresh requests, reconciles
every local MLS group on initialization or reconnect, and allows one
claim/export/upload flow per `cid`. A repair upload always carries the server
`request_id` and short `lease_token`; matching or older local work is removed
only after an uploaded event or a successful HTTP persistence/reconcile cycle.

Custom `EncryptionStorageAdapter` implementations are eligible to repair only
when they implement `listGroupInfoRefreshRequests`,
`saveGroupInfoRefreshRequest`, and `deleteGroupInfoRefreshRequests`. Otherwise
the SDK emits `e2ee.group_info_repair_state` with
`repair_status="unsupported"` and never performs an unleased repair upload.

On external-join `group_info_stale` or `group_info_invalid`, the SDK reports
the exact observed epoch/hash and fetches a fresh GroupInfo using at most three
bounded jittered backoffs. Applications should render that state as “Secure
session is being refreshed” and keep user retry available. They must not reuse
or retry an external commit already accepted by Bellboy.

## Client Configuration

### MLS mutations with delayed delivery

<details><summary>Change log</summary>

- `2026-10-07`: Internal Web source consolidation preserves bootstrap/single-join journals together with retained-state repair and authenticated own-Commit replay.
  - Main `ermis-chat-monorepo` is the active source. Recovery first skips an in-flight request, then handles a saved retained-rejoin candidate; neither branch replaces the other.
  - An unreadable persisted provider, or a retained identity with no provider, fails initialization while keeping stored data for explicit repair. A fresh provider cannot reconstruct uploaded private KeyPackages.
  - Owner-triggered encrypted-state repair stages a retained external-rejoin candidate before HTTP. Exact accepted Commit/epoch/generation/GroupId settles it; ambiguous outcomes retain the candidate, and definite initial rejection restores prior state. Plaintext, ciphertext backlog and scope cursors are preserved. Old ciphertext without plaintext remains pending for authorized archive recovery.
  - Custom adapters must support the existing atomic mutation primitive. Older SDK rollback must first settle retained-rejoin journals. Build/unit evidence does not establish combined browser/device acceptance or cross-tab provider serialization; see the [canonical implementation journal](../../../bellboy/docs/todo/e2ee_mls_android_parity_plan.md).

- `2026-10-06`: Single external-join uses the durable mutation journal before HTTP.
  - Unknown responses preserve the exact staged external Commit; matching historical Commit, successful exact-request response or a validated accepted-pending receipt completes the original merge. Retry keeps the saved Commit instead of fetching a new GroupInfo and creating another candidate.
  - Staged N+1 cannot authorize readiness or encryption. Merged provider, marker, first-decryptable epoch, existing Welcome-fallback metadata and journal deletion commit atomically. Initial timeout/rate-limit failures and rejected retries keep the unknown candidate; definite initial authorization/input rejection clears it.
  - Custom storage adapters need the atomic mutation checkpoint as well as the existing Welcome JOIN checkpoint. A missing primitive fails before network I/O. This shares the bootstrap/batch SDK rollback requirement below; full crash/generation-replacement and multi-tab/provider concurrency remain gates.

- `2026-10-06`: Channel/topic bootstrap and batch topic external-join now retain durable candidates before HTTP.
  - Preparation leaves the bootstrap Commit staged at epoch 0. `Channel.create`, direct-channel creation and `Channel.createTopic` bind the complete encoded request before sending; custom flows should use `postMlsBootstrap(cid, url, encodedPayload)` after preparation. Preparation without complete metadata cannot invent a create request during recovery.
  - Acceptance requires exact generation/GroupId and the original Welcome/tree or signed GroupInfo, rather than HTTP 200 or a numeric epoch. An existing channel can return 200 for a different creator's bundle. Solo bootstrap and enable also require matching authoritative GroupInfo.
  - Batch external-join persists each staged group with its exact external Commit. OpenMLS reports N+1 before merge, so that number cannot acknowledge a staged candidate. Exact historical Commit or matching per-topic success completes the original merge. Missing/ambiguous outcomes remain non-ready; retry sends the saved artifact once per sync.
  - Persistence: merged join provider, generation marker, first-decryptable epoch and journal deletion are atomic. Custom adapters must handle `MlsMutationCheckpoint.readiness` in the same transaction: undefined preserves it, null deletes it, an object replaces it. A null group marker deletes the CID marker.
  - Concurrency: sync does not resend an initial bootstrap/batch join still in flight. A parent with an unresolved bound topic create refuses another random-CID create. This does not provide cross-tab or full shared-provider serialization.
  - Compatibility: existing public request fields, WASM and IndexedDB version remain unchanged. Code expecting a merged group immediately from `createE2eeChannel`/`createE2eeTopic` must wait for accepted creation. Single external-join unknown responses, the full interruption matrix and multi-tab/provider concurrency remain gates. No external SDK publication.
  - SDK rollback: deploy the matching storage adapter with these journal kinds. Reconcile/drain pending bootstrap and batch-join journals before returning to older SDK code that cannot recover them; unchanged IndexedDB version does not make that rollback safe.

- `2026-10-06`: Rotation, add/remove member, self-left eviction and gated-topic member-add retain device-local mutation checkpoints before HTTP.
  - Re-add safety: ignore an older removal only when authenticated current active membership has a strictly newer creation timestamp. Refresh queued ghost membership before a mutation; preserve active users unless explicitly removed or re-added.
  - Welcome recovery: a Welcome carrying a newer generation installs its group over an older restored group at the same CID; the older handle is released after the JOIN checkpoint succeeds.
  - Decrypt recovery: the Welcome checkpoint clears cached external-join readiness as well as storage. Cached encrypted envelopes or rows without plaintext cannot satisfy a replay/dedup check.
  - Historical bytes: receive and waterfall normalize Base64/legacy byte arrays through the existing strict codec before WASM and ciphertext hashing; malformed encoded input stays retryable in replay.
  - Reason: a timeout, lost reply or per-topic error string cannot prove the original Commit was rejected.
  - Integrator action: custom storage adapters must implement `saveMlsMutationCheckpoint` atomically across provider, group marker and pending record, plus `listPendingMlsMutations`. Unsupported adapters fail before HTTP. The default IndexedDB adapter uses existing meta/groups stores, without a DB version change.
  - Recovery: exact next-epoch pending receipts merge the original candidate; unknown outcomes remain non-ready and block new mutation/encryption for that group. Sync replays within the current membership boundary, matches exact Commit/generation/GroupId, or retries the saved request once per sync. It never regenerates Commit or consumes fresh KeyPackages for that retry. A failed retry does not disprove original acceptance.
  - Persistence: acceptance is checkpointed before merge; merged provider and journal deletion are then atomic. Own-device Commit events must reconcile pending candidates instead of always being skipped. Competing authenticated Commits may resolve a losing candidate after successful application.
  - Limits: this change covers ordinary installed-group mutations and topic member-add, not new channel/topic bootstrap, batch external join or all multi-tab/device/generation-replacement crashes. Those remain separate gates. No external SDK/UI package publication.

- `2026-10-05`: Global encryption sync compares its installed epoch with the existing authenticated recovery-discovery snapshot and replays from the current membership boundary when it is behind in the same generation/GroupId.
  - Reason: a delayed outbox Commit keeps its original acceptance timestamp, which can precede an already saved application cursor.
  - Integrator action: pending protocol delivery reports `needs_retry`; retry sync after delivery. The client must not treat a numeric server epoch as a locally installed/decryptable epoch.
  - Compatibility: no sequence contract, schema change, group replacement or extra Commit. Healthy sync adds no network call. A lagging scope scans O(current membership history), in pages of 100; large-history recovery remains a load gate.

- `2026-10-05`: Ordinary MLS mutations and gated-topic bundles send the installed `group_generation` and canonical Base64 `group_id`.
  - Reason: preserve correct key rotation and membership operations after rebootstrap.
  - Integrator action: update this SDK together with Bellboy's optional mutation identity fields; generation > 0 requires an exact local OpenMLS GroupId. Historical/mismatched local markers fail before a Commit is staged or sent.
  - Compatibility: generation 0 omits GroupId. No WASM or IndexedDB schema change. This is the local monorepo test SDK; no external SDK artifact has been promoted.

- `2026-10-05`: `EncryptionManager.keyRotation()` recognizes a validated HTTP 503 `mls_transition_pending` response for the requested next epoch.
  - Reason: Bellboy has already accepted that Commit into its durable outbox; clearing it leaves the creating device at the previous epoch.
  - Integrator action: the result may include `delivery_pending: true` and `operation_id`. The original pending Commit is merged and saved once. Wait for durable delivery/reconcile before assuming peers have advanced; do not generate another Commit to retry this operation.
  - Compatibility: ordinary success still returns `{ epoch }`. Generic 503, invalid operation identity, authorization errors and a mismatched accepted epoch are not treated as acceptance. No IndexedDB schema or WASM change.

</details>

Cloud mode:

```ts
const client = ErmisChat.getInstance({
  apiKey: API_KEY,
  projectId: PROJECT_ID,
  baseURL: BASE_URL,
  selfHosted: false,
  endUserApiMode: 'legacy',
});
```

Self-host mode:

```ts
const client = ErmisChat.getInstance({
  baseURL: BASE_URL,
  selfHosted: true,
  endUserApiMode: 'v1',
});
```

`selfHosted` controls deployment and tenant behavior. `endUserApiMode` independently selects the user/auth adapter. Self-host mode omits `api_key` from the WebSocket URL and does not require SDK callers to send `project_id` on normal project-scoped requests. After `connectUser()`, Bellboy returns the license project ID in `health.check`; the SDK stores it for local caches and E2EE deterministic channel helpers.

## Legacy USS And End User v1

- Legacy routes include `/auth/get_otp_new`, `/auth/otp_login`, `/refresh_token`, legacy users/profile, SSE, wallet, and external auth. V1 routes include `/auth/otp/request`, `/auth/otp/verify`, `/auth/google`, `/auth/refresh`, and targeted users/profile endpoints.
- Auth responses expose compatibility aliases: `success: true`, `token = access_token`, and top-level `user_id` when v1 returns it or when it can be read from the JWT payload.
- `ErmisChat` calls the selected adapter's refresh endpoint when authenticated HTTP requests return 401, 403, or `TOKEN_EXPIRED`, then retries the original request once. Concurrent HTTP/WS failures share one refresh promise; WebSocket close `4001`/`JWT Expire` refreshes, reconnects, and recovers state without surfacing a handshake error to the app.
- Use `refreshToken: () => localStorage.getItem('refresh_token')` and `onTokenRefresh` to keep app storage in sync with rotated access/refresh tokens.
- Successful refreshes dispatch `auth.token_refreshed`; terminal refresh failures dispatch `auth.refresh_failed` so applications can clear the session.
- V1 user APIs call `/users/:id`, `/users/batch`, `/users/search`, `/users/me`, and `/users/me/avatar`. The v1 adapter throws `UnsupportedEndUserFeatureError` with code `END_USER_FEATURE_UNSUPPORTED` for wallet, SSE, unrestricted listing, external auth, and `about_me`.
- `searchUsers(query, limit)` is the preferred overload. The legacy `searchUsers(page, page_size, name)` overload maps to `q=name&limit=page_size` and ignores `page`.
- The SDK no longer preloads all users after `connectUser()`. Browser cache hydration remains local-only, and cache entries are refreshed by `queryUser`, `getBatchUsers`, `searchUsers`, message/member enrichment, `updateProfile`, and `uploadAvatar`.
- For external auth, exchange the external identity through a trusted backend calling `/uss/v1/auth/external`, then pass the returned `access_token` to `connectUser(user, access_token)`.

## Durable GroupInfo repair

The SDK treats `group_info.refresh_requested` and `group_info.uploaded` as
best-effort wake-ups over Bellboy's PostgreSQL state. The default IndexedDB
adapter persists metadata-only refresh requests, reconciles every local MLS
group on initialization/reconnect, and allows one claim/export/upload flow per
`cid`. A repair upload always carries the server `request_id` and short
`lease_token`; matching or older local work is removed only after an uploaded
event or a successful HTTP persistence/reconcile cycle.

Custom `EncryptionStorageAdapter` implementations are eligible to repair only
when they implement `listGroupInfoRefreshRequests`,
`saveGroupInfoRefreshRequest`, and `deleteGroupInfoRefreshRequests`. Otherwise
the SDK emits `e2ee.group_info_repair_state` with
`repair_status="unsupported"` and never performs an unleased upload.

On external-join `group_info_stale`/`group_info_invalid`, the SDK reports the
exact observed epoch/hash, emits `repair_status="retryable"`, and fetches a
fresh GroupInfo after a newer upload hint or at most three bounded jittered
backoffs. Applications should render that state as “Secure session is being
refreshed” and keep user retry available; they must not reuse or retry an
accepted external commit.

## Publishing

### `connectUser` migration in 2.1.0

```ts
// Before
await client.connectUser(user, token, false, refreshToken);
await client.connectUser(user, externalToken, true);

// 2.1.0
await client.connectUser(user, token, { refreshToken });
await client.connectUser(user, externalToken, { externalAuth: true }); // legacy only
```

<details>
<summary>Implementation progress</summary>

- `2026-07-03` (production): Added flexible SDK self-host/cloud initialization.
  - Code changed: SDK config parsing/types, AuthProvider API-key decoration, WebSocket URL construction, project-scoped client/channel payload helpers, and UHM app initialization/login wiring.
  - Docs changed: SDK README client configuration, root README setup examples, and UHM runtime notes.
  - Decision: cloud mode remains strict and backward compatible; self-host mode allows omitted `apiKey`/`projectId`, learns `project_id` from `health.check`, and avoids empty-scope user cache writes before that event.
  - Performance: O(1) config/payload checks, no new HTTP/WS round trips, and slightly smaller self-host request payloads because `api_key`/`project_id` are omitted where Bellboy derives scope from claims.
  - Verification: `yarn workspace @ermis-network/ermis-chat-sdk types`, `npm run build:sdk`, and `yarn workspace uhm-chat build` passed.
- `2026-07-04` (production): Added SDK/UHM refresh-token flow for expired access tokens.
  - Code changed: `TokenManager` stores refresh token/provider, `ErmisChat` refreshes and retries expired HTTP requests once, WebSocket reconnect refreshes before rebuilding the URL, and UHM stores/clears `refresh_token`.
  - Docs changed: SDK README and core SDK auth/client docs document `refreshToken`, `onTokenRefresh`, and automatic retry behavior.
  - Decision: refresh calls are single-flight per client; callback persistence failures are logged but do not fail the refreshed request.
  - Performance: normal requests stay O(1) with no extra round trip; expired-token recovery adds one `POST /auth/refresh` plus one retry, and concurrent expired requests share the in-flight refresh promise.
  - Verification: `yarn workspace @ermis-network/ermis-chat-sdk types`, `npm run build:sdk`, and `yarn workspace uhm-chat build` passed.

</details>

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
- E2EE quoted replies hydrate `quoted_message` from active decrypted state or IndexedDB when Bellboy only returns `quoted_message_id`.
- For non-gated E2EE topics, historical restore queries parent archive material by `e2ee_group_id` and routes restored plaintext into each timeline by `ciphertext.cid`.
- `client.encryptionManager.getRecoveryStatus()` reports vault existence, memory-only unlock state, incomplete restore channels, channels that completed with permanent gaps, and the issue-bearing restore progress records that account PIN settings can summarize.
- `client.encryptionManager.getRestoreProgress(channelType, channelId)` returns the per-device restore progress record for active restore progress and diagnostics.
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

## Documentation

For full documentation, API references, and integration guides, please visit our official documentation website:

👉 **[Ermis Chat Documentation](https://ermisnetwork.github.io/ermis-chat-monorepo/)**
