# External SDK release guide

Core and React must always use the same exact `external.N` version. Publish core first, wait until it resolves from the registry, then publish React.

Both package names already have public npm releases, and npm visibility applies to the whole package rather than an individual version. External releases therefore remain publicly downloadable under the existing names, while the included proprietary license limits use and redistribution. Public availability does not make the SDK open source.

## Preflight

```bash
yarn workspace @ermis-network/ermis-chat-sdk build
yarn workspace @ermis-network/ermis-chat-sdk test:external
yarn workspace @ermis-network/ermis-chat-react build
bash scripts/publish-packages.sh --dry-run
```

Audit both tarballs before publishing:

- the proprietary `LICENSE` file is present in both packages;
- package metadata and publish output both report `access: public` and dist-tag `external`;
- no `/src`, test/config files, `.map`, or `sourcesContent`;
- no encrypted-history API/UI/endpoint strings or generated WASM/glue exports;
- SDK package metadata records the pinned OpenMLS commit, Cargo lock checksum, WASM checksum, size, and toolchain;
- SDK source/public and consumer-app OpenMLS binaries have the same recorded checksum;
- React package depends on the exact matching core version;
- public declarations expose only the supported live MLS contract.

## Publish

```bash
bash scripts/publish-packages.sh --yes
```

For web-based npm 2FA, follow the script prompt. The script rejects non-`external` tags and package metadata that differs from the existing public visibility. Never repoint `latest` as part of this release.

## Verify

```bash
npm view @ermis-network/ermis-chat-sdk@external version
npm view @ermis-network/ermis-chat-react@external version
```

Install the exact versions into the standalone app, regenerate its lockfile, build it outside the monorepo, and record evidence in `uhm-chat-external/OUTSOURCE_TASKS.md`.

No npm authentication is required to install these public packages. Publishing still requires an account with write access to both packages. Do not commit npm access tokens or a user-level `.npmrc`.
