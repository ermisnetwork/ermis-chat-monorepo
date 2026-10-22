# Web SDK and UHM MLS upgrade runbook

Tài liệu này chỉ dành cho repository **`ermis-chat-monorepo`**, gồm
`packages/ermis-chat-sdk`, React package và `apps/uhm-chat`. Owner repo này
nhận OpenMLS WASM đã qualify, build/publish client và chứng minh browser dùng
đúng artifact. Không migrate Bellboy database và không build iOS XCFramework.

Contract server/canonical plan nằm trong
[bundle Bellboy](../bellboy/docs/todo/e2ee_mls_group_rebootstrap_plan.md);
artifact producer dùng
[OpenMLS handoff](../openmls/MLS_UPGRADE_HANDOFF.md).

## 0. Inputs và no-go

Cần có:

- reviewed monorepo snapshot, lockfile và release/version plan;
- Bellboy schema/server capability đã deploy ở compatibility phase, automatic
  rebootstrap chưa bật;
- OpenMLS four-file WASM set cùng source/lock/toolchain/hash manifest;
- TEST URLs/config đã redact, approved accounts/channels và rollback owner.

```bash
git branch --show-current
git rev-parse HEAD
git status --porcelain=v1
git diff --binary | shasum -a 256
git ls-files --others --exclude-standard
shasum -a 256 yarn.lock package.json packages/ermis-chat-sdk/package.json
```

**No-go:** WASM provenance không khớp source contract; SDK và React khác version;
Bellboy thiếu discovery/generation capability; UHM load artifact khác file đã
hash; tests chỉ mock binding; hoặc không có version-skew/rollback test.

**Known source snapshot 2026-09-15:** sibling OpenMLS HEAD là
`d5746f58e907ed3ddee01761656da7ce08de365c`, trong khi
`packages/ermis-chat-sdk/package.json.openmlsBuild.commit` và UHM provenance
đang ghi `ea2310f46d716e29e28422c18b310dba06515267` (UHM manifest còn ghi
`openmls_dirty=true`). Đây không phải release-reproducible match. Release
owner phải chọn reviewed source/artifact baseline và regenerate/re-pin có
provenance; reverify vì snapshot này có thể thay đổi.

## 1. Nhận và verify WASM

Repo có **hai distribution boundary**:

1. SDK publishable artifact:
   `packages/ermis-chat-sdk/src/encryption/wasm` và
   `packages/ermis-chat-sdk/public/openmls_wasm_bg.wasm`.
2. UHM internal artifact:
   `apps/uhm-chat/public/openmls_wasm.{js,d.ts}`,
   `openmls_wasm_bg.wasm` và `openmls_wasm_bg.wasm.d.ts`.

Không copy SDK WASM thay UHM set hoặc ngược lại. Cả JS glue, declarations và
WASM phải cùng một build.

`scripts/build-openmls-wasm.mjs` verify pinned commit/toolchain/lock/hash,
apply release patches vào sibling OpenMLS rồi copy SDK artifact. Nó có mutation
trong OpenMLS checkout; chỉ chạy trong checkout sạch, cô lập đúng manifest,
không chạy trên user-owned dirty tree. Nếu `openmlsBuild.commit` khác source
được bàn giao, dừng và tạo/review release manifest/patch set mới; không sửa hash
để bypass validation.

`npm run build:uhm-wasm` build UHM internal artifact và tạo
`apps/uhm-chat/public/openmls_wasm_build.json`. `ALLOW_DIRTY_OPENMLS=1`
chỉ dùng local validation; artifact đó không được promote lên môi trường chung.

Sau khi nhận artifact, ghi:

```bash
shasum -a 256 \
  packages/ermis-chat-sdk/public/openmls_wasm_bg.wasm \
  apps/uhm-chat/public/openmls_wasm_bg.wasm
node --test apps/uhm-chat/test/openmls_contract.test.mjs
```

Runtime contract phải có explicit GroupId/generation, typed Welcome,
trusted historical time và archive APIs mà từng distribution công bố.

## 2. Build và test Web SDK

```bash
yarn workspace @ermis-network/ermis-chat-sdk types
npm run build:sdk
yarn workspace @ermis-network/ermis-chat-sdk test:repair
yarn workspace @ermis-network/ermis-chat-sdk test:rebootstrap
yarn workspace @ermis-network/ermis-chat-sdk test:rollout
```

Ghi exact pass/fail/skip counts. Test phải dùng generated WASM được publish,
không thay bằng source-only/mock proof. Kiểm tra package `dist`, public WASM,
declarations và version cùng nằm trong release manifest.

Startup owner là `Client.performSync()`. Acceptance không pagination:

- một logical `scope_sync` cho event/cursor;
- sau page cuối, một `POST /v1/e2ee/mls/recovery/discover` cho tối đa 200
  unique active E2EE CIDs;
- 201 CIDs tạo hai deterministic chunks; 0 CIDs không gửi empty discovery;
- zero per-CID generation/refresh GET fan-out;
- duplicate `channels.queried`, render, typing, send retry và concurrent
  manual sync không tạo startup lần hai;
- deadline retry dùng one-CID discovery; claim/complete/receipt vẫn per-CID.

`scope_sync has_more` phải page đầy đủ trước discovery. CIDs không terminal
hoặc cursor lagged mới được bounded catch-up; không tối ưu request count bằng
cách bỏ event correctness.

## 3. Build và test UHM

UHM phải dùng cùng SDK/React release và internal WASM đã verify:

```bash
npm run build:react
npm run build:uhm
node --test apps/uhm-chat/test/openmls_contract.test.mjs
node --test apps/uhm-chat/test/mls_rebootstrap_load.test.mjs
```

Ở browser TEST, bật Network `Disable cache`, reload một lần và lưu evidence:

- hash/size của `openmls_wasm_bg.wasm` response khớp manifest;
- request count startup đúng contract trên;
- discovery response/state được apply trước Welcome/external join/rebootstrap;
- valid GI + missing local group đi normal external join;
- missing/stale/invalid GI đi repair; không generic sync/Welcome failure nào mở
  external join hoặc rebootstrap;
- ready chỉ khi current-generation local group usable;
- old-generation ciphertext/pending send không được replay vào group mới.

UHM chỉ render typed state: syncing, waiting repair, preparing, recovered,
history incomplete, infrastructure retry và server/client upgrade required.
Thiếu archive không chặn chat mới nhưng không được hứa complete history.

## 4. Version skew và release order

Canary:

1. old Web client + new Bellboy trên generation 0 vẫn hoạt động;
2. new Web + old Bellboy cache discovery unsupported một lần/session, không
   fan-out N generation/refresh calls; nếu cần rebootstrap thì
   `incompatible_server_client`, non-retryable;
3. old Web trên CID đã reset nhận `upgrade_required`;
4. ambiguous complete ACK reconcile bằng receipt;
5. app restart/current generation discovery vẫn hoạt động khi reset event hết
   retention;
6. Welcome đúng device ưu tiên, `NoMatchingKeyPackage` giữ typed fallback
   riêng và failed secret-consuming private commit không retry.

Chỉ deploy Web/UHM sau Bellboy compatibility capability, trước khi backend bật
automatic claim/activation.

## 5. Cost, rollback và evidence

Network startup là `O(scope pages + ceil(N/200))`; request/payload memory
`O(N)`, N tối đa 200/chunk. Provider/tree/Welcome memory là `O(M+K)` theo
members/recipients. Với 100 members, 200 offline recipients và device 201,
ghi request counts, bytes, p95/p99, scheduled-late/dropped work, peak RSS/copies
và unrelated traffic ratio `during / baseline <= 1.10`.

Rollback trước generation activation bằng cách rollback SDK/UHM release hoặc
tắt client adoption, giữ generation-0 flow. Sau khi CID đã reset, không phục
hồi client/artifact không hiểu generation; ship fix forward. Không xóa
IndexedDB provider/cursor/archive để che lỗi và không resend ciphertext cũ.

| Evidence | Nội dung |
|---|---|
| Source | Commit/diff/lock hashes, SDK+React version |
| Artifact | SDK và UHM WASM four-file provenance/hash/size |
| Build/test | Exact commands và pass/fail/skip |
| Runtime | Loaded WASM hash, startup request counts, typed UI/readiness |
| Compatibility | Old/new client-server matrix và receipt/restart |
| Rollback | Build ID trước/sau, trigger, state-preservation proof |

<details>
<summary>Change log</summary>

- `2026-09-15`: Added repository-owned Web SDK/UHM MLS upgrade instructions.
  - Reason: Web artifact adoption and browser behavior cannot be proved by Bellboy or OpenMLS docs.
  - Integrator action: Web owner verifies two WASM boundaries, builds SDK/UHM and runs runtime/version-skew gates.
  - Compatibility/default: documentation only; no WASM/package/runtime setting changed.

</details>

## 2026-10-03 shared repair ACK correction

Production IndexedDB deletion now lets an epoch-bearing ACK clear only epoch-covered obligations, including matching IDs. Request-only cancellation and per-CID/account isolation stay compatible. Actual SDK store regression uses test-only fake-indexeddb and verifies same-ID epoch7->9, ACK8 retain across DB reopen, ACK9 clear and cancellation/CID isolation. Rebuilt bundles/declarations and repair suites pass **53/0/4**; the four skipped external-distribution checks are retained. [Exact evidence/commands/artifact identity](../bellboy/docs/evidence/local_main_plan/20261003-android-coordinator/README.md), [shared canonical journal](../bellboy/docs/todo/e2ee_mls_group_rebootstrap_plan.md#2026-10-03--shared-ack-fence-verified). Whole-workspace dependency addition hit existing espree hoisting invariant; narrow manifest/lock entry uses the fetched verified cache, while fresh workspace installation remains unverified. Native WASM is unchanged; no flag/schema/route change or environment deployment.


## 2026-10-05 — Persisted pending-send epoch recovery (local acceptance pending)

Canonical history remains the [shared parity plan](../bellboy/docs/todo/e2ee_mls_android_parity_plan.md),
A-004/A-007/CLIENT-005. [Final evidence](../bellboy/docs/evidence/local_main_plan/20261004-three-platform-field/pending-send-recovery-provenance.json)
binds source/build hashes. Login/reconnect resume of stored ciphertext now handles
definitive epoch_stale with existing sync/recovery and one same-generation retry.
Provider and updated retry record persist before corrected send; same message ID,
AAD and encrypted metadata retained. Optional full payload field needs no IndexedDB
version change; legacy text/manifest fallback remains. Ambiguous network errors
retain original bytes; generation mismatch is terminal; unsent rows are never
deleted merely because new traffic works. After accepted send/cache publication,
queued row is removed. Historical HTTP400 remains in DevTools history.

SDK/UHM builds and29 focused regressions PASS (12 recovery,17 existing); fake
IndexedDB reopen proves adapter semantics only, not real browser/native durability.
Owner final-source reload/new exchange pending with collector active first. Vite
HMR interval is unverified; require explicit retry receipts for exact old-queue
recovery. TEST/PRODUCTION excluded, no broad rollout gate closed.

### Axios HTTP400 response-shape follow-up — 2026-10-05

[Supplement evidence](../bellboy/docs/evidence/local_main_plan/20261004-three-platform-field/pending-send-axios-provenance.json)
records classifier reproduction/fix: prefer Bellboy response.data.message over
Axios generic error.message. Actual Axios stale/non-stale/direct-send regression
coverage added. Serial32/0/0 PASS; parallel31/1/0 old standard-upload fixture
failure retained with root cause unverified. SDK/UHM builds PASS. Fixed enum
pending_send_failed categories add no payload logging. Mobile capture gap
invalidates complete runtime acceptance of prior owner confirmation; collectors
restored and final browser pending-send acceptance remains UNVERIFIED. Reuse
the shared canonical plan, preserve all prior failed reports and persistent data.


## 2026-10-05 — Archive permission6 backlog pause

[Canonical journal](../bellboy/docs/todo/e2ee_mls_android_parity_plan.md#2026-10-05--archive-permission-pause-and-coalesced-drain-locally-verified),
[bound source/build evidence](../bellboy/docs/evidence/local_main_plan/20261004-three-platform-field/archive-backlog-provenance.json).
Web retains permission-denied encrypted uploads/protected checkpoints, suppresses
regeneration/query loops and coalesces concurrent drains. Other eligible epochs
continue; denied work is never marked acknowledged. Explicit
`retryBlockedArchiveUploads(channelType, channelId)` reuses bytes after server
rights remediation. Fields are additive, no IndexedDB upgrade; old SDK rollback
retries paused rows. Server authorization remains account/epoch based; device
change is not a proven root cause. Fixed capture enums include archive result;
no raw payload/token logs. SDK/UHM builds,37 focused +40 recovery tests PASS.
Invalid fixture/old standard-attachment timing failures retained; broader
crash/concurrency/cursor/history gates remain OPEN. Prepared owner Web reload/
PIN-unlock gate remains UNVERIFIED; do not clear stores or fake historical ACKs.


### Owner runtime result for permission backlog

[Observed result](../bellboy/docs/evidence/local_main_plan/20261004-three-platform-field/archive-backlog-owner-result.json):
owner browser/tab reopen after reported crash, all3 read/capture0/no archive
errors. Logs Android2 full checkpoint chains, Web/iOS2 decode/provider pairs;
source/artifacts match. Bounded reopen/exchange/error non-repetition PASS.
Exact blocked blob inventory, successful valid archive ACK, browser crash cause
and broad durability/history/rollout gates remain OPEN.


## 2026-10-05 — Durable archive ACK retirement and batch capture

[Canonical journal](../bellboy/docs/todo/e2ee_mls_android_parity_plan.md#2026-10-05--ack-before-retirement-and-batched-capture-locally-verified),
[final provenance](../bellboy/docs/evidence/local_main_plan/20261004-three-platform-field/archive-ack-batch-provenance.json).
Real server ACK/checkpoint must commit before pending archive deletion; aborted
local writes retain unchanged idempotent work. recipient_set_stale remains a
rewrap decision, not an ACK. Four archive writes now reject transaction abort/
request errors explicitly. Local86/0 SDK cases pass, failed82/4 candidate retained.
No DB/public API/backend change; old SDK rollback retains its original window.

Capture now batches<=32 fixed markers,200ms timer/finish flush and5s deadline.
Collector validates all markers before logging; legacy single marker still works.
Lost-marker count is preserved; timestamps are batch receipt time. Source tests
5 frontend +7 parser PASS and consumer build PASS. Owner reports tab/DevTools
freeze, not a process crash; root cause still unknown. Source/artifact13/6 bound,
new Web collector11581; owner new-E2EE-group valid ACK smoke pending. No broad
history/cursor/ratchet/KP/GI/rollout closure or prior-runtime rebinding.


## 2026-10-05 — Repeated group query payload and iOS initial-join failure

[Canonical plan](../bellboy/docs/todo/e2ee_mls_android_parity_plan.md),
[new-group failure](../bellboy/docs/evidence/local_main_plan/20261004-three-platform-field/archive-ack-new-group-owner-result.json),
[same-group reopen](../bellboy/docs/evidence/local_main_plan/20261004-three-platform-field/new-group-ios-reopen-owner-result.json).
Web selected Android/iOS KPs, emitted2 durable archive ACK operations; owner
Web/Android worked but initial iOS read/send failed. Uhm Dev relaunch then emitted
external join/commit acceptance/receipt finalization/ready; owner same group all3
worked, capture0. Android collector255 disconnect precedes that exchange; native
Android runtime evidence UNVERIFIED. Do not call initial join or broad gates PASS.

Channel.query now retires full E2EE constructor payload after acknowledged
same-channel response, before local hydration. Failed HTTP keeps exact payload;
newer in-flight data and non-MLS behavior retained. Three same-ID HTTP200 queries
are create/watch/read, not proven duplicate bootstrap. Actual Channel focused
8PASS/0FAIL; prior baseline2PASS/3FAIL retained; SDK/UHM buildsPASS.
Strict native join parser13PASS saves only fixed enums/booleans, no identifiers
or raw error text. Fresh initial-join owner acceptance on all3 still pending.

## 2026-10-05 — External key rotation pending-delivery compatibility

Mode: research/local rehearsal against Bellboy External with Datastore db637807
and Concierge 294229b. Its adapter passed a 100-cycle/10-room reconnect probe.
An authenticated outage exposed a Web SDK acceptance bug: user B replayed the
durably accepted Commit to epoch 2, while user A had cleared its pending Commit
after Bellboy's 503 `mls_transition_pending` and stayed at epoch 1.

`EncryptionManager.keyRotation` now accepts only that typed response with a
valid operation UUID, retryable flag and the exact requested next epoch. It
merges/persists the original Commit and returns optional `delivery_pending`
and `operation_id`. Generic outage and mismatched receipts retain their prior
error behavior. SDK README documents the additive result. Existing unrelated
dirty source changes remain preserved; no WASM/storage/dependency update.
SDK build passed; focused acceptance/epoch-stale tests and a fresh authenticated
outage are being verified. This does not close other mutation acceptance,
nonzero-generation, browser crash, native-client or TEST/production gates.

Local follow-up PASS: SDK build and nine acceptance/epoch-stale tests. On two
existing test identities, an 8-second Concierge outage produced accepted pending
503; the creating peer merged/saved epoch 2 and its peer replayed the Commit to
epoch 2. Both message directions decrypted after recovery, GroupInfo matched
epoch 2, and stale epoch/generation requests were rejected. Bellboy was not
restarted for recovery. SDK source/build hashes and remaining gates are recorded
in `bellboy-external-release/docs/release/evidence/2026-10-05/sdk-source-manifest.json`.
This local monorepo SDK fix has not been promoted to an external SDK/UI artifact.


## 2026-10-05 local External generation compatibility follow-up

Ordinary mutations use the installed `_groupGenerations` marker and compare its
explicit GroupId against OpenMLS before staging a Commit. Rotation, member add/
remove, self-left cleanup and per-topic request/codec paths transmit this identity.
Batch external join stores the verified topic marker. Generation 0 omits GroupId.
No WASM/IndexedDB schema change and no external SDK artifact promotion.

Actual Web3002 + External Docker: controlled loss/expired-repair fixture activated
generation 1; B recovered historical Welcome. Rotation to epoch 2, removal to 3,
re-add to 4, bidirectional decrypt and reload persistence passed. Invalid/absent/
legacy GroupId at matching epoch failed closed. Build +31 focused tests passed.
Other mutation pending/ambiguous acceptance and crash durability remain open;
gated-topic and self-left full live/outage matrices are not closed by codec tests.


The epoch-5 outage also exposed a delayed-Commit mixed-cursor gap. Global sync
now compares the installed epoch with existing same-generation/GroupId recovery
metadata and replays from current membership when behind. Healthy sync adds no
network call; gap repair scans O(membership history) in 100-event pages. An epoch-6
live regression kept B at 5/needs_retry until Commit delivery, then ordinary sync
recovered 6 and two-way decrypt passed, without stale-send/rejoin/API restart.
SDK build +44 focused tests passed; earlier failure is retained. External SDK
promotion and large-history recovery budgets remain gates.


### 2026-10-06 — External ordinary mutation checkpoint follow-up (local)

Scope: bellboy-external-release + local SDK/Web3002; no internal backend modification,
external UI promotion, commit/push or environment deployment. Added atomic staged/accepted/
merged mutation checkpoints in existing IndexedDB stores, exact own-Commit reconciliation,
unknown-outcome retention and saved-artifact retries. Custom storage adapters need the new
atomic primitive before ordinary mutations. New channel/topic bootstrap and batch external
join checkpointing, cross-tab/provider concurrency and full crash coverage remain open.
External dedicated-topic backend now uses existing atomic channel-create/outbox reservation
instead of pre-writing the next epoch. Existing SQL bundle and both old dependency pins stay.
Source/image-specific runtime evidence is in External release docs; prior images are historical.

Topic regressions added strict re-add/removal timestamp checks, queued-ghost membership
refresh, newer-generation Welcome replacement, readiness-cache invalidation through the
existing atomic Welcome coordinator, and REST Base64 normalization before receive/replay.
Encrypted cache rows without plaintext are not decrypt evidence. SDK build and 80 focused
tests pass, including real WASM encoded-history receive/waterfall and checkpoint failures.
Real Web tests recovered ordinary mutation journals at renderer crash boundaries before HTTP
and after acceptance/before merge using replacement pages in the same browser context.
The old pre-fix cursor did not automatically rewind a skipped envelope; explicit SDK waterfall
replay recovered it. Full browser/process restart, all interruption boundaries and cross-tab
coordination remain open. No SQL schema or dependency pin changes were introduced by these fixes.

### 2026-10-06 — Internal Uhm Web future-epoch receive baseline (local)

Owner iOS/Android peers read new messages while Web reports epoch/future. The internal SDK now rejects unprocessed Commit gaps instead of acknowledging them, restores provider/group together, preserves failed scope prefix while reaching authoritative rewind discovery, and requests gated/cooldown global sync after persisted realtime future-epoch failure. Channel realtime Commit/own-ACK/Welcome awaits global gate and retains session identity. No backend wire/schema or data reset; no external SDK promotion in this change.

Real-WASM baseline16PASS/2FAIL and Channel gate baseline0PASS/3FAIL/9SKIP retained; final affected tests100PASS/0FAIL/0SKIP, build/types exit0. Vite3001 serves matching code; native artifacts unchanged. Physical original-message recovery/new reads NOT YET VERIFIED; CLIENT-005-MEMBER-REJOIN FAIL/OPEN and kick/reinvite halted. See [canonical journal](../bellboy/docs/todo/e2ee_mls_android_parity_plan.md#2026-10-06--future-epoch-protocol-correction-verified-locally-retained-state-browser-retest-pending) and [bound evidence](../bellboy/docs/evidence/local_main_plan/20261004-three-platform-field/membership-rejoin/r02-future-epoch-fix-provenance.json).

### 2026-10-06 — Internal Web peer-membership fence and scoped diagnostics follow-up

Previous100-case local correction still FAILS physically: Web future epoch persists after sync, native peers read. Retained failed report remains authoritative; kick/reinvite halted. Peer member.updated was independently reproduced replacing current-user membership/moving replay fence. Channel producer now restricts current membership to authenticated user; MLS reader rejects explicitly peer identity and falls back to own roster, preserving ownerless legacy projections. No data/provider reset or backend contract change.

Hidden SDK info logs made owner Console-copy instructions unusable. DEV host now prints/captures validated scope SHA256 + safe epoch/replay enum metadata (bounded128/10s; no raw IDs/payload/errors). Matching collector restart and fresh retained-state refresh required. Local109 SDK cases,13 host diagnostic cases,24 parser cases pass; SDK build/types pass. Full Uhm typecheck still fails unrelated poll narrowing, retained. Actual-message recovery and broader CLIENT-005-MEMBER-REJOIN remain FAIL/OPEN. [Canonical plan](../bellboy/docs/todo/e2ee_mls_android_parity_plan.md), [prior corrected-source failure](../bellboy/docs/evidence/local_main_plan/20261004-three-platform-field/membership-rejoin/r02-future-epoch-retest-failed-result.json).

### 2026-10-06 — Own Commit acknowledgement fence

Internal Web SDK now routes own-tagged WS/scope events through processOwnMlsCommit. Exact durable candidate still reconciles first; unapplied event is authenticated through WASM rather than skipped by logical device ID. Genuine missing self candidate stays failed, preserving provider/cursor; no auto rejoin/reset. Local WASM/durability regressions pass; retained-state MLS-Join-04 physical acceptance pending. Canonical journal: ../bellboy/docs/todo/e2ee_mls_android_parity_plan.md (CLIENT-005-MEMBER-REJOIN FAIL/OPEN). No external artifact promotion.

### 2026-10-06 — External bootstrap and batch join checkpoint follow-up (local)

Scope: bellboy-external-release plus this local SDK/Web3002. Bootstrap preparation
keeps its Commit staged and checkpoints the complete encoded create request
before HTTP. Exact Welcome/tree or authoritative matching GroupInfo confirms
acceptance; an unknown response preserves the original artifacts and metadata.
Batch external-join checkpoints each candidate before POST and explicitly merges
its external Commit despite OpenMLS already reporting N+1. Provider, marker,
first-decryptable epoch and journal deletion commit together. Storage adapters
must support atomic readiness; reconcile/drain these journal kinds before an
older SDK rollback. Same-manager in-flight sync retries and duplicate topic
creation for an unresolved parent are blocked; cross-tab serialization remains open.

Real Web renderer recovery passes bootstrap before HTTP/after acceptance and
two-topic batch before HTTP/lost response. SQL absence/unchanged epoch proves
the pre-HTTP boundaries; journals clear and two-way decrypt passes at bootstrap
epoch 1/batch epoch 2. Batch fixtures use a synthetic second owner-device
KeyPackage and suppress automatic single-join only for fixture CIDs. Same browser
contexts are preserved; this does not prove a full browser/process crash matrix.
The rejected empty-Welcome setup and earlier cache/sync failures remain recorded.
External creation now invalidates membership cache after commit and GroupInfo
checks current SQL membership. No dependency-pin or SQL migration changes in
this follow-up; internal bellboy backend was not edited by this task.

Final SDK build/types +119 focused tests, Rust125 tests, Datastore80k command
routing and Concierge adapter100 reconnect cycles pass. Matching-image generated
d6→target migration/backfill/resume/verify and PostgreSQL rollback pass with
explicit clone-only current-GroupInfo projection; stale-source verify still
fails and remains evidence. See [External follow-up result](../bellboy-external-release/docs/release/evidence/2026-10-06/bootstrap-followup/result.json).
Single external-join unknown outcomes, partial enable activation, full crash/
generation-replacement matrix, shared-provider concurrency, external SDK/UI
adoption, representative legacy migration/cryptographic rollback and TEST
soak/canary remain gates. Status: dependency-compatible but rollout-unverified.
No commit/push, external SDK publication or environment rollout.

### 2026-10-06 — External single external-join journal follow-up (local)

The public single-join SDK path now checkpoints its staged external Commit
before HTTP instead of clearing it on unknown response. Exact historical
Commit, successful exact request or validated accepted-pending receipt merges
the original candidate. Recovery keeps the saved Commit; a retry rejection
cannot disprove original acceptance. Initial timeout/rate-limit errors remain
pending, and definite initial input/authorization rejection clears the candidate.
The final atomic checkpoint preserves Welcome fallback metadata and writes
provider, marker, first-decryptable epoch and journal deletion together.

SDK build/types and 131 focused tests pass, including real-WASM generation0/1
checkpoint faults and exact retry. Real Web single joins recover after lost
response and before-HTTP renderer crash, reach epoch2, clear journals and decrypt
both ways. Same-context/synthetic-owner-device fixture limits still apply.
Backend/image digest is unchanged from the bootstrap follow-up; no new SQL or
pin changes, internal Bellboy edit or external artifact publication. See
[single-join evidence](../bellboy-external-release/docs/release/evidence/2026-10-06/single-join-followup/result.json).
Partial enable activation, full crash/generation-replacement and multi-tab
provider matrix, external SDK/UI adoption, representative legacy/cryptographic
rollback and TEST soak/canary remain gates. Status remains dependency-compatible
but rollout-unverified.

### 2026-10-07 — Owner-authorized Web source consolidation

The reviewed field-replay changes are now integrated into the main
`ermis-chat-monorepo` checkout on `feature/key-package`, retaining the other
task's bootstrap, single/batch external-join journals, in-flight exclusions and
Welcome-fallback metadata. The only integration conflict keeps the in-flight
skip before retained-rejoin recovery. No Git commit or branch merge was made.

Own-Commit replay and owner-triggered retained-state repair remain separate
modules. Repair preserves plaintext, pending ciphertext and scope cursors;
unknown outcomes retain the exact candidate, and a definite initial rejection
restores prior provider/group state. Corrupt/missing-provider restore fails
closed to preserve private KeyPackages. Old history recovery and cross-tab
provider coordination remain open.

The main SDK matches the reviewed combined candidate. Actual main SDK build,
typecheck and141focused tests pass; React and full Uhm build pass. Port3001 now
serves main source; real Chromium/WASM/IndexedDB synthetic reload and encryption
checks pass with capture0. Authenticated combined browser/device acceptance
remains unverified. Full evidence is recorded in the
[canonical journal](../bellboy/docs/todo/e2ee_mls_android_parity_plan.md).
[Integration evidence](../bellboy/docs/evidence/local_main_plan/20261007-web-source-review/)
preserves pre-merge status, reviewed patch and final main tests. Prior physical
FINAL exchange belongs to the earlier isolated artifact and is not transferred
to the new combined artifact. The old worktree remains a retained snapshot;
new development uses the main checkout. No backend/schema/WASM upgrade,
external package publication or TEST/PRODUCTION deployment in this integration.


### 2026-10-07 — Combined source physical messaging follow-up

Owner confirms all three platforms send/read MERGE messages and capture0. The
bounded Web/Android/iOS logs contain fresh decoded/provider checkpoints, same
process identities and zero reviewed main-source/generated-artifact drift.
Combined ordinary send/receive is now **PASS bounded**, superseding the preceding
authenticated-combined-unverified status.
[Result](../bellboy/docs/evidence/local_main_plan/20261007-web-source-review/combined-device-result.json)
and [canonical journal](../bellboy/docs/todo/e2ee_mls_android_parity_plan.md#2026-10-07--combined-source-merge-exchange-functional-pass-bounded).

Web historical cache retries and past-generation mismatch remain OPEN; this
exchange does not establish full cursor/provider/proof/ratchet atomicity,
selected/private server-pool reconciliation, cross-tab correctness or natural
auth expiry. No new membership repetitions, reset, commit/push or deployment.
## 2026-10-08 — TEST/POC KeyPackage and generation parity

Against Bellboy External's client/server recovery contract, validate lifecycle
inventory/demand fields before KeyPackage generation, honor uncleared durable
demand above the low watermark, and recount an ambiguous fifth upload without
creating a sixth batch. Keep Provider persistence before upload, concurrent
coalescing and old-server responses lacking all lifecycle metadata compatible.
Reject recovery protocol skew, malformed/regressing generation identity, and use
authoritative join for `delivery_failed_retryable` rather than a new claim.
Update the stale GI repair test storage fixture to include atomic mutation
checkpoints. Local UHM Web `.env.local` points at `https://api.khoakheu.pro`.
GI repair and server-authorized rebootstrap already enabled; no new toggle needed.
No WASM/native artifact, backend API/SQL/Postman or production deployment changes.
Validation O(1); Provider snapshot O(P) time/memory plus O(B) keys, B <= 100;
at most five uploads and six counts on ambiguous outcomes. See
[cross-client executable evidence](../bellboy-external-release/docs/release/evidence/2026-10-08/client-rebootstrap/README.md).

### 2026-10-08 — Web source readiness confirmation

Owner clarified that deployment/build will be performed on their server, using
`api-trieve.ermis.network`; no agent deployment or publication is requested.
Fresh `npm run build:uhm` passes SDK, React, declarations and Uhm/PWA build;
the five focused refill/GI/recovery/claim-intent/generation suites pass **73/73**
with no failures/skips, and `git diff --check` passes. Rebootstrap, KeyPackage
refill and GroupInfo repair need no additional Web toggle for this change.
Local `.env.local` is ignored and selects the owner's test API; server builds
must select `VITE_API_URL=https://api-trieve.ermis.network` independently.
The five current tracked edits remain uncommitted/unpushed; these local checks
do not imply the server has received the updated source or that production
runtime recovery has been verified. No WASM, backend or deployment change.

## 2026-10-07 — Actual ownership inventory and final generated consumers

This supersedes the earlier statement that no ownership endpoint was added. Canonical design/journal/evidence: [remaining client plan](../bellboy/docs/todo/e2ee_mls_android_parity_plan.md#2026-10-07--final-generated-consumers-and-bounded-local-acceptance); authoritative [lifecycle ledger](../bellboy/docs/todo/e2ee_mls_keypackage_lifecycle_plan.md). Own-device `/v1/e2ee/key_packages/ownership/inventory` and `/ownership/reconcile` use bounded hash-reference pages and selective CAS retirement tombstones. Generated private-bundle/current-signer probes are adopted by all3actual consumers; unknown storage/pending join/unsupported capability defer safely, no whole-pool purge. Native generation/serialization now throw typed errors; Swift callers require `try`, generated source and library must move together. Main Web serves3001, historical exact proofs skip obsolete ratchet reuse and contextual AAD rejection restores durable state. Local automated counts and failures are in the canonical journal. Server deployment, owner final-artifact messaging and genuine native expiry remain unverified; full ledger boxes are not closed by build/unit/capture0.

## 2026-10-09 — LOR reviewed three-way restoration starts

Both the current 2026-10-08 source-readiness journal and the parked 2026-10-07 consumer journal are retained above as historical evidence. They do not certify the new lifetime/ownership/recovery source or artifact. Current coordination is solely the [LOR ledger](../bellboy/docs/todo/e2ee_mls_lifetime_ownership_recovery_ledger.md), with its [canonical narrative](../bellboy/docs/todo/e2ee_mls_lifetime_ownership_recovery_plan.md). Local source/build/disposable tests are authorized; production/publish/device/canary remain separate. Server rebootstrap remains disabled for the new canary. This reviewed text resolution combines base/current/saved append-only histories; current manager changes merge separately without overwrite.

## 2026-10-09 — LOR Web implementation journal (local only)

Authoritative status/dependencies remain in [Bellboy LOR ledger](../bellboy/docs/todo/e2ee_mls_lifetime_ownership_recovery_ledger.md); the single canonical detailed narrative is [LOR plan](../bellboy/docs/todo/e2ee_mls_lifetime_ownership_recovery_plan.md). Historical journals above are preserved; none closes the new LOR gates.

Three-way restoration receipt restore-qjtqom4d.json retained newer manager work and both conflicting journals. Web public ownership checkpoint version 1 uses existing IndexedDB meta store, signer fingerprint, scan/retry lanes, max16 queue and bounded3-page/6-HTTP work; 19 source tests PASS. Welcome uses isolated candidate, atomic save/readback/activate then group publication; 45 related tests PASS. Live/history/own settlement now require canonical event-bound context, isolated protocol checkpoint and typed errors; 131 regression tests PASS. Raw timestamp alone defers and does not advance cursor. Paired SDK/app current artifact SHA256 4f52c348ddd73a5412bc6bbbbefbf9ee671765eb2ee9a21944a82026be3db12a (2557170 bytes), local-only provenance includes untracked producer hashes; seven binary scenario groups PASS.

Full mutation writer migration/retry routing, exact upload retry bytes, external receipt/Welcome race, state callbacks/ACK/hints/minimum version, browser restart/crash and mobile/device/canary gates remain open. No runtime flags/production endpoints changed and no install/publish/rollout was performed. Android/iOS have not been restored. Evidence and failed runs are retained under ../.task-artifacts/lor-20261009; ledger has exact commands and limitations.


2026-10-20 DEC085 final intent writer contract: applicationIntentCheckpointVersion1 includes exact ephemeral pending_send_guards in the same provider+pending private checkpoint. Cancellation/replacement between admission and commit aborts the whole candidate; no ratchet or winning job is overwritten. Preserve unsealed_intent_version1 original UUID/payload/route/AAD and known generation across restart. Hydration/resume restores text intents as well as attachment jobs through existing Channel callbacks. Canceled unknown ciphertext is retained; late errors cannot make it retryable. Compatible predecessor reader/artifact remains unqualified. Final507 affected tests and physical/browser evidence are indexed in the existing Bellboy LOR canonical/ledger, with full six gates still open. Pinned Uhm build used Vite configLoader runner; ESM config resolves projectDir through import.meta.url without alias changes. Default bundled Rolldown loader hung and is retained as a toolchain limitation, not a source-test PASS.


DEC085 final continuation (2026-10-20): a queued send that encounters typed provider_mutation_busy now coalesces a point-read wake after the existing provider checkpoint tail. It rereads durable status and current scope, preserves exact UUID/ciphertext and skips canceled/terminal/sent work; no timer, attempt reset or provider mutex through HTTP. Final affected510PASS includes held-checkpoint autonomous wake/cancel/owner fences; actual final browser restart and offline/online exact retry both returned200. This supersedes the earlier507 count for this changed boundary. Full generation/rollback/performance acceptance remains open in the authoritative LOR ledger.


2026-10-20 Gate2 functional reader floor: restored/unknown sealed work observes scoped server generation independently of full Ready before messageHTTP when no current-session authenticated head is available; just-minted durable Ready/ciphertext objects have one-use volatile admission only. Exact retry keeps UUID/body/endpoint; newer generation yields old_group_generation and retained terminal obligation, never reencrypt. Genuine absent endpoint404/405/501 permits only generation0 legacy compatibility; transient/malformed/lower observations retain fail-closed. Scoped generation GET includes5s absolute auth/transport deadline and owner/cancel reread.

Web IndexedDB local WelcomeRecoveryCheckpoint v1 additionally understands status `superseded_by_generation` and checkpoint.generation_receipt (version/cid/operation_id/state/expected_generation/current_generation/current_epoch/group_id/membership_version/activated_at), guarded by storage `welcomeGenerationDispositionVersion:1`. Original old event/cursor/hash/scope remain; only actual authenticated activated receipt matching current durable marker operation/GroupId and exact previous-generation boundary can atomically disposition that event. It is neither applied nor authored Welcome proof and grants no old private state/history. Provider bytes unchanged, matching pending index/readiness removed only by full CAS/readback. Older statuses/readers remain unchanged; older binaries that reject/ignore this appended status are not qualified rollback. No IndexedDBversion/nativeABI/server-schema migration. Qualified predecessor now must retain/read this disposition in addition to prior native/preparing, iOS pointer/continuation, generation and exact Web pending obligations. Missing receipt/operation provenance remains typed welcome_generation_receipt_pending; invalid proof stays retained with welcome_generation_receipt_invalid. [Current execution](../.task-artifacts/qa/runs/20261020T083844Z-06733877c196/report.md).


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

SDK31-file affected regression: 1134 PASS/0 FAIL/0 skipped/0 cancelled, execution `20261020T163510Z-db203e5bdfc6`; SDK and React build PASS. Actual artifacts and UI acceptance are mapped in the [canonical LOR journal](../bellboy/docs/todo/e2ee_mls_lifetime_ownership_recovery_plan.md). No API/SQL/Postman request contract changed.


### Joined-external Ready continuation — 2026-10-21 local / 2026-10-20 UTC

<details>
<summary>Change log</summary>

- After an acknowledged private-noop Ready commit, a recognized forward cursor/new-pending race may now be re-proved for joined-external owners too. `loadExternalJoinWorkBase` must return one consistent full readonly base: accepted/rejected receipt, Welcome primary/pending/history witnesses and Ready state. Every canonical field outside Ready state must equal the original checkpoint base; within state only the already recognized public progress is admitted. Original owner, exact own next revision and full provider/identity bytes must still match.
  - Integrator action: retain the complete canonical read set and perform the one fresh full Ready validation outside the provider queue. No Ready is granted by a state-only read. Unknown read, backlog, receipt/Welcome/index/admission replacement or foreign owner/private revision remains fail closed.
  - Compatibility/default: existing composed adapter methods and versions, no new persistence format, database version, native ABI, wire payload or SQL/Postman change. The proof read has no retention/compaction continuation and no HTTP. At most100 active Welcome rows; exceeding the bound cannot become truncated proof. Same one-retry bound applies; repeated progress returns `local_checkpoint_pending`, then a later normal invocation may continue.

</details>

Final producer/consumer regressions:1138 PASS/0 FAIL/0 skipped/0 cancelled across31 affected files, including real WASM joined-external cursor races, repeated-race bound, simultaneous changed receipt+cursor rejection and throwing full-base read. The earlier final3 exclusion is superseded only for this precisely re-proved class. Unknown or changed authoritative data is not normalized away. Full client binary rollback remains unqualified.
