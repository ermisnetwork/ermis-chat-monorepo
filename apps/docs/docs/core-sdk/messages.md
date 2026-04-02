---
sidebar_position: 6
---

# Messages & Indicators

All message manipulations are executed through the specific `Channel` instance that the messages belong to.

## Sending Messages

### Sending Text
```typescript
await channel.sendMessage({
  text: 'Hello from Ermis Chat!',
  mentioned_users: ['user_2']
});
```

### Sending Messages with Attachments
The SDK has a dedicated helper `uploadAndPrepareAttachments` to run file uploads in parallel and generate thumbnails for videos.
```typescript
const files = [/* File or Blob items */];
const { attachments, failedFiles } = await channel.uploadAndPrepareAttachments(files);

await channel.sendMessage({
  text: 'Check out these files!',
  attachments: attachments
});
```

### Retrying Failed Messages
If the websocket goes offline while sending, the message is stored locally with a `failed_offline` status.
```typescript
await channel.retryMessage('failed_message_id');
```

## Manipulating Messages
- **Edit**: `channel.editMessage(messageID, { text: "Updated text" })`
- **Pin / Unpin**: `channel.pinMessage(messageID)` / `channel.unpinMessage(messageID)`
- **Forward**: `channel.forwardMessage(message, { type: 'messaging', channelID: 'target_id' })`
- **Reactions**: 
  - `channel.sendReaction(messageID, 'heart')`
  - `channel.deleteReaction(messageID, 'heart')`
- **Polls**: 
  - `channel.createPoll({ text: "Vote!", poll_type: "single", poll_choices: ["A", "B"] })`
  - `channel.votePoll(messageID, "A")`

## Reading & Typing Indicators

### Read Receipts
When the user views the channel, mark it as read up to the latest point:
```typescript
await channel.markRead();
```

To calculate unread counts locally based on the loaded state:
```typescript
const unread = channel.countUnread();
```

### Typing Indicators
When the user presses a key inside the input block:
```typescript
await channel.keystroke();

// Once they stop typing or submit the message
await channel.stopTyping();
```
