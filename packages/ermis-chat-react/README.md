# @ermis-network/ermis-chat-react

The official React UI components for Ermis Chat.

## E2EE UI Support

- `CreateChannelModal` supports E2EE direct/group creation when `client.mlsManager` is initialized.
- Channel info actions can enable E2EE for an existing standard channel when the viewer is the owner and MLS is initialized.
- Channel message lists listen for `e2ee.message_decrypted` and refresh decrypted message content from the SDK MLS storage.
- Recovery PIN helpers expose recovery status, per-channel restore progress loading, and queue enqueueing for app-level PIN gates.
- `useRecoveryPin()` refreshes after MLS initialization and restore progress events, including apps that mount recovery UI before `client.mlsManager` is attached.
- `CreateChannelModal` asks the SDK to archive the initial E2EE epoch after server channel creation succeeds, but does not fail channel creation if archive upload/stash is temporarily unavailable.
- Channel info add/remove member actions use MLS member commits for E2EE channels and never fall back to standard `removeMembers` while MLS is required. Self-leave calls `channel.leaveChannelE2ee`, sending `self_remove: true` so the remaining designated MLS member can commit the eviction.
- Consumers can customize E2EE toggle rendering through `E2eeToggleComponent` and receive E2EE status/key-rotation props in channel info cover/actions components.

## Progress Log

### 2026-05-17 - Production

- Goal: fix E2EE self-leave from React channel actions so OpenMLS does not reject a self-removal commit.
- Code changed: `ChannelInfo.tsx` and `ChannelActions.tsx` now call `channel.leaveChannelE2ee(currentUserId)` for E2EE leave actions instead of `mlsManager.evictMember(...)` or a plain `removeMembers(...)` call.
- Follow-up audit: E2EE remove-member actions now fail early if MLS is not initialized instead of falling back to standard `removeMembers`, and remove errors are rethrown to the confirmation/action caller.
- Docs changed: this README now distinguishes E2EE remove-member commits from self-leave with `self_remove=true`.
- Design decision: self-leave remains a channel membership update; the existing `member.removed` handler cleans local MLS state for the leaving user only after the server emits the removal event and lets a remaining designated member commit the MLS eviction with `selfLeft=true`.
- Verification: `./node_modules/.bin/tsc --noEmit -p packages/ermis-chat-react/tsconfig.json` and `yarn workspace @ermis-network/ermis-chat-react build` passed.
- Next step: browser retest the E2EE leave action with at least one remaining online designated evictor.

### 2026-05-29 - PIN Restore Local Sync

- Goal: refresh the visible message list immediately after PIN archive restore writes decrypted messages into SDK storage.

### 2026-06-01 - PIN Recovery Gate and Restore Progress

- Goal: expose production PIN recovery UX primitives for setup, unlock, incomplete restore prompts, and terminal gap display.
- Code changed: `useRecoveryPin()` now surfaces SDK recovery status and queue enqueueing, while `RecoveryGate` and `RecoveryRestoreProgress` provide dialog/progress rendering helpers.
- Design decision: the recovery gate is a non-blocking dialog. Permanent gaps render as recovery metadata and do not create fake timeline messages.
- Code changed: `useChannelMessages` now merges `event.messages` from `e2ee.local_messages_loaded` before reloading the MLS local cache.
- Verification: `yarn workspace @ermis-network/ermis-chat-react build` and `yarn workspace uhm-chat build` passed.

### 2026-06-01 - Restore Progress Event Wiring

- Goal: let consuming apps react to resumable PIN restore progress without polling.
- Code changed: `useRecoveryPin()` now subscribes to `e2ee.initialized` and `e2ee.restore_progress`, refreshes recovery status, and exposes `loadRestoreProgress(channelType, channelId)` for active-channel badges and gap banners.
- Verification: `npm run build:uhm` passed, including SDK, React package, and uhm-chat builds.

### 2026-06-01 - Initial Archive and Gate Refresh Fixes

- Goal: close real-app gaps where recovery UI mounted before MLS init and new E2EE rooms could miss their first epoch archive.
- Code changed: `useRecoveryPin()` now retries status refresh while MLS initialization is still attaching the manager, and `CreateChannelModal` archives the current epoch immediately after the created E2EE channel is available.
- Design decision: archive upload still belongs to the SDK manager; React only triggers the post-create hook after the channel exists on the server.
- Verification: `npm run build:uhm` passed.

### 2026-06-01 - Non-blocking Initial Archive Hook

- Goal: keep E2EE room creation usable even if local deferred archive encryption or archive upload fails.
- Code changed: `CreateChannelModal` now fires the post-create initial archive hook as best-effort and logs failures without rejecting the channel creation flow.
- Verification: `npm run build:uhm` passed.

## Documentation

For full documentation, component references, and integration guides, please visit our official documentation website:

👉 **[Ermis Chat Documentation](https://ermisnetwork.github.io/ermis-chat-monorepo/)**
