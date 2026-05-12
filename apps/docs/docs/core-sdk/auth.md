---
sidebar_position: 2
---

# Authentication

If your application uses the default Ermis backend for user management or requires initial authentication flows independent of an existing application server, you can use the `ErmisAuthProvider`.

## Instantiating Auth Provider

```typescript
import { ErmisAuthProvider } from '@ermis-network/ermis-chat-sdk';

const authProvider = new ErmisAuthProvider('YOUR_API_KEY', 'https://api.baseURL.com');
```

## Passwordless OTP Login
You can facilitate OTP logins through SMS, Voice, or Email methods.

```typescript
// 1. Send OTP via phone
await authProvider.sendOtpToPhone('+1234567890', 'Sms'); // You can also pass 'Voice'

// Or send OTP via email
await authProvider.sendOtpToEmail('user@example.com');

// 2. Have the user input the OTP
const response = await authProvider.verifyOtp('123456');

if (response.success) {
    // Navigate to chat interface...
    // Note: Use response.token to connect to client via client.connectUser()
}
```

## Google Integration
```typescript
// Google OAuth Flow
const response = await authProvider.loginWithGoogle('google-oauth-token');

if (response.success) {
   // Use response.token
}
```

## Token Refresh

When a user's JWT token expires, you can obtain a new one without requiring re-authentication using the refresh token returned from the initial login.

```typescript
// The refresh_token is provided alongside the JWT during login
const newTokenResponse = await chatClient.refreshNewToken('REFRESH_TOKEN');
```

:::caution
If you receive API error codes `40`–`43` (token expired / invalid), you **must** call `refreshNewToken` before retrying any failed requests. Simple retries will not resolve authentication errors. See [Error Handling](./error-handling.md) for the full error code reference.
:::

### Recommended Pattern

```typescript
let token = initialToken;
let refreshToken = initialRefreshToken;

async function ensureValidToken() {
  try {
    await chatClient.connectUser(user, token);
  } catch (err) {
    if (err.code >= 40 && err.code <= 43) {
      const response = await chatClient.refreshNewToken(refreshToken);
      token = response.token;
      refreshToken = response.refresh_token;
      await chatClient.connectUser(user, token);
    } else {
      throw err;
    }
  }
}
```
