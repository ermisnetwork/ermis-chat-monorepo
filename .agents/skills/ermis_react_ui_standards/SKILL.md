---
name: "Ermis Chat React UI Development Standards"
description: "Guidelines and strict standards for developing and maintaining UI components inside packages/ermis-chat-react."
---

# Ermis Chat React UI Development Standards

When modifying, maintaining, or adding features to the Ermis Chat React SDK UI Kit (`packages/ermis-chat-react`), you **MUST** adhere to the following architecture, performance, and styling standards. This SDK is designed strictly for high-performance, real-time messaging environments natively supporting millions of events.

## 1. Core Architecture & Hooks
- **Smart Hooks, Dumb Components:** React Components must remain as pure and dumb as possible. All logic regarding real-time synchronization (e.g. `channel.updated`), capability computations, and contextual states must be encapsulated within extracted `Custom Hooks` (e.g. `useMessageActions`, `useChannelCapabilities`, `useMentions`).
- **Context-Driven Architecture:** Do not use prop-drilling for core Chat entities (like `channel`, `client`, `messages`). Components deep within the tree must map to Context APIs using hook consumers (e.g., `useChatContext`, `useChannelContext`) to prevent unmanageable hierarchies.

## 2. CSS & Aesthetic Engineering
- **Vanilla CSS & BEM Mandatory:** TailwindCSS is strictly **PROHIBITED** within the SDK Core to prevent styling conflicts with consumer applications. Instead, use standard Vanilla CSS abiding completely by the **BEM Methodology** prefixed with the SDK tag (e.g. `.ermis-message-list__actions-trigger`).
- **CSS Variables Only:** All colors, paddings, typography lengths must map to the `--ermis-xxx` tokens defined globally in `_tokens.css`.
- **Theme-Driven Styling (CRITICAL):** The SDK uses **class-based theming** via `.ermis-chat--dark` and `.ermis-chat--light` applied on the root container. All `--ermis-xxx` tokens automatically switch values between these classes. Therefore:
  - **NEVER** use `[data-theme='dark']`, `[data-theme='light']`, or any `data-*` attribute selectors for theming — they do not exist in the SDK.
  - **NEVER** hardcode light/dark fallback values (e.g. `var(--ermis-bg-surface, #ffffff)` with a separate `[data-theme='dark']` override). Instead, use the token directly without fallback: `var(--ermis-bg-primary)`.
  - **NEVER** write separate dark-mode override blocks. If you need a color that changes per theme, define a new token in `_tokens.css` under both `.ermis-chat--dark` and `.ermis-chat--light`, then reference it.
- **"Defensive UI" Paradigm:** Do not hide actions or buttons when a user lacks permission (e.g., Delete/Edit messages). Provide resilient layouts by maintaining the element in the DOM but rendering it in a `:disabled` state via CSS pseudo-classes.
- **NO Inline Styling:** Refrain from embedding inline logic like `style={{ opacity: 0.5 }}` directly into JSX elements. Always pass states to CSS using class modifiers (e.g., `.ermis-btn--disabled` or generic node `:disabled` selectors).

## 3. Data Structures & Safe Typing
- **Centralized Types:** Do not define local `Interfaces` inside `.tsx` components if they might be passed anywhere else. Centralize core UI Types natively into `types.ts`.
- **Flat Properties over Nested Objects:** Optimize render cycles by flattening JSON configurations. Prefer exposing components with multiple primitive props (e.g., `maxImageSize`, `addMemberButtonLabel`) instead of requiring users to pass large config trees (`config={{ limit: X, texts: Y }}`).
- **Strict Generic Constraints:** Minimize the use of the `any` keyword. If deriving structure from external Core SDK streams `channel.data`, define specific Generics or fallback defaults safely. 

## 4. Uncompromising Performance Optimization
- **UI List Virtualization:** A conversation might spawn 10,000+ messages. **ALL LISTS** (Member list, Channel list, Message list) must mount strictly using Virtualized Layouts (e.g. `react-virtuoso` or native equivalents) mapping chunked DOM windows dynamically.
- **Aggressive Memoization:** Prevent cascading re-renders. Force deep sub-components to use `React.memo` safely. Abstract computational arrays down to `useMemo`, and tie callbacks consistently with `useCallback` tracking precise dependencies.

## 5. Chat-Specific Realities
- **Optimistic UI:** Actions like typing a message, clicking "reaction", or hitting delete must immediately reflect in UI state BEFORE the server responds, ensuring instantaneous fluidity. In case of API failure, roll back with explicit UI error states.
- **Composability / Escape Hatches:** The SDK must empower customization. Core containers (like `ChannelInfo` or `MessageList`) must expose numerous internal `Component` overridable hooks (e.g., `AvatarComponent`, `MessageBubbleComponent`). Provide at least 5-10 structural entry points per view.
- **No Hardcoded Language:** Never hardcode English or Vietnamese strings down into JSX textual nodes (`<span>Send message</span>`). Expose these using Customizable Labels inside Interfaces (e.g., `saveLabel`, `titlePlaceholder`) allowing downstream software to adapt natively for multi-language (i18n) integrations.
- **No Hardcoded Channel Types (CRITICAL):** Never compare `channel.type` directly against raw strings like `'team'`, `'meeting'`, `'messaging'`, or `'topic'` inside components or hooks. All channel type classification **MUST** use the semantic helper functions from `src/channelTypeUtils.ts`:
  - `isGroupChannel(channel)` — replaces `channel.type === 'team' || channel.type === 'meeting'`
  - `isDirectChannel(channel)` — replaces `channel.type === 'messaging'`
  - `isTopicChannel(channel)` — replaces `channel.type === 'topic' || Boolean(channel.data?.parent_cid)`
  - `isPublicGroupChannel(channel)`, `hasTopicsEnabled(channel)`, `isGeneralProxy(channel)`, `supportsBlocking(channel)`
  - When adding a **new channel type**, add it to the appropriate `Set` in `channelTypeUtils.ts` (`GROUP_CHANNEL_TYPES` or `DIRECT_CHANNEL_TYPES`) — zero changes needed in any component or hook.
  - **Exception:** Raw type strings are permitted only when passing values to SDK API methods (e.g., `client.channel('team', payload)` for channel creation, or `filters = { type: ['messaging', 'team'] }` for queries).
- **No Hardcoded System Roles:** Never compare string values like `'owner'`, `'moder'`, `'member'`, `'pending'`, or `'skipped'` directly. Use exported `CHANNEL_ROLES` and utility logic from `channelRoleUtils.ts` (e.g. `canManageChannel(role)`, `isPendingMember(role)`).
- **No Hardcoded Message/Attachment Types:** Never compare `message.type === 'sticker'` or `attachment.type === 'video'`. Must use `MESSAGE_TYPES`, `ATTACHMENT_TYPES` and their helper functions exported from `messageTypeUtils.ts` (e.g. `isStickerMessage(message)`, `isVideoAttachment(attachment)`).
