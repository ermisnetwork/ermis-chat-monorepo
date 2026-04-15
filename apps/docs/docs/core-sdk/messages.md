---
sidebar_position: 7
---

# Message Management

All message operations are executed through the specific `Channel` instance that the messages belong to.

## Sending Messages

### Text Messages

```typescript
await channel.sendMessage({
  text: 'Hello from Ermis Chat!',
  mentioned_users: ['user_2'],
});
```

Messages support **optimistic updates**: the SDK immediately inserts the message into `channel.state.messages` with `status: 'sending'`, then updates it to `'received'` when the server confirms via WebSocket.

### Messages with Attachments

The SDK provides `uploadAndPrepareAttachments` to handle file uploads in parallel, normalize file names, and automatically generate video thumbnails.

```typescript
const files = [
  /* File or Blob items */
];
const { attachments, failedFiles } = await channel.uploadAndPrepareAttachments(files);

if (failedFiles.length > 0) {
  console.error('Some files failed to upload:', failedFiles);
}

await channel.sendMessage({
  text: 'Check out these files!',
  attachments,
});
```

Supported attachment types: `image`, `video`, `file`, `voiceRecording`, `linkPreview`.

#### Voice Recordings

You can pass voice recording metadata when uploading:

```typescript
const voiceMetadata = new Map();
voiceMetadata.set(0, { duration: 5.2, waveform: [0.1, 0.5, 0.8, 0.3] });

const { attachments } = await channel.uploadAndPrepareAttachments(files, {
  voiceMetadata,
});
```

### Quoting a Message

```typescript
await channel.sendMessage({
  text: 'I agree with this!',
  quoted_message_id: 'original_message_id',
});
```

### Stickers

```typescript
await channel.sendMessage({
  sticker_url: 'https://example.com/sticker.webp',
});
```

## Retrying Failed Messages

If the WebSocket is offline while sending, messages are stored locally with a `failed_offline` status. When the connection recovers, the SDK automatically retries these messages. You can also retry manually:

```typescript
await channel.retryMessage('failed_message_id');
```

> On `connection.recovered`, the SDK automatically retries all `failed_offline` messages that have no attachments.

## Editing Messages

Only `text` and `mentioned_users` can be edited. Attachments cannot be modified after sending.

```typescript
await channel.editMessage('message_id', {
  text: 'Updated message text',
  mentioned_users: ['user_2'],
});
```

## Deleting Messages

### Delete for Everyone

Permanently removes the message for all channel members. Permission rules differ by channel type:

- **Team channel**: Only the **`owner`** can delete any member's message.
- **Messaging channel**: Users can only delete their **own** messages.

```typescript
await channel.deleteMessage('message_id');
```

### Delete for Me

Removes the message only from the current user's view.

```typescript
await channel.deleteMessageForMe('message_id');
```

## Forwarding Messages

Forward an existing message to another channel. You can use the `createForwardMessagePayload` helper function from the SDK to automatically prepare the correct payload, handling edge cases like sticker-only messages and stripping out `linkPreview` attachments.

```typescript
import { createForwardMessagePayload } from '@ermis-network/ermis-chat-sdk';

const forwardPayload = createForwardMessagePayload(
  message, // The original message object
  targetChannel.cid, // The target channel's CID
  activeChannel.cid, // The current channel's CID
);

await activeChannel.forwardMessage(forwardPayload, {
  type: targetChannel.type,
  channelID: targetChannel.id,
});
```

## Pinned Messages

### Pin / Unpin

```typescript
await channel.pinMessage('message_id');
await channel.unpinMessage('message_id');
```

Pinned messages are accessible via `channel.state.pinnedMessages`, sorted by pin date (newest first).

## Reactions

### Send a Reaction

```typescript
await channel.sendReaction('message_id', 'heart');
```

### Remove a Reaction

```typescript
await channel.deleteReaction('message_id', 'heart');
```

Reactions are stored on each message as `latest_reactions` (all reactions) and `own_reactions` (current user's reactions).

## Polls

### Create a Poll

```typescript
await channel.createPoll({
  text: 'What should we do?',
  poll_type: 'single', // 'single' or 'multiple'
  poll_choices: ['Option A', 'Option B', 'Option C'],
});
```

### Vote on a Poll

```typescript
await channel.votePoll('poll_message_id', 'Option A');
```

## Searching & Querying

### Search Messages

Full-text search within a channel with pagination:

```typescript
const result = await channel.searchMessage('keyword', 0);
// result.messages - array of matching messages with user info
// result.total - total number of matches
```

### Query Attachment Messages

Retrieve all messages that contain attachments, filtered by type:

```typescript
const attachments = await channel.queryAttachmentMessages();
// Returns messages with: image, video, file, voiceRecording, linkPreview
```

### Paginated Message Loading

Load older or newer messages relative to a known message ID:

```typescript
// Load older messages (before a given message)
const olderMessages = await channel.queryMessagesLessThanId('message_id', 25);

// Load newer messages (after a given message)
const newerMessages = await channel.queryMessagesGreaterThanId('message_id', 25);

// Load messages around a specific message (for jump-to-message)
const surroundingMessages = await channel.queryMessagesAroundId('message_id', 25);
```

### Jump to a Specific Message

Load a message into the current state view (used for "jump to message" UI):

```typescript
await channel.state.loadMessageIntoState('target_message_id');

// Jump back to the latest messages
await channel.state.loadMessageIntoState('latest');
```

## Read Receipts & Typing Indicators

### Mark as Read

When the user views the channel, mark it as read:

```typescript
await channel.markRead();
```

### Unread Count

Calculate unread messages locally:

```typescript
const unreadCount = channel.countUnread();

// Or get unread count since a specific date
const unreadSince = channel.countUnread(lastReadDate);
```

### Unread Status per Member

```typescript
const readStatuses = channel.getUnreadMemberCount();
// Returns array of { last_read, unread_messages, user } for each member
```

### Typing Indicators

Broadcast typing events to other members:

```typescript
// When the user starts typing
await channel.keystroke();

// When the user stops typing or submits
await channel.stopTyping();
```

The SDK automatically throttles `typing.start` events to one every 2 seconds and cleans up stale typing indicators after 7 seconds of inactivity.

## System Messages

System messages are auto-generated by the server when channel management actions occur (e.g. member added, name changed). They are stored as messages with `type: 'system'` and contain a coded format.

Use `parseSystemMessage` to convert them into human-readable text:

```typescript
import { parseSystemMessage } from '@ermis-network/ermis-chat-sdk';

// Build a user map from channel state
const userMap: Record<string, string> = {};
Object.values(channel.state.members).forEach((m) => {
  if (m.user) userMap[m.user.id] = m.user.name || m.user.id;
});

const text = parseSystemMessage(message.text, userMap);
// e.g. "Jane changed the channel name to Project Alpha."
```

### System Message Types

| Code | Event                                       |
| ---- | ------------------------------------------- |
| `1`  | Changed channel name                        |
| `2`  | Changed channel avatar                      |
| `3`  | Changed channel description                 |
| `4`  | Member removed from channel                 |
| `5`  | Member banned                               |
| `6`  | Member unbanned                             |
| `7`  | Member promoted to moderator                |
| `8`  | Member demoted from moderator               |
| `9`  | Member permissions updated                  |
| `10` | User joined the channel                     |
| `11` | User declined the invitation                |
| `12` | User left the channel                       |
| `13` | Chat history cleared                        |
| `14` | Channel visibility changed (public/private) |
| `15` | Cooldown (slow mode) toggled                |
| `16` | Banned words updated                        |
| `17` | Member added to channel                     |
| `18` | Admin transferred ownership                 |
| `19` | Message pinned                              |
| `20` | Message unpinned                            |

## Signal Messages (Call Events)

Signal messages represent audio/video call events. They are stored as regular messages with a coded text format.

Use `parseSignalMessage` to parse them into a structured object containing the display text, call duration, call type, and color:

```typescript
import { parseSignalMessage } from '@ermis-network/ermis-chat-sdk';

const result = parseSignalMessage(message.text, client.userID);
// result = { text, duration, callType, color }
```

The function returns a `SignalMessageResult` object:

| Property   | Type                       | Description                                                    |
| ---------- | -------------------------- | -------------------------------------------------------------- |
| `text`     | `string`                   | Human-readable description (e.g. "Incoming audio call...")     |
| `duration` | `string`                   | Formatted call duration (e.g. "2 min, 15 sec"), empty if none  |
| `callType` | `'audio' \| 'video' \| ''` | The type of call                                               |
| `color`    | `string`                   | Suggested display color (`#54D62C` for success, `#FF4842` for missed/rejected) |

The displayed text is **perspective-aware** — it changes based on whether the current user (`myUserId`) is the caller or the recipient.

### Signal Message Types

| Code | Event               |
| ---- | ------------------- |
| `1`  | Audio call started  |
| `2`  | Audio call missed   |
| `3`  | Audio call ended    |
| `4`  | Video call started  |
| `5`  | Video call missed   |
| `6`  | Video call ended    |
| `7`  | Audio call rejected |
| `8`  | Video call rejected |
| `9`  | Audio call busy     |
| `10` | Video call busy     |

