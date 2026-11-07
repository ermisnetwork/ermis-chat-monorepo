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

## Query-unavailable history and deletion barriers

<details><summary>Change log</summary>

- `2026-11-04`: Persist optional `SyncStateRecord.queryUnavailableMessageSeqs` pairs `[msg_seq, observed latest_event_seq]` alongside the conservative `hiddenMessageSeqs` union.
  - Reason: sequence queries can return an anonymous `unavailable` placeholder while an allocated message is not readable yet; absence alone does not establish permanent deletion.
  - Integrator action: custom sync-state adapters must round-trip the optional pairs with the same checkpoint. Restore cached metadata with `channel.state.restoreHiddenSequences(record)`; use `mergeHiddenSequences` only for authoritative hidden/deletion metadata. Do not rewrite either set directly.
  - Compatibility/default: omitted, invalid, or legacy provenance remains conservatively hidden. Older SDKs still honor the hidden union; an older writer can discard recoverability but cannot automatically reopen content. No IndexedDB schema upgrade or server API change.

</details>

Only a normal canonical query response in the same CID can retire a query-only marker. The query must begin after that exact absence was observed, no later absence/deletion may supersede it, and its message `last_event_seq` must meet the recorded server watermark. Cache, realtime, stale/in-flight responses, confirmed per-ID deletion, sync hidden metadata, local tombstones and clear-history boundaries cannot reopen content. Missing watermarks and older hidden records require separate repair evidence; this change does not migrate them.

Implementation history, verification and the original unresolved live case are tracked in the [canonical LOR plan](../../../bellboy/docs/todo/e2ee_mls_lifetime_ownership_recovery_plan.md#2026-11-04--query-unavailable-sequence-provenance-lor-bug-web-live-hidden-seq-001).

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

## Durable recovery discovery

<details><summary>Change log</summary>

- `2026-10-20`: Validated authenticated channel HTTP metadata can admit a new public discovery observation after a lost event. The optional version1 `observed_head` binds generation/recovery revision; the greatest head/event evidence survives restart. An event equal to current control is deduplicated against the durable observation rather than discarded before admission.
  - Same/stale metadata, repeated reconnect and timers preserve an exhausted observation's exact budget. Superseding evidence respects an existing in-flight lease time. No synthetic event UUID, private provider mutation or extra per-CID request is used.
  - Custom storage must preserve and validate the optional head under existing owner CAS/full readback and2KiB limit. No database-version/server/native API change; missing head remains compatible. Metadata and GI availability do not establish Ready or reset eligibility.
  - Final artifact/browser evidence and remaining release/rollback gates are tracked in the [canonical LOR document](../../../bellboy/docs/todo/e2ee_mls_lifetime_ownership_recovery_plan.md).

</details>

## Client Configuration

### Browser device identity

<details><summary>Change log</summary>

- `2026-10-27`: `connectUser` resolves the account's IndexedDB device binding before WebSocket/auth initialization. Retained private state restores its ID; an empty private database reserves a fresh ID even when localStorage survives. Existing database names and private identity bytes are preserved. Incomplete or ambiguous private tuples return `provider_checkpoint_invalid`; do not clear them or retry with a different identity to hide this error.

</details>

LocalStorage is an optional cache. A sole legacy account provider/identity tuple can recover its device ID without the cache; concurrent tabs reserve one ID atomically. Global migration-only storage retains its legacy ID lookup, but a fresh account database does not inherit that ID without private state. Custom encryption storage adapters remain responsible for their own durable device binding.

### Resuming a pending External Join

<details><summary>Change log</summary>

- `2026-10-27`: Replaying the same typed `NoMatchingKeyPackage` failure retains its existing Welcome/history work and does not request a fresh pool refill; the native package match is still re-evaluated, so a valid private restore can use that Welcome. Normal readiness can share its own freshly validated evidence checkpoint while the exact owner proof remains current; any intervening revision requires fresh validation.

- `2026-10-27`: A targeted Welcome following its same-epoch Add Commit in a sync page is validated through the existing durable Welcome path before replaying that Commit. A missing group retains its exact protocol cursor and reaches typed recovery admission. Startup isolates recoverable scope failures, and installed groups still run their normal Ready proof when public discovery has exhausted its budget. Discovery attempts and recovery deadlines are unchanged. If own Commit replay activates the original join UUID before its HTTP completes, one owner-guarded readiness continuation runs after both original operations settle; replacement owners remain fenced.

- `2026-10-27`: Channel readiness/open and unsealed sends can resume a retained join using the original operation UUID. A server-accepted operation must finish native rebase, durable activation, sync and Ready before application encryption. Unknown results retain the same candidate; manual/deadline/provider/owner fences and existing exact ciphertext stay protected. No candidate deletion, new operation UUID or background polling is required.

</details>

### Isolated local environments

<details><summary>Change log</summary>

- `2026-10-23`: Optional `ErmisChatOptions.localStorageNamespace` isolates IndexedDB and the browser device-ID cache. Omit it to keep existing names and data. An explicit namespace imports no legacy device ID; use a stable, different value for each backend snapshot. It does not change API keys, user IDs, project IDs or authentication. Never copy private providers between active environments.

</details>

Uhm development builds can select this option with `VITE_QA_DATA_SCOPE`. Use an OAuth-authorized browser origin (currently `localhost:3001` for the local test setup). Changing this value starts a separate local identity; it does not repair or erase another namespace.


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

<details>
<summary>Change log</summary>

- `2026-10-27`: Refresh failures with HTTP401/403, or HTTP400 carrying `REFRESH_TOKEN_INVALID`/`REFRESH_TOKEN_EXPIRED`/`invalid_grant`, emit `auth.refresh_failed` with `reason: refresh_rejected`. This applies only to the generated refresh operation; business400 and generic WS1006 are not logout authority. Expired access credentials are refreshed before the first WS handshake using an untrusted `exp` scheduling hint (Ermis millisecond epoch or second epoch). A1006 close uses that refresh path only when expiry is locally evident. Normal transport errors keep reconnect behavior.
  - Integrator action: retire pending bootstrap callbacks and return to login on `refresh_rejected`/missing refresh credentials. Preserve private MLS storage and exact pending intents/ciphertexts. Retry network/5xx without clearing authentication credentials. Reconnect callbacks from a retired host/account cannot refresh a newer session.
  - Compatibility/default: existing single-flight refresh and deadlines remain; no issuer/signing/token validation change. The application owns logout and presentation. JWT decoding never authenticates a user or establishes MLS Ready.

</details>

- Legacy routes include `/auth/get_otp_new`, `/auth/otp_login`, `/refresh_token`, legacy users/profile, SSE, wallet, and external auth. V1 routes include `/auth/otp/request`, `/auth/otp/verify`, `/auth/google`, `/auth/refresh`, and targeted users/profile endpoints.
- Auth responses expose compatibility aliases: `success: true`, `token = access_token`, and top-level `user_id` when v1 returns it or when it can be read from the JWT payload.
- `ErmisChat` calls the selected adapter's refresh endpoint when authenticated HTTP requests return 401, 403, or `TOKEN_EXPIRED`, then retries the original request once. Concurrent HTTP/WS failures share one refresh promise; WebSocket close `4001`/`JWT Expire` refreshes, reconnects, and recovers state without surfacing a handshake error to the app.
- Use `refreshToken: () => localStorage.getItem('refresh_token')` and `onTokenRefresh` to keep app storage in sync with rotated access/refresh tokens.
- Successful refreshes dispatch `auth.token_refreshed`; failures dispatch `auth.refresh_failed`. Only `refresh_rejected` (refresh HTTP401/403 or explicitly typed legacy400) or `missing_refresh_token` requires login; untyped400/timeout/offline/5xx remain retryable. Uhm navigates directly to login with an expiry message, retires late bootstrap work and preserves IndexedDB MLS state.
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

<details>
<summary>Change log</summary>

- `2026-10-27`: IndexedDB advertises `readyObservationVersion:1`. A fresh native-validated Ready checkpoint uses `provider_observation:true` with the unchanged captured provider revision, full transactional private/scoped CAS and full readback. It writes Ready/admission metadata only. Other adapters keep the v2 provider writer. Genuine private writes still invalidate every old Ready proof; previously Ready scopes with live subscribers receive coalesced fresh local admission after the writer releases. No join or polling is triggered by that continuation.
  - Reason: observing Ready for one group must not manufacture a private revision and invalidate other groups or discovery jobs.
  - Integrator action: custom adapters must advertise the capability only if they implement the unchanged-revision observation contract; keep all private, receipt, owner and metadata checks. Snapshots remain informational; send still requires async admission.
  - Compatibility/default: additive optional capability, no IndexedDB schema/key migration or backend contract change; v2-only adapters retain existing behavior.

</details>

- `channel.removeMembersE2ee(members, e2eeOptions)` removes other members from an E2EE channel with an encryption commit and sends `self_remove: false`.
- `channel.leaveChannelE2ee(userId)` self-leaves an E2EE channel by sending `self_remove: true`; this path does not include an encryption commit from the leaving user.
- Live `member.removed` events and reconnect sync persist self-leave ghosts for the designated evictor. They do not submit a drain-only `commit_eviction`. The next explicit add/remove/key rotation bundles inactive ghosts into its composite commit; current membership is checked before removing a queued ghost. An active re-add or owner replacement during the durable queue write fences the old event callback.
- A replacement sync owner releases waiters on the retired gate so they can recheck their captured scope. It keeps its own gate active; settling an old gate does not establish Ready or authorize old callbacks.
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


Durable Welcome compatibility (LOR DEC085): adapters implementing `welcomeAuthoredDispositionVersion: 1` may retain an `authored` disposition for the exact current user's logical-device Welcome, after actual persisted private-group/signer/tree/epoch validation and atomic Welcome CAS/readback. This is not an applied Welcome and never supplies returning-device applied-Welcome proof. Missing capability or unknown status must fail closed; a predecessor binary must retain these records and all pending obligations before it qualifies for rollback. The existing IndexedDB schema is sufficient. Fresh application ratchets require durable Ready admission; existing exact ciphertext retries retain their UUID/body/bytes. Authenticated requests preserve timeout/signal/body limits; registration2s and signed5s budgets include proof/auth waits.

Durable application intent compatibility (LOR DEC085, 2026-10-20): adapters need `applicationIntentCheckpointVersion:1` and atomic `reserveApplicationIntent(record, owner, assertOwner)` before a fresh send/edit can wait for Ready. Existing pending-send stores retain `unsealed_intent_version:1`, original UUID/payload/route/AAD and account/device/signer/known generation. This local plaintext intent is distinct from ciphertext acceptance; it never replaces an existing exact ciphertext job. Missing capability fails typed; conflicting same-ID intent rejects. Resume uses normal Ready/private-ratchet checkpoint and preserves known-generation fencing. Cancellation retains exact canceled ciphertext/intent with `acceptance_unknown_after_cancel` when ciphertext exists; no automatic resend or replacement batch follows cancellation. There is no schema migration. A rollback reader must understand and preserve both authored Welcome and unsealed intents; no predecessor is qualified yet. Owner snapshot/copies cost O(provider bytes + intent payload), one short reservation transaction, no HTTP while holding the provider queue.


2026-11-05 queued-send durability: a fresh send reserves its owner-bound unsealed intent before waiting for an earlier send's HTTP, within the existing32-ticket admission limit. Queued intents remain `sending` so interrupted work can resume with its original UUID; an actual admission failure becomes `failed_retryable` and still requires explicit Retry. Ratchet mutation and HTTP stay in per-scope FIFO order. Existing sealed ciphertext and completed-upload journals keep their original adoption/reconciliation path. The Channel publishes an E2EE `sending` bubble only after intent reservation commits; failures publish a separate error. Await the send result for canonical acceptance; an optimistic bubble is not a receipt. No server API or IndexedDB schema change.


2026-10-20 DEC085 final intent writer contract: applicationIntentCheckpointVersion1 includes exact ephemeral pending_send_guards in the same provider+pending private checkpoint. Cancellation/replacement between admission and commit aborts the whole candidate; no ratchet or winning job is overwritten. Preserve unsealed_intent_version1 original UUID/payload/route/AAD and known generation across restart. Hydration/resume restores text intents as well as attachment jobs through existing Channel callbacks. Canceled unknown ciphertext is retained; late errors cannot make it retryable. Compatible predecessor reader/artifact remains unqualified. Final507 affected tests and physical/browser evidence are indexed in the existing Bellboy LOR canonical/ledger, with full six gates still open. Pinned Uhm build used Vite configLoader runner; ESM config resolves projectDir through import.meta.url without alias changes. Default bundled Rolldown loader hung and is retained as a toolchain limitation, not a source-test PASS.


DEC085 final continuation (2026-10-20): a queued send that encounters typed provider_mutation_busy now coalesces a point-read wake after the existing provider checkpoint tail. It rereads durable status and current scope, preserves exact UUID/ciphertext and skips canceled/terminal/sent work; no timer, attempt reset or provider mutex through HTTP. Final affected510PASS includes held-checkpoint autonomous wake/cancel/owner fences; actual final browser restart and offline/online exact retry both returned200. This supersedes the earlier507 count for this changed boundary. Full generation/rollback/performance acceptance remains open in the authoritative LOR ledger.

2026-10-20 DEC085 per-CID discovery: optional complete generation.capability overrides batch defaults, including explicitfalse. Absent preserves legacy fallback; malformed present values fail before control persistence, scoped protocol skew affects only that CID. Policy remains subject to owner, pending receipt, client opt-in and genuine900s incident/claim fences; enabled is not Ready or reset eligibility. No persistence/dependency/minimum-version change. Final Web/Android runtime verification is tracked in the canonical LOR journal.


### Retained generation0 history after activation (2026-10-20)

<details>
<summary>Change log</summary>

- `2026-10-20`: The Web history receive pipeline can process generation0 ciphertext using the exact retained native group whose GroupId is UTF8(CID), while the active generation is newer.
  - Reason: old ciphertext was previously buffered despite the original private group still being present.
  - Integrator action: use the production history receive pipeline; keep all retained providers and exact pending sends. Cached plaintext alone cannot establish fresh historical decrypt acceptance.
  - Compatibility/default: no wire, native ABI, IDB version or server schema change. Positive old generations need exact historical GroupId bindings and remain unsupported/pending; never infer their GroupId from CID.

</details>

History-only processing loads the retained group from the same account/device owned provider, verifies the exact legacy GroupId, uses a candidate provider, and atomically commits the old ratchet/plaintext through the existing application receive checkpoint. It preserves the current active group handle, generation marker and epoch. Realtime receive and send continue to require the current generation; old ciphertext must never enter that current group. Missing old private state stays pending, without an extra External Join, key import, cursor rewind or provider replacement. No network occurs inside the provider mutation/storage transaction. The branch adds at most one native retained-group lookup to the existing per-message candidate/checkpoint path; no timer or background scan. Optimization/benchmark work remains Deferred by owner.

Rollback qualification requires a predecessor that preserves and understands exact pending/unknown/canceled send obligations, native journals, iOS applied-Welcome continuation, generation markers, and the appended Web `superseded_by_generation` Welcome disposition. A historical binary that ignores a retained obligation or cannot make required history progress is not qualified. Current full-client binary rollback remains OPEN; the native preparing testhost reader rehearsal qualifies only that component.


### 2026-10-20 Ready public-progress recovery (LOR-WEB/REC/TEST/COMPAT)

<details>
<summary>Change log</summary>

- `2026-10-20`: Ready retains its full durable CAS/readback proof. After a successful private-noop checkpoint, an exact own next revision plus identical provider/identity bytes may rebase only when the remaining readset differs solely by forward scoped cursor progress or a newly added same-CID protocol-pending obligation. A fresh full validation runs once after releasing the provider queue; a second race returns `local_checkpoint_pending`. No Ready is published from byte equality alone.
  - Integrator action: preserve the winning public state and all pending obligations; treat typed pending as continuation, never clear private uncertainty manually. Precommit public-only conflict is an aborted `local_checkpoint_pending`; actual private/revision conflict remains `provider_checkpoint_conflict`.
  - Compatibility/default: no schema, durable version, wire payload or native ABI change. Unknown commit/readback exceptions, foreign revision, admission/receipt/index/marker changes and joined-external canonical-base mismatch remain fail closed. These unproved mismatch classes are still open liveness work; the bounded fix does not qualify a predecessor binary or close LOR.

</details>

SDK31-file affected regression: 1134 PASS/0 FAIL/0 skipped/0 cancelled, execution `20261020T163510Z-db203e5bdfc6`; SDK and React build PASS. Actual artifacts and UI acceptance are mapped in the [canonical LOR journal](../../../bellboy/docs/todo/e2ee_mls_lifetime_ownership_recovery_plan.md). No API/SQL/Postman request contract changed.


### Joined-external Ready continuation — 2026-10-21 local / 2026-10-20 UTC

<details>
<summary>Change log</summary>

- After an acknowledged private-noop Ready commit, a recognized forward cursor/new-pending race may now be re-proved for joined-external owners too. `loadExternalJoinWorkBase` must return one consistent full readonly base: accepted/rejected receipt, Welcome primary/pending/history witnesses and Ready state. Every canonical field outside Ready state must equal the original checkpoint base; within state only the already recognized public progress is admitted. Original owner, exact own next revision and full provider/identity bytes must still match.
  - Integrator action: retain the complete canonical read set and perform the one fresh full Ready validation outside the provider queue. No Ready is granted by a state-only read. Unknown read, backlog, receipt/Welcome/index/admission replacement or foreign owner/private revision remains fail closed.
  - Compatibility/default: existing composed adapter methods and versions, no new persistence format, database version, native ABI, wire payload or SQL/Postman change. The proof read has no retention/compaction continuation and no HTTP. At most100 active Welcome rows; exceeding the bound cannot become truncated proof. Same one-retry bound applies; repeated progress returns `local_checkpoint_pending`, then a later normal invocation may continue.

</details>

Final producer/consumer regressions:1138 PASS/0 FAIL/0 skipped/0 cancelled across31 affected files, including real WASM joined-external cursor races, repeated-race bound, simultaneous changed receipt+cursor rejection and throwing full-base read. The earlier final3 exclusion is superseded only for this precisely re-proved class. Unknown or changed authoritative data is not normalized away. Full client binary rollback remains unqualified.


### 2026-10-21 — Ready and durable completed attachment jobs

<details>
<summary>Change log</summary>

- Ready readback binds provider/identity, group generation/epoch and the full MLS candidate/mutation/control/receipt/Welcome evidence. Application sends are bound separately by exact per-UUID intent/ciphertext CAS; Ready does not read all historical application jobs or attest local File contents. Sent outcomes and unknown obligations remain retained. This prevents opaque File handles and the100-row cleanup census limit from permanently blocking normal sends. Destructive cleanup still performs its complete original read and fails closed at its existing bound.
- After confirmed attachment upload, persist the exact manifest and attachment IDs before retiring source File data. Unknown/incomplete upload retains files and upload checkpoints. Normal restart/reconnect must select manifest-only completed-upload jobs and continue the same UUID/manifest without repeating upload; sealed unknown ciphertext keeps retry priority and never re-encrypts silently. Manifest/attachment-ID mismatch retains File data and blocks HTTP. No schema or wire change.
- Reader compatibility: the current reader selects completed-manifest jobs without files; a predecessor that ignores this pre-cipher state is not qualified for binary rollback. Do not install such a predecessor over physical private state. This is a functional continuation fix; no retention/GC rollout or performance gate is claimed.

</details>

Completed-upload generation admission (2026-10-21): a pending upload's recorded `group_generation` remains the intended instance before ciphertext exists. Application preparation compares that retained generation after Ready admission and again inside the provider checkpoint queue. A replacement group cannot silently receive an older completed upload intent; retain its UUID/manifest with terminal `old_group_generation`, no HTTP or new ratchet. Existing exact-ciphertext reconciliation priority is unchanged; no extra network roundtrip or wire/persistence migration.

Application send acknowledgement remains independent of temporary private-provider writer availability after HTTP completes. Pre-dispatch owner, generation, pending-mutation and provider checks remain enforced. An existing durable `sent` checkpoint reuses its saved message projection without a second POST; a missing projection fails closed. Queued continuation skips `sent`. Neither acceptance nor cache reuse grants common Ready, and unknown HTTP outcomes still retain original ciphertext/UUID for reconciliation. See the [canonical LOR journal](../../../bellboy/docs/todo/e2ee_mls_lifetime_ownership_recovery_plan.md); cross-request server idempotence and physical-peer acceptance remain separate gates.


### Reconnect synchronization ownership

With `recoverStateOnReconnect: false`, the SDK leaves channel-state recovery to
the consumer and does not open an automatic MLS synchronization barrier. MLS
receive still verifies its generation, epoch, AAD and durable private checkpoint.
With automatic recovery enabled, the pre-handshake barrier prevents realtime
receive from racing protocol catch-up. Failed or skipped recovery releases only
an unclaimed barrier; an actual `EncryptionManager.sync()` owns its barrier until
that work settles. A retired WebSocket cannot refresh or recover a replacement
connection.

Internal integrations that call `markSyncStart()` before asynchronous setup may
use its returned release callback in `finally`. The callback retires only that
unclaimed ticket and cannot close another session's barrier or active MLS sync.
It does not publish Ready, advance cursors, authorize re-encryption or cancel a
server-accepted operation. Existing callers that immediately run `sync()` may
ignore the return value. See the [canonical LOR implementation](../../../bellboy/docs/todo/e2ee_mls_lifetime_ownership_recovery_plan.md)
and [ledger](../../../bellboy/docs/todo/e2ee_mls_lifetime_ownership_recovery_ledger.md).

`EncryptionApiClient.scopeSync()` bounds each mixed protocol/application read to
5 seconds, including token readiness, authentication renewal/retry and completion
of the response body. A status of HTTP 200 alone does not complete synchronization.
An expired/incomplete transport reports retryable `transport_unknown`; it does
not advance cursors, retry a scope request automatically, or establish Ready.
The existing sync owner releases its receive gate through its failure path.
A later normal sync reuses the durable cursor; authentication errors, malformed
responses and ownership changes retain their existing validation and fences.
This budget changes only the scope read, not mutation acceptance or retry rules.
See the [canonical LOR plan](../../../bellboy/docs/todo/e2ee_mls_lifetime_ownership_recovery_plan.md)
and [ledger](../../../bellboy/docs/todo/e2ee_mls_lifetime_ownership_recovery_ledger.md)
for the partial-body reproduction, retained failures and final-artifact gates.

Checkpoint and AAD byte equality scans every byte. Aligned buffers use native
32-bit views; unaligned buffers retain the DataView path, and both compare the
remaining tail bytes. No reference, cached hash or digest replaces an exact
comparison. This reduces CPU cost without changing provider/CAS proof semantics,
readiness policy, channel loading or network fanout.


Self profile enrichment replaces the member presentation object and invalidates an
existing Ready proof. The SDK publishes the computed pending state and coalesces
a fresh native/checkpoint validation for installed groups with live E2EE state
subscribers. Validation waits for existing sync, send and private-writer owners;
a changed session, route, membership or subscription retires the old wake. Other
users' profile changes do not schedule self Ready validation. This continuation
does not fetch or join missing groups and makes no recovery-policy, cursor or
wire-format change.

<details>
<summary>Change log</summary>

- `2026-10-29`: Self member presentation updates wake subscribed Ready validation.
  - Reason: profile enrichment could leave a usable local group in `repairing` until another action requested a proof.
  - Integrator action: retain `subscribeE2eeState` for the active view; continue to await normal send admission.
  - Compatibility/default: same native validation, durable CAS and membership/auth fences; no additional HTTP or missing-group bootstrap.

</details>


Application reconciliation and returning channel views (2026-10-30): newly sealed pending sends keep `application_http_started:false`; first-dispatch CAS sets true before physical HTTP. Unknown/restarted or legacy sealed rows use `/message/reconcile` only with exact UUID/ciphertext. A valid canonical message/sequence is required; missing history remains unresolved. Direct sends wait within the existing five-second budget for the actual provider checkpoint, then recheck scope/cancel/generation/mutation guards; no native handle survives an await or HTTP. Existing queued wake semantics remain. Returning subscribers to installed groups with `local_checkpoint_pending` schedule the existing local Ready revalidation worker, which validates native state and full durable proof without network or private ratchet changes. Unsubscribe/owner/manual/uncertain-provider fences remain; stale pending is emitted before asynchronous revalidation. Whole native/mixed-version/performance acceptance remains separately tracked in the canonical LOR ledger.


Local outgoing presentation (2026-10-30): cached plaintext is not a send receipt. `IndexedDBEncryptionStorage.getMessages` and bulk `loadMessages` read the returned page/UUIDs and their exact pending-send records in one readonly transaction. Unsettled new sends project as sending/error, including canceled/terminal outcomes; update operations and other CID/account records do not relabel accepted history. Channel cache seeding preserves that status. Reads do not rewrite the pending intent, private provider or cache. A positive normal server acceptance still settles the existing outcome atomically. No schema/IDB version or wire changes.

Channel-list transport (2026-10-30): `queryChannels` bounds its HTTP read at five seconds, including an unfinished response body, while retaining shorter positive caller timeouts. Failure rejects through the existing ChannelList error/retry path; it does not hydrate partial snapshots or automatically resend. Auth scope continues to reject late responses from a retired session. This deadline does not certify the network or make global MLS Ready.

### Retrying failed encrypted messages

`channel.retryMessage(messageId)` routes E2EE retries through the original durable pending intent. It retains the UUID and original payload. A sealed operation with an unknown HTTP outcome reconciles the exact ciphertext; it never falls through to the ordinary plaintext endpoint. Missing, foreign-channel, canceled, terminal and edit checkpoints fail closed. Failed unsealed intents remain failed after reload until explicit retry; interrupted work and sealed reconciliation retain their existing resume behavior. Acceptance comes from the server receipt, not the retry button or optimistic cache.

After an accepted rebootstrap installs the founder group, the SDK observes and durably binds authoritative recovery control through the existing bounded discovery flow. Failed observation retains the installed group; a newer manual/repair control still governs it. No identity reset or second rebootstrap is implied. See the [canonical LOR journal](../../../bellboy/docs/todo/e2ee_mls_lifetime_ownership_recovery_plan.md).

Startup scope isolation (2026-11-06): malformed/missing event-bound acceptance metadata keeps that scope at its saved durable cursor with `needs_retry` / `acceptance_metadata_invalid`. Other scopes in the same response can finish checkpointing and recovery discovery. The strict validator is unchanged; the invalid scope is not Ready and does not receive a cursor skip. Shared provider persistence or ownership failures still abort the sync. No wire/schema, retry or crypto-policy changes. See the [canonical LOR journal](../../../bellboy/docs/todo/e2ee_mls_lifetime_ownership_recovery_plan.md).

### Group avatar upload purpose

<details>
<summary>Change log</summary>

- `2026-11-07`: Added optional `purpose: 'channel_avatar'` for channel metadata uploads.
  - Reason: E2EE group avatars use the standard storage path without becoming message attachments.
  - Integrator action: pass the option for group avatar upload, then use the existing channel update with `image`.
  - Compatibility/default: omitted purpose keeps message attachment behavior; deploy backend purpose support first.

</details>

```ts
// Keep the existing normal proxy transport (Uhm):
const uploaded = await channel.sendFile(file, file.name, file.type, undefined, { purpose: 'channel_avatar' });
// Or keep the existing presigned transport (default React component):
const direct = await channel.uploadFilePresigned(file, file.name, file.type, undefined, undefined, { purpose: 'channel_avatar' });
await channel.update({ image: uploaded.file });
```

Purpose is sent only to the API, never to storage. Existing membership, role and upload permissions still apply.
Avatar bytes and the channel image URL remain server-readable metadata; MLS attachment encryption is unchanged.

Browser presigned uploads still require storage CORS to allow the exact page origin (scheme, host and port); multipart also needs ETag exposed. A successful normal proxy avatar upload does not validate browser direct-upload CORS. Uhm currently uses the normal avatar path, while the shared React editor uses presign. `purpose` changes upload admission only.
