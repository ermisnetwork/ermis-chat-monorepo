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
