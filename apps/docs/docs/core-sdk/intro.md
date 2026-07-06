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

Getting started with Ermis Chat requires three steps: **initialize the client**, **connect a user**, and **start chatting**.

### Step 1: Initialize the Client

```typescript
import { ErmisChat } from '@ermis-network/ermis-chat-sdk';

const chatClient = ErmisChat.getInstance('YOUR_API_KEY', 'YOUR_PROJECT_ID', 'API_BASE_URL');
```

### Step 2: Connect a User

The SDK supports two authentication modes depending on how your backend manages users.

#### Option A: Standard Authentication

Use this when your users are managed directly by the Ermis platform. The token is obtained from the [Authentication](./auth.md) flow (OTP, Google OAuth, etc.).

```typescript
const user = { id: 'user_1', name: 'User One', avatar: 'https://avatar.url' };
await chatClient.connectUser(user, 'ERMIS_USER_TOKEN');
```

#### Option B: External Authentication

Use this when your application has its own backend and user system. In `ermis_end_user` v1, the browser SDK does not exchange external tokens directly. Your trusted backend calls `/uss/v1/auth/external`, then returns the Ermis `access_token` and `user_id` to the browser.

```typescript
const { user_id, access_token } = await yourBackend.exchangeExternalToken(appToken);
await chatClient.connectUser({ id: user_id }, access_token);
```

For setup details, see the [Authentication](./auth.md) guide.

### Step 3: Create & Join a Quick Channel

Once the user is connected, use **Quick Channels** for instant, frictionless group chat — no invitations or acceptance steps needed.

```typescript
// Creator: Create a quick channel
const channel = await chatClient.createQuickChannel('General Discussion');

// Share the channel ID with others
const channelId = channel.id;
```

Another user can join instantly with just the channel ID:

```typescript
// Joiner: Join by channel ID
const channel = await chatClient.joinQuickChannel(channelId);

// Start chatting right away
await channel.sendMessage({ text: 'Hello everyone!' });
```

### Full Example

```typescript
import { ErmisChat } from '@ermis-network/ermis-chat-sdk';

// 1. Initialize client
const chatClient = ErmisChat.getInstance('YOUR_API_KEY', 'YOUR_PROJECT_ID', 'API_BASE_URL');

// 2. Connect user with an Ermis access token
const user = { id: 'user_1', name: 'User One', avatar: 'https://avatar.url' };
await chatClient.connectUser(user, 'ERMIS_ACCESS_TOKEN');

// 3. Create a quick channel
const channel = await chatClient.createQuickChannel('General Discussion');

// 4. Another user joins by ID
const joinedChannel = await chatClient.joinQuickChannel(channel.id);

// 5. Start chatting
await joinedChannel.sendMessage({ text: 'Hello everyone!' });
```

> For more advanced channel setups (private channels, invitations, team channels), see the [Channels](./channel.md) guide.
