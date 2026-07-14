---
sidebar_position: 2
---

# Authentication

`ErmisAuthProvider` supports legacy USS and End User v1 through the explicit `endUserApiMode` option. If omitted, it defaults to `legacy` for both self-host and cloud deployments.

```typescript
import { ErmisAuthProvider } from '@ermis-network/ermis-chat-sdk';

const authProvider = new ErmisAuthProvider({
  baseURL: 'https://api.example.com/uss/v1',
  selfHosted: true,
  endUserApiMode: 'v1',
});
```

## Passwordless OTP Login

OTP supports SMS, Voice, and Email. The SDK keeps the public method names as `Sms`, `Voice`, and `Email`, then sends lowercase v1 request methods.

```typescript
await authProvider.sendOtpToPhone('+1234567890', 'Sms');
await authProvider.sendOtpToEmail('user@example.com');

const response = await authProvider.verifyOtp('123456');

if (response.success) {
  await chatClient.connectUser({ id: response.user_id }, response.token, {
    refreshToken: response.refresh_token,
  });
}
```

V1 routes used by the provider:

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

Client-side external authentication is available only in legacy mode through `connectUser(user, token, { externalAuth: true })`. In v1, exchange external identity from a trusted backend by calling `/uss/v1/auth/external`, then pass the returned `access_token` to the client:

```typescript
const { user_id, access_token } = await yourBackend.exchangeExternalToken(appToken);
await chatClient.connectUser({ id: user_id }, access_token);
```

## Token Refresh

`ErmisChat` can refresh automatically when authenticated HTTP calls return 401/token-expired responses. Configure a refresh token provider and persistence callback:

```typescript
const chatClient = ErmisChat.getInstance({
  baseURL,
  selfHosted: true,
  endUserApiMode: 'v1',
  refreshToken: () => localStorage.getItem('refresh_token'),
  onTokenRefresh: ({ token, refresh_token }) => {
    localStorage.setItem('token', token);
    if (refresh_token) localStorage.setItem('refresh_token', refresh_token);
  },
});
```

The SDK refreshes and retries an authenticated HTTP request once on 401, 403, or `TOKEN_EXPIRED`. WebSocket close `4001`/`JWT Expire` uses the same in-flight refresh, rebuilds the URL, reconnects, and recovers state.

Use `refreshNewToken(refresh_token)` for manual refresh. It calls `/refresh_token` in legacy mode or `/auth/refresh` in v1 without Bearer auth.

```typescript
const refreshed = await chatClient.refreshNewToken('REFRESH_TOKEN');
await chatClient.connectUser({ id: refreshed.user_id }, refreshed.token);
```

## Unsupported v1 Auth Flows

Wallet and client-side external authentication are not exposed by v1. These calls throw `UnsupportedEndUserFeatureError` with code `END_USER_FEATURE_UNSUPPORTED` before SDK state changes or network requests.
