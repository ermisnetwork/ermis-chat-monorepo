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
  endUserApiMode: 'v1',
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

In both modes, `userBaseURL` may be a root host, `/v1`, or `/uss/v1`; the SDK normalizes it to `/uss/v1`.

### `ErmisChatOptions` Reference

| Option                    | Type                         | Default              | Description                                                            |
| ------------------------- | ---------------------------- | -------------------- | ---------------------------------------------------------------------- |
| `recoverStateOnReconnect` | `boolean`                    | `true`               | Re-fetch channel state after a WebSocket reconnection.                 |
| `logger`                  | `(level, msg, data) => void` | no-op                | Custom SDK logging callback.                                           |
| `userBaseURL`             | `string`                     | normalized `baseURL` | End-user v1 auth/profile API URL.                                      |
| `selfHosted`              | `boolean`                    | `false`              | Allows omitted API key/project ID for self-hosted Bellboy deployments. |
| `endUserApiMode`          | `'legacy' \| 'v1'`           | `legacy`             | Selects the end-user API contract without probing the backend.         |
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

Connect the user with a JWT/access token. The third argument is a single options object in SDK `2.1.0`.

```typescript
await chatClient.connectUser({ id: 'user-123', name: 'Jane Doe' }, 'ACCESS_TOKEN');
```

If the auth response includes a `refresh_token`, pass it through the client option above or the connection options:

```typescript
await chatClient.connectUser({ id: user_id }, access_token, {
  refreshToken: refresh_token,
});
```

`connectUser()` opens the chat WebSocket, hydrates local user cache from IndexedDB in browsers, and asynchronously refreshes the current user's full profile with `queryUser(me)`. It does not open profile SSE and does not preload the full user list.

Authenticated HTTP requests automatically refresh once on 401/token-expired responses and retry the original request. WebSocket reconnect refreshes before rebuilding the URL when the server reports an expired token.

### External Authentication

Legacy mode supports `connectUser(user, externalToken, { externalAuth: true })`. This is unsupported in v1; a trusted backend should call `/uss/v1/auth/external`, then the browser calls:

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

Delegates to the selected adapter. V1 calls `GET /users/:id` and normalizes `display_name -> name` and `avatar_url -> avatar`; legacy keeps its existing project-scoped lookup contract.

### `getBatchUsers`

```typescript
const users = await chatClient.getBatchUsers(['user-1', 'user-2']);
```

Delegates to the selected adapter. V1 calls `POST /users/batch` with `{ user_ids }`, removes duplicate IDs, and chunks requests at 100 IDs.

### `searchUsers`

```typescript
const response = await chatClient.searchUsers('Jane', 25);
```

The preferred overload is `searchUsers(query, limit)`. Both public overloads are normalized to one internal request; the selected adapter maps it to its contract. V1 caps `limit` at 100.

### Unsupported Listing APIs

In v1 mode, `queryUsers()` and `syncUserCache()` throw `UnsupportedEndUserFeatureError` because unrestricted listing is unavailable. Legacy mode retains these APIs. Cache namespaces include `endUserApiMode`, preventing legacy/v1 data from being reused across modes.

## Profile Updates

```typescript
await chatClient.updateProfile({ name: 'New Name', avatar: 'https://cdn.example.com/me.png' });
await chatClient.uploadAvatar(fileInput.files[0]);
```

`updateProfile()` calls `PATCH /users/me` and maps `name -> display_name`, `avatar -> avatar_url`. `about_me` is unsupported in v1 and throws.

`uploadAvatar()` calls `POST /users/me/avatar` and normalizes the returned full user profile.

## Profile SSE

`connectToSSE()` is unsupported in v1. Profile cache updates happen through `queryUser`, `getBatchUsers`, `searchUsers`, message/member enrichment, `updateProfile`, and `uploadAvatar`.
