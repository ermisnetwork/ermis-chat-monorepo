# External SDK release guide

Core and React must always use the same exact `external.N` version. Publish core first, wait until it resolves from the registry, then publish React.

## Preflight

```bash
yarn workspace @ermis-network/ermis-chat-sdk build
yarn workspace @ermis-network/ermis-chat-react build
bash scripts/publish-packages.sh --tag external --dry-run
```

Audit both tarballs before publishing:

- the Ermis-approved license file is present (the repository currently has no license text; do not publish until legal supplies it);
- no `/src`, test/config files, `.map`, or `sourcesContent`;
- no high-level encrypted-history API/UI/endpoint strings outside the documented temporary WASM binary/glue exception;
- React package depends on the exact matching core version;
- public declarations do not expose the temporary WASM-only history exports.

## Publish

```bash
bash scripts/publish-packages.sh --tag external --yes
```

For web-based npm 2FA, follow the script prompt. Never repoint `latest` as part of this release.

## Verify

```bash
npm view @ermis-network/ermis-chat-sdk@external version
npm view @ermis-network/ermis-chat-react@external version
```

Install the exact versions into the standalone app, regenerate its lockfile, build it outside the monorepo, and record evidence in `uhm-chat-external/OUTSOURCE_TASKS.md`.
