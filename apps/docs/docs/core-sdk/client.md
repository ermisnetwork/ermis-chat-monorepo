---
sidebar_position: 3
---

# The Client (ErmisChat)

The `ErmisChat` class is the main entry point to the Core SDK. It manages instances, authentication, global web-socket connections, and HTTP REST logic.

## Instantiation

You should initialize the client as a global singleton via the `getInstance` factory.

```typescript
import { ErmisChat } from '@ermis-network/ermis-chat-sdk';

const chatClient = ErmisChat.getInstance(
  'YOUR_API_KEY',
  'YOUR_PROJECT_ID',
  'https://api.your-baseURL.com', // Base URL for the Chat API
  {
    recoverStateOnReconnect: true,
    logger: (level, message, extraData) => {
      console.log(`[${level}]`, message, extraData);
    },
    // Allows setting a custom userBaseURL if your auth server is hosted elsewhere
    // userBaseURL: 'https://auth.your-baseURL.com'
  },
);
```

## Connection

Before creating channels or sending messages, you need to connect the user to establishing a WebSocket tunnel.

### `connectUser`

Connects the user via JWT or using an external auth provider.

```typescript
const user = {
  id: 'user-123',
  name: 'Jane Doe',
  avatar: 'https://bit.ly/dan-abramov',
};

// Standard JWT connection
await chatClient.connectUser(user, 'USER_JWT_TOKEN');
```

#### External Authentication

If your application relies on an external authentication system, you can set the `external_auth` flag to `true`. This instructs the SDK to exchange your external token for an Ermis Network token by calling the `{userBaseURL}/get_token/external_auth` endpoint behind the scenes.

```typescript
// Connect with external authentication
// The SDK fetches an internal token from `userBaseURL` utilizing the external token as a Bearer authorization header.
await chatClient.connectUser(user, 'EXTERNAL_OAUTH_TOKEN', true);
```

> **Note**: When using `external_auth`, the `id` you provide in the `user` object acts as an initial reference but will be overwritten globally by the `user_id` returned from the external authentication server response.

> **Note**: Avoid calling `connectUser` multiple times without disconnecting first.

### `disconnectUser`

Closes the websocket connection, tears down channel listener references, and clears the client state.

```typescript
await chatClient.disconnectUser();
```


## Event Listening

The client exposes an `EventEmitter` interface to listen for global events (like connection drops, new invitations, or member additions).

```typescript
// Subscribe to a specific event
const listener = chatClient.on('connection.recovered', (event) => {
  console.log('Connection recovered!', event);
});

// Subscribe to all events
chatClient.on('all', (event) => {
  console.log(`SDK Event Fired: ${event.type}`);
});

// Remove listener
listener.unsubscribe();
// Alternatively:
chatClient.off('connection.recovered', listenerFunction);
```
