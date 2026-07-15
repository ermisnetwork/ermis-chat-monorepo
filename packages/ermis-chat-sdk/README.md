# @ermis-network/ermis-chat-sdk — external distribution

Compiled core SDK for the standalone `uhm-chat-external` application.

```bash
yarn add @ermis-network/ermis-chat-sdk@2.1.0-external.1
```

## Supported E2EE scope

- Live MLS group creation, welcome and external join.
- Ordered proposal/commit processing, reconnect/offline sync, member add/remove, and key rotation.
- Encrypted message and attachment handling, multipart upload, media streaming, and device-local replay/reset.
- `loadOpenMlsWasm()` with a live-only public TypeScript contract.

Account PIN, remote encrypted-history backup, and historical-message restoration are not part of this distribution. The client does not send an encrypted-history policy during channel creation or upgrade and does not call encrypted-history storage endpoints.

The current OpenMLS binary is a temporary compatibility artifact. It contains internal code outside the external JavaScript/TypeScript contract; the app cannot access that code through `loadOpenMlsWasm()` types, and the external runtime manager does not invoke it. A replacement binary is tracked separately as `WASM-001`.

## Runtime assets

Copy the required files from the package `public` directory into the application's public directory:

- `openmls_wasm_bg.wasm`
- `ermis_call_node_wasm_bg.wasm`
- `e2ee-media-stream-worker.js`
- call audio assets

Copy `dist/wasm_worker.worker.mjs` for call-worker support.

## Publishing

This package is released in lockstep with `@ermis-network/ermis-chat-react` using the exact version `2.1.0-external.1` and npm dist-tag `external`. Source TypeScript, tests, build configuration, and source maps are intentionally excluded from the package.
