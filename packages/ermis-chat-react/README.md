# @ermis-network/ermis-chat-react

The official React UI components for Ermis Chat.

## E2EE UI Support

- `CreateChannelModal` supports E2EE direct/group creation when `client.mlsManager` is initialized.
- Channel info actions can enable E2EE for an existing standard channel when the viewer is the owner and MLS is initialized.
- Channel message lists listen for `e2ee.message_decrypted` and refresh decrypted message content from the SDK MLS storage.
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

## Documentation

For full documentation, component references, and integration guides, please visit our official documentation website:

👉 **[Ermis Chat Documentation](https://ermisnetwork.github.io/ermis-chat-monorepo/)**
