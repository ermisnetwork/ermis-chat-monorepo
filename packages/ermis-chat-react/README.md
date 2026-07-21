# @ermis-network/ermis-chat-react — external distribution

Compiled React UI package for `uhm-chat-external`.

```bash
yarn add @ermis-network/ermis-chat-react@2.1.0-external.2
```

Import the compiled stylesheet once at the application entrypoint:

```ts
import '@ermis-network/ermis-chat-react/dist/index.css';
```

The package depends exactly on `@ermis-network/ermis-chat-sdk@2.1.0-external.2`.

It includes the standard chat UI, live MLS/E2EE integration, encrypted attachments and media, channel creation/upgrade, key rotation, and device-local encrypted-state replay/reset support. PIN setup/unlock/change components, recovery hooks, restore progress UI, recovery-policy controls, and archive-backed repair are not exported.

Only compiled JavaScript, declaration files, and CSS are published. The package does not include `/src` or source maps.

## License

This is proprietary software under the included `LICENSE`. Public npm availability does not grant open-source rights. An authorized licensee may customize its application and distribute the compiled package only as an embedded dependency of an authorized built or packaged application. The package may not be republished or distributed as a standalone SDK.
