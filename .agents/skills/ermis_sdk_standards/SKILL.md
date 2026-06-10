---
name: "Ermis Chat SDK Development Standards"
description: "Guidelines and standards for modifying the core Ermis Chat SDK (packages/ermis-chat-sdk)."
---

# Ermis Chat SDK Development Standards

When making changes to the `packages/ermis-chat-sdk` codebase, abide by the following architectural patterns and rules.

## Core Architecture
- **Singleton Pattern:** The `ErmisChat` class must be instantiated via `ErmisChat.getInstance()`. Do not call the constructor directly.
- **Generics:** All client classes use `<ErmisChatGenerics extends ExtendableGenerics>` to ensure extensibility. Make sure added methods propagate these generics correctly.

## Design Review Gate
- For architecture, API contract, storage, E2EE/MLS, performance, migration, rollout, or high-blast-radius changes, use `$technical-design-challenger` before implementation. Surface independent tradeoffs, failure modes, compatibility risks, and production gates instead of simply following the preferred option.

## API & Networking
- **Axios:** All REST API communication is done via `this.doAxiosRequest()`. Do not use `fetch` or bare `axios` instances.
- **FormData:** Use `addFileToFormData` utility when handling file uploads.
- **Error Handling:** Standardize errors using `this.errorFromResponse()`.

## Event Dispatching & WebSocket
- The SDK utilizes `isomorphic-ws` and `EventSourcePolyfill`.
- When a new WebSocket event is received, it triggers `dispatchEvent()`.
- **Modifying State based on Events:** Event payload mutations should be applied to `ClientState` (for global states) or `Channel` state (for channel-specific states). Handle asynchronous event requirements (e.g. `channel.created` loading user info) via helper functions like `ensureMembersUserInfoLoaded`.
