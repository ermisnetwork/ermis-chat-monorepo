# @ermis-network/ermis-chat-sdk

The official core SDK for Ermis Chat.

## Public Module Structure

<details>
<summary>Change log</summary>

- `2026-07-03`: Kept the public npm package under the official `@ermis-network/ermis-chat-sdk` scoped name.
  - Reason: keep the SDK aligned with the existing Ermis public package name before wider adoption.
  - Integrator action: install/import `@ermis-network/ermis-chat-sdk` and use `@ermis-network/ermis-chat-sdk/encryption` for encryption-only imports.
  - Compatibility/default: runtime APIs and package exports are unchanged; only the npm package name and module specifier changed from the temporary unscoped naming. Any temporary package names should be deprecated on npm.

</details>

- Customer integrations should import from the package root, for example `import { ErmisChat, EncryptionManager, loadOpenMlsWasm } from '@ermis-network/ermis-chat-sdk'`.
- Encryption-specific integrations may import from `@ermis-network/ermis-chat-sdk/encryption`, which exposes `E2eeClient`, `EncryptionManager`, `IndexedDBEncryptionStorage`, `loadOpenMlsWasm`, public encryption types, and friendly aliases `EncryptionApiClient` and `BrowserEncryptionStorage`.
- Deep imports from `@ermis-network/ermis-chat-sdk/src/*` are intentionally unsupported. The package publishes `dist/` and runtime assets from `public/`, not TypeScript source files.
- Apps using OpenMLS must publish `openmls_wasm_bg.wasm` with their web assets. The SDK package includes this binary under `public/openmls_wasm_bg.wasm`; `loadOpenMlsWasm('/openmls_wasm_bg.wasm')` loads the bundled JS glue and that public binary.

## Release Channels And NPM Tags

### Mechanism

Ermis keeps multiple SDK lines available when backend API contracts are different. The source branch, Git tag, npm version, and npm dist-tag each have a different job:

- Git branches hold ongoing source work for each SDK line.
- Git tags mark immutable source snapshots for released versions.
- NPM versions are immutable package artifacts; the same `name@version` cannot be published twice.
- NPM dist-tags are movable aliases that let consumers install the right SDK line without memorizing exact versions.

### Current Channels

Current public channels:

| Channel        | Source branch       | Purpose                                                                                       |
| -------------- | ------------------- | --------------------------------------------------------------------------------------------- |
| `latest`       | `feat/self-host`    | Default SDK line, currently the self-host/Bellboy SDK.                                        |
| `self-host`    | `feat/self-host`    | Explicit channel for the new self-host SDK line.                                              |
| `user-service` | `uhm-chat-dev-e2ee` | Legacy line for apps that still depend on the old `ermis_end_user` user-service API contract. |

### Install By Channel

Install the self-host line:

```bash
npm install @ermis-network/ermis-chat-sdk@self-host
npm install @ermis-network/ermis-chat-react@self-host
```

Install the user-service line:

```bash
npm install @ermis-network/ermis-chat-sdk@user-service
npm install @ermis-network/ermis-chat-react@user-service
```

Always install SDK and React from the same channel/version. Do not mix `@ermis-network/ermis-chat-sdk@self-host` with `@ermis-network/ermis-chat-react@user-service`, or the React package can call SDK APIs from a different backend contract.

### Publish By Channel

Publish the self-host line:

```bash
git switch feat/self-host
yarn bump
yarn publish:packages --tag self-host --yes
npm dist-tag add @ermis-network/ermis-chat-sdk@<version> latest
npm dist-tag add @ermis-network/ermis-chat-react@<version> latest
```

Publish the user-service line:

```bash
git switch uhm-chat-dev-e2ee
yarn bump
yarn publish:packages --tag user-service --yes
```

Do not point `latest` at the `user-service` line unless you intentionally want the legacy backend contract to become the default install target. If SDK publish succeeds but React publish fails, rerun `yarn publish:packages --tag <channel> --yes`; the publish script resumes by skipping package versions that already exist and continuing with the missing package.

## Client Configuration

<details>
<summary>Change log</summary>

- `2026-07-03`: Added `selfHosted` SDK config for Bellboy self-host deployments.
  - Reason: self-hosted Bellboy resolves tenant scope from the JWT/license instead of requiring frontend API key and project ID inputs.
  - Integrator action: use `ErmisChat.getInstance({ baseURL, selfHosted: true })` and `new ErmisAuthProvider({ baseURL, selfHosted: true })` for self-host; keep `apiKey` and `projectId` for cloud mode.
  - Compatibility/default: legacy positional constructors still work; when `selfHosted` is not true, `apiKey` and `projectId` remain required.

</details>

Cloud mode:

```ts
const client = ErmisChat.getInstance({
  apiKey: API_KEY,
  projectId: PROJECT_ID,
  baseURL: BASE_URL,
  selfHosted: false,
});
```

Self-host mode:

```ts
const client = ErmisChat.getInstance({
  baseURL: BASE_URL,
  selfHosted: true,
});
```

Self-host mode omits `api_key` from the WebSocket URL and does not require SDK callers to send `project_id` on normal project-scoped requests. After `connectUser()`, Bellboy returns the license project ID in `health.check`; the SDK stores it for local caches and E2EE deterministic channel helpers. Pass `projectId` in the self-host config only when the app must create project-scoped IDs before the first WebSocket health check.

## `ermis_end_user` v1 Auth And Users

<details>
<summary>Change log</summary>

- `2026-07-06`: Restored the USS `/uss/v1` prefix for SDK auth/profile calls.
  - Reason: the `ermis_end_user` backend contract keeps USS routes under `/uss/v1`.
  - Integrator action: set `userBaseURL`/auth `baseURL` to the root host, `/v1`, or `/uss/v1`; the SDK normalizes these inputs to `/uss/v1`.
  - Compatibility/default: bare `/v1` end-user inputs are mapped to `/uss/v1`; Bellboy chat/E2EE routes are unchanged.
- `2026-07-04`: Switched SDK auth/profile calls to targeted `ermis_end_user` v1 APIs.
  - Reason: v1 exposes targeted user lookup, batch lookup, search, profile update, avatar upload, and auth routes without unrestricted user enumeration.
  - Integrator action: use the targeted auth/users/profile methods instead of unrestricted listing or profile SSE.
  - Compatibility/default: `queryUsers`, `syncUserCache`, profile SSE, wallet auth, client-side `external_auth`, and `about_me` updates now throw explicit unsupported errors.
- `2026-07-04`: Added SDK-managed access-token refresh using v1 `refresh_token`.
  - Reason: `/auth/otp/verify` and other v1 auth responses can return short-lived access tokens plus refresh tokens.
  - Integrator action: persist `refresh_token`, pass it through `refreshToken`/`connectUser(..., refreshToken)`, and persist rotated tokens in `onTokenRefresh`.
  - Compatibility/default: without a refresh token, expired access-token requests keep returning the original auth error.

</details>

- AuthProvider routes are `POST /auth/otp/request`, `POST /auth/otp/verify`, `POST /auth/google`, and client `refreshNewToken()` calls `POST /auth/refresh`.
- Auth responses expose compatibility aliases: `success: true`, `token = access_token`, and top-level `user_id` when v1 returns it or when it can be read from the JWT payload.
- `ErmisChat` automatically calls `POST /auth/refresh` when authenticated HTTP requests return 401/token-expired responses, then retries the original request once. WebSocket reconnect also refreshes first when the server reports an expired token.
- Use `refreshToken: () => localStorage.getItem('refresh_token')` and `onTokenRefresh` to keep app storage in sync with rotated access/refresh tokens.
- User APIs call `/users/:id`, `/users/batch`, `/users/search`, `/users/me`, and `/users/me/avatar` with Bearer auth and without `project_id` query/body decoration.
- `searchUsers(query, limit)` is the preferred overload. The legacy `searchUsers(page, page_size, name)` overload maps to `q=name&limit=page_size` and ignores `page`.
- The SDK no longer preloads all users after `connectUser()`. Browser cache hydration remains local-only, and cache entries are refreshed by `queryUser`, `getBatchUsers`, `searchUsers`, message/member enrichment, `updateProfile`, and `uploadAvatar`.
- For external auth, exchange the external identity through a trusted backend calling `/uss/v1/auth/external`, then pass the returned `access_token` to `connectUser(user, access_token)`.

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

- `2026-06-19`: E2EE message hydration now preserves sender display names when local user cache only contains a bare user id.

  - Reason: freshly sent encrypted messages can otherwise replace the current user's name/email with the raw id in timelines and channel previews.
  - Integrator action: rebuild SDK/React clients so encrypted message state uses the richer user object already available on the client.
  - Compatibility/default: if no display name is available locally, clients keep the existing id fallback.

- `2026-06-19`: E2EE message hydration now resolves `quoted_message` from decrypted local state or IndexedDB when only `quoted_message_id` is present, including sticker quotes stored as `type: 'sticker'`.

  - Reason: quoted replies in encrypted channels must preview the replied-to plaintext without requiring Bellboy to decrypt or duplicate message bodies.
  - Integrator action: rebuild SDK/React clients so reply previews can hydrate from local encrypted-message cache.
  - Compatibility/default: if the quoted message is not available locally, clients keep the existing unavailable-message fallback.

- `2026-06-19`: Added `restoreProgressWithIssues` to `client.encryptionManager.getRecoveryStatus()`.
  - Reason: account-level PIN settings need channel-level unavailable-history diagnostics without showing permanent-gap warnings inside every channel.
  - Integrator action: prefer the new records when rendering global PIN/history diagnostics; keep `getRestoreProgress(channelType, channelId)` for selected-channel progress and repair flows.
  - Compatibility/default: existing `incompleteChannels` and `channelsWithPermanentGaps` arrays remain unchanged.

</details>

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
