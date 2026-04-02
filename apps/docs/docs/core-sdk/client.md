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
  }
);
```

## Connection & Authentication

Before creating channels or sending messages, you need to connect the user to establishing a WebSocket tunnel.

### `connectUser`
Connects the user via JWT or using an external auth provider.

```typescript
const user = {
    id: 'user-123',
    name: 'Jane Doe',
    avatar: 'https://bit.ly/dan-abramov'
};

// Standard JWT connection
await chatClient.connectUser(user, 'USER_JWT_TOKEN');

// Connect with external authentication (fetches token from the `userBaseURL`)
await chatClient.connectUser(user, 'EXTERNAL_OAUTH_TOKEN', true);
```

> **Note**: Avoid calling `connectUser` multiple times without disconnecting first.

### `disconnectUser`
Closes the websocket connection, tears down channel listener references, and clears the client state.

```typescript
await chatClient.disconnectUser();
```

### `refreshNewToken`
Requests a refreshed token using the refresh JWT from your authentication flow.

```typescript
const response = await chatClient.refreshNewToken('LONG_LIVED_REFRESH_TOKEN');
console.log('New Token:', response.token);
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

## REST API Methods

The `ErmisChat` client wrapper exports Axios-based shortcuts directly to interact with the backend platform without needing to attach authorization rules manually.

```typescript
try {
  const result = await chatClient.get('/custom/endpoint', { query_param: '123' });
  const mutation = await chatClient.post('/custom/endpoint', { data: 'hello' });
} catch (error) {
  console.error("API call failed:", error.response?.data);
}
```

### `sendFile`
Specifically typed helper for uploading multiparts.

```typescript
const fileResponse = await chatClient.sendFile(
    '/upload', 
    fileInput.files[0], 
    'my_image.png', 
    'image/png'
);
console.log(fileResponse.file); // The returned file URL
```
