# UHM Chat Invite Navigation and Startup Responsiveness Plan

Status: **In progress**  
Owning repository: `ermis-chat-monorepo`  
Authoritative ledger: [`docs/todo/todo.md`](./todo.md)  
Requirement IDs: `UHM-INVITE-001`, `UHM-INVITE-002`, `UHM-PERF-001`,
`UHM-PERF-002`, `UHM-VERIFY-001`

## 1. Goal and acceptance criteria

### Goal and user-visible behavior

- Clicking a pending invite opens the channel's Accept/Reject view instead of a
  permanent chat skeleton.
- Selecting the invite returns the sidebar to the normal channel list, matching
  contact selection behavior.
- Loading UHM Chat does not initialize hidden emoji/GIPHY UI or call GIPHY before
  the user opens that picker.
- The E2EE bootstrap phase is painted before CPU-heavy initialization begins, so
  the UI communicates progress rather than remaining on the previous frame.

### Scope

- `apps/uhm-chat` navigation, bootstrap presentation, and global picker mounting.
- `packages/ermis-chat-react` message-list readiness for non-list overlays.
- Build and browser verification for the linked workspace sources.

### Exclusions

- Bellboy API/schema changes.
- Changing MLS correctness, recovery, Welcome processing, or KeyPackage target
  `100` / low watermark `50`.
- Moving OpenMLS WASM to a Web Worker. This is a possible future optimization,
  not an implicit dependency of this fix.
- Browser-extension errors such as Chrome `runtime.lastError`.

### Dependencies

- The active channel remains the source of truth in `ChatProvider`.
- Pending membership continues to render `PendingOverlay` and must not query or
  expose protected message plaintext before acceptance.
- GIPHY remains optional and requires `VITE_GIPHY_API_KEY` when opened.

### Acceptance criteria

1. A pending channel can reach the visible `PendingOverlay` and its Accept/Reject
   actions; no readiness gate waits for a DOM node that the overlay intentionally
   does not render.
2. Invite selection calls both `setActiveChannel(channel)` and the panel's
   `onBack()` callback.
3. Closed pickers render no emoji tree, sticker iframe, or GIPHY component; no
   GIPHY fetch occurs until the GIPHY picker is explicitly opened.
4. Missing `VITE_GIPHY_API_KEY` renders the existing not-configured state without
   trying a built-in third-party key.
5. SDK React build and UHM production build pass. A real browser invite click and
   cold-start performance capture remain required before release closure.

## 2. Verified facts, assumptions, and constraints

### Verified facts (2026-09-19 source review)

- `InvitesPanel` only called `setActiveChannel`; unlike `ContactsPanel`, it did
  not call `onBack`.
- `ChatPage` adds a `z-[50]` skeleton whenever the URL has a channel and
  `isMessageListReady` is false.
- `VirtualMessageList` renders `PendingOverlay` before rendering its normal
  `.ermis-message-list` container. `useChannelMessages.fadeListIn()` returned
  immediately when that container ref was absent, so `onReady` never fired.
- `GlobalPickers` mounted `GiphyPicker` even when its wrapper used
  `display:none`; `GiphyPicker` fetches trending items from its mount effect.
- When no environment key existed, `GiphyPicker` used a built-in key. The
  reported deployment shows that request returning HTTP 401.
- Bellboy uses permissive CORS in current source. The screenshot uses a
  same-origin `/bellboy-api` URL, so it does not establish CORS preflight as the
  cause of the permanent skeleton or main-thread stalls.
- E2EE initialization awaits recovery metadata, KeyPackage inventory/refill,
  local group restore, and provider persistence before setting the app ready.
  KeyPackage generation is synchronous WASM work, but the screenshot alone does
  not prove which E2EE step accounts for the reported 4.147 s submit handler.

### Assumptions to verify in a live browser

- The pending invite in the report uses membership role `pending` and therefore
  follows the inspected `PendingOverlay` path.
- The deployed bundle matches the reviewed branch/artifacts.
- Remaining cold-start stalls after lazy picker mounting occur inside E2EE/WASM
  or IndexedDB work rather than an unobserved deployment proxy/network issue.

### Product preferences and technical constraints

- Invite actions must remain explicit; selecting an invite must not auto-accept.
- E2EE initialization remains fail-closed.
- KeyPackage availability cannot be made eventual merely to improve first paint;
  a background-refill design needs a separate correctness and rollout decision.

## 3. Design and call paths

### Invite selection and readiness

```text
InvitesPanel row click
  -> setActiveChannel(channel)
  -> onBack()
  -> ChatPage syncs channel into URL
  -> VirtualMessageList detects pending membership
  -> useChannelMessages completes pending channel query/setup
  -> fadeListIn sees no message-list DOM
  -> signal onReady directly
  -> ChatPage removes URL skeleton
  -> PendingOverlay Accept/Reject is visible
```

The missing-container path represents a valid overlay, not a rendering failure.
The readiness callback therefore runs without opacity/scroll work. Normal message
lists keep their existing delayed scroll-and-fade sequence.

### Picker lifecycle

```text
App startup -> GlobalPickers container only -> no picker subtree -> no GIPHY I/O
User opens GIPHY -> mount GiphyPicker -> validate env keys -> fetch or local error
User closes picker -> unmount picker subtree
```

### Bootstrap presentation

```text
connectUser complete -> set phase=e2ee -> browser paint opportunity
  -> initialize OpenMLS/E2EE with existing fail-closed ordering -> ready
```

This changes presentation scheduling only. It does not move cryptographic work to
the background or report the session ready early.

### API, schema, and state changes

- API: none.
- Schema/storage: none.
- React state: invite selection also changes `activePanel` through `onBack`;
  picker subtrees exist only while their picker type is open.
- Contract: `VirtualMessageList.onReady` also means that an intentional overlay
  is ready for interaction, not only that a virtualized message DOM has faded in.

## 4. Decisions, alternatives, compatibility, and rollback

### Decisions

- Fix readiness in the shared React hook because banned/blocked/skipped/closed
  overlays can have the same absent-container shape.
- Keep the pending invite query and E2EE role checks unchanged.
- Remove the undocumented GIPHY fallback credential; configuration must be
  explicit.
- Keep KeyPackage target/refill policy unchanged pending live timing evidence.

### Rejected alternatives

- **Disable the ChatPage skeleton for all URL channels:** hides the symptom but
  reintroduces stale-message and scroll flashes for real message lists.
- **Auto-accept when an invite row is clicked:** changes product/security behavior
  and removes the explicit user decision.
- **Treat the Bellboy recovery-vault 400 or GIPHY 401 as the invite blocker:** the
  source-level readiness deadlock exists independently of both requests.
- **Background all E2EE initialization:** could render a device ready before it
  has durable identity/provider/KeyPackages and needs a separate design.

### Compatibility and rollback

- No server or persisted-data compatibility change.
- Old and new servers receive the same chat/E2EE requests.
- Rollback is a source revert of the three UI/shared-React changes; no data
  rollback is required.

## 5. Performance and cost model

| Path                 | Current cost                                                                                                     | Proposed cost                                                                         | Gate                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Pending invite open  | One channel query plus a readiness state that can remain blocked forever; no useful message-list DOM             | Same network round trips and `O(1)` readiness notification after the overlay is ready | Overlay visible and actionable                     |
| Closed global picker | Emoji component mount plus GIPHY mount/fetch; GIPHY payload up to 30 results                                     | `O(1)` dormant container, zero picker network round trips                             | No GIPHY request before open                       |
| Open GIPHY picker    | One request returning up to 30 results                                                                           | Same with configured key; zero requests and local error if unconfigured               | 2xx with configured key or local not-configured UI |
| E2EE bootstrap       | Sequential network/storage work; possible synchronous generation of up to 100 KeyPackages and WASM serialization | Same time/memory/round trips; one browser paint yield before work                     | Live marks/profile required before deeper change   |

- Memory: removing closed picker trees reduces startup DOM/component memory; the
  invite change is `O(1)` memory.
- Network: removes one unsolicited GIPHY request. Chat/Bellboy round trips are
  unchanged.
- Worst-case third-party payload removed from startup: 30 GIPHY result records
  plus image metadata; image bytes depend on browser loading policy.
- Contention/hot partitions: unchanged. Bellboy KeyPackage device inventory is
  deliberately not modified.
- Horizontal/vertical scaling: no backend effect. Client startup work is reduced
  per browser session; remaining WASM CPU cost scales vertically with the device.
- Benchmark gate: cold reload with DevTools Performance/Network, three runs each;
  zero startup GIPHY calls, no permanent invite skeleton, and capture durations
  for `connectUser`, WASM load, recovery-vault lookup, KeyPackage refill, group
  restore, and provider persistence. Numerical p95 thresholds are `unverified`
  until representative deployment traces exist.

## 6. Requirement-to-source/test mapping

| ID               | Repository            | Files / symbols                                                                                                                 | Evidence                                                           |
| ---------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `UHM-INVITE-001` | `ermis-chat-monorepo` | `packages/ermis-chat-react/src/hooks/useChannelMessages.ts` `fadeListIn`; `apps/uhm-chat/src/pages/ChatPage.tsx` readiness gate | React package build; live pending invite browser gate `unverified` |
| `UHM-INVITE-002` | `ermis-chat-monorepo` | `apps/uhm-chat/src/features/chat/InvitesPanel.tsx` selection callback                                                           | UHM TypeScript/build; browser panel navigation `unverified`        |
| `UHM-PERF-001`   | `ermis-chat-monorepo` | `apps/uhm-chat/src/features/chat/GlobalPickers.tsx`; `GiphyPicker.tsx` key resolution/fetch guard                               | UHM build; cold-start Network capture `unverified`                 |
| `UHM-PERF-002`   | `ermis-chat-monorepo` | `apps/uhm-chat/src/App.tsx` bootstrap scheduling; `EncryptionManager.initialize` reviewed but unchanged                         | UHM build; live CPU trace `unverified`                             |
| `UHM-VERIFY-001` | `ermis-chat-monorepo` | all above plus generated workspace packages                                                                                     | Commands recorded below                                            |

## 7. Verification evidence

Evidence is appended; failed results are retained rather than replaced.

| Date       | Command / artifact                                                                                                                             | Result                                                                                                                                                                                                                          |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-19 | Source call-path review from invite click through `ChatPage`, `VirtualMessageList`, and `useChannelMessages`                                   | Pass: absent message-list ref prevents `onReady` on pending overlay                                                                                                                                                             |
| 2026-09-19 | Source review of `GlobalPickers` and `GiphyPicker`                                                                                             | Pass: hidden component mounted and initiated trending fetch with fallback key                                                                                                                                                   |
| 2026-09-19 | Screenshot console/network evidence supplied by reporter                                                                                       | GIPHY 401; recovery vault 400; handler violations 157 ms and 4147 ms. Artifact/source provenance not yet tied to a commit, so deployment conclusions remain `unverified`                                                        |
| 2026-09-19 | `yarn workspace @ermis-network/ermis-chat-react build`                                                                                         | Pass: CJS, ESM, CSS, sourcemaps, and DTS built; exit 0                                                                                                                                                                          |
| 2026-09-19 | Parallel first attempt: React build plus `yarn workspace uhm-chat build`                                                                       | Fail retained: UHM TypeScript could not resolve the React workspace while the parallel React build had deleted and not yet recreated `dist`; root cause was verification command ordering                                       |
| 2026-09-19 | Sequential retry: `yarn workspace uhm-chat build`                                                                                              | Pass: TypeScript plus Vite production/PWA build; 2,414 modules; exit 0. Existing warnings include a roughly 3,987 kB main JS chunk, 2,515.70 kB OpenMLS WASM asset, `lottie-web` direct `eval`, and ineffective dynamic imports |
| 2026-09-19 | Final provenance build: `yarn build:uhm`                                                                                                       | Pass: SDK, React, and UHM built sequentially from current sources; UHM transformed 2,414 modules and emitted `index-DCHuGKWu.js` 3,986.93 kB (1,053.39 kB gzip) plus OpenMLS WASM 2,515.70 kB (757.53 kB gzip); exit 0          |
| 2026-09-19 | `node --test packages/ermis-chat-react/test/call_eligibility.test.cjs packages/ermis-chat-react/test/last_message_preview.test.cjs`            | Pass: 8 passed, 0 failed, 0 skipped/cancelled/todo                                                                                                                                                                              |
| 2026-09-19 | First targeted UHM ESLint including `App.tsx`, picker files, and invite panel                                                                  | Fail retained: 14 errors; existing `App.tsx` empty-block/explicit-any findings plus picker hook findings. Picker findings were corrected; unrelated `App.tsx` baseline findings remain                                          |
| 2026-09-19 | `yarn workspace uhm-chat exec eslint src/features/chat/GiphyPicker.tsx src/features/chat/GlobalPickers.tsx src/features/chat/InvitesPanel.tsx` | Pass: exit 0                                                                                                                                                                                                                    |
| 2026-09-19 | `git diff --check`                                                                                                                             | Pass: exit 0                                                                                                                                                                                                                    |
| 2026-09-19 | Live deployed/local browser invite and performance trace                                                                                       | `unverified`                                                                                                                                                                                                                    |

Source provenance at investigation start:

- `ermis-chat-monorepo` branch `feature/key-package`, HEAD
  `4d730d1235259ae81b8f8e7980033e178cd38920`, clean worktree.
- Bellboy was read only for contract/CORS context; branch `feat/attachment`, HEAD
  `4ca521bc7abf59cae60ebc54ee0a242a0214d644`.

## 8. Implementation journal

### 2026-09-19 — diagnosis and design

- Reproduced the permanent-skeleton condition from source: the pending overlay
  intentionally omits the ref required by the only `onReady` path.
- Separated the root UI blocker from unrelated/cascading console entries:
  Chrome extension `runtime.lastError`, optional GIPHY credential failure, and
  expected/missing recovery-vault lookup are not evidence of the invite blocker.
- Found startup-only hidden work: closed global pickers still mount, and GIPHY
  fetches immediately.
- Chose shared overlay readiness plus consumer navigation and lazy picker mount.
- Declined to weaken E2EE/KeyPackage readiness without phase-level production
  timing and correctness evidence.

### 2026-09-19 — local implementation and verification

- Updated shared message readiness so intentional overlays notify consumers even
  without a virtual-list container. Normal message lists retain their existing
  scroll/fade delay.
- Made invite selection close the panel after activating the selected channel.
- Removed closed-picker component trees and the undocumented fallback GIPHY key;
  an unconfigured picker now fails locally without a third-party request.
- Added a browser paint opportunity between successful connection and synchronous
  OpenMLS/E2EE initialization without moving any security prerequisite into the
  background.
- The first parallel build exposed a `dist` delete/recreate race. The React build
  completed, and a sequential UHM retry passed.
- Scoped picker/invite lint, existing React tests, and whitespace checks passed.
  A broad targeted lint that included `App.tsx` still reports unrelated existing
  empty-block/explicit-any debt; this is not treated as passing evidence.

## 9. Status, risks, closure, and handoff

### Current status

- Local implementation is complete and package/application builds pass.
- Ledger items remain open because a real browser invite click, cold-start
  Network capture, and phase-level performance trace are still `unverified`.

### Known limitations and product risks

- The screenshot is not sufficient to attribute the full four-second stall to a
  specific E2EE phase.
- Hidden-picker removal cannot eliminate synchronous WASM work.
- A server deployment with a missing/invalid GIPHY key will show the existing
  local configuration message only when the picker is opened.

### Closure conditions

- Close implementation IDs only when source and builds agree.
- Close `UHM-VERIFY-001` only after a real pending invite shows Accept/Reject and
  Network proves no GIPHY request occurs before picker open.
- Any future Web Worker or staged KeyPackage refill work must have its own
  canonical plan/ledger item and must not be silently treated as a dependency of
  this fix.

### Handoff / next steps

1. Deploy the exact built artifact to TEST and capture invite/Network/Performance
   evidence before claiming rollout completion.
2. If the four-second stall remains, profile the E2EE bootstrap phases before
   choosing Web Worker, code splitting, or staged KeyPackage refill work.
