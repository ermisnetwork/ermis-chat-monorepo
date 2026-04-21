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

Use this when your application has its **own backend and user system**. This allows your users to chat through Ermis without needing to create separate Ermis accounts.

**Setup (one-time):**

1. Generate an **RSA key pair** on your backend.
2. Sign your user's JWT token using the **private key** with the **RS256** algorithm.
3. Provide the **public key** to Ermis.
4. Ermis will issue you an **API Key** and **Project ID** to connect to the chat system.

**Usage:**

Set the third parameter `external_auth` to `true` and pass in the RS256-signed JWT from your backend:

```typescript
const user = { id: 'your_backend_user_id', name: 'User One', avatar: 'https://avatar.url' };
await chatClient.connectUser(user, 'YOUR_RS256_SIGNED_JWT', true);
```

> **How it works:** When `external_auth` is `true`, the SDK sends your RS256-signed JWT to the Ermis backend. Ermis verifies the token using the public key you registered during setup. Once verified, it creates (or retrieves) the corresponding Ermis user and returns a valid session token. This is all handled internally — you only need to pass your backend JWT and set `external_auth` to `true`.
>
> For setup details, see the [Authentication](./auth.md) guide.

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

// 2. Connect user (using external auth)
const user = { id: 'user_1', name: 'User One', avatar: 'https://avatar.url' };
await chatClient.connectUser(user, 'YOUR_BACKEND_TOKEN', true);

// 3. Create a quick channel
const channel = await chatClient.createQuickChannel('General Discussion');

// 4. Another user joins by ID
const joinedChannel = await chatClient.joinQuickChannel(channel.id);

// 5. Start chatting
await joinedChannel.sendMessage({ text: 'Hello everyone!' });
```

> For more advanced channel setups (private channels, invitations, team channels), see the [Channels](./channel.md) guide.
