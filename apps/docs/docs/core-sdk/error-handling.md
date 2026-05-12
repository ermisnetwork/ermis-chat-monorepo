---
sidebar_position: 8
sidebar_label: Error Handling
---

# Error Handling

The Ermis Chat SDK provides a structured error system with typed error codes, retry classification, and utility functions to help you build robust error-handling logic.

## API Error Codes

Every failed REST or WebSocket request returns a numeric error code. The SDK maps these codes to human-readable names and classifies whether a retry is safe.

| Code | Name | Retryable |
|------|------|-----------|
| `-1` | `InternalSystemError` | ✅ Yes |
| `2` | `AccessKeyError` | ❌ No |
| `3` | `AuthenticationFailedError` | ✅ Yes |
| `4` | `InputError` | ❌ No |
| `6` | `DuplicateUsernameError` | ❌ No |
| `9` | `RateLimitError` | ✅ Yes |
| `16` | `DoesNotExistError` | ❌ No |
| `17` | `NotAllowedError` | ❌ No |
| `18` | `EventNotSupportedError` | ❌ No |
| `19` | `ChannelFeatureNotSupportedError` | ❌ No |
| `20` | `MessageTooLongError` | ❌ No |
| `21` | `MultipleNestingLevelError` | ❌ No |
| `22` | `PayloadTooBigError` | ❌ No |
| `23` | `RequestTimeoutError` | ✅ Yes |
| `24` | `MaxHeaderSizeExceededError` | ❌ No |
| `40` | `AuthErrorTokenExpired` | ❌ No |
| `41` | `AuthErrorTokenNotValidYet` | ❌ No |
| `42` | `AuthErrorTokenUsedBeforeIssuedAt` | ❌ No |
| `43` | `AuthErrorTokenSignatureInvalid` | ❌ No |
| `44` | `CustomCommandEndpointMissingError` | ❌ No |
| `45` | `CustomCommandEndpointCallError` | ✅ Yes |
| `60` | `CoolDownError` | ✅ Yes |
| `69` | `ErrWrongRegion` | ❌ No |
| `70` | `ErrQueryChannelPermissions` | ❌ No |
| `71` | `ErrTooManyConnections` | ✅ Yes |
| `99` | `AppSuspendedError` | ❌ No |

---

## Error Utility Functions

The SDK exports several helpers from the `errors` module to classify and handle errors programmatically.

### `isAPIError(error)`

```typescript
import { isAPIError } from '@ermis-network/ermis-chat-sdk';

try {
  await channel.sendMessage({ text: 'Hello' });
} catch (err) {
  if (isAPIError(err)) {
    console.log('API error code:', err.code);
  }
}
```

Returns `true` if the error object has a numeric `code` property, indicating it originated from the Ermis API.

### `isErrorRetryable(error)`

```typescript
import { isAPIError, isErrorRetryable } from '@ermis-network/ermis-chat-sdk';

try {
  await channel.sendMessage({ text: 'Hello' });
} catch (err) {
  if (isAPIError(err) && isErrorRetryable(err)) {
    // Safe to retry this request
    await retryWithBackoff(() => channel.sendMessage({ text: 'Hello' }));
  } else {
    // Permanent error — show user feedback
    showErrorToast('This action is not allowed.');
  }
}
```

Looks up the error code in the `APIErrorCodes` table and returns `true` if the error is classified as retryable (e.g., rate limits, timeouts, transient server errors).

### `isWSFailure(error)`

```typescript
import { isWSFailure } from '@ermis-network/ermis-chat-sdk';

client.on('connection.changed', (event) => {
  if (!event.online) {
    console.log('Connection lost — SDK will auto-reconnect');
  }
});
```

Returns `true` if the error originated from a WebSocket transport failure (as opposed to an API-level rejection). The SDK automatically reconnects on WS failures, so you typically only need this for logging or UI indicators.

---

## Best Practices

:::tip
**Distinguish retryable from permanent errors.** Use `isErrorRetryable()` to decide whether to retry automatically or show an error to the user. Retrying a permanent error (like `NotAllowedError`) wastes resources and confuses users.
:::

:::caution
**Token expiration errors** (codes `40`–`43`) are marked as non-retryable because they require a fresh token, not a simple retry. Use `client.refreshNewToken(refresh_token)` to obtain a new token, then retry the operation. See [Authentication — Token Refresh](./auth.md) for details.
:::

### Recommended Pattern

```typescript
import { isAPIError, isErrorRetryable } from '@ermis-network/ermis-chat-sdk';

async function safeSendMessage(channel, text) {
  try {
    return await channel.sendMessage({ text });
  } catch (err) {
    if (!isAPIError(err)) {
      // Network or unexpected error
      console.error('Unexpected error:', err);
      throw err;
    }

    if (isErrorRetryable(err)) {
      // Wait and retry once
      await new Promise((r) => setTimeout(r, 2000));
      return await channel.sendMessage({ text });
    }

    // Permanent error — surface to user
    throw new Error(`Message failed: ${err.message} (code ${err.code})`);
  }
}
```
