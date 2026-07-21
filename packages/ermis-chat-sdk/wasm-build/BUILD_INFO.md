# OpenMLS WASM build provenance

The external SDK's live-only OpenMLS artifact is reproduced from these pinned inputs:

- repository: `git@github.com:pk7795/ermis-openmls.git`
- OpenMLS commit: `ce0ed8fde928db16f1c4709c30d18f2aaa4507c2`
- source branch at selection time: `main`
- Cargo lock: [`Cargo.lock`](./Cargo.lock)
- Cargo lock SHA-256: `3c11a94c7f97bcb1056853fc43268400a0cfb49302d2a5cc5a3f6e6d49798377`
- pinned `hpke-rs` git revision: `6e30f233daf51ec63d982c60ff1ecd83f90c1139`
- `wasm-pack`: `0.13.1`
- `cargo`: `1.94.1 (29ea6fb6a 2026-03-24)`
- `rustc`: `1.94.1 (e408947bf 2026-03-25)`

Build from a detached checkout so later changes to `main` cannot alter the artifact:

```bash
git checkout --detach ce0ed8fde928db16f1c4709c30d18f2aaa4507c2
cp /path/to/ermis-chat-monorepo/packages/ermis-chat-sdk/wasm-build/Cargo.lock Cargo.lock
cd openmls-wasm
wasm-pack build --target web
```

Copy `pkg/openmls_wasm.js`, `pkg/openmls_wasm.d.ts`, `pkg/openmls_wasm_bg.wasm`, and `pkg/openmls_wasm_bg.wasm.d.ts` together. The SDK glue routes generated warnings/errors through `globalThis.__ermisSdkLog`; preserve that post-generation integration when refreshing the files.

Expected WASM output for the pinned inputs above:

- size: `1,667,354` bytes
- SHA-256: `a54a975e52a267c98884e18656078c21b16f05bf5aec5657ae9631dd59899889`

The artifact must not export or contain the PIN, recovery-vault, or epoch-archive feature set. Core SDK, React SDK, package-contract, and consumer-app builds remain mandatory release gates after any regeneration.
