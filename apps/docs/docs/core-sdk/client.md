---
sidebar_position: 3
---

# The Client (ErmisChat)

`ErmisChat` is the Core SDK entry point for WebSocket connection, channels, authenticated chat REST calls, and targeted end-user profile calls.

## Instantiation

```typescript
import { ErmisChat } from '@ermis-network/ermis-chat-sdk';

const chatClient = ErmisChat.getInstance({
  baseURL: 'https://chat.example.com',
  userBaseURL: 'https://users.example.com/uss/v1',
  selfHosted: true,
  refreshToken: () => localStorage.getItem('refresh_token'),
  onTokenRefresh: ({ token, refresh_token }) => {
    localStorage.setItem('token', token);
    if (refresh_token) localStorage.setItem('refresh_token', refresh_token);
  },
  logger: (level, message, extraData) => {
    console.log(`[${level}]`, message, extraData);
  },
});
```

`userBaseURL` may be a root host, `/v1`, or `/uss/v1`; the SDK normalizes it to `/uss/v1` for `ermis_end_user` calls.

### `ErmisChatOptions` Reference

| Option                    | Type                         | Default              | Description                                                            |
| ------------------------- | ---------------------------- | -------------------- | ---------------------------------------------------------------------- |
| `recoverStateOnReconnect` | `boolean`                    | `true`               | Re-fetch channel state after a WebSocket reconnection.                 |
| `logger`                  | `(level, msg, data) => void` | no-op                | Custom SDK logging callback.                                           |
| `userBaseURL`             | `string`                     | normalized `baseURL` | End-user v1 auth/profile API URL.                                      |
| `selfHosted`              | `boolean`                    | `false`              | Allows omitted API key/project ID for self-hosted Bellboy deployments. |
| `refreshToken`            | `string` or function         | -                    | Refresh token, or provider returning the latest refresh token.         |
| `onTokenRefresh`          | `(tokens) => void`           | -                    | Called after SDK refreshes access token; persist rotated tokens here.  |
| `browser`                 | `boolean`                    | auto-detected        | Force browser mode.                                                    |
| `warmUp`                  | `boolean`                    | `false`              | Immediately open health-check connection on init.                      |
| `withCredentials`         | `boolean`                    | `false`              | Set `withCredentials` on HTTP requests.                                |
| `httpsAgent`              | `https.Agent`                | -                    | Custom HTTPS agent for Node.js.                                        |
| `allowServerSideConnect`  | `boolean`                    | `false`              | Allow `connectUser` outside the browser.                               |
| `wsConnection`            | `StableWSConnection`         | -                    | Inject a custom WebSocket connection instance.                         |

## Connection

### `connectUser`

Connect the user with a JWT/access token returned by v1 auth or by your trusted backend.

```typescript
await chatClient.connectUser({ id: 'user-123', name: 'Jane Doe' }, 'ACCESS_TOKEN');
```

If the auth response includes a `refresh_token`, pass it through the client option above or as the fourth argument:

```typescript
await chatClient.connectUser({ id: user_id }, access_token, false, refresh_token);
```

`connectUser()` opens the chat WebSocket, hydrates local user cache from IndexedDB in browsers, and asynchronously refreshes the current user's full profile with `queryUser(me)`. It does not open profile SSE and does not preload the full user list.

Authenticated HTTP requests automatically refresh once on 401/token-expired responses and retry the original request. WebSocket reconnect refreshes before rebuilding the URL when the server reports an expired token.

### External Authentication

`connectUser(user, externalToken, true)` is unsupported in v1. A trusted backend should call `/uss/v1/auth/external`, then the browser calls:

```typescript
await chatClient.connectUser({ id: user_id }, access_token);
```

### `disconnectUser`

```typescript
await chatClient.disconnectUser();
```

Closes the WebSocket, clears active channel references, clears the in-memory client state, and resets the token manager.

## User Management

### `queryUser`

```typescript
const user = await chatClient.queryUser('user-123');
```

Calls `GET /users/:id` with Bearer auth and normalizes `display_name -> name` and `avatar_url -> avatar`.

### `getBatchUsers`

```typescript
const users = await chatClient.getBatchUsers(['user-1', 'user-2']);
```

Calls `POST /users/batch` with `{ user_ids }`, removes duplicate IDs, and chunks requests at 100 IDs.

### `searchUsers`

```typescript
const response = await chatClient.searchUsers('Jane', 25);
```

Calls `GET /users/search?q=Jane&limit=25`. `limit` is capped at 100. The legacy overload `searchUsers(page, page_size, name)` still works but ignores `page`.

### Unsupported Listing APIs

`queryUsers()` and `syncUserCache()` throw explicit unsupported errors because v1 does not expose unrestricted user listing. User discovery should be search-driven or based on explicit user IDs from channels/messages.

## Profile Updates

```typescript
await chatClient.updateProfile({ name: 'New Name', avatar: 'https://cdn.example.com/me.png' });
await chatClient.uploadAvatar(fileInput.files[0]);
```

`updateProfile()` calls `PATCH /users/me` and maps `name -> display_name`, `avatar -> avatar_url`. `about_me` is unsupported in v1 and throws.

`uploadAvatar()` calls `POST /users/me/avatar` and normalizes the returned full user profile.

## Profile SSE

`connectToSSE()` is unsupported in v1. Profile cache updates happen through `queryUser`, `getBatchUsers`, `searchUsers`, message/member enrichment, `updateProfile`, and `uploadAvatar`.
