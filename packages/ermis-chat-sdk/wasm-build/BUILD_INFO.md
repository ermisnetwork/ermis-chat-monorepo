# OpenMLS WASM build provenance

The external SDK's live-only OpenMLS artifact is reproduced from these pinned inputs:

- repository: `git@github.com:pk7795/ermis-openmls.git`
- OpenMLS commit: `ce0ed8fde928db16f1c4709c30d18f2aaa4507c2`
- source branch at selection time: `main`
- external-safe JOIN patch: [`join-typed-welcome.patch`](./join-typed-welcome.patch)
- JOIN patch SHA-256: `dd475c8f4cdf0d0381030780d4f538eed75f2ee60a62a5e23cbbb7cfc36943d6`
- trusted historical-time patch: [`historical-validation-time.patch`](./historical-validation-time.patch)
- historical-time patch SHA-256: `7c3ae96d90db911d60d3740d6779ee2da943ac3bf627cd454524aac8cb8b9a3e`
- consuming package version: `@ermis-network/ermis-chat-sdk@2.1.0-external.4`
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
OPENMLS_DIR=/absolute/path/to/detached/openmls \
  node /path/to/ermis-chat-monorepo/scripts/build-openmls-wasm.mjs
```

Copy `pkg/openmls_wasm.js`, `pkg/openmls_wasm.d.ts`, `pkg/openmls_wasm_bg.wasm`, and `pkg/openmls_wasm_bg.wasm.d.ts` together. The SDK glue routes generated warnings/errors through `globalThis.__ermisSdkLog`; preserve that post-generation integration when refreshing the files.

Expected WASM output for the pinned inputs above:

- size: `1,682,289` bytes
- SHA-256: `2c518e94bbf915ea8d460eab8ca034186ef7a74d3f4f355aa22fb4089e29771f`

The build script verifies and applies the pinned JOIN and historical-time
patches before compilation.
The resulting artifact exports `Group.join_with_welcome_typed`, stable
`MlsErrorCode.NoMatchingKeyPackage`, `MlsError.code_name`, and
`Group.process_message_at`; it does not carry the internal PIN,
recovery-vault, or epoch-archive feature set.

The artifact must not export or contain the PIN, recovery-vault, or epoch-archive feature set. Core SDK, React SDK, package-contract, and consumer-app builds remain mandatory release gates after any regeneration.
