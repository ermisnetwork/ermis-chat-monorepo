# @ermis-network/ermis-chat-sdk

The official core SDK for Ermis Chat.

## E2EE Channel Helpers

- `channel.removeMembersE2ee(members, e2eeOptions)` removes other members from an E2EE channel with an MLS commit and sends `self_remove: false`.
- `channel.leaveChannelE2ee(userId)` self-leaves an E2EE channel by sending `self_remove: true`; this path does not include an MLS commit from the leaving user.
- `client.mlsManager.setupRecoveryPin(pin)`, `unlockRecoveryVault(pin)`, and `changeRecoveryPin(oldPin, newPin)` manage the PIN recovery vault for epoch archive restore.
- `client.mlsManager.restoreHistoricalMessages(channelType, channelId, options)` restores accessible historical E2EE ciphertexts from account-owned epoch archives and returns explicit gap entries when archive material is missing.

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

## Documentation

For full documentation, API references, and integration guides, please visit our official documentation website:

👉 **[Ermis Chat Documentation](https://ermisnetwork.github.io/ermis-chat-monorepo/)**
