# React + TypeScript + Vite

## UHM Chat E2EE Runtime Notes

- `public/openmls_wasm_bg.wasm` must be published with the app. `App.tsx` loads this binary through `loadOpenMlsWasm()` after `connectUser`; the OpenMLS JS glue comes from the SDK bundle so SDK logger settings cover OpenMLS glue logs. The legacy public OpenMLS JS glue copies are logger-safe for direct/older asset loads.
- `public/e2ee-media-stream-worker.js` is the E2EE video streaming worker. UHM enables native Service Worker range playback by default at bootstrap with `VITE_E2EE_MEDIA_STREAMING` defaulting to on; set `VITE_E2EE_MEDIA_STREAMING=false` to force the whole-blob fallback. Playback diagnostics default to on for current UHM validation and can be disabled with `VITE_E2EE_MEDIA_PLAYBACK_DEBUG=false`. The bootstrap only unregisters stale `e2ee-media-stream-worker.js` registrations, not the app PWA `sw.js` or unrelated Service Workers. The worker intercepts only `/__ermis/e2ee-media/*` virtual URLs and keeps decrypted frames in memory only.
- Large E2EE attachment upload can use multipart when `VITE_E2EE_ATTACHMENT_MULTIPART=true`. Multipart PUT concurrency defaults to `3` and can be tuned with `VITE_E2EE_ATTACHMENT_MULTIPART_CONCURRENCY`; the SDK clamps it to `1..4`, where `1` restores the old sequential PUT behavior. Optional upload diagnostics are enabled with `VITE_E2EE_ATTACHMENT_UPLOAD_DEBUG=true` or `localStorage.ermis_e2ee_attachment_upload_debug = "1"`.
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
- UHM defaults to SDK self-host mode (`VITE_ERMIS_SELF_HOSTED` unset or any value except `false`), so API key and project ID env vars are optional. Set `VITE_ERMIS_SELF_HOSTED=false` for cloud mode, where `VITE_API_KEY` and `VITE_CHAT_PROJECT_ID` are required.
- UHM uses `ermis_end_user` v1 for auth and profile APIs. `VITE_USS_API_URL` may be the root host, `/v1`, or legacy `/uss/v1`; the SDK normalizes it to `/v1`.
- UHM persists v1 `refresh_token` after OTP/Google login. The SDK refreshes expired access tokens automatically and writes rotated tokens back to localStorage through `onTokenRefresh`.
- UserPicker is search-driven for v1. It seeds from `client.state.users` and active friend channels on mount, does not call `queryUsers()`, and only performs remote user search when the search box is non-empty.
- After the channel list loads, the SDK prepares all loaded E2EE channels in the background with sequential external join and reports progress through a compact secure-restore banner.
- Active E2EE channels show running/pending restore progress from local `restore_progress` records without creating fake messages.
- Permanent restore gaps are summarized in Chat history PIN settings instead of rendering warning banners or gap badges inside each channel.
- E2EE message rows and channel previews preserve sender display names from local user metadata when encrypted message cache entries only carry a raw user id.
- E2EE quoted replies render from local decrypted quote data when the server event only carries `quoted_message_id`; sticker quotes render as sticker previews instead of unavailable encrypted placeholders.
- SDK and app work now uses this monorepo as the source of truth: `packages/ermis-chat-sdk` and `apps/uhm-chat`.
- E2EE edits use latest-snapshot same-id updates. The old secondary edit-record model is no longer part of the active client contract.

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
