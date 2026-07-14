# @ermis-network/ermis-chat-sdk

The official core SDK for Ermis Chat.

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

## Client Configuration

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
