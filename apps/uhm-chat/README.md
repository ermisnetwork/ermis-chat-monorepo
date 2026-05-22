# React + TypeScript + Vite

## UHM Chat E2EE Runtime Notes

- `public/openmls_wasm*` must be published with the app. `App.tsx` loads `/openmls_wasm_bg.wasm` through `loadOpenMlsWasm()` after `connectUser`.
- E2EE controls stay disabled when `client.mlsManager` is not initialized; standard chat continues to work.
- E2EE direct/group creation uses the SDK MLS bundle flow. Group E2EE channels are always private.
- Existing standard channels can be upgraded from Channel Info by the owner when MLS is initialized.
- E2EE topics inherit encryption from the parent channel. Key rotation is exposed on parent E2EE channels for owners/moderators.
- PIN Epoch Archive V1 is exposed from E2EE channel headers. Users can create/unlock/change a recovery PIN and restore historical messages by epoch range.
- SDK and app work now uses this monorepo as the source of truth: `packages/ermis-chat-sdk` and `apps/uhm-chat`.
- E2EE edits use latest-snapshot same-id updates. The old secondary edit-record model is no longer part of the active client contract.

## Progress Log

### 2026-05-22 - production

- Goal: expose PIN Epoch Archive V1 in `apps/uhm-chat` after the backend/SDK contract landed.
- Code changed: added a localized `UhmRecoveryPinDialog`, wired a recovery PIN icon into E2EE channel headers, added PIN configuration constants, and registered English/Vietnamese copy.
- Docs changed: this README now records the uhm-chat PIN recovery entry point and behavior.
- Design decision: uhm-chat renders its own i18n-aware PIN dialog instead of using the generic React UI RecoveryPin component, whose current labels are package-level English defaults.
- Verification: `yarn workspace uhm-chat build` passed.

### 2026-05-15 - production

- Goal: move SDK/app E2EE update work to the monorepo source of truth.
- Code changed: `packages/ermis-chat-sdk` now handles E2EE edits as same-id latest snapshots with encrypted `old_texts`, version-aware decrypt dedup, and metadata sync update decrypts. Removed stale secondary-edit-record handling from SDK source and aligned `apps/uhm-chat` notes with the monorepo workflow.
- Verification: run SDK/react/app type and build commands after implementation.

### 2026-05-15 - production

- Goal: add missing E2EE UI/UX to `apps/uhm-chat` without replacing existing optimized app and React SDK flows.
- Code changed: initialized MLS in app login/restore flow, published OpenMLS WASM assets, added E2EE channel creation and standard-channel enable controls, decrypted-message refresh, encrypted placeholders, add/remove member E2EE paths, E2EE badges, inherited topic notice, and key rotation controls.
- Docs changed: this README now records OpenMLS runtime requirements and E2EE UI behavior.
- Verification: run SDK/react/app type and build commands after implementation.

### 2026-05-15 - production

- Goal: fix direct `messaging` E2EE channel creation diagnostics.
- Code changed: SDK now rejects E2EE channel creation before the channel create request when any selected recipient has no uploaded KeyPackages, avoiding invalid MLS bundles with an empty `welcome`.
- Verification: `yarn workspace @ermis-network/ermis-chat-sdk types` passed.

### 2026-05-15 - production

- Goal: fix E2EE message hydration after reactions/reload.
- Code changed: React message hydration now overlays IndexedDB plaintext cache onto the SDK message list. SDK decrypt replay avoids a second decrypt attempt after OpenMLS has deleted the consumed secret.
- Verification: `yarn workspace @ermis-network/ermis-chat-sdk types`, `yarn workspace @ermis-network/ermis-chat-sdk build`, `yarn workspace @ermis-network/ermis-chat-react build`, and `yarn workspace uhm-chat build` passed.

### 2026-05-15 - production

- Goal: prevent channel query responses from overwriting local decrypted E2EE messages.
- Code changed: SDK channel query and message pagination now hydrate server-returned MLS envelopes from the local E2EE message cache before writing into `ChannelState`.
- Verification: `yarn workspace @ermis-network/ermis-chat-sdk types`, `yarn workspace @ermis-network/ermis-chat-sdk build`, `yarn workspace @ermis-network/ermis-chat-react build`, and `yarn workspace uhm-chat build` passed.

### 2026-05-15 - production

- Goal: implement a more efficient local-first E2EE message fetch/reconcile path.
- Code changed: MLS storage now supports batch message lookup in one IndexedDB transaction; `Channel` seeds E2EE state from local cache before non-windowed queries and reconciles query/pagination/search results with cached plaintext. React listens for local-cache seed events and asks the SDK state for messages instead of relying on server envelopes.
- Verification: `yarn workspace @ermis-network/ermis-chat-sdk types`, `yarn workspace @ermis-network/ermis-chat-sdk build`, `yarn workspace @ermis-network/ermis-chat-react build`, and `yarn workspace uhm-chat build` passed.

### 2026-05-15 - production

- Goal: fix repeated E2EE sync reaction events after reload.
- Code changed: durable sync cursor now advances past the processed server `next_cursor` when a page is fully handled and unbuffered. This avoids re-fetching the same metadata event on the next sync when the backend treats the cursor as inclusive, while still preserving the old cursor when encrypted messages remain buffered.
- Verification: `yarn workspace @ermis-network/ermis-chat-sdk types`, `yarn workspace @ermis-network/ermis-chat-sdk build`, `yarn workspace @ermis-network/ermis-chat-react build`, and `yarn workspace uhm-chat build` passed.

### 2026-05-15 - production

- Goal: prevent consumed MLS application messages from blocking metadata sync after new reactions.
- Code changed: waterfall sync now treats forward-secrecy/secret-consumed decrypt errors as non-buffering consumed messages, allowing cursor advancement instead of replaying later reaction events forever.
- Verification: `yarn workspace @ermis-network/ermis-chat-sdk types`, `yarn workspace @ermis-network/ermis-chat-sdk build`, `yarn workspace @ermis-network/ermis-chat-react build`, and `yarn workspace uhm-chat build` passed.

### 2026-05-15 - production

- Goal: stop channel query envelopes from overwriting already-rendered local plaintext.
- Code changed: `Channel` hydration now falls back to current `ChannelState` plaintext when IndexedDB does not have a matching decrypted record yet, and the shared message-list merge utility preserves decrypted plaintext fields when a later server MLS envelope with the same ID arrives.
- Verification: `yarn workspace @ermis-network/ermis-chat-sdk types`, `yarn workspace @ermis-network/ermis-chat-sdk build`, `yarn workspace @ermis-network/ermis-chat-react build`, and `yarn workspace uhm-chat build` passed.

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

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
])
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

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
])
```
