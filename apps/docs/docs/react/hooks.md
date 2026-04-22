---
sidebar_position: 5
---

# Hooks

Ermis Chat React provides 19 powerful React hooks that allow you to build completely custom UI interfaces. These hooks directly tap into the core SDK state and real-time events.

---

## 1. Core State Context

Hooks representing the highest level of connection state and context domain.

### `useChatClient`

Retrieves the global connection values from `ChatProvider`.

| Parameter | Type | Description |
| --------- | ---- | ----------- |
| None | `N/A` | Does not accept arguments. |

**Returns:** `ChatContextValue` (Includes `client`, `activeChannel`, `setActiveChannel`, `theme`, `setTheme`...)

**Example:**
```tsx
import { useChatClient } from '@ermis-network/ermis-chat-react';

export const GlobalHeader = () => {
  const { client, theme, setTheme } = useChatClient();

  if (!client.activeConnection) return <p>Connecting to Ermis...</p>;

  return (
    <header className={theme}>
      <h1>Connected as: {client.user.id}</h1>
      <button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>Toggle Theme</button>
    </header>
  );
};
```

### `useCallContext`

Retrieves the call state and actions from `ErmisCallProvider`. Must be used within a component tree that has `enableCall={true}` on `ChatProvider`.

| Parameter | Type | Description |
| --------- | ---- | ----------- |
| None | `N/A` | Does not accept arguments. |

**Returns:** `CallContextValue` (Includes `callStatus`, `callType`, `callDuration`, `createCall`, `acceptCall`, `endCall`, `toggleMic`, `toggleVideo`...)

**Example:**
```tsx
import { useCallContext } from '@ermis-network/ermis-chat-react';

export const CallStatusBadge = () => {
  const { callStatus, callType, callDuration } = useCallContext();

  if (!callStatus) return null;

  const mins = Math.floor(callDuration / 60).toString().padStart(2, '0');
  const secs = (callDuration % 60).toString().padStart(2, '0');

  return (
    <div className="call-badge">
      {callType === 'video' ? '📹' : '📞'}
      {callStatus === 'connected' ? `${mins}:${secs}` : 'Ringing...'}
    </div>
  );
};
```

:::tip
For the full `CallContextValue` API reference with all properties and actions, see [Audio & Video Calls — useCallContext](./calls.md#usecallcontext-hook).
:::

### `useChannel`

Extracts the specific channel context when rendering inside a `<Channel />` component wrapper.

| Parameter | Type | Description |
| --------- | ---- | ----------- |
| None | `N/A` | Does not accept arguments. |

**Returns:** `UseChannelReturn` (Includes `channel: Channel | null`, `loading`, `error`)

**Example:**
```tsx
import { useChannel } from '@ermis-network/ermis-chat-react';

export const ChannelNameDisplay = () => {
  const { channel, loading, error } = useChannel();

  if (loading) return <span>Loading...</span>;
  if (error) return <span>Failed to load channel context</span>;

  return <h1>Chatting in: {channel?.data?.name || "Unnamed"}</h1>;
};
```

### `useChannelCapabilities`

Resolves the current viewer's permission set inside the channel (e.g. Can they send messages? Can they ban members?).

| Parameter | Type | Description |
| --------- | ---- | ----------- |
| None | `N/A` | Does not accept arguments. |

**Returns:** `Record<string, boolean>`

**Example:**
```tsx
import { useChannelCapabilities } from '@ermis-network/ermis-chat-react';

export const AdminControls = () => {
  const capabilities = useChannelCapabilities();

  // Conditionally render buttons based on the user's role-based capabilities
  return (
    <div className="admin-menu">
      {capabilities['delete-channel'] && <button>Delete Channel</button>}
      {capabilities['ban-members'] && <button>Ban Spammers</button>}
    </div>
  );
};
```

---

## 2. Channel Lists & Info Streams

Hooks dealing with monitoring real-time profile statuses, ban states, and array lists of channels.

### `useChannelListUpdates`

Provides arrays of channels dynamically sorted and updated by incoming websocket events.

| Parameter | Type | Description |
| --------- | ---- | ----------- |
| `filters` | `ChannelFilters` | Fetch queries (e.g. `type: 'messaging'`). |
| `sort` | `ChannelSort` | Database sorting direction. |
| `options` | `ChannelQueryOptions` | Offset and pagination details. |

**Returns:** `{ channels: Channel[], loading: boolean, error: Error }`

**Example:**
```tsx
import { useChannelListUpdates } from '@ermis-network/ermis-chat-react';

export const CustomSidebar = () => {
  const filters = { type: 'messaging' };
  const sort = [{ last_message_at: -1 }];
  const options = { limit: 20, offset: 0 };

  const { channels, loading } = useChannelListUpdates(filters, sort, options);

  if (loading) return <p>Syncing rooms...</p>;

  return (
    <ul>
      {channels.map((c) => (
         <li key={c.id}>{c.data.name}</li>
      ))}
    </ul>
  );
};
```

### `useChannelMembers`

Extracts member properties safely tracked against real-time member added/removed socket events.

| Parameter | Type | Description |
| --------- | ---- | ----------- |
| `channel` | `Channel \| null \| undefined` | Target channel instance. |

**Returns:** `{ members: ChannelMember[] }`

**Example:**
```tsx
import { useChannelMembers, useChannel } from '@ermis-network/ermis-chat-react';

export const MemberCountBadge = () => {
  const { channel } = useChannel();
  const { members } = useChannelMembers(channel);

  return <span className="badge">Participants: {members.length}</span>;
};
```

### `useChannelProfile`

Listens uniquely to `channel.updated` events to sync title, name, and image metadata properly across the UI.

| Parameter | Type | Description |
| --------- | ---- | ----------- |
| `channel` | `Channel \| null \| undefined` | Target channel instance. |

**Returns:** `{ name: string, image: string, description: string, public: boolean }`

**Example:**
```tsx
import { useChannelProfile, useChannel } from '@ermis-network/ermis-chat-react';

export const ChannelBanner = () => {
  const { channel } = useChannel();
  const { name, image, description } = useChannelProfile(channel);

  return (
    <div className="banner flex space-x-2">
      <img src={image} alt={name} className="w-10 h-10 rounded-full" />
      <div>
         <h2 className="font-bold">{name}</h2>
         <p>{description}</p>
      </div>
    </div>
  );
};
```

### `useBannedState`

Monitors whether the current user explicitly lost read/write privilege in the designated group.

| Parameter | Type | Description |
| --------- | ---- | ----------- |
| `channel` | `Channel \| null \| undefined` | Target channel instance. |
| `currentUserId`| `string \| undefined` | Local device User ID. |

**Returns:** `{ isBanned: boolean, bannedReason: string }`

**Example:**
```tsx
import { useBannedState, useChatClient, useChannel } from '@ermis-network/ermis-chat-react';

export const SanctionAlert = () => {
  const { client } = useChatClient();
  const { channel } = useChannel();
  const { isBanned, bannedReason } = useBannedState(channel, client.user.id);

  if (!isBanned) return null;

  return (
    <div className="bg-red-500 text-white p-2">
      You are banned from this room. Reason: {bannedReason || 'Violation of TOS'}
    </div>
  );
};
```

### `useBlockedState`

Identifies whether 1-on-1 direct messaging lines are severed by a peer block action.

| Parameter | Type | Description |
| --------- | ---- | ----------- |
| `channel` | `Channel \| null \| undefined` | Target channel instance. |
| `currentUserId`| `string \| undefined` | Local device User ID. |

**Returns:** `{ isBlocked: boolean }`

**Example:**
```tsx
import { useBlockedState, useChatClient, useChannel } from '@ermis-network/ermis-chat-react';

export const BlockOverlay = () => {
  const { client } = useChatClient();
  const { channel } = useChannel();
  const { isBlocked } = useBlockedState(channel, client.user.id);

  if (isBlocked) {
    return <div className="overlay overlay-gray">You cannot message this user.</div>;
  }
  return null;
};
```

### `usePendingState`

Specifically evaluates if an invitation holds `pending` status, requiring an Accept/Reject prompt before text entry is allowed.

| Parameter | Type | Description |
| --------- | ---- | ----------- |
| `channel` | `Channel \| null \| undefined` | Target channel instance. |
| `currentUserId`| `string \| undefined` | Local device User ID. |

**Returns:** `{ isPending: boolean, onAccept: () => void, onReject: () => void }`

**Example:**
```tsx
import { usePendingState, useChatClient, useChannel } from '@ermis-network/ermis-chat-react';

export const InviteGate = () => {
  const { client } = useChatClient();
  const { channel } = useChannel();
  const { isPending, onAccept, onReject } = usePendingState(channel, client.user.id);

  if (isPending) {
    return (
      <div className="invite-box">
         <p>Do you want to join this channel?</p>
         <button onClick={onAccept}>Accept</button>
         <button onClick={onReject}>Decline</button>
      </div>
    );
  }
  return <MessageInput />;
};
```

### `useChannelRowUpdates`

Optimal hook tracking localized read receipts and latest message mutations specific to a targeted Sidebar ListView Row.

| Parameter | Type | Description |
| --------- | ---- | ----------- |
| `channel` | `Channel` | Target channel instance. |
| `currentUserId`| `string \| undefined` | Local device User ID. |

**Returns:** `{ unreadCount: number, lastMessage: FormatMessageResponse }`

**Example:**
```tsx
import { useChannelRowUpdates, useChatClient } from '@ermis-network/ermis-chat-react';

export const NotificationRow = ({ channel }) => {
  const { client } = useChatClient();
  const { unreadCount, lastMessage } = useChannelRowUpdates(channel, client.user.id);

  return (
    <div className="flex justify-between">
      <span>{lastMessage?.text || 'No messages yet'}</span>
      {unreadCount > 0 && <span className="bg-blue-500 rounded-full">{unreadCount}</span>}
    </div>
  );
};
```

### `useOnlineUsers`

A global listener that aggregates user presence data from the `client.activeConnection` and `user.presence.changed` events across all tracked friend channels.

| Parameter | Type | Description |
| --------- | ---- | ----------- |
| None | `N/A` | Does not accept arguments. |

**Returns:** `Record<string, OnlineStatus>` (A dictionary mapping user IDs to their `OnlineStatus` object).

**Example:**
```tsx
import { useOnlineUsers } from '@ermis-network/ermis-chat-react';

export const ActiveFriendsList = () => {
  const onlineUsers = useOnlineUsers();
  const onlineCount = Object.values(onlineUsers).filter(u => u.isOnline).length;

  return <div>Total Online Friends: {onlineCount}</div>;
};
```

### `useOnlineStatus`

Retrieves the specific online/offline state of a peer within a 1-on-1 "friend" channel.

| Parameter | Type | Description |
| --------- | ---- | ----------- |
| `channel` | `Channel \| null \| undefined` | Target channel instance. |

**Returns:** `{ isOnline: boolean, lastActive?: string }`

**Example:**
```tsx
import { useOnlineStatus, useChannel } from '@ermis-network/ermis-chat-react';

export const FriendStatusBadge = () => {
  const { channel } = useChannel();
  const { isOnline, lastActive } = useOnlineStatus(channel);

  if (!channel) return null;

  return (
    <div className="status-indicator">
      <span className={isOnline ? "text-green-500" : "text-gray-400"}>
        {isOnline ? "Online" : "Offline"}
      </span>
    </div>
  );
};
```

---

## 3. Message Loading & Feeds

Hooks dictating logic for infinite-scroll virtual feeds and data.

### `useChannelMessages`

Primary hook anchoring the active socket stream pushing unread arrays directly into the React tree.

| Parameter | Type | Description |
| --------- | ---- | ----------- |
| `options` | `UseChannelMessagesOptions` | Limit configurations. |

**Returns:** `{ messages: FormatMessageResponse[], loading: boolean }`

**Example:**
```tsx
import { useChannelMessages, useChannel } from '@ermis-network/ermis-chat-react';

export const SimpleFeed = () => {
  const { channel } = useChannel();
  const { messages, loading } = useChannelMessages({ 
    activeChannel: channel,
    loadMoreLimit: 50
  });

  if (loading) return <p>Loading history...</p>;

  return (
    <div className="feed overflow-y-auto">
      {messages.map(msg => (
        <div key={msg.id} className="bubble">{msg.text}</div>
      ))}
    </div>
  );
};
```

### `useLoadMessages`

Orchestrator for pagination fetching commands when users scroll toward the ceiling boundary of their timeline.

| Parameter | Type | Description |
| --------- | ---- | ----------- |
| `options` | `UseLoadMessagesOptions` | Limit integers tracking offsets. |

**Returns:** `UseLoadMessagesReturn` (Includes `loadMore: () => void`, `loadingMore: boolean`, `hasMore: boolean`)

**Example:**
```tsx
import { useLoadMessages, useChannelMessages, useChannel } from '@ermis-network/ermis-chat-react';

export const InfiniteFeed = () => {
  const { channel } = useChannel();
  const { loadMore, loadingMore, hasMore } = useLoadMessages({ 
    activeChannel: channel,
    loadMoreLimit: 50 
  });

  return (
    <div 
       className="scroll-container"
       onScroll={(e) => {
         if (e.target.scrollTop === 0 && hasMore && !loadingMore) loadMore();
       }}
    >
      {loadingMore && <span>Loading older messages...</span>}
      {/* List logic here */}
    </div>
  );
};
```

### `useScrollToMessage`

Executes DOM calculations targeting vertical positioning against specific Message IDs.

| Parameter | Type | Description |
| --------- | ---- | ----------- |
| `options` | `UseScrollToMessageOptions` | ID targeting properties via context. |

**Returns:** `UseScrollToMessageReturn` (Includes `jumpTo: (id: string) => void`)

**Example:**
```tsx
import { useScrollToMessage, useChatClient, useChannel } from '@ermis-network/ermis-chat-react';

export const ReferenceButton = ({ targetMessageId }) => {
  const { client } = useChatClient();
  const { channel } = useChannel();
  const { jumpTo } = useScrollToMessage({ 
    activeChannel: channel, 
    client 
  });

  return <button onClick={() => jumpTo(targetMessageId)}>Go to Original Message</button>;
};
```

### `useMessageActions`

Assembles safe function maps verifying if the active user can successfully fire requests deleting or editing specific properties.

| Parameter | Type | Description |
| --------- | ---- | ----------- |
| `message` | `FormatMessageResponse` | Target interaction node. |
| `isOwnMessage` | `boolean` | Verifies identity priority. |

**Returns:** `MessageActionList` (Includes `onReply`, `onForward`, `onCopy`, `onPinToggle`, `onDelete`)

**Example:**
```tsx
import { useMessageActions, useChatClient } from '@ermis-network/ermis-chat-react';

export const FloatingMenu = ({ message }) => {
  const { client } = useChatClient();
  const isOwnMessage = message.user_id === client.user.id;
  const actions = useMessageActions(message, isOwnMessage);

  return (
    <div className="hover-menu shadow-lg">
      <button onClick={() => actions.onCopy(message)}>Copy</button>
      {isOwnMessage && <button onClick={() => actions.onEdit(message)}>Edit</button>}
      {isOwnMessage && <button onClick={() => actions.onDeleteForMe(message)}>Delete</button>}
    </div>
  );
};
```

---

## 4. Text Input & Composer 

Hooks dedicated strictly to intercepting keystrokes and converting strings.

### `useMessageSend`

The async command dispatcher natively capturing strings and handling optimistic UI updates before data clears server confirmations.

| Parameter | Type | Description |
| --------- | ---- | ----------- |
| `options` | `UseMessageSendOptions` | Execution logic mappings. |

**Returns:** `{ sendMessage: (text: string, attachments: FilePreviewItem[]) => void, sending: boolean }`

**Example:**
```tsx
import { useState } from 'react';
import { useMessageSend, useChannel, useChatClient } from '@ermis-network/ermis-chat-react';

export const MobileInput = () => {
  const [val, setVal] = useState("");
  const { channel } = useChannel();
  const { client } = useChatClient();

  const { sendMessage, sending } = useMessageSend({
    activeChannel: channel,
    currentUserId: client.user.id,
    onBeforeSend: (text) => text.trim().length > 0 // Validate before commit
  });

  return (
    <div className="flex w-full">
      <input type="text" value={val} onChange={(e) => setVal(e.target.value)} />
      <button 
        onClick={() => { sendMessage(val, []); setVal(""); }} 
        disabled={sending}
      >
         {sending ? 'Sending...' : 'Send'}
      </button>
    </div>
  );
};
```

### `useFileUpload`

A specialized logic orchestrator for tracking queued object previews while parallel XHR requests hit media infrastructure.

| Parameter | Type | Description |
| --------- | ---- | ----------- |
| `options` | `UseFileUploadOptions` | File queue buffers. |

**Returns:** `{ files: FilePreviewItem[], addFiles: (fls: FileList) => void, removeFile: (id: string) => void, uploadAll: () => Promise<string[]> }`

**Example:**
```tsx
import { useRef } from 'react';
import { useFileUpload, useChannel } from '@ermis-network/ermis-chat-react';

export const DragDropZone = () => {
  const { channel } = useChannel();
  const inputRef = useRef(null);

  const { files, addFiles, removeFile } = useFileUpload({
    activeChannel: channel,
    editableRef: inputRef,
    setHasContent: () => {}
  });

  return (
    <div className="dropbox">
       <input 
         type="file" 
         multiple 
         onChange={(e) => addFiles(e.target.files)} 
       />
       <div className="preview-grid">
         {files.map(f => (
           <div key={f.id}>
             {f.status === 'uploading' && <span className="spinner" />}
             <img src={f.previewUrl} className="w-20" />
             <button onClick={() => removeFile(f.id)}>Remove</button>
           </div>
         ))}
       </div>
    </div>
  );
};
```

### `useMentions`

Parser utilizing strict ContentEditable DOM bounds querying server registries returning filtered matching user blocks.

| Parameter | Type | Description |
| --------- | ---- | ----------- |
| `options` | `UseMentionsOptions` | Node Reference maps mapping autocomplete rules. |

**Returns:** `UseMentionsReturn` (Includes `filteredMembers: MentionMember[]`, `selectMention: (u) => void`)

**Example:**
```tsx
import { useRef } from 'react';
import { useMentions, useChatClient } from '@ermis-network/ermis-chat-react';

export const AutocompleteEngine = ({ members }) => {
  const { client } = useChatClient();
  const editableRef = useRef(null);

  const { showSuggestions, filteredMembers, selectMention, handleInput, handleKeyDown } = useMentions({
    members,
    currentUserId: client.user.id,
    editableRef
  });

  return (
    <div className="relative">
      <div 
        ref={editableRef} 
        contentEditable 
        onInput={handleInput} 
        onKeyDown={handleKeyDown} 
      />
      {showSuggestions && (
        <ul className="absolute top-full shadow-lg bg-white z-50">
           {filteredMembers.map(m => (
             <li onClick={() => selectMention(m)} key={m.id}>@{m.name}</li>
           ))}
        </ul>
      )}
    </div>
  );
};
```

### `useEmojiPicker`

Links DOM node selection boundaries resolving cursor injections when native unicode emoji blocks arrive via third-party maps.

| Parameter | Type | Description |
| --------- | ---- | ----------- |
| `options` | `UseEmojiPickerOptions` | Ref nodes matching inputs safely. |

**Returns:** `{ onSelectEmoji: (emoji: string) => void }`

**Example:**
```tsx
import { useRef, useState } from 'react';
import { useEmojiPicker } from '@ermis-network/ermis-chat-react';
import Picker from '@emoji-mart/react'; // External vendor package

export const EmojiToolbar = () => {
  const [show, setShow] = useState(false);
  const editableRef = useRef(null);

  const { onSelectEmoji } = useEmojiPicker({
    editableRef,
    setHasContent: () => {}
  });

  return (
    <div>
      <div ref={editableRef} contentEditable className="border p-2" />
      <button onClick={() => setShow(!show)}>😃</button>
      {show && (
         <Picker onEmojiSelect={(em) => {
             onSelectEmoji(em.native);
             setShow(false);
         }} />
      )}
    </div>
  );
};
```

### `useTypingIndicator`

Aggregates `typing.start` and `typing.stop` socket dispatches reducing arrays natively outputting precisely only active keystrokes.

| Parameter | Type | Description |
| --------- | ---- | ----------- |
| None | `N/A` | Does not accept arguments. |

**Returns:** `{ typingUsers: TypingUser[] }`

**Example:**
```tsx
import { useTypingIndicator } from '@ermis-network/ermis-chat-react';

export const FloatingTypingStatus = () => {
  const { typingUsers } = useTypingIndicator();

  if (typingUsers.length === 0) return null;

  if (typingUsers.length === 1) {
    return <span className="italic">{typingUsers[0].name || typingUsers[0].id} is typing...</span>;
  }

  return <span className="italic">Multiple people are typing...</span>;
};
```
