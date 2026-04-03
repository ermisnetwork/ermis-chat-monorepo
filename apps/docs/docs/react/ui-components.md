---
sidebar_position: 5
---

# UI Components

Beyond the core structural providers, the UI Kit exposes several standalone **UI Components**. These building blocks are heavily utilized internally but exported explicitly so you can use them when overriding layouts or building completely custom views.

## `<Avatar />`

A versatile avatar component that expertly handles image rendering, fallback initials when images are missing, and customizable sizing.

### Props

| Prop | Type | Description |
| ---- | ---- | ----------- |
| `image` | `string` | The URL of the avatar image. |
| `name` | `string` | Used to generate fallback initials if `image` is null or fails to load. |
| `size` | `number` | Square size dimension in pixels (Defaults to `36`). |
| `className` | `string` | Additional CSS class for styling. |

### Example

```tsx
import { Avatar } from '@ermis-network/ermis-chat-react';

export const CustomUserBadge = () => (
  <Avatar 
    image="https://example.com/avatar.png"
    name="Tony Nguyen" 
    size={48} 
  />
);
```

---

## `<ChannelHeader />`

A preset header component conventionally placed at the top of a `<Channel />`. It displays the active channel's automatically resolved title, avatar, and sub-status (e.g., online member count).

### Props

| Prop | Type | Description |
| ---- | ---- | ----------- |
| `title` | `string` | Overrides the automatically resolved channel name. |
| `image` | `string` | Overrides the channel's default avatar image. |
| `subtitle` | `string` | Subtitle text (useful for member counts or connection status). |
| `renderRight` | `(channel: Channel) => React.ReactNode` | Render custom UI components like "Video Call" or "Menu" buttons on the far right edge. |
| `renderTitle` | `(channel: Channel) => React.ReactNode` | Fully replace the central title formatting area. |
| `AvatarComponent`| `React.ComponentType<AvatarProps>`| Override the left-aligned avatar graphic. |
| `className` | `string` | Additional CSS class for styling. |

### Example

```tsx
import { ChannelHeader } from '@ermis-network/ermis-chat-react';

export const CustomHeader = () => (
  <ChannelHeader 
    renderRight={() => <button className="call-btn">Start Call</button>}
    subtitle="3 members online"
  />
);
```

---

## `<TypingIndicator />`

A subtle, localized animated indicator that displays who is currently typing within the active channel. This is typically injected natively at the bottom of `<VirtualMessageList />`, but you can extract and reposition it anywhere in your UI.

*Note*: State is internally managed by `VirtualMessageList` using `useTypingIndicator` unless used outside of typical flows.

### Props

| Prop | Type | Description |
| ---- | ---- | ----------- |
| `renderText` | `(users: TypingUser[]) => React.ReactNode` | Custom render function for the typing text. If not provided, default formatting is used. |

---

## `<PinnedMessages />`

A specialized banner typically rendered across the top edge of the message timeline to display messages that moderators have pinned. 

### Props

| Prop | Type | Description |
| ---- | ---- | ----------- |
| `onClickMessage`| `(messageId: string) => void` | Event triggered to scroll/jump back down to the original pinned message node when clicked. |
| `maxCollapsed` | `number` | Determines how many messages to show before stacking and burying the rest under a toggle (Default: `1`). |
| `PinnedMessageItemComponent` | `React.ComponentType<PinnedMessageItemProps>` | Custom override renderer for the individual pinned alert rows. |
| `AvatarComponent` | `React.ComponentType<AvatarProps>` | Override the default avatar renderer for messages. |
| `className` | `string` | Additional CSS class for styling. |

---

## `<ReadReceipts />`

A lightweight UI component to display small avatars of users who have read a specific message. Includes highly customizable tooltip capabilities when hovering over the avatars.

### Props

| Prop | Type | Description |
| ---- | ---- | ----------- |
| `readers` | `ReadContext[]` | Array of read info objects containing user data and timestamps. |
| `maxAvatars` | `number` | Maximum number of avatars to render before showing an overflow +N indicator (Default: `5`). |
| `showTooltip` | `boolean` | Whether to display the tooltip on hover (Default: `true`). |
| `AvatarComponent` | `React.ComponentType<AvatarProps>` | Override for the tiny avatar image representations. |
| `TooltipComponent` | `React.ComponentType<ReadReceiptsTooltipProps>` | Override for the hover tooltip layout and logic. |

