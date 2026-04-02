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


