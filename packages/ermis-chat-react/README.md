# @ermis-network/ermis-chat-react

The official React UI components for Ermis Chat.

## E2EE UI Support

- `CreateChannelModal` supports E2EE direct/group creation when `client.encryptionManager` is initialized.
- `CreateChannelModal` accepts `e2eeRecoveryPolicy`, defaulting to `member_assisted`, and sends it with new E2EE direct/group creation payloads.
- Channel info actions can enable E2EE for an existing standard channel when the viewer is the owner and encryption is initialized; enable uses `member_assisted` recovery by default unless the caller has already set a policy in channel data.
- Channel message lists listen for `e2ee.message_decrypted` and refresh decrypted message content from the SDK encryption storage.
- Channel and topic-group previews listen for E2EE decrypted/local-cache refresh events so sidebar previews replace `Encrypted message` after plaintext is available.
- Quoted reply previews fall back to the active channel state when a message has `quoted_message_id` and no renderable embedded `quoted_message`; sticker quotes render as stickers before the encrypted/unavailable fallback is considered.
- Recovery PIN helpers expose vault state, unlocked PIN change, issue-bearing restore progress records, `repairEncryptedChannel()` for Channel Info repair, lower-level archive repair, selected-channel restore progress loading, and queue enqueueing for app-level PIN gates.
- `useRecoveryPin()` refreshes after encryption initialization and restore progress events, including apps that mount recovery UI before `client.encryptionManager` is attached.
- `CreateChannelModal` asks the SDK to archive the initial E2EE epoch after server channel creation succeeds, but does not fail channel creation if archive upload/stash is temporarily unavailable.
- Channel info add/remove member actions use encryption member commits for E2EE channels and never fall back to standard `removeMembers` while encryption is required. Self-leave calls `channel.leaveChannelE2ee`, sending `self_remove: true` so the remaining designated encryption member can commit the eviction.
- Consumers can customize E2EE toggle rendering through `E2eeToggleComponent` and receive E2EE status/key-rotation props in channel info cover/actions components.
- Custom Channel Info action components receive the current `channel`, allowing selected-timeline repair UI without relying on global active-channel state.

## Progress Log

### 2026-06-19 - E2EE Quoted Reply Preview

- Goal: render quoted reply UI for sent messages and avoid `Message unavailable` when the replied-to message is already decrypted locally.
- Code changed: `MessageItem` now resolves a missing or unrenderable `quoted_message` from active channel message sets/pinned messages, treats `type: 'sticker'` quote previews as renderable, and `useMessageSend` includes reply/edit state in the send callback dependencies. `QuotedMessagePreview` renders sticker/attachment previews before encrypted-unavailable fallback checks. `useScrollToMessage` now maps message IDs to rendered VList indexes that include date separators. `useChannelMessages` keeps full IndexedDB E2EE cache hydration for channel open/recovery paths but realtime events only overlay local cache entries for currently rendered message IDs and their quoted IDs, preventing older cached reply messages from being reinserted into the visible list during append. `VirtualMessageList` now reads live VList bottom metrics, snaps appended messages in a layout effect before paint, temporarily blocks scroll-triggered pagination while auto-following new messages, and disables browser scroll anchoring so reply sends/realtime receives do not briefly jump to the quoted message before returning to the newest message.
- Docs/artifacts changed: this README records the React UI behavior. SDK and UHM README files record the matching cache hydration and app-level fix. SQL, Postman, and Bellboy docs are unchanged because no server/API contract changed.
- Design decision: React keeps a synchronous render fallback for already-loaded timeline messages, while the SDK handles durable IndexedDB hydration for reload/sync paths. Full local-cache windows are reserved for explicit open/recovery flows; realtime append/update paths are visible-list overlays so local persisted history cannot reset the virtualized list anchor. Scroll-to-message must use VList's rendered child indexes, not raw message-array indexes, because date separators are also VList children. Realtime bottom-follow uses instant snaps, not smooth scrolling, and suppresses load-more during the snap window because transient VList scroll offsets can otherwise prepend older history and expose an older quoted-message anchor between renders.
- Performance: fallback lookup is `O(M)` per rendered item only when `quoted_message` is missing, rendered-index lookup is `O(M)` only on explicit quote/search jumps, realtime local-cache overlay is `O(V + Q)` for visible message IDs plus quoted IDs instead of loading a fixed 100-message IndexedDB window, and live bottom checks are `O(1)` reads from VList metrics; no network or backend work is added.
- Verification: `npm run build:sdk`, `npm run build:react`, `yarn workspace uhm-chat build`, and `yarn workspace @ermis-network/ermis-chat-sdk test:repair` passed. The latest scroll refinement was reverified with `npm run build:react` and a sequential `yarn workspace uhm-chat build`.

### 2026-06-17 - Encryption Naming API Cleanup

- Goal: align React package integration points with the SDK encryption naming cleanup.
- Code changed: React hooks/components now read `client.encryptionManager`, use encryption initialization naming, and expose Channel Info props as `encryptionInitialized` / `encryptionEpoch`.
- Docs/artifacts changed: this README records the rename boundary. Bellboy wire fields remain `mls_*`, so API docs, SQL, and Postman artifacts are unchanged.
- Design decision: UI package names should describe the product feature as encryption; OpenMLS remains an implementation detail below the SDK boundary.
- Performance: no runtime complexity, memory, storage, network, payload, or scaling behavior changes.
- Verification: `npm run build:react`, `yarn workspace uhm-chat build`, static forbidden-name checks, and Node SDK export smoke test passed. Targeted UHM ESLint was attempted but is blocked by existing app lint errors unrelated to this rename.

### 2026-06-17 - E2EE Topic Preview Refresh

- Goal: fix topic-enabled channel list previews staying on `Encrypted message` after a hidden topic message decrypts.
- Code changed: `useChannelRowUpdates()` and `useTopicGroupUpdates()` now listen for E2EE decrypted/local-cache refresh events and recompute row previews for the matching channel or topic group.
- Docs changed: E2EE UI support notes now mention channel/topic-group preview refresh behavior.
- Design decision: keep the fix in React render-state wiring; the SDK already merges successful decrypted messages into channel state before dispatching `e2ee.message_decrypted`.
- Verification: `npm run build:react` and `yarn workspace uhm-chat build` passed.

### 2026-06-16 - E2EE Recovery Policy Create Flow

- Goal: expose Bellboy recovery policy selection to React create-channel consumers.
- Code changed: `CreateChannelModalProps` now includes `e2eeRecoveryPolicy`, and `CreateChannelModal` sends `data.e2ee_recovery_policy` when creating E2EE direct/group channels.
- Code changed: Channel Info enable E2EE now passes the recovery policy to `EncryptionManager.enableE2ee()`, defaulting to `member_assisted`.
- Design decision: the default remains `member_assisted`; apps that need strict self-owned recovery can pass `self_owned_only` without changing the encryption bundle flow.
- Verification: `npm run build:react` passed.

### 2026-05-17 - Production

- Goal: fix E2EE self-leave from React channel actions so OpenMLS does not reject a self-removal commit.
- Code changed: `ChannelInfo.tsx` and `ChannelActions.tsx` now call `channel.leaveChannelE2ee(currentUserId)` for E2EE leave actions instead of `encryptionManager.evictMember(...)` or a plain `removeMembers(...)` call.
- Follow-up audit: E2EE remove-member actions now fail early if encryption is not initialized instead of falling back to standard `removeMembers`, and remove errors are rethrown to the confirmation/action caller.
- Docs changed: this README now distinguishes E2EE remove-member commits from self-leave with `self_remove=true`.
- Design decision: self-leave remains a channel membership update; the existing `member.removed` handler cleans local encryption state for the leaving user only after the server emits the removal event and lets a remaining designated member commit the encryption eviction with `selfLeft=true`.
- Verification: `./node_modules/.bin/tsc --noEmit -p packages/ermis-chat-react/tsconfig.json` and `yarn workspace @ermis-network/ermis-chat-react build` passed.
- Next step: browser retest the E2EE leave action with at least one remaining online designated evictor.

### 2026-05-29 - PIN Restore Local Sync

- Goal: refresh the visible message list immediately after PIN archive restore writes decrypted messages into SDK storage.

### 2026-06-01 - PIN Recovery Gate and Restore Progress

- Goal: expose production PIN recovery UX primitives for setup, unlock, incomplete restore prompts, and terminal gap display.
- Code changed: `useRecoveryPin()` now surfaces SDK recovery status and queue enqueueing, while `RecoveryGate` and `RecoveryRestoreProgress` provide dialog/progress rendering helpers.
- Design decision: the recovery gate is a non-blocking dialog. Permanent gaps render as recovery metadata and do not create fake timeline messages.
- Code changed: `useChannelMessages` now merges `event.messages` from `e2ee.local_messages_loaded` before reloading the encryption local cache.
- Verification: `yarn workspace @ermis-network/ermis-chat-react build` and `yarn workspace uhm-chat build` passed.

### 2026-06-01 - Restore Progress Event Wiring

- Goal: let consuming apps react to resumable PIN restore progress without polling.
- Code changed: `useRecoveryPin()` now subscribes to `e2ee.initialized` and `e2ee.restore_progress`, refreshes recovery status, and exposes `loadRestoreProgress(channelType, channelId)` for active-channel badges and gap banners.
- Verification: `npm run build:uhm` passed, including SDK, React package, and uhm-chat builds.

### 2026-06-19 - PIN Settings Restore Diagnostics

- Goal: let account-level PIN settings summarize unavailable history without showing permanent-gap warnings inside every channel.
- Code changed: `useRecoveryPin()` now carries SDK `restoreProgressWithIssues` records through `recoveryStatus` so apps can render channel-level diagnostics in one settings surface.
- Verification: `npm run build:sdk`, `npm run build:react`, `yarn workspace uhm-chat build`, and `yarn workspace @ermis-network/ermis-chat-sdk test:repair` passed.

### 2026-06-01 - Initial Archive and Gate Refresh Fixes

- Goal: close real-app gaps where recovery UI mounted before encryption init and new E2EE rooms could miss their first epoch archive.
- Code changed: `useRecoveryPin()` now retries status refresh while encryption initialization is still attaching the manager, and `CreateChannelModal` archives the current epoch immediately after the created E2EE channel is available.
- Design decision: archive upload still belongs to the SDK manager; React only triggers the post-create hook after the channel exists on the server.
- Verification: `npm run build:uhm` passed.

### 2026-06-01 - Non-blocking Initial Archive Hook

- Goal: keep E2EE room creation usable even if local deferred archive encryption or archive upload fails.
- Code changed: `CreateChannelModal` now fires the post-create initial archive hook as best-effort and logs failures without rejecting the channel creation flow.
- Verification: `npm run build:uhm` passed.

### 2026-06-13 - Account PIN and Channel Repair APIs

- Goal: let apps move PIN management to account settings and expose message-level encrypted-history repair in Channel Info.
- Code changed: `useRecoveryPin()` now exposes `changeUnlockedRecoveryPin()` and `repairRecoveryChannel()`, and reports `ready` only when the recovery vault is actually unlocked.
- Code changed: custom `ChannelInfoActions` receive the selected channel for correct topic/timeline repair.
- Design decision: locked vault UI must not expose change PIN; repair callers can choose failed-only retry or full selected-channel recheck.
- UX decision: consuming apps should normally present one Repair action. Uhm Chat uses full selected-channel recheck internally and keeps retry-mode terminology out of the user interface.
- UX decision: the repair card is conversation-oriented, uses a neutral secondary action, and expands result metrics plus remaining issue details inline from a detail row.
- Verification: `npm run build:react`, `yarn workspace uhm-chat build`, and targeted Uhm ESLint for the new PIN/repair components passed.

### 2026-06-13 - Encrypted State Repair Hook

- Goal: expose the SDK safe-cursor replay/reset repair API to React apps without forcing users to pick retry modes.
- Code changed: `useRecoveryPin()` now exposes `repairEncryptedChannel(channelType, channelId, { mode })` and returns the SDK result with `requiresPin`, `resetAvailable`, processed counts, and message repair summary.
- Design decision: apps should call replay from the primary Repair button. If `requiresPin` is true, open the PIN dialog and resume repair after unlock; if `resetAvailable` is true, show the advanced reset action with a warning.
- Verification: `npm run build:react` and `yarn workspace uhm-chat build` passed.

### 2026-06-14 - Archive-First Repair Semantics

- `repairEncryptedChannel()` keeps the same React contract, but the SDK now tries PIN archive recovery before protocol replay and only exposes reset after protocol replay failure.
- Missing archive material remains a normal unavailable-history result and must not show the reset warning.
- PIN unlock automatically rechecks accepted E2EE timelines once per unlock session.

### 2026-06-15 - Vault Revision and V2 Rollout

- `useRecoveryPin()` keeps the account PIN flow unchanged while the SDK enforces Bellboy vault revisions internally.
- Repair UI must remain compatible with V1 archive discovery until Bellboy completes manifest/recipient backfill; V2 availability is a transport/storage optimization and does not introduce a second user-facing repair mode.

## Documentation

For full documentation, component references, and integration guides, please visit our official documentation website:

👉 **[Ermis Chat Documentation](https://ermisnetwork.github.io/ermis-chat-monorepo/)**
