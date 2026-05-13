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

### `ErmisChatOptions` Reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `recoverStateOnReconnect` | `boolean` | `true` | Re-fetch channel state after a WebSocket reconnection. |
| `logger` | `(level, msg, data) => void` | no-op | Custom logging callback. `level` is `'info'` or `'error'`. |
| `userBaseURL` | `string` | same as base URL | Separate auth server URL (for split API/auth deployments). |
| `browser` | `boolean` | auto-detected | Force browser mode (enables EventSource, disables Node features). |
| `warmUp` | `boolean` | `false` | Immediately open health-check connection on init. |
| `withCredentials` | `boolean` | `false` | Set `withCredentials` on HTTP requests (for cookie-based auth). |
| `httpsAgent` | `https.Agent` | — | Custom HTTPS agent (Node.js server-side only). |
| `allowServerSideConnect` | `boolean` | `false` | Allow `connectUser` in a server (non-browser) environment. |
| `wsConnection` | `StableWSConnection` | — | Inject a custom WebSocket connection instance. |

:::tip
Most applications only need `recoverStateOnReconnect` and `logger`. The other options are for advanced deployment scenarios like server-side rendering or split infrastructure.
:::

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

If your application relies on an external authentication system, you can set the `external_auth` flag to `true`. This instructs the SDK to exchange your external token for an Sub2s token by calling the `{userBaseURL}/get_token/external_auth` endpoint behind the scenes.

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

## Downloading Media

The client exposes `downloadMedia` for fetching uploaded files as a `Blob`. This bypasses CORS restrictions and browser caching issues.

```typescript
const blob = await chatClient.downloadMedia('https://cdn.ermis.network/attachments/image123.png');

// Save the file in the browser
const url = URL.createObjectURL(blob);
const a = document.createElement('a');
a.href = url;
a.download = 'image123.png';
a.click();
URL.revokeObjectURL(url);
```

## User Management

### `queryUsers`

Fetches a paginated list of all users in the project.

```typescript
const response = await chatClient.queryUsers('25', 1); // page_size, page
console.log(response.data); // UserResponse[]
```

### `searchUsers`

Search users by name with pagination.

```typescript
const response = await chatClient.searchUsers(1, 25, 'Jane');
console.log(response.data); // matching users
```

### `updateProfile`

Update the authenticated user's profile (name, avatar, etc.).

```typescript
await chatClient.updateProfile({ name: 'New Name' });
```

### `uploadAvatar`

Upload a new profile picture for the current user.

```typescript
const fileInput = document.querySelector('input[type="file"]');
await chatClient.uploadAvatar(fileInput.files[0]);
```
