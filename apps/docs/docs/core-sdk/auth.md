---
sidebar_position: 2
---

# Authentication

`ErmisAuthProvider` talks to `ermis_end_user` v1. The constructor accepts a root host, `/v1`, or legacy `/uss/v1` URL and normalizes it to `/v1`.

```typescript
import { ErmisAuthProvider } from '@ermis-network/ermis-chat-sdk';

const authProvider = new ErmisAuthProvider({
  baseURL: 'https://api.example.com/v1',
  selfHosted: true,
});
```

## Passwordless OTP Login

OTP supports SMS, Voice, and Email. The SDK keeps the public method names as `Sms`, `Voice`, and `Email`, then sends lowercase v1 request methods.

```typescript
await authProvider.sendOtpToPhone('+1234567890', 'Sms');
await authProvider.sendOtpToEmail('user@example.com');

const response = await authProvider.verifyOtp('123456');

if (response.success) {
  await chatClient.connectUser({ id: response.user_id }, response.token, false, response.refresh_token);
}
```

Routes used by the provider:

| Method | Route               | Body                                                           |
| ------ | ------------------- | -------------------------------------------------------------- |
| `POST` | `/auth/otp/request` | `{ identifier, method: 'sms' \| 'voice' \| 'email', language: 'vi' }` |
| `POST` | `/auth/otp/verify`  | `{ identifier, otp }`                                          |

The v1 response is adapted for older callers: `success` is set to `true`, `token` aliases `access_token`, and `user_id` is available at top level when returned or recoverable from the JWT payload.

## Google Login

```typescript
const response = await authProvider.loginWithGoogle('google-oauth-token');

if (response.success) {
  await chatClient.connectUser({ id: response.user_id }, response.token);
}
```

The provider calls `POST /auth/google` with `{ token }`.

## External Authentication

Client-side `connectUser(user, token, true)` is not supported in `ermis_end_user` v1. Exchange external identity from a trusted backend by calling `/v1/auth/external`, then pass the returned `access_token` to the client:

```typescript
const { user_id, access_token } = await yourBackend.exchangeExternalToken(appToken);
await chatClient.connectUser({ id: user_id }, access_token);
```

## Token Refresh

<details>
<summary>Change log</summary>

- `2026-07-04`: Added automatic SDK refresh and retry for expired access tokens.
  - Reason: v1 auth responses can include `refresh_token` alongside short-lived access tokens.
  - Integrator action: persist the refresh token and pass it through `ErmisChatOptions.refreshToken` or `connectUser(..., refreshToken)`.
  - Compatibility/default: `refreshNewToken(refresh_token)` remains available for manual refresh.

</details>

`ErmisChat` can refresh automatically when authenticated HTTP calls return 401/token-expired responses. Configure a refresh token provider and persistence callback:

```typescript
const chatClient = ErmisChat.getInstance({
  baseURL,
  selfHosted: true,
  refreshToken: () => localStorage.getItem('refresh_token'),
  onTokenRefresh: ({ token, refresh_token }) => {
    localStorage.setItem('token', token);
    if (refresh_token) localStorage.setItem('refresh_token', refresh_token);
  },
});
```

The SDK also refreshes before WebSocket reconnect when the server reports an expired token.

Use `refreshNewToken(refresh_token)` to call `POST /auth/refresh` without Bearer auth manually.

```typescript
const refreshed = await chatClient.refreshNewToken('REFRESH_TOKEN');
await chatClient.connectUser({ id: refreshed.user_id }, refreshed.token);
```

## Unsupported v1 Auth Flows

Wallet challenge/signature authentication is not exposed by `ermis_end_user` v1 and the SDK methods throw explicit unsupported errors.
