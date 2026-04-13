---
sidebar_position: 5
---

# UI Components

Beyond the base providers, the UI Kit exposes several standalone **UI Components**. These functional elements are utilized internally but exported explicitly so you can reuse them when building custom views. 

---

## `<Avatar />`

A versatile graphic component that handles profile image rendering, fallback initials processing, and uniform sizing.

### Props

| Prop | Type | Description |
| ---- | ---- | ----------- |
| `image` | `string \| null` | Profile image URL. |
| `name` | `string` | String for initial fallbacks. |
| `size` | `number` | Dimension in pixels (Default 36). |
| `className` | `string` | Custom CSS injection. |

### Example
If an `image` is passed as null or fails to load, `<Avatar />` handles gracefully extracting initials from the `name` prompt automatically.
```tsx
import { Avatar } from '@ermis-network/ermis-chat-react';

export const UserListing = ({ user }) => (
  <div className="flex items-center space-x-2">
    <Avatar 
      image={user.avatarUrl} // Passes null properly
      name={user.fullName || "Anonymous"} 
      size={40} 
      className="shadow-sm border border-gray-100"
    />
    <span>{user.fullName}</span>
  </div>
);
```

---

## `<ChannelHeader />`

A preset layout element placed atop the channel container, displaying the active channel metadata.

### Props

| Prop | Type | Description |
| ---- | ---- | ----------- |
| `title` | `string` | Contextual title text. |
| `image` | `string` | Channel image mapping. |
| `subtitle` | `string` | Minor contextual strings. |
| `renderRight` | `(channel: Channel) => React.ReactNode` | Anchor rightward nodes. |
| `renderTitle` | `(channel: Channel) => React.ReactNode` | Bypass central views. |
| `AvatarComponent`| `React.ComponentType<AvatarProps>`| Override left graphic. |
| `className` | `string` | Adjust boundary styles. |

### Example
```tsx
import { ChannelHeader } from '@ermis-network/ermis-chat-react';

export const CustomHeader = ({ channel }) => (
  <ChannelHeader 
    subtitle={`${Object.keys(channel.state.members).length} members online`}
    renderRight={() => <button className="video-call-btn w-6 h-6">📹</button>}
  />
);
```

---

## `<TypingIndicator />`

An animated float tracking keystrokes within the group. Mounted at the timeline floor.

*(Internal Note: State resolves via `VirtualMessageList` linking `useTypingIndicator` unless used manually).*

### Props

| Prop | Type | Description |
| ---- | ---- | ----------- |
| `renderText` | `(users: TypingUser[]) => React.ReactNode` | Replaces standard maps. |

### Example
```tsx
import { TypingIndicator } from '@ermis-network/ermis-chat-react';

export const CustomIndicatorBox = () => (
   <TypingIndicator 
      renderText={(users) => {
         if (users.length === 0) return null;
         return <span className="text-gray-400 italic">Someone is typing...</span>;
      }}
   />
);
```

---

## `<PinnedMessages />`

A sticky header panel mounting pinned message arrays.

### Props

| Prop | Type | Description |
| ---- | ---- | ----------- |
| `className` | `string` | Framework layout variable. |
| `onClickMessage`| `(messageId: string) => void` | Event mapping jumps. |
| `maxCollapsed` | `number` | Limit before grouping. |
| `PinnedMessageItemComponent` | `React.ComponentType<PinnedMessageItemProps>` | Individual row element. |
| `AvatarComponent` | `React.ComponentType<AvatarProps>` | Override profile icon. |

---

## `<ReadReceipts />`

A mini status list reflecting user read arrays. Contains floating context labels.

### Props

| Prop | Type | Description |
| ---- | ---- | ----------- |
| `readers` | `ReadReceiptUser[]` | User state references. |
| `maxAvatars` | `number` | Truncation cutoff number. |
| `showTooltip` | `boolean` | Activates hover popup. |
| `AvatarComponent` | `React.ComponentType<AvatarProps>` | Visual element format. |
| `TooltipComponent` | `React.ComponentType<ReadReceiptsTooltipProps>` | Interface element logic. |
| `isOwnMessage` | `boolean` | Validates target structure. |
| `isLastInGroup` | `boolean` | Constraints logic bound. |
| `status` | `string` | Transmit log variable. |

---

## `<MessageSearchPanel />`

A heavy-duty layout menu designed to securely query entire channel arrays. 

### Core Modal Props
| Prop | Type | Description |
| ---- | ---- | ----------- |
| `isOpen` | `boolean` | Conditional render boundary. |
| `onClose` | `() => void` | Unmounts visual hierarchy. |
| `channel` | `Channel` | Exact timeline contexts. |
| `debounceMs` | `number` | Frame metric limiting HTTP queries (Default 500). |

### Layout Props
| Prop | Type | Description |
| ---- | ---- | ----------- |
| `AvatarComponent` | `React.ComponentType<AvatarProps>` | Override visual template. |
| `title` | `string` | Top bar title. |
| `placeholder` | `string` | Input box hint. |
| `loadingText` | `string` | Loading prompt logic. |
| `emptyText` | `string` | Miss alert boundary. |

### Example
```tsx
import { MessageSearchPanel, useChannel } from '@ermis-network/ermis-chat-react';

export const SearchManager = ({ isSearchOpen, closeSearch }) => {
  const { channel } = useChannel();
  
  if (!channel) return null;

  return (
    <MessageSearchPanel 
      isOpen={isSearchOpen}
      onClose={closeSearch}
      channel={channel}
      title="Search Conversation"
      emptyText="No exact messages matched this query."
    />
  );
};
```

---

## `<ChannelSettingsPanel />`

The central modular control board wrapping configurations cleanly. 

### Props
| Prop | Type | Description |
| ---- | ---- | ----------- |
| `isOpen` | `boolean` | Node tracking visibility. |
| `onClose` | `() => void` | Removal execution callback. |
| `channel` | `Channel` | Overrides native context. |
| `title` | `string` | Header string block. |
| `slowModeOptions` | `{ label: string, value: number }[]` | Rate cap mapping. |

### Example
```tsx
import { ChannelSettingsPanel, useChannel } from '@ermis-network/ermis-chat-react';

export const SettingsManager = ({ isSettingsOpen, closeSettings }) => {
  const { channel } = useChannel();
  
  if (!channel) return null;

  return (
    <ChannelSettingsPanel 
      isOpen={isSettingsOpen}
      onClose={closeSettings}
      channel={channel}
      title="Room Preferences"
      slowModeOptions={[
        { label: 'Off', value: 0 }, 
        { label: '5s delay', value: 5 }, 
        { label: '1m delay', value: 60 }
      ]}
    />
  );
};
```
