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
| `disableLightbox`| `boolean` | Prevent the image from opening in a full-screen lightbox on click. |

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
| `showOnlineStatus` | `boolean` | Show online/offline indicator for direct friend channels (default: `true`). |
| `onlineLabel` | `string` | I18n label for "Online" subtitle. |
| `offlineLabel` | `string` | I18n label for "Offline" subtitle. |
| `OnlineIndicatorComponent`| `React.ComponentType<{ isOnline: boolean }>` | Custom online indicator component. |

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

## `<MediaLightbox />`

A standalone component for viewing images and videos in a full-screen interactive lightbox. Includes zoom, panning, and secure authenticated file downloading.

### Props

| Prop | Type | Description |
| ---- | ---- | ----------- |
| `items` | `MediaLightboxItem[]` | Array of media objects (`{ type: 'image' \| 'video', src, alt, posterSrc }`). |
| `initialIndex` | `number` | Starting index when opened. |
| `isOpen` | `boolean` | Whether the lightbox is visible. |
| `onClose` | `() => void` | Event triggered to close the lightbox. |

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

---

## `<UserPicker />`

A versatile, virtualized list component for searching and selecting users. Supports single (`radio`) and multiple (`checkbox`) selection modes, local-first search with remote fallback, and infinite scrolling.

### Props

| Prop | Type | Description |
| ---- | ---- | ----------- |
| `mode` | `'radio' \| 'checkbox'` | Selection mode. |
| `onSelectionChange` | `(users: UserPickerUser[]) => void` | Callback when selection updates. |
| `excludeUserIds` | `string[]` | Array of user IDs to show as disabled. |
| `initialSelectedUsers`| `UserPickerUser[]` | Users pre-selected on component mount. |
| `pageSize` | `number` | Items per page for infinite scroll (Default 30). |
| `AvatarComponent` | `React.ComponentType` | Override avatar visual. |
| `searchPlaceholder` | `string` | Placeholder for search input. |
| `selectedEmptyLabel`| `string` | Text to show in checkbox mode when no users are selected. |

### Example
```tsx
import { UserPicker } from '@ermis-network/ermis-chat-react';
import { useState } from 'react';

export const AddMembersPanel = ({ existingMemberIds }) => {
  const [selected, setSelected] = useState([]);

  return (
    <div className="h-96">
      <UserPicker 
        mode="checkbox"
        excludeUserIds={existingMemberIds}
        onSelectionChange={(users) => setSelected(users)}
        searchPlaceholder="Type a name or email..."
        selectedEmptyLabel="Select users to add..."
      />
    </div>
  );
};
```

---

## `<Modal />`

A flexible overlay component that serves as the foundation for the UI Kit's dialog windows (like `CreateChannelModal`, `TopicModal`, etc.). The `Modal` component is designed to be overridden globally via the `ChatProvider`'s `components` registry to seamlessly integrate with your application's design system (e.g., Shadcn UI or Radix).

### Props

| Prop | Type | Description |
| ---- | ---- | ----------- |
| `isOpen` | `boolean` | Controls whether the modal is visible. |
| `onClose` | `() => void` | Event triggered to dismiss the modal. |
| `title` | `string` | Header text displayed at the top of the modal. |
| `children` | `React.ReactNode` | The main content of the modal. |
| `className` | `string` | Custom CSS wrapper class name. |
| `disableBackdropClick`| `boolean` | Prevent closing the modal when clicking outside of it. |

### Example
```tsx
import { Modal } from '@ermis-network/ermis-chat-react';

export const MyCustomDialog = ({ isOpen, onClose }) => (
  <Modal isOpen={isOpen} onClose={onClose} title="Warning">
    <p>Are you sure you want to proceed?</p>
    <button onClick={onClose}>Cancel</button>
  </Modal>
);
```

---

## `<Panel />`

A sliding drawer or side-panel component, typically used for the Right-sidebar contexts like `ChannelInfo` and `MessageSearchPanel`. Like `Modal`, it can be globally overridden via the Component Registry.

### Props

| Prop | Type | Description |
| ---- | ---- | ----------- |
| `isOpen` | `boolean` | Controls whether the panel is visible. |
| `onClose` | `() => void` | Event triggered to dismiss the panel. |
| `title` | `string` | Header text displayed at the top of the panel. |
| `children` | `React.ReactNode` | The main content of the panel. |
| `className` | `string` | Custom CSS wrapper class name. |

### Example
```tsx
import { Panel } from '@ermis-network/ermis-chat-react';

export const SettingsDrawer = ({ isOpen, onClose }) => (
  <Panel isOpen={isOpen} onClose={onClose} title="Settings">
    <div>Theme configuration options...</div>
  </Panel>
);
```

