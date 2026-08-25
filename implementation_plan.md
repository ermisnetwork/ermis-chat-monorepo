# E2EE Upload Reload and Reply Media UX Plan

## Design Challenge Review

### Problem Statement

After a reload, large E2EE multipart uploads can appear frozen because encryption emits no progress before the first part upload, while quoted E2EE image/video manifests cannot produce the same compact decrypted thumbnail used by standard attachments.

### Alternatives Considered

#### Alternative A — Truthful streaming progress + dedicated quoted E2EE thumbnail

Emit a weighted, monotonic encryption/upload percentage from `encryptAndUploadE2eeAssetMultipart`, keeping the existing durable queue and IndexedDB schema unchanged. Add a small quoted-thumbnail child in `QuotedMessagePreview` that detects an E2EE manifest, decrypts only its `preview` asset through `useE2eeAttachmentRenderer`, and reuses the existing 36px quote thumbnail CSS.

```ts
onEncryptedFrame(plainLoaded) {
  emit({ phase: 'encrypting', percentage: plainLoaded / total * 35 });
}
onUploadedBytes(cipherLoaded) {
  emit({ phase: 'uploading', percentage: 35 + cipherLoaded / cipherTotal * 65 });
}
<E2eeQuotedThumbnail manifest={firstAttachment} />
```

#### Alternative B — Persist preview/encryption checkpoints in IndexedDB

Extend `PendingE2eeSendRecord` to persist the generated preview blob plus encryption/multipart checkpoints. Reload would resume from a richer checkpoint and quoted messages could materialize a standard thumbnail URL from the persisted preview.

```ts
pending = {
  ...pending,
  preview_blob,
  content_key,
  nonce_prefix,
  completed_parts,
};
await storage.savePendingE2eeSend(pending);
```

#### Alternative C — UI-only synthetic progress + reuse the full attachment renderer

Leave SDK upload progress unchanged and animate a synthetic percentage while status is `generating_preview` or `encrypting`. Render the existing full `E2eeAttachment` inside the quote and constrain it with CSS.

```ts
const shown = actual ?? syntheticTick(1, 30);
return <CompactBox><E2eeAttachment attachment={manifest} /></CompactBox>;
```

### Tradeoff Matrix

| Dimension | Alt A | Alt B | Alt C |
|---|---|---|---|
| Correctness | 🟢 Progress reflects real encrypted/uploaded bytes; preview decrypts from the signed manifest. | 🟡 True checkpointing is strongest, but key/nonce/part invariants add several corruption cases. | 🔴 Synthetic percentage is not tied to work and can reach a misleading value during a stall. |
| Failure Modes | 🟢 Failure remains isolated to one upload or one thumbnail; current retry path remains intact. | 🔴 A malformed checkpoint can make a pending send permanently unrecoverable or reuse cryptographic material incorrectly. | 🟡 Upload remains operational, but users still cannot distinguish slow work from a dead job. |
| Backward Compat | 🟢 No IndexedDB migration or public API change. | 🔴 Requires versioning/migration for existing `pending_sends` records. | 🟢 No storage or API contract changes. |
| Performance | 🟢 Constant-time counters per encrypted frame; quote downloads only the small preview asset and uses the existing LRU cache. | 🟡 Extra IndexedDB writes and large preview blobs increase reload/storage cost. | 🔴 Full attachment renderer can initialize original/stream state for every visible quote. |
| Complexity | 🟢 Small SDK progress change plus a focused memoized React child. | 🔴 Cross-cuts storage, crypto, upload retry, migration, and cleanup. | 🟡 Low code volume but couples quote layout to the full message renderer. |
| Rollout Risk | 🟢 Safe rollback; no persisted format changes. | 🔴 Rollback after new checkpoint records are written is unsafe without a compatibility window. | 🟡 Easy rollback, but the knowingly inaccurate progress is a UX liability. |
| Security | 🟢 Keeps plaintext preview only in memory/object-URL cache and uses existing grant/decrypt flow. | 🔴 Persists more sensitive plaintext/cryptographic checkpoint material locally. | 🟢 No new persisted sensitive data, though it may trigger unnecessary decrypts. |
| Testability | 🟢 Deterministic unit tests for monotonic progress and component tests for preview-only loading. | 🟡 Needs IndexedDB migration, reload, corruption, and crypto-reuse integration tests. | 🟡 Visual tests are easy, but correctness of synthetic progress cannot be asserted meaningfully. |

### Recommendation

Choose Alternative A. The observed 0% stall maps directly to `encryptAndUploadE2eeAssetMultipart`: it only calls `onProgress` from part PUT callbacks, so a 100 MB video can encrypt and fill a large first part without any visible update. Weighted real-byte progress fixes that root cause without changing Khoa’s whole-job reload mechanism or persisted schema. For replies, a dedicated preview-only child keeps quotes compact and avoids downloading/decrypting the original video.

> [!CAUTION]
> This does not turn E2EE reload into part-level resume. If the page reloads before a manifest/ciphertext is persisted, Khoa’s queue still restarts encryption/upload from the file stored in IndexedDB; it will now show truthful progress while doing so.

### When This Recommendation Is Wrong

- If product requirements change to true part-level resume across F5, Alternative B (with a versioned encrypted checkpoint design) becomes necessary.
- If the backend stops producing a `preview` asset for image/video manifests, the quote component must use a separately generated encrypted thumbnail contract or cautiously fall back to the original asset.
- If quote previews must work completely offline after cache eviction, an encrypted persistent preview cache is required instead of the current in-memory object-URL LRU.

### Verification Plan

- Unit-test multipart E2EE encryption with a part size larger than the file: progress must move during encryption before the first XHR starts and remain monotonic through upload.
- Reload-queue test with a large video `File`: restored optimistic UI must receive progress callbacks and end at 100 only after message send succeeds.
- React component test for standard image, standard video, E2EE image manifest, E2EE video manifest, missing preview, and decrypt failure.
- Assert quoted E2EE media requests only the `preview` asset and renders the existing `.ermis-quoted-message__thumb` 36px layout.
- Run SDK, React package, and Uhm Chat production builds plus attachment/recovery regression suites.


## Design Challenge Review ? True Multipart Resume

### Problem Statement

The durable E2EE queue survives F5 but creates a new attachment and uploads from byte zero because it does not persist the live multipart/crypto checkpoint.

### Alternatives Considered

#### Alternative A ? Versioned minimal checkpoint

Persist file fingerprint, init response, `upload_expires_at`, fixed key/nonce, completed ETags, and completion lease in `PendingE2eeSendRecord`. Reload deterministically re-encrypts/scans the file for hashes, but skips PUT for completed parts.

```ts
cp = validate(record.checkpoint, file, now) ?? await freshSession(file);
result = await encryptMultipart(file, {
  key: cp.key, nonce: cp.nonce, completedParts: cp.parts,
  onPart: (part) => persistSerialized(part),
});
await complete(cp.attachmentId, cp.leaseId, result.parts);
```

#### Alternative B ? Persist the encrypted blob

Encrypt once and store the complete ciphertext Blob plus hashes and ETags. Reload slices that Blob for missing PUTs, saving CPU but temporarily storing both the plaintext File and full ciphertext.

```ts
cp.encryptedBlob ??= await encryptWholeFile(file);
await persist(cp);
for (const part of missingParts(cp)) await put(cp.encryptedBlob.slice(part));
```

#### Alternative C ? Backend-owned resume

Add an authenticated endpoint to report completed parts and refresh expired URLs for an existing attachment. The frontend retains only file fingerprint/crypto seed while the server is authoritative for session state.

```ts
session = await api.resumeAttachment(attachmentId);
for (const part of session.missingParts) await encryptAndPut(file, crypto, part);
await api.completeAttachment(attachmentId, session.leaseId, allEtags);
```

### Tradeoff Matrix

| Dimension | Alt A | Alt B | Alt C |
|---|---|---|---|
| Correctness | ?? Fixed crypto reproduces ciphertext; strict validation fails closed. | ?? Exact persisted bytes make resume simple. | ?? Server resolves local/server divergence. |
| Failure Modes | ?? Corrupt/expired checkpoint must restart a fresh session once. | ?? Quota failure can strand large uploads. | ?? Version mismatch falls back to fresh upload. |
| Backward Compat | ?? Optional v1 fields; old records restart once. | ?? Large Blob fields burden custom adapters. | ?? Requires coordinated backend contract. |
| Performance | ?? Repeats CPU scan but saves uploaded network bytes. | ?? Low CPU, nearly doubles p99 disk usage. | ?? Best network/session behavior. |
| Complexity | ?? Types, manager, multipart helper, serialized storage. | ?? Adds quota and large-record cleanup. | ?? Cross-repo API/auth/rollout work. |
| Rollout Risk | ?? Feature-gated; rollback ignores optional fields. | ?? Rollback can leave large orphan records. | ?? Cannot ship frontend-only. |
| Security | ?? Key joins a record already holding plaintext File; never log/export it. | ?? Persists key and full ciphertext too. | ?? Server never receives content key. |
| Testability | ?? Deterministic F5/expiry/corruption tests. | ?? Easy slice tests plus quota tests. | ?? Requires server integration tests. |

### Recommendation

Choose **Alternative A**. It is the only frontend-only option that resumes multipart network bytes without duplicating the full file on disk.

Required invariants: checkpoint is optional/versioned; validate fingerprint, geometry, IDs and expiry; reuse key/nonce only for the same live session; serialize ETag writes; persist `completion_lease_id` before complete; discard crypto on expiry/corruption/new init; if complete rejects reconstructed parts, delete best-effort and restart fresh at most once.

> [!CAUTION]
> IndexedDB already stores the plaintext File. Persisting key/nonce does not add a new local trust boundary, but makes uploaded ciphertext decryptable from the same record; never copy checkpoint data to logs, events, localStorage, or sessionStorage.

> [!CAUTION]
> The backend cannot query incomplete part state or refresh the session. Local ETags are therefore the only resume evidence; mismatch at complete must fail closed instead of looping.

### When This Recommendation Is Wrong

- If a backend resume/status endpoint can ship now, Alternative C is stronger.
- If near-zero repeated CPU is mandatory and disk quota is guaranteed, Alternative B is faster.
- If a custom storage adapter cannot atomically persist nested checkpoint data, keep restart behavior for that adapter.
- If completion leases are not idempotent, response-loss retry needs backend clarification.

### Verification Plan


## Design Challenge Review — E2EE Resume Progress Floor

### Problem Statement

After F5, E2EE resume restores `local_progress`, which may include non-durable encryption and in-flight PUT bytes, so monotonic clamping hides all real resumed work until completion emits 99%.

### Alternatives Considered

#### Alternative A — Derive progress from durable completed parts

Ignore the old scalar `local_progress` when resuming an unfinished multipart upload. Calculate a truthful floor from the ciphertext bytes represented by persisted ETags, then let re-encryption and missing-part PUT callbacks advance from that floor.

```ts
const durableBytes = completedParts.sum(partCipherLength);
const uploadFraction = durableBytes / totalCipherSize;
const floor = mapMultipartToMessageProgress(uploadFraction * 65);
resumeProgress = floor;
```

#### Alternative B — Persist a separate durable progress field

Add `durable_progress` to each checkpoint and update it only after an ETag is successfully persisted. Reload uses that value while `local_progress` remains the live-session display value.

```ts
await saveCheckpoint({
  ...checkpoint,
  completed_parts,
  durable_progress: calculateDurableProgress(completed_parts),
});
```

#### Alternative C — Animate synthetic progress from the old percentage

Keep restoring `local_progress` and run a timer that slowly advances the displayed value until actual progress catches up.

```ts
shown = Math.max(restored, actual, syntheticTick(restored, 98));
```

### Tradeoff Matrix

| Dimension | Alt A | Alt B | Alt C |
|---|---|---|---|
| Correctness | 🟢 Derived only from persisted ETags and current multipart geometry. | 🟢 Correct if every ETag and derived scalar are written atomically. | 🔴 Can move while encryption or network is completely stalled. |
| Failure Modes | 🟢 Invalid geometry already fails closed into a fresh session. | 🟡 A stale scalar can disagree with `completed_parts`. | 🔴 Hides real stalls and still jumps when the timer ceiling is reached. |
| Backward Compat | 🟢 Works with existing v1 checkpoints without migration. | 🟡 Optional field is compatible, but old records need fallback logic. | 🟢 No storage/API change. |
| Performance | 🟢 O(number of parts) calculation once per restore. | 🟡 Same calculation plus a larger persisted record/write path. | 🟡 Adds timers and repeated UI updates for every pending upload. |
| Complexity | 🟢 One shared calculation used by queue restore and optimistic UI. | 🟡 Adds another persisted invariant and synchronization point. | 🟢 Small code change but difficult semantics. |
| Rollout Risk | 🟢 Rollback-safe; no schema or API change. | 🟡 Rollback ignores the optional field but leaves redundant data. | 🔴 Product behavior becomes knowingly inaccurate. |
| Security | 🟢 Reads existing metadata only; no new sensitive state. | 🟢 Stores only a number, with no new cryptographic exposure. | 🟢 No security boundary change. |
| Testability | 🟢 Deterministic tests can assert the exact restored floor and monotonic movement. | 🟢 Deterministic, plus storage consistency tests. | 🟡 Timer tests pass even when the real upload is broken. |

### Recommendation

Choose **Alternative A**. The source of truth is already `completed_parts`; deriving the resume floor removes the stale nondurable percentage without changing the checkpoint schema. The first re-encrypted frame will then move progress above that floor, while each missing PUT continues to represent real work.

> [!CAUTION]
> The percentage may be lower immediately after F5 than it was immediately before F5 because bytes from an unfinished part are not resumable. Preserving that higher number is exactly what causes the current frozen-then-99% behavior.

### When This Recommendation Is Wrong

- If product requires the displayed percentage never to decrease across reload even when work was not durable, Alternative C is the only visual option, but it would be synthetic.
- If multipart geometry can change while keeping the same attachment session, the backend must return a resume contract; local derivation would no longer be authoritative.
- If future checkpoint versions persist encrypted partial-frame state, Alternative B can expose a more precise durable percentage.

### Verification Plan

- Reproduce a record with `local_progress: 95` but only one completed part; restore must use the derived durable floor, not 95.
- Assert the first re-encryption callbacks increase progress before the next PUT completes.
- Assert progress remains monotonic within the resumed run and stays at 99% until the encrypted message send succeeds.
- Assert records without a valid checkpoint continue to restart at 0%.
- Run attachment resume tests, E2EE regression tests, typecheck, and SDK/React/Uhm builds.

### F5 State Mapping Amendment

The screenshot exposes a second state in the same root cause. Restore must map persisted state explicitly instead of trusting stale `local_progress`:

```ts
if (record.manifest?.length || record.mls_ciphertext) return 99;
if (hasValidCompletedParts(record)) return deriveDurableMultipartFloor(record);
return 0;
```

The `sending + mls_ciphertext` fast path must publish 99% to the optimistic message before retrying the final API call, because it currently completes without emitting any upload progress event.

## Design Challenge Review — Atomic Repair Presentation

### Problem Statement

`repairEncryptedChannel` publishes intermediate `message.updated`, `e2ee.post_join_sync`, and `e2ee.local_messages_loaded` batches, so `useChannelMessages` repeatedly rebuilds virtual rows before `e2ee.repair_completed` and the visible chat list flickers.

### Alternatives Considered

#### Alternative A — Preserve the VList and cover it until the final React commit

Emit scoped `e2ee.repair_started` and `e2ee.repair_failed` lifecycle events around the existing SDK repair lock. Keep the current virtual list mounted, show an opaque loading overlay, allow repair/cache work underneath, and remove the overlay only after `syncStoredE2eeMessages(true)` plus the final React/VList commit.

```ts
onRepairStarted(cid) => setRepairingCid(cid);
onRepairCompleted(cid) => {
  await syncStoredE2eeMessages(true);
  await nextPaint(2);
  setRepairingCid(null);
}
```

#### Alternative B — Unmount the list and rebuild it after repair

Replace `VirtualMessageList` with a loading screen on repair start, then mount a new VList when repair completes. This exactly matches a full rebuild, but destroys measured rows, scroll offset, focus, media state, and object identity.

```tsx
return repairing
  ? <RepairLoading />
  : <VList key={`${cid}:${repairGeneration}`}>{rows}</VList>;
```

#### Alternative C — Transactional SDK publication

Buffer all ChannelState mutations and UI events during repair, then atomically apply one final message array and dispatch one event. This removes intermediate React work, but must reconcile live WebSocket events, deletes, reactions, topic routing, and failed repair rollback inside the SDK.

```ts
const tx = beginChannelStateTransaction(scopeCid);
await repair({ publish: tx.buffer });
await tx.commitAtomically();
dispatch({ type: 'e2ee.repair_completed', cid });
```

### Tradeoff Matrix

| Dimension | Alt A | Alt B | Alt C |
|---|---|---|---|
| Correctness | 🟢 Existing ChannelState and storage continue updating; only presentation is gated. | 🟡 Final data is correct, but unmount loses local viewport/UI state. | 🟡 Atomicity is strongest only if realtime conflict handling is complete. |
| Failure Modes | 🟢 `repair_failed` removes the overlay and preserves the previous visible snapshot. | 🔴 A missing completion event can leave the chat area blank indefinitely. | 🔴 A transaction bug can drop live events or commit stale plaintext/tombstones. |
| Backward Compat | 🟢 Additive internal lifecycle events and optional UI state; no storage migration. | 🟢 No SDK storage change, but custom list components experience remounts. | 🟡 Changes when ChannelState/events become observable to SDK consumers. |
| Performance | 🟢 VList stays mounted; one final visible layout, with bounded overlay cost. | 🔴 Rebuilds and remeasures the full visible window plus media components. | 🟢 Lowest React churn, but buffers potentially large repair batches in memory. |
| Complexity | 🟢 Small SDK lifecycle wrapper plus React hook/context/overlay wiring. | 🟢 Smallest implementation, but creates follow-up scroll and media bugs. | 🔴 Cross-cuts sync, repair, ChannelState, realtime events, and rollback. |
| Rollout Risk | 🟢 Rollback-safe and can be scoped only to the active repaired CID. | 🟡 Easy rollback, but visible regression for scroll/focus is likely. | 🔴 High-blast-radius behavior change for every repair path. |
| Security | 🟢 No plaintext persistence or cryptographic behavior changes. | 🟢 No cryptographic change. | 🟡 Buffered decrypted content lives longer in memory and needs strict cleanup. |
| Testability | 🟢 Deterministic lifecycle, failure, active-CID, and final-commit tests. | 🟢 Easy visual test, but preserving user state is difficult. | 🟡 Requires concurrent repair/realtime/delete/reaction integration tests. |

### Recommendation

Choose **Alternative A**. It fixes the visible flicker while preserving scroll, virtualization measurements, focus, and media state. The SDK should always pair `e2ee.repair_started` with either `e2ee.repair_completed` or `e2ee.repair_failed`; the React hook should keep the overlay until its final cache merge has committed, not merely until the SDK promise resolves.

> [!CAUTION]
> Do not clear `messages` or change the VList `key` during repair. That recreates the message tree and reintroduces the scroll-floating and media remount bugs already seen in this thread.

> [!CAUTION]
> The overlay must be scoped by requested `cid`, not only `scope_cid`, otherwise repairing a parent MLS scope can block unrelated visible topic lists.

### When This Recommendation Is Wrong

- If product requires zero hidden React work during repair for extremely large histories, Alternative C is the long-term solution after realtime conflict semantics are specified.
- If preserving scroll, media playback, focus, and optimistic messages is explicitly unnecessary, Alternative B is simpler.
- If repair can run without an active channel/UI, lifecycle events must remain no-op for inactive CIDs.

### Verification Plan

- SDK test: success emits exactly `repair_started` then `repair_completed`; failure emits `repair_started` then `repair_failed` with the same requested CID.
- React hook test: intermediate `post_join_sync` batches do not remove the overlay; the overlay clears only after the final stored-message sync commits.
- Visual test: VList DOM identity and scroll offset remain stable while repairing 100+ messages.
- Realtime test: a new message and a delete arriving during repair are present after the overlay clears.
- Channel-scope test: repairing one CID does not cover another active channel/topic.
- Run SDK/React tests, typecheck, and production builds for SDK, React, and Uhm Chat.

## Design Challenge Review ? Late-subscriber E2EE Upload Progress Replay

### Problem Statement

After a page reload, `EncryptionManager.initialize()` restores and resumes durable E2EE
attachment jobs before the channel list and active message UI have mounted. Upload progress
continues in the background, but `message.updated` is an ephemeral event. A React subscriber
that mounts after those events can retain the original restored 0% snapshot until the final
message suddenly replaces it.

The upload pipeline and ciphertext are not stalled. The missing contract is presentation
rehydration after `queryChannels()` has finished mutating `ChannelState`. Product requires the
post-reload display to start at the last locally persisted percentage, not reset to the lower
durable multipart checkpoint. That percentage is a presentation floor only: an unfinished
multipart part still restarts from its durable boundary and the displayed value waits there
until real transfer progress catches up.

### Alternatives Considered

#### Alternative A ? Idempotent presentation-only replay after channel hydration

Extend the existing `channels.queried` listener to list durable pending E2EE sends and restore
their optimistic presentation into the hydrated channel without scheduling or restarting an
upload job. Make `Channel.restorePendingE2eeAttachmentUpload()` idempotent: reuse existing
local attachment URLs, preserve the maximum live percentage already in `ChannelState`, apply
the last persisted display percentage when state was rebuilt, and dispatch one fresh
`message.updated` for late subscribers. Keep that display percentage separate from the
durable multipart checkpoint used to choose which encrypted bytes/parts must actually be
uploaded again.

```ts
on('channels.queried', async () => {
  await bootstrapKnownE2eeChannels();
  await restorePendingE2eeAttachmentPresentations();
});
```

#### Alternative B ? Delay E2EE resume until the channel UI is ready

Move `resumePendingE2eeSends()` out of initialization and start it only after the first
`channels.queried` or active-channel mount. This guarantees that the first progress listener
exists, but makes delivery correctness depend on a particular React screen lifecycle.

```ts
on('channels.queried', () => resumePendingE2eeSends());
```

#### Alternative C ? Poll pending upload records from React

Have the active message list periodically read IndexedDB and merge `local_progress` into the
optimistic message. This can recover from missed events without SDK lifecycle changes, but
turns storage into a realtime UI API and can surface stale, non-durable percentages.

```ts
setInterval(() => syncPendingUploadProgressFromStorage(cid), 250);
```

### Tradeoff Matrix

| Dimension | Alt A | Alt B | Alt C |
|---|---|---|---|
| Correctness | High: upload ownership stays in the SDK; replay only repairs presentation. | Medium: correct only when channel query/UI lifecycle occurs. | Medium: persistence lag and stale `local_progress` can make the display lie. |
| Failure Modes | A failed replay leaves the background upload unchanged and the next progress/final event still works. | Headless consumers or an unopened list can leave uploads paused indefinitely. | Timer leaks, tab throttling, storage errors, and stale-session progress. |
| Backward Compatibility | Additive private SDK behavior; no API, event shape, or storage-schema change. | Changes when pending sends resume for every SDK consumer. | Couples React to SDK storage internals and pending-record schema. |
| Performance | One bounded storage read after query and one event per pending message. | Lowest duplicate work, but delays useful network work. | Repeated IndexedDB reads and React merges throughout every upload. |
| Complexity | Small manager/channel change using existing lifecycle and restore helpers. | Small code diff but introduces cross-layer lifecycle coupling. | Adds timers, cleanup, visibility handling, and cache reconciliation. |
| Migration / Rollout | No migration; rollback only removes the replay hook. | Requires documenting a new resume trigger for non-React clients. | Requires exposing or duplicating internal storage access. |
| Security | Does not touch file bytes, MLS ciphertext, keys, or encryption ordering. | Delays encryption/delivery but does not change cryptography. | Broadens decrypted/local upload metadata access into the UI layer. |
| Testability | Deterministic late-subscriber, idempotency, multi-file, and no-restart tests. | Requires lifecycle integration tests for every client surface. | Timer/storage races make deterministic testing harder. |

### Recommendation

Choose **Alternative A**. Keep `resumePendingE2eeSends()` eager and independent of the UI,
then replay only the optimistic presentation after channel hydration. The replay must never
call `_processQueuedE2eeAttachmentMessage()` and must not add an entry to
`_resumePendingE2eeSendRequests`.

`restorePendingE2eeAttachmentUpload()` must preserve monotonic progress with:

```ts
displayedProgress = Math.max(
  existingAttachment.upload_progress ?? 0,
  resolvePendingE2eeAttachmentDisplayProgress(record, index),
  resolvePendingE2eeAttachmentRestoreProgress(record, index),
);
```

It must reuse the existing `_pendingE2eeAttachmentSends` entry so repeated
`channels.queried` events do not allocate duplicate object URLs.

Because optimistic E2EE state is already applied before notification, its local events must
notify channel/client listeners without re-entering `_handleChannelEvent`. Reprocessing an
older asynchronous `message.new` can otherwise overwrite a newer progress snapshot with 0%.

> [!CAUTION]
> Persisted local progress may be used only as a monotonic presentation floor. It must never
> mark an unfinished multipart part complete, skip encryption/upload work, or drive the resume
> byte offset. Completed multipart checkpoints, an uploaded manifest, or persisted MLS
> ciphertext remain the only durable transfer evidence.

> [!CAUTION]
> Do not solve this by calling `resumePendingE2eeSends()` from React. When a job is already
> active, that method intentionally records another resume request and can cause redundant
> processing after the current attempt exits.

### When This Recommendation Is Wrong

- If the SDK later exposes a replayable observable/store as the sole message-state source,
  the channel-hydration replay should move into that store.
- If channel hydration stops mutating or replacing optimistic state, a direct initial
  `ChannelState` snapshot may become sufficient.
- If upload continuation is intentionally tied to an active foreground screen, Alternative B
  is simpler, but that would be a product-level delivery-policy change.

### Verification Plan

- SDK test: progress events emitted before `channels.queried` are replayed afterward with the
  last locally persisted monotonic percentage visible to a late subscriber.
- SDK test: if F5 occurs mid-part at 47%, the UI restores 47% while the transfer restarts only
  the unfinished part; values below 47% are suppressed and values above 47% continue normally.
- SDK test: persisted display progress never causes a multipart part, attachment completion,
  encryption phase, or final message send to be skipped.
- SDK test: presentation replay does not call the queued upload processor, create another
  network request, or add a resume request.
- SDK test: repeated `channels.queried` events reuse local attachment object URLs and do not
  duplicate the optimistic message.
- SDK test: a rebuilt channel falls back to the truthful durable multipart floor (0, weighted
  completed parts, or 99 for manifest/ciphertext).
- SDK test: multi-file progress remains scoped to the correct attachment index.
- Regression test: normal non-E2EE upload behavior is unchanged.
- Run targeted SDK tests, SDK typecheck/build, React tests/typecheck/build, and the Uhm Chat
  production build.

## Design Challenge Review ? Smooth E2EE Progress After F5

### Problem Statement

After F5, E2EE restores the last displayed percentage but can remain there because the SDK
waits for restarted encryption to catch up and React asynchronously reloads IndexedDB for every
progress event, allowing an older percentage to overwrite a newer one.

### Alternatives Considered

#### Alternative A ? Attempt-relative SDK progress plus synchronous optimistic React merge

Capture the restored percentage once as the display floor for the resumed attempt. Map fresh
physical progress across the remaining range to 99%, while keeping transfer checkpoints and
cryptographic work unchanged. In React, merge pending upload events synchronously and
monotonically; cache reads remain for durable/decrypted messages, not per-percent updates.

```ts
floor = restoredDisplayProgress;
display = max(previous, floor + raw / 99 * (99 - floor));
if (isPendingUpload(event.message)) {
  mergeOptimisticMessage(event.message, { monotonicProgress: true });
  return;
}
```

#### Alternative B ? React fast path only, retain SDK catch-up plateau

Bypass IndexedDB for optimistic progress and add a per-message request generation guard for
other cache reads. This fixes stale React overwrites, but 19% can still remain unchanged while
E2EE regenerates ciphertext from byte zero before raw progress passes the restored floor.

```ts
if (isPendingUpload(message)) mergeSynchronously(message);
else syncCache({ messageId, generation: nextGeneration(messageId) });
```

#### Alternative C ? Persist resumable encryption/hash state

Persist frame offset, partial multipart bytes, and hash/encryption continuation state so the
crypto pipeline resumes at exactly the previous byte. This makes percentage byte-accurate but
requires serializable hash state, secure partial ciphertext storage, versioning, and migration.

```ts
checkpoint = { frameOffset, sha256State, bufferedCiphertext };
resumeEncryption(checkpoint);
```

### Tradeoff Matrix

| Dimension | Alt A | Alt B | Alt C |
|---|---|---|---|
| Correctness | High: UI is monotonic and 99 remains gated by attachment completion; upload checkpoints are unchanged. | Medium: event ordering is fixed but visible progress may still plateau. | Medium: exact only if every crypto/hash/buffer state restores atomically. |
| Failure Modes | A bad display formula affects only UX; delivery and ciphertext still follow existing code. | Users continue reporting a frozen percentage on large E2EE files. | Corrupt/incompatible checkpoints can invalidate ciphertext or force complex rollback. |
| Backward Compatibility | Additive internal behavior with no API or storage migration. | Additive React-only behavior. | Requires checkpoint version changes and old-record fallback. |
| Performance | Removes IndexedDB reads from the per-percent hot path and adds constant-time arithmetic. | Removes hot-path reads; SDK still re-encrypts from zero. | Can reduce repeated encryption but adds large local writes and restore cost. |
| Complexity | Small bounded changes in the existing manager and message hook. | Smallest change but does not meet the smooth-progress requirement. | Cross-cuts crypto provider, hashing, storage, migration, and cleanup. |
| Rollout Risk | Low: revertable presentation behavior; normal chat is untouched. | Low, but incomplete product outcome. | High because persisted E2EE data format and recovery semantics change. |
| Security | No key, nonce, ciphertext, or upload-offset changes. | No cryptographic changes. | Persists additional sensitive intermediate encryption material. |
| Testability | Deterministic raw-to-display mapping and out-of-order cache tests. | Easy ordering tests, but plateau remains expected. | Requires reload integration tests across every frame/part boundary. |

### Recommendation

Choose **Alternative A**. It matches the smooth behavior users see in standard chat without
pretending that unfinished multipart bytes are durable: the number represents progress of the
current resume attempt over the remaining UI range, while completed-part checkpoints remain
the sole authority for network work.

The restored floor must be captured once per file. Reusing the latest emitted value as the
floor on every callback would compound the formula and jump to 99 too early. React must merge
attachment percentages using `Math.max(current, incoming)` and must not query IndexedDB for
pending local upload progress.

> [!CAUTION]
> `99%` must remain the ceiling until attachment complete and final message sending begins;
> rebasing must never emit 100 or skip `completeAttachment`, MLS encryption, or message send.

> [!CAUTION]
> The optimistic fast path must be limited to local pending attachments with numeric
> `upload_progress`; deletes, edits, reactions, and received E2EE messages still require the
> existing decrypted-cache reconciliation.

### When This Recommendation Is Wrong

- If product requires percentage to mean only server-durable bytes, choose Alternative B and
  show a separate ?resuming/encrypting? state during the plateau.
- If avoiding repeated client-side encryption after F5 is a hard performance requirement,
  Alternative C needs a separate cryptographic checkpoint design and security review.
- If pending upload messages become durable message-cache entries, the React fast path must
  reconcile their cache schema explicitly instead of bypassing it.

### Verification Plan

- SDK unit test: floor 19 with raw `[0, 5, 10, 20, 99]` produces a strictly monotonic sequence
  above 19 and reaches 99 only at raw 99.
- SDK unit test: floor 0 preserves existing fresh-upload percentages unchanged.
- SDK resume test: completed multipart parts are still skipped and no new init session is made.
- React race test: resolve cache promises in reverse order after events 19, 20, 21; UI remains
  21 and pending progress does not call IndexedDB.
- React test: received edits/deletes/reactions still use cache reconciliation.
- Regression test: standard non-E2EE upload behavior is unchanged.
- Run SDK attachment suites, SDK typecheck/build, React build/tests, and Uhm Chat production
  build.
