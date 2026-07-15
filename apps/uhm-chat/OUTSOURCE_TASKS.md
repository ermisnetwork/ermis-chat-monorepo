# uhm-chat-external delivery tracker

Allowed status: `TODO | IN_PROGRESS | BLOCKED | DEFERRED | DONE`. Only one Codex-owned task may be `IN_PROGRESS` at a time.

| ID | Task | Status | Owner | Dependency | Commit / evidence |
|---|---|---|---|---|---|
| PLAN-001 | Lock scope, version, repositories, and WASM exception | DONE | Codex | — | Plan approved; version `2.1.0-external.1` |
| SDK-001 | Create internal `outsource` branch from `uhm-chat@974eb5b` | DONE | Codex | PLAN-001 | Branch `outsource`, base `974eb5b` |
| SDK-002 | Remove high-level PIN/epoch archive from core SDK | DONE | Codex | SDK-001 | External contract test and endpoint/type negative audit passed |
| SDK-003 | Remove PIN/recovery from React SDK | DONE | Codex | SDK-002 | React build and package tarball audit passed |
| SDK-004 | Exclude `/src`, sourcemaps, and internal files from packages | DONE | Codex | SDK-003 | `files=["/dist"]` for React; sourcemaps disabled |
| SDK-005 | Build, test, and audit both package tarballs | DONE | Codex | SDK-004 | Core/React build; external contract, attachment, media tests; npm pack and dry-run passed |
| SDK-006 | Publish both packages with npm dist-tag `external` | BLOCKED | Codex + user npm approval | SDK-005 | `npm whoami` failed with `E401 Unauthorized`; no package published |
| FE-001 | Create sanitized standalone app and `.env.example` | DONE | Codex | PLAN-001 | Standalone source created at `/Users/khoakheu/Ermis-workspace/chat/uhm-chat-external` |
| FE-002 | Remove PIN/archive UI and pin exact SDK versions | DONE | Codex | SDK-005 | Exact versions set; workspace and tarball-backed app builds passed |
| FE-003 | Smoke test with package tarballs outside monorepo | DONE | Codex | SDK-005 | `/private/tmp/uhm-chat-external-smoke`; tarball install and production build passed |
| FE-004 | Install registry packages and create final lockfile | BLOCKED | Codex | SDK-006 | Registry release not published |
| FE-005 | Build, lint, E2EE smoke test, and clean initial commit | BLOCKED | Codex | FE-004 | — |
| DOC-001 | Update SDK/app docs, release guide, and research progress log | DONE | Codex | FE-005 | SDK/React/app README, `EXTERNAL_RELEASE.md`, and 2026-07-15 research entry |
| WASM-001 | Build WASM without epoch archive and replace artifact | DEFERRED | User | FE-005 | Current WASM checksum/size must remain unchanged |
| BE-001 | Analyze attachment/base64 contract for `bellboy-external` | BLOCKED | Later phase | FE-005 | Backend scope intentionally unchanged |
| BE-002 | Implement and test backend attachment/base64 | BLOCKED | Later phase | BE-001 | Backend scope intentionally unchanged |

## Release acceptance

- Core SDK, React SDK, and standalone app build successfully.
- Package tarballs contain compiled JS, declarations, CSS, docs/license, and required runtime assets only; no source tree or source maps.
- Public declarations and non-WASM runtime contain no PIN, recovery vault, epoch archive, historical restore, archive-backed repair, or recovery endpoint contract.
- Startup and live MLS flows make zero requests to recovery/archive endpoints.
- The standalone app resolves exact registry versions with no workspace/file/link dependency and builds without a parent monorepo.
- The outsource repository contains one clean initial commit on `main`; secrets, build output, dependency folders, and development PWA output are not tracked.
