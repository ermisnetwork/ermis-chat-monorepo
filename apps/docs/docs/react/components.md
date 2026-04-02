---
sidebar_position: 2
---

# Core Components

Ermis Chat React uses Context Providers at the root level so that all deeper UI components have access to state.

## `<Chat />`

The overarching provider for the application. You must pass the initialized `chatClient` instance to it.

```tsx
import { Chat } from '@ermis-network/ermis-chat-react';

<Chat client={chatClient}>
    {/* Other UI Components */}
</Chat>
```

## `<Channel />`

Establishes the active channel context. Any components inside `<Channel>` will read from that specific channel.

```tsx
const activeChannel = chatClient.channel('messaging', 'general');

<Channel channel={activeChannel}>
   <MessageList />
   <MessageInput />
</Channel>
```

## `<ChannelList />`

Renders a list of channels for the current user and handles channel switching.

## `<MessageList />`

Displays the messages for the currently active channel. It dynamically handles attachments, read receipts, reactions, and infinite scrolling.

## `<MessageInput />`

The textbox area for writing new messages. Handles typing events, file uploads, and formatting automatically.
