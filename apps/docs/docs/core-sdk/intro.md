---
sidebar_position: 1
---

# Getting Started with Core SDK

Ermis Chat SDK is the JavaScript/TypeScript client for the Ermis Chat platform. It allows you to connect to the Ermis Chat backend, manage channels, send messages, and handle real-time WebSockets and WebRTC events.

## Installation

You can install the package using your preferred package manager:

```bash
yarn add @ermis-network/ermis-chat-sdk
# or
npm install @ermis-network/ermis-chat-sdk
```

## Basic Usage: The Core Chat Flow

To get started, you must connect the user, create a channel, resolve any channel invitations, and then watch the channel to begin chatting.

```typescript
import { ErmisChat } from '@ermis-network/ermis-chat-sdk';

// 1. Initialize client
const chatClient = ErmisChat.getInstance('YOUR_API_KEY', 'YOUR_PROJECT_ID', 'API_BASE_URL');

// 2. Connect User
const user = { id: 'user_1', name: 'User One', avatar: 'https://avatar.url' };
await chatClient.connectUser(user, 'USER_TOKEN');

// 3. Create a channel (team or messaging) and invite members
const payload = {
  members: ['user_1', 'user_2'],
};
const channel = chatClient.channel('messaging', payload);
await channel.create(); // Registers the target users into a pending state

// 4. Resolve the Invite (For the invited user: 'user_2')
// The user must actively accept the channel invitation before fully joining
await channel.acceptInvite('accept');

// 5. Watch the channel & Enter chat details
// This subscribes to real-time events and fetches the message history
await channel.watch();

// 6. Send a message
await channel.sendMessage({
  text: 'Hello world! I have entered the channel.',
});
```
