# @ermis-network/ermis-chat-sdk — external distribution

Compiled core SDK for the standalone `uhm-chat-external` application.

```bash
yarn add @ermis-network/ermis-chat-sdk@2.1.0-external.2
```

## Supported E2EE scope

- Live MLS group creation, welcome and external join.
- Ordered proposal/commit processing, reconnect/offline sync, member add/remove, and key rotation.
- Encrypted message and attachment handling, multipart upload, media streaming, and device-local replay/reset.
- `loadOpenMlsWasm()` with a live-only public TypeScript contract.

Account PIN, remote encrypted-history backup, and historical-message restoration are not part of this distribution. The client does not send an encrypted-history policy during channel creation or upgrade and does not call encrypted-history storage endpoints.

The bundled OpenMLS artifact is built from pinned live-only `main` commit `ce0ed8fde928db16f1c4709c30d18f2aaa4507c2`. Build provenance is published in the package manifest and recorded internally in `wasm-build/BUILD_INFO.md`. Its generated JavaScript, declarations, and WASM binary do not contain the PIN, recovery-vault, or epoch-archive feature set.

## Runtime assets

Copy the required files from the package `public` directory into the application's public directory:

- `openmls_wasm_bg.wasm`
- `ermis_call_node_wasm_bg.wasm`
- `e2ee-media-stream-worker.js`
- call audio assets

Copy `dist/wasm_worker.worker.mjs` for call-worker support.

## Publishing

This package is released in lockstep with `@ermis-network/ermis-chat-react` using the exact version `2.1.0-external.2`, npm dist-tag `external`, and public npm access. Source TypeScript, tests, build configuration, and source maps are intentionally excluded from the package.

## License

This is proprietary software under the included `LICENSE`. Public npm availability does not grant open-source rights. An authorized licensee may integrate the compiled SDK with a self-hosted or customized backend and distribute it only as an embedded dependency of an authorized built or packaged application. The package may not be republished or distributed as a standalone SDK.
