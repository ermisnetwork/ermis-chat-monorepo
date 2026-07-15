# uhm-chat-external

Standalone React/Vite client for the external UHM Chat distribution.

## Setup

```bash
cp .env.example .env.local
yarn install --frozen-lockfile
yarn dev
```

The app pins both Ermis packages to `2.1.0-external.1`. The `external` npm dist-tag is only for release discovery; do not use it in `package.json`.

## E2EE runtime

- Startup stays ordered as `connectUser → initialize E2EE → mount chat`.
- Live MLS remains enabled for direct/group creation, external join, ordered proposal/commit sync, reconnect, key rotation, encrypted attachments, media streaming, and local replay/reset.
- Account PIN, recovery vault, epoch archive, historical restore, and archive-backed repair are intentionally unavailable.
- `public/openmls_wasm_bg.wasm` is the current temporary WASM artifact. It still contains internal epoch-archive code, but the external JavaScript and TypeScript contracts do not expose or invoke it. Replacing this binary is tracked as `WASM-001`.
- OpenMLS glue is loaded from the SDK bundle. Do not add public `openmls_wasm.js` or generated OpenMLS declaration files.
- `public/e2ee-media-stream-worker.js`, `public/wasm_worker.worker.mjs`, and `public/ermis_call_node_wasm_bg.wasm` are runtime assets.

## Environment

Copy `.env.example` and supply deployment-specific values. Never commit `.env.local`. Self-hosted mode is the default; cloud mode requires the API key and project ID.

## Release boundary

Outsource consumers receive this repository and compiled npm packages only. The SDK monorepo and SDK TypeScript source are not part of the handoff.

See [OUTSOURCE_TASKS.md](./OUTSOURCE_TASKS.md) for release status and evidence.
