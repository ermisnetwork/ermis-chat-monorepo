# uhm-chat-external delivery tracker

Allowed status: `TODO | IN_PROGRESS | BLOCKED | DEFERRED | DONE`. Only one Codex-owned task may be `IN_PROGRESS` at a time.

| ID | Task | Status | Owner | Dependency | Commit / evidence |
|---|---|---|---|---|---|
| PLAN-001 | Lock scope, version, repositories, and WASM exception | DONE | Codex | — | Plan approved; version `2.1.0-external.1` |
| SDK-001 | Create internal `outsource` branch from `uhm-chat@974eb5b` | DONE | Codex | PLAN-001 | Branch `outsource`, base `974eb5b` |
| SDK-002 | Remove high-level PIN/epoch archive from core SDK | DONE | Codex | SDK-001 | External contract test and endpoint/type negative audit passed |
| SDK-003 | Remove PIN/recovery from React SDK | DONE | Codex | SDK-002 | React build and package tarball audit passed |
| SDK-004 | Exclude `/src`, sourcemaps, and internal files from packages | DONE | Codex | SDK-003 | `files=["/dist"]` for React; sourcemaps disabled |
| SDK-004A | Add the approved proprietary embedded-distribution license to both tarballs | DONE | Codex + user | SDK-004 | Approved 2026-07-18; `LICENSE` included in both package tarballs |
| SDK-005 | Build, test, and audit both package tarballs | DONE | Codex | SDK-004A | Builds/tests passed; dry-run reports tag `external`, access `restricted`, SDK 25 files and React 8 files with no source/map |
| SDK-006 | Publish both public proprietary packages with npm dist-tag `external` | DONE | Codex | SDK-005 | Registry verified: both `external` tags resolve to `2.1.0-external.1`; `latest` remains `2.1.0`; React pins exact core version |
| SDK-007 | Publish live-only OpenMLS packages as `2.1.0-external.2` | DONE | Codex + User | WASM-001 | Registry verified: both `external` tags resolve to `.2`, `latest` stays `2.1.0`, React pins exact core `.2`, and published integrity matches the audited tarballs |
| FE-001 | Create sanitized standalone app and `.env.example` | DONE | Codex | PLAN-001 | Standalone source created at `/Users/khoakheu/Ermis-workspace/chat/uhm-chat-external` |
| FE-002 | Remove PIN/archive UI and pin exact SDK versions | DONE | Codex | SDK-005 | Exact versions set; workspace and tarball-backed app builds passed |
| FE-003 | Smoke test with package tarballs outside monorepo | DONE | Codex | SDK-005 | `/private/tmp/uhm-chat-external-smoke`; tarball install and production build passed |
| FE-004 | Install registry packages and create final lockfile | DONE | Codex | SDK-006 | `yarn.lock` resolves both exact versions from the public registry; no workspace/file/link dependency |
| FE-005 | Build, lint, E2EE smoke test, and clean initial commit | DONE | Codex | FE-004 | Registry/Vite build and lint passed; React SDK CSS is imported; user-confirmed live E2EE channel/message smoke passed; light message contrast adjusted; standalone `main` is delivered as one root commit |
| FE-006 | Live browser regression with the live-only WASM | TODO | User | SDK-007 | Verify existing/direct/group channels, send/receive, external join, rotation, reconnect, and encrypted attachment upload/download before customer rollout |
| DOC-001 | Update SDK/app docs, release guide, licensing, and research progress log | DONE | Codex | FE-005 | SDK/React/app README, `EXTERNAL_RELEASE.md`, license boundary, and 2026-07-15 research entry |
| WASM-001 | Build WASM without epoch archive and replace artifact | DONE | Codex + User | FE-005 | OpenMLS `main` pinned at `ce0ed8fde`; Core/React/Uhm builds, 8 external tests, and both package dry-runs pass |
| BE-001 | Analyze attachment/base64 contract for `bellboy-external` | DONE | Codex | FE-005 | Canonical base64 applies only to JSON MLS byte fields; encrypted assets use direct presigned PUT/multipart and a separate opaque lifecycle control plane |
| BE-002 | Implement and test backend attachment/base64 | DONE | Codex | BE-001 | Branch `feat/e2ee-attachment-base64`: 43 Rust tests pass; live single-PUT init/upload/complete/bind/query/grant/download/delete/R2-cleanup passed on port 8889 |
| OPS-001 | Rotate Firebase service-account credential exposed by legacy `gauth` startup logging | TODO | User | BE-002 | Private-key logging removed via vendored security patch; rotate the local/shared credential and replace `firebase_config.json` in every environment using it |

## Release acceptance

- Core SDK, React SDK, and standalone app build successfully.
- Package tarballs contain compiled JS, declarations, CSS, docs/license, and required runtime assets only; no source tree or source maps.
- App source uses a customer-specific proprietary license that permits authorized fork/rebrand/self-host/commercial distribution but prohibits standalone source resale; the two SDKs remain proprietary despite public npm availability, with redistribution allowed only while embedded in an authorized built or packaged application.
- The publish scripts reject a non-`external` dist-tag and enforce the packages' existing `access: public` visibility in both package metadata and the npm publish command.
- Public declarations and non-WASM runtime contain no PIN, recovery vault, epoch archive, historical restore, archive-backed repair, or recovery endpoint contract.
- Startup and live MLS flows make zero requests to recovery/archive endpoints.
- The standalone app resolves exact registry versions with no workspace/file/link dependency and builds without a parent monorepo.
- The outsource repository contains one clean initial commit on `main`; secrets, build output, dependency folders, and development PWA output are not tracked.

## Progress log

### 2026-07-21 — OpenMLS live-only artifact release gates

- Mode: production release; user approved real npm publish, with npm authentication refresh required before registry mutation.
- Replaced the temporary epoch-archive-capable OpenMLS artifact with a live-only build from pinned OpenMLS `main` commit `ce0ed8fde928db16f1c4709c30d18f2aaa4507c2`.
- Stored the exact Cargo lock and toolchain provenance beside the SDK. The lock pins `hpke-rs` at `6e30f233daf51ec63d982c60ff1ecd83f90c1139` so a clean build does not resolve the incompatible upstream `0.6.1` HEAD.
- The new WASM is 1,667,354 bytes with SHA-256 `a54a975e52a267c98884e18656078c21b16f05bf5aec5657ae9631dd59899889`; generated glue/declarations expose the same live MLS surface while removing PIN, recovery-vault, and epoch-archive APIs.
- Core and React package metadata plus the monorepo consumer are prepared for `2.1.0-external.2`. Existing published `2.1.0-external.1` artifacts remain immutable.
- User approved the remaining local gates. Core and React SDK builds passed, followed by all 8 `test:external` cases, including the pinned WASM provenance/live-only contract and Base64 migration coverage. The Uhm Chat production build passed with only the existing runtime-WASM URL, bundle-size, and ineffective-dynamic-import warnings.
- Corrected the stale root `dev:uhm` and `build:uhm` workspace aliases from `uhm-chat` to the actual `uhm-chat-external` package name.
- Package dry-run passed for public access and the `external` tag: Core contains 25 files (3.1 MB packed, 10.6 MB unpacked) and React contains 8 files (296.2 kB packed, 1.6 MB unpacked), with no source trees or source maps. The first sandboxed attempt hit the machine's root-owned npm cache; rerunning with a temporary npm cache passed without publishing.
- Published both packages as `2.1.0-external.2`. Registry metadata resolves both `external` tags to `.2`, preserves `latest=2.1.0`, and records the audited core/React integrity values. React depends exactly on core `.2`.
- npm 10.8.2 returned a misleading exit-handler error during web approval and registry propagation; npm completed both publishes asynchronously. Verification used registry version, timestamp, dist-tag, dependency, tarball, and integrity metadata before any retry. A retry with npm 11 correctly refused to overwrite the immutable core version.
- Updated the standalone app to exact `.2`, installed both packages from the public registry, copied the matching live-only WASM, and verified identical SHA-256 values in app and installed SDK. Production build passed; lint has zero errors and the same six pre-existing hook warnings. The customer repo remains one amended root commit (`9395b40`).
- Next: complete `FE-006` live browser regression, then run the manual cross-repository staging workflow with `E2EE_BYTE_LEGACY` enabled and disabled before customer rollout.

### 2026-07-18 — FE live smoke and contrast pass

- Mode: production delivery verification.
- User-confirmed live login, channel listing, new E2EE channel creation, and encrypted message send all passed against the local Bellboy stack.
- Imported React SDK CSS fixed the zero-height virtualized channel list.
- Light-theme message tokens now use a coherent dark foreground on lavender own-message bubbles; timestamp, delivery status, hover actions, borders, and background pattern were adjusted for clearer visual separation.
- No backend/API, database, event, SQL, or Postman contract changed.
- Final gate passed: standalone build/lint succeeded, local-only runtime artifacts were excluded, and the repository was prepared as a single root commit on `main`.

### 2026-07-18 — Backend attachment/base64 design gate

- Mode: production implementation design.
- Verified `bellboy-external` supports only legacy plaintext multipart attachments and JSON `number[]` MLS bytes; SDK `2.1.0-external.1` requires canonical padded base64 byte fields plus the E2EE attachment V1 init/query/complete/grant/cancel contract.
- Chosen boundary: Bellboy never receives plaintext attachment bodies or base64 file bodies. Clients encrypt locally and upload ciphertext directly to object storage; Bellboy stores opaque object keys, lifecycle, channel authorization, message binding, and cleanup state.
- Base64 encode/decode is O(n) time/O(n) temporary memory with 4/3 wire size and adds no database/network round trip. It is restricted to small MLS protocol fields; JSON byte arrays are not retained on the external lane.
- Attachment init is O(assets + multipart parts) time/memory and response size, bounded by two V1 assets and configured max parts. File transfer bypasses Bellboy. Complete uses object-store complete/HEAD plus bounded DB state transitions; query is indexed O(limit), and grant authorization is one indexed projection read plus one presign operation.
- Production gates: exact SDK request/response fixtures, 2 GiB/256-part config bounds, R2 `ETag` CORS, incomplete multipart lifecycle cleanup, idempotent complete/cancel, attachment-ID/MLS-manifest agreement, authorization/hidden-message tests, and no PIN/archive API introduction.

### 2026-07-18 — Backend attachment/base64 implementation pass

- Mode: production implementation; live infrastructure gate remains open.
- Added canonical padded base64 for public MLS JSON byte fields. Public byte arrays and non-canonical base64 are rejected, while already-persisted Concierge byte arrays remain read-compatible and are emitted as base64.
- Added encrypted attachment init/query/complete/download-grant/cancel routes, single-PUT and multipart presigning, object HEAD validation, message binding/confirmation, authorization filters, idempotency, cleanup leases/retries, and abandoned-upload cleanup.
- Added additive PostgreSQL schema/migration, complete sample config, external API guide, README rollout notes, and a Postman collection. No PIN, vault, epoch-archive, restore, or archive-repair API/table was introduced.
- Verification: `cargo test` passes 43 tests total (34 unit + 4 external contract + 5 existing key-package integration); `cargo clippy --all-targets` completes with pre-existing repository warnings only plus the existing deprecated timeout warning.
- Live single-PUT gate passed on a separate Bellboy process at port `8889`: init, direct R2 ciphertext upload, complete, message bind, query, download grant, exact 64-byte download verification, message delete, and R2 cleanup all succeeded. Multipart stays disabled until R2/S3 CORS exposes `ETag` and incomplete multipart lifecycle cleanup is configured.
- Startup smoke exposed a transitive `gauth` statement that printed the Firebase service-account private key. `bellboy-external` now vendors the exact dependency revision with that statement removed, pins it through Cargo `[patch]`, and includes a regression gate. The exposed credential must still be rotated by the environment owner (`OPS-001`).
