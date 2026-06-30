# React + TypeScript + Vite

## UHM Chat E2EE Runtime Notes

- `public/openmls_wasm_bg.wasm` must be published with the app. `App.tsx` loads this binary through `loadOpenMlsWasm()` after `connectUser`; the OpenMLS JS glue comes from the SDK bundle so SDK logger settings cover OpenMLS glue logs. The legacy public OpenMLS JS glue copies are logger-safe for direct/older asset loads.
- `public/e2ee-media-stream-worker.js` is the optional E2EE video streaming worker. It is feature-flagged off by default; enable only after R2 single/concurrent range and CORS gates pass. The worker intercepts only `/__ermis/e2ee-media/*` virtual URLs and keeps decrypted frames in memory only.
- `public/wasm_worker.worker.mjs` must be copied from the SDK `dist` after building or installing a published SDK. The worker forwards WASM logs through the SDK logger bridge, so stale public copies can bypass `logger` and write to the browser console directly.
- E2EE controls stay disabled when `client.encryptionManager` is not initialized; standard chat continues to work.
- uhm-chat waits for `connectUser()` and encryption initialization before mounting the chat shell, preventing first-login channel queries with an unset auth token.
- E2EE direct/group creation uses the SDK encryption bundle flow. Group E2EE channels are always private.
- New E2EE direct/group channels default to Standard recovery (`e2ee_recovery_policy=member_assisted`) and can be created with Strict recovery (`self_owned_only`) from the create-channel modal.
- Existing standard channels can be upgraded from Channel Info by the owner when encryption is initialized; this path uses Standard recovery (`member_assisted`) by default.
- E2EE topics inherit encryption and recovery policy from the parent channel unless they are gated/own-group topics. Key rotation is exposed on parent E2EE channels for owners/moderators.
- Chat history PIN lives in the account menu. Users can set up, unlock, and change the PIN there; Channel Info repair only asks for the PIN when it is needed to continue.
- E2EE Channel Info exposes one conversation repair card. The app replays encrypted state for the selected conversation, restores any available history, asks for PIN only when needed, and keeps retry modes plus message-level diagnostics out of the primary UI.
- If replay cannot recover this device, Channel Info reveals the advanced reset action that reloads encrypted state on this device while keeping already shown messages.
- If this device has no PIN or has incomplete history restore, uhm-chat shows a soft PIN popup after login/app entry; a locked vault alone does not interrupt login.
- After the channel list loads, the SDK prepares all loaded E2EE channels in the background with sequential external join and reports progress through a compact secure-restore banner.
- Active E2EE channels show running/pending restore progress from local `restore_progress` records without creating fake messages.
- Permanent restore gaps are summarized in Chat history PIN settings instead of rendering warning banners or gap badges inside each channel.
- E2EE message rows and channel previews preserve sender display names from local user metadata when encrypted message cache entries only carry a raw user id.
- E2EE quoted replies render from local decrypted quote data when the server event only carries `quoted_message_id`; sticker quotes render as sticker previews instead of unavailable encrypted placeholders.
- SDK and app work now uses this monorepo as the source of truth: `packages/ermis-chat-sdk` and `apps/uhm-chat`.
- E2EE edits use latest-snapshot same-id updates. The old secondary edit-record model is no longer part of the active client contract.

## Progress Log

### 2026-06-19 - production E2EE sender display names

- Goal: fix new encrypted messages in UHM Chat showing the current user's raw id instead of the display name/email in timeline/channel previews.
- Code changed: SDK encrypted send/decrypt/hydrate paths now persist own message user metadata and pick a local user object with a useful display name before falling back to ids; UHM consumes the corrected SDK message state without app-level UI changes.
- Docs changed: this README records the app behavior. SDK and React README files record the package-level behavior. SQL, Postman, and Bellboy docs are unchanged because Bellboy still stores and emits the same message/user envelope.
- Design decision: sender display preservation is client-local E2EE hydration behavior; the server remains a relay and does not need extra plaintext display-name fields.
- Performance: the fix adds only `O(C)` constant-candidate user selection per hydrated encrypted message, with no additional IndexedDB transactions, network requests, backend DB round trips, server payload growth, hot partitions, or contention.
- Verification: `npm run build:sdk`, `npm run build:react`, `yarn workspace uhm-chat build`, and `yarn workspace @ermis-network/ermis-chat-sdk test:repair` passed.

### 2026-06-19 - production E2EE quoted reply previews

- Goal: fix reply previews in UHM Chat where own replies had no quote UI and the other participant saw `Message unavailable`.
- Code changed: SDK optimistic/decrypted/local-cache message hydration now attaches available quoted-message plaintext from active state or IndexedDB, including sticker quotes stored as `type: 'sticker'`. React `MessageItem` falls back to active channel state when `quoted_message` is missing or only has an encrypted envelope, and `QuotedMessagePreview` renders stickers/attachments before checking encrypted-unavailable fallback. Reply/search jump scrolling now uses rendered VList indexes that include date separators. Realtime E2EE events now overlay IndexedDB cache entries only for the currently rendered message IDs and their quoted IDs, while full 100-message cache hydration remains limited to open/recovery flows. The message list now reads live VList bottom metrics, snaps appended own/incoming messages before paint when the viewer is at the bottom, temporarily blocks scroll-triggered pagination during that snap window, and disables browser scroll anchoring so reply sends do not briefly jump to the quoted `hahaha`-style message before returning to the newest message.
- Docs changed: this README records the app behavior. SDK and React README files record the package-level changes. SQL, Postman, and Bellboy docs are unchanged because Bellboy still stores and emits the same reply metadata.
- Design decision: quoted plaintext remains client-local for E2EE; the server contract stays metadata-only with `quoted_message_id`. Full local-cache windows are for channel open/recovery, not realtime append/update, so persisted history cannot reset the virtualized list anchor. Scroll state stays frontend-only and must account for virtualized non-message children, input reply-preview height changes, transient VList offsets during append, and browser scroll anchoring.
- Performance: send/decrypt adds at most one local quote lookup, history hydration remains `O(M + Q)`, explicit jump index calculation is `O(M)` over loaded messages, realtime cache overlay is bounded to visible message IDs plus quoted IDs (`O(V + Q)`) instead of a fixed 100-message IndexedDB window, and realtime bottom checks are `O(1)` VList metric reads; no additional network requests, backend DB round trips, server payload growth, hot partitions, or contention.
- Verification: `npm run build:sdk`, `npm run build:react`, `yarn workspace uhm-chat build`, and `yarn workspace @ermis-network/ermis-chat-sdk test:repair` passed. The latest scroll refinement was reverified with `npm run build:react` and a sequential `yarn workspace uhm-chat build`.

### 2026-06-19 - production PIN settings restore diagnostics

- Goal: move unavailable-history warnings out of per-channel UI and into Chat history PIN settings with channel-level details.
- Code changed: `UhmRecoveryPinDialog` now shows a compact "Some history unavailable" panel above Change PIN with a Details dropdown listing affected channels, message counts, epochs, and primary reasons; `ChatPage` no longer renders permanent-gap channel badges or timeline banners.
- Docs changed: this README records the account-level diagnostics UX. SDK and React README files record the recovery status field that carries issue-bearing restore progress.
- Design decision: restore progress that is currently running remains visible in the active channel, while terminal/unavailable history moves to the PIN settings surface to reduce repeated channel-level warnings.
- Performance: status refresh keeps `O(I + G)` time and memory where `I` is incomplete restore records and `G` is done-with-gap records from IndexedDB; it adds no network requests, server payload growth, database hot partitions, or backend contention.
- Verification: `npm run build:sdk`, `npm run build:react`, `yarn workspace uhm-chat build`, and `yarn workspace @ermis-network/ermis-chat-sdk test:repair` passed.

### 2026-06-17 - production encryption naming cleanup

- Goal: align uhm-chat with the SDK breaking rename from MLS-facing integration names to encryption-facing names.
- Code changed: app bootstrap and E2EE UI paths now instantiate `EncryptionManager` and read `client.encryptionManager`; user-visible copy no longer says MLS initialized except OpenMLS runtime notes.
- Docs changed: this README records the app integration rename and explicitly keeps OpenMLS/WASM asset names unchanged.
- Design decision: app code should use product-level encryption naming while server-owned `mls_*` fields and OpenMLS asset names stay stable.
- Performance: startup, channel navigation, repair, IndexedDB, network round trips, payload sizes, and scaling behavior are unchanged.
- Verification: `npm run build:sdk`, `npm run build:react`, `yarn workspace uhm-chat build`, static forbidden-name checks, and Node SDK export smoke test passed. Targeted UHM ESLint was attempted but remains blocked by existing no-explicit-any/react-hooks lint findings in `App.tsx`, `CustomCreateChannelModal.tsx`, `ChatPage.tsx`, and `UhmAddMemberModal.tsx`.

### 2026-06-17 - production PIN lazy unlock and ready-channel navigation

- Goal: keep recovery PIN prompts tied to real recovery work and avoid redundant E2EE scope sync when users click channels that are already ready.
- Code changed: app behavior already scopes the login gate to missing PIN setup or incomplete restore, and Channel Info repair opens the repair PIN dialog only when SDK repair returns `requiresPin`.
- Docs changed: this README records that locked vault alone is not enough to show the login PIN gate; the SDK README records the channel-open sync guard.
- Design decision: users can still open account PIN controls manually for setup/unlock/change, while passive reload/navigation stays uninterrupted when no restore work is pending.
- Verification: `npm run build:uhm` passed. Targeted `yarn workspace uhm-chat exec eslint src/pages/ChatPage.tsx src/features/chat/UhmChannelInfoActions.tsx` was attempted but is blocked by existing `ChatPage.tsx` lint errors; neither file has code diffs in this change.

### 2026-06-16 - production SDK logger assets

- Goal: keep uhm-chat's published/copied WASM worker assets aligned with SDK logger behavior.
- Artifact changed: refreshed `apps/uhm-chat/public/wasm_worker.worker.mjs` from the SDK `dist` worker and made public OpenMLS JS glue copies use `globalThis.__ermisSdkLog` so copied/published WASM assets do not write to `console.*` directly.
- Docs changed: clarified that OpenMLS uses the public `.wasm` binary with SDK-bundled JS glue, while the Direct Call worker is a public asset that must be refreshed from the published SDK.
- Verification: `yarn workspace uhm-chat build` passed after the asset refresh.

### 2026-06-16 - production

- Goal: make the E2EE recovery policy explicit in the Uhm create-channel flow.
- Code changed: `CustomCreateChannelModal` now defaults to Standard recovery (`member_assisted`) and shows a compact Standard/Strict recovery selector when E2EE is enabled.
- Code changed: Channel Info enable E2EE uses Standard recovery by default, and topic creation relies on parent-policy inheritance for normal non-gated topics.
- UI copy: `Standard recovery: members can help preserve encrypted history; only your PIN can unlock it.` and `Strict recovery: history can only be recovered from archives created by your own devices; some history may be unavailable if all your devices were offline.`
- Design decision: Uhm keeps member-assisted recovery as the default while making the stricter self-owned policy selectable before channel creation.
- Verification: `yarn workspace uhm-chat build` passed.

### 2026-06-13 - production

- Goal: align Recovery PIN and conversation repair content with a WhatsApp-style chat-history flow.
- Code changed: `UhmRecoveryPinDialog` now has a repair context so Channel Info repair asks for PIN with simple continue/setup copy instead of account/vault wording.
- Code changed: English and Vietnamese recovery/repair copy now talks about chat history, this device, and restoration; archive/epoch/vault terms are kept out of normal UI and only technical fields remain inside the explicit details section.
- Docs changed: this README now records the account-menu PIN entry point, one-button conversation repair, and simplified content direction.
- Design decision: keep the user-facing flow focused on “restore available chat history”; message-level counts and crypto details stay behind the detail row.
- Verification: `jq empty apps/uhm-chat/src/locales/en.json apps/uhm-chat/src/locales/vi.json`, targeted `yarn workspace uhm-chat exec eslint`, and `yarn workspace uhm-chat build` passed.

### 2026-06-13 - production

- Goal: wire Channel Info Repair to SDK safe-cursor replay/reset instead of calling archive recheck directly.
- Code changed: `UhmChannelInfoActions` now calls `repairEncryptedChannel(..., { mode: 'replay' })`, opens the PIN dialog only when the SDK returns `requiresPin`, and shows `Reset encrypted state on this device` only when `resetAvailable` is returned.
- Code changed: EN/VI copy adds reset status, reset warning, and PIN-required repair text while keeping the primary card conversation-focused.
- Design decision: users see one normal Repair button. The app handles replay, pending snapshots, and archive repair internally; reset remains an advanced fallback after replay fails.
- Verification: `yarn workspace uhm-chat build` passed; targeted ESLint for `UhmChannelInfoActions.tsx` passed with locale JSON ignored by repo config.

### 2026-05-22 - production

- Goal: expose PIN Epoch Archive V1 in `apps/uhm-chat` after the backend/SDK contract landed.
- Code changed: added a localized `UhmRecoveryPinDialog`, wired a recovery PIN icon into E2EE channel headers, added PIN configuration constants, and registered English/Vietnamese copy.
- Docs changed: this README now records the uhm-chat PIN recovery entry point and behavior.
- Design decision: uhm-chat renders its own i18n-aware PIN dialog instead of using the generic React UI RecoveryPin component, whose current labels are package-level English defaults.
- Verification: `yarn workspace uhm-chat build` passed.

### 2026-06-01 - production

- Goal: wire v2.3 PIN restore progress into the real uhm-chat UX.
- Code changed: added a soft recovery gate mode to `UhmRecoveryPinDialog`, opened it when SDK recovery status reports unfinished restore, enqueued active-channel restore when unlocked, and rendered active-channel restore badges plus permanent-gap banners.
- Design decision: restore remains sequential in the SDK; the app prompts for PIN only to unlock the recovery vault, then lets the queue process channel history in the background.
- Verification: `npm run build:uhm` passed.

### 2026-06-01 - production

- Goal: fix recovery gate visibility and first-restore behavior found in manual multi-device testing.
- Code changed: the login/app-entry gate now opens for locked recovery status even when this new device has no prior `restore_progress` record; gate mode supports both PIN setup and unlock copy; active E2EE channels without progress can enqueue restore or prompt PIN when opened.
- Design decision: the prompt remains soft-blocking with “later” behavior, but setup is now encouraged early because epochs sent before any vault/archive exists cannot be recreated cryptographically.
- Verification: `npm run build:uhm` passed.

### 2026-06-05 - production

- Goal: prevent active-channel entry from re-triggering PIN history restore after reload when the channel's restore progress is already terminal locally.
- Code changed: `ChatPage` now waits for the active channel's local `restore_progress` lookup before enqueueing active restore, and restore progress events mark the active CID as checked.
- Design decision: uhm-chat treats stored `done`/`done_with_gaps` progress as the source of truth for automatic active restore prompts; manual range restore remains available from the PIN dialog.
- Verification: `yarn workspace @ermis-network/ermis-chat-sdk types`, `yarn workspace @ermis-network/ermis-chat-sdk build`, and `yarn workspace uhm-chat build` passed.

### 2026-06-05 - production

- Goal: stop the recovery PIN popup from appearing on every reload once local history restore is already complete.
- Code changed: the app-entry recovery gate now opens only when SDK recovery status reports incomplete restore work, and active-channel fallback prompts only for CIDs in `incompleteChannels`.
- Design decision: a locked vault alone is not enough reason to interrupt login; PIN entry is requested for restore work, while manual setup/change/restore remains available from the header action.
- Verification: `yarn workspace @ermis-network/ermis-chat-sdk types`, `yarn workspace @ermis-network/ermis-chat-sdk build`, and `yarn workspace uhm-chat build` passed.

### 2026-06-01 - production

- Goal: remove confusing “0 channels unfinished” recovery copy and align app UX with deferred archive setup.
- Code changed: locked-vault gate copy now uses generic secure archive setup wording when there are no incomplete restore records, while incomplete channels still show the count-specific restore prompt.
- Verification: `npm run build:uhm` passed.

### 2026-06-01 - production

- Goal: fix first-login `/channels` 401 races and make new devices prepare all loaded E2EE channels without requiring channel clicks.
- Code changed: app bootstrap now waits for `connectUser()` and encryption initialization before rendering `ChatPage`, and uhm-chat renders a compact secure-restore preparation banner while the SDK external-joins loaded E2EE channels in the background.
- Design decision: auth/token readiness is hard-gated before ChannelList mounts, while external join and restore preparation remain non-blocking once the chat shell is visible.
- Verification: `npm run build:uhm` passed.

### 2026-06-01 - production

- Goal: fix empty-cache reload on `/chat` getting stuck on the bootstrap screen.
- Code changed: `AuthRoute` now redirects unauthenticated users to `/login` before showing the authenticated bootstrap screen.
- Design decision: bootstrap screen is only for an existing authenticated session that is still connecting/preparing E2EE; missing tokens should always go to login.
- Verification: `npm run build:uhm` passed.

### 2026-05-15 - production

- Goal: move SDK/app E2EE update work to the monorepo source of truth.
- Code changed: `packages/ermis-chat-sdk` now handles E2EE edits as same-id latest snapshots with encrypted `old_texts`, version-aware decrypt dedup, and metadata sync update decrypts. Removed stale secondary-edit-record handling from SDK source and aligned `apps/uhm-chat` notes with the monorepo workflow.
- Verification: run SDK/react/app type and build commands after implementation.

### 2026-05-15 - production

- Goal: add missing E2EE UI/UX to `apps/uhm-chat` without replacing existing optimized app and React SDK flows.
- Code changed: initialized encryption in app login/restore flow, published OpenMLS WASM assets, added E2EE channel creation and standard-channel enable controls, decrypted-message refresh, encrypted placeholders, add/remove member E2EE paths, E2EE badges, inherited topic notice, and key rotation controls.
- Docs changed: this README now records OpenMLS runtime requirements and E2EE UI behavior.
- Verification: run SDK/react/app type and build commands after implementation.

### 2026-05-15 - production

- Goal: fix direct `messaging` E2EE channel creation diagnostics.
- Code changed: SDK now rejects E2EE channel creation before the channel create request when any selected recipient has no uploaded KeyPackages, avoiding invalid encryption bundles with an empty `welcome`.
- Verification: `yarn workspace @ermis-network/ermis-chat-sdk types` passed.

### 2026-05-15 - production

- Goal: fix E2EE message hydration after reactions/reload.
- Code changed: React message hydration now overlays IndexedDB plaintext cache onto the SDK message list. SDK decrypt replay avoids a second decrypt attempt after OpenMLS has deleted the consumed secret.
- Verification: `yarn workspace @ermis-network/ermis-chat-sdk types`, `yarn workspace @ermis-network/ermis-chat-sdk build`, `yarn workspace @ermis-network/ermis-chat-react build`, and `yarn workspace uhm-chat build` passed.

### 2026-05-15 - production

- Goal: prevent channel query responses from overwriting local decrypted E2EE messages.
- Code changed: SDK channel query and message pagination now hydrate server-returned encryption envelopes from the local E2EE message cache before writing into `ChannelState`.
- Verification: `yarn workspace @ermis-network/ermis-chat-sdk types`, `yarn workspace @ermis-network/ermis-chat-sdk build`, `yarn workspace @ermis-network/ermis-chat-react build`, and `yarn workspace uhm-chat build` passed.

### 2026-05-15 - production

- Goal: implement a more efficient local-first E2EE message fetch/reconcile path.
- Code changed: encryption storage now supports batch message lookup in one IndexedDB transaction; `Channel` seeds E2EE state from local cache before non-windowed queries and reconciles query/pagination/search results with cached plaintext. React listens for local-cache seed events and asks the SDK state for messages instead of relying on server envelopes.
- Verification: `yarn workspace @ermis-network/ermis-chat-sdk types`, `yarn workspace @ermis-network/ermis-chat-sdk build`, `yarn workspace @ermis-network/ermis-chat-react build`, and `yarn workspace uhm-chat build` passed.

### 2026-05-15 - production

- Goal: fix repeated E2EE sync reaction events after reload.
- Code changed: durable sync cursor now advances past the processed server `next_cursor` when a page is fully handled and unbuffered. This avoids re-fetching the same metadata event on the next sync when the backend treats the cursor as inclusive, while still preserving the old cursor when encrypted messages remain buffered.
- Verification: `yarn workspace @ermis-network/ermis-chat-sdk types`, `yarn workspace @ermis-network/ermis-chat-sdk build`, `yarn workspace @ermis-network/ermis-chat-react build`, and `yarn workspace uhm-chat build` passed.

### 2026-05-15 - production

- Goal: prevent consumed encryption application messages from blocking metadata sync after new reactions.
- Code changed: waterfall sync now treats forward-secrecy/secret-consumed decrypt errors as non-buffering consumed messages, allowing cursor advancement instead of replaying later reaction events forever.
- Verification: `yarn workspace @ermis-network/ermis-chat-sdk types`, `yarn workspace @ermis-network/ermis-chat-sdk build`, `yarn workspace @ermis-network/ermis-chat-react build`, and `yarn workspace uhm-chat build` passed.

### 2026-05-15 - production

- Goal: stop channel query envelopes from overwriting already-rendered local plaintext.
- Code changed: `Channel` hydration now falls back to current `ChannelState` plaintext when IndexedDB does not have a matching decrypted record yet, and the shared message-list merge utility preserves decrypted plaintext fields when a later server encryption envelope with the same ID arrives.
- Verification: `yarn workspace @ermis-network/ermis-chat-sdk types`, `yarn workspace @ermis-network/ermis-chat-sdk build`, `yarn workspace @ermis-network/ermis-chat-react build`, and `yarn workspace uhm-chat build` passed.

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

## E2EE Recovery Notes

- The single Channel Info `Repair` action now runs archive-first recovery, safe-cursor replay, pending ciphertext flush, and a final archive recheck.
- `Reset encrypted state on this device` appears only after protocol replay fails, not merely because some history has no archive.
- PIN unlock automatically rechecks accepted encrypted conversations once per unlock session.
- Bellboy V2 archive availability is rolled out behind server backfill; this does not change the PIN or one-button Repair UX.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
]);
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x';
import reactDom from 'eslint-plugin-react-dom';

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
]);
```
