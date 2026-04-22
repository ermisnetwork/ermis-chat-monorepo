---
sidebar_position: 7
---

# Channel Management

Once a channel is created and initialized, you can manage its members, permissions, notifications, and lifecycle. The available operations differ depending on the channel type.

---

## Team Channel

Team channels support multiple members with a role-based permission system. Each member has one of the following `channel_role` values:

| Role        | Description                                      |
| ----------- | ------------------------------------------------ |
| `owner`     | Channel creator. Full control over the channel.  |
| `moder`     | Moderator. Can manage members and channel settings. |
| `member`    | Regular member. Can send messages and add others.   |
| `pending`   | Invited but has not yet accepted. Cannot perform actions. |

### Mute / Unmute Notifications

Any member can mute or unmute channel notifications for themselves.

```typescript
// Mute for 60 minutes (pass duration in minutes, or null for indefinite)
await channel.muteNotification(60);

// Unmute
await channel.unMuteNotification();
```

### Add Members

All roles **except `pending`** can add new members to the channel.

```typescript
await channel.addMembers(['user_2', 'user_3']);
```

### Remove Members

**`owner`** and **`moder`** can remove users with the `member` or `pending` role from the channel.

```typescript
// Remove another member (owner/moder only)
await channel.removeMembers(['user_2']);
```

Any member (including `moder`) can also use this method to **leave the channel themselves** by passing their own user ID. A `member` cannot remove other members — only themselves.

```typescript
// Leave the channel
await channel.removeMembers(['my_own_user_id']);
```

> **Note**: If the **`owner`** wants to leave, they should use `channel.delete()` instead — an owner leaving will delete the entire channel.

### Ban & Unban

Only **`owner`** and **`moder`** can ban or unban members in the channel. An `owner` or `moder` **cannot** ban/unban each other — this action only applies to the `member` role.

```typescript
// Ban members (prevents sending messages)
await channel.banMembers(['user_bad']);

// Unban members
await channel.unbanMembers(['user_bad']);
```

### Moderators

Only the **`owner`** can promote a `member` to `moder`, or demote a `moder` back to `member`.

```typescript
// Promote to moderator
await channel.addModerators(['user_2']);

// Demote back to member
await channel.demoteModerators(['user_2']);
```

### Update Channel

Only **`owner`** and **`moder`** can update channel metadata (name, description, image, etc.).

```typescript
await channel.update({
  name: 'Renamed Channel',
  description: 'Updated description',
  image: 'https://example.com/new-image.png',
});
```

> Reserved fields (`config`, `cid`, `created_by`, `id`, `type`, etc.) are automatically stripped before the request.

### Update Capabilities

Only **`owner`** and **`moder`** can update channel capabilities. The updated capabilities affect the **`member`** role only — `owner` and `moder` retain full permissions regardless.

The following capabilities can be granted or revoked for members:

| Capability             | Description                                                  |
| ---------------------- | ------------------------------------------------------------ |
| `create-call`          | Start an audio/video call in the channel.                    |
| `join-call`            | Join an ongoing call.                                        |
| `send-message`         | Send text messages in the channel.                           |
| `send-links`           | Include URLs/links in messages.                              |
| `update-own-message`   | Edit their own previously sent messages.                     |
| `delete-own-message`   | Delete their own messages.                                   |
| `quote-message`        | Quote (reply inline to) another message.                     |
| `send-reply`           | Send thread replies to a message.                            |
| `search-messages`      | Search through channel message history.                      |
| `pin-message`          | Pin or unpin messages in the channel.                        |
| `send-reaction`        | Add emoji reactions to messages.                             |
| `delete-own-reaction`  | Remove their own reactions from messages.                    |
| `send-typing-events`   | Broadcast typing indicators to other members.                |
| `upload-file`          | Upload files, images, and videos as attachments.             |
| `create-poll`          | Create polls in the channel.                                 |
| `vote-poll`            | Vote on polls created in the channel.                        |

```typescript
// Grant only specific capabilities to members
await channel.updateCapabilities([
  'send-message',
  'send-reaction',
  'upload-file',
  'send-reply',
]);

// Grant all capabilities
await channel.updateCapabilities([
  'create-call', 'join-call', 'send-message', 'send-links',
  'update-own-message', 'delete-own-message', 'quote-message',
  'send-reply', 'search-messages', 'pin-message', 'send-reaction',
  'delete-own-reaction', 'send-typing-events', 'upload-file',
  'create-poll', 'vote-poll',
]);
```

### Slow Mode (Message Cooldown)

Only **`owner`** and **`moder`** can enable slow mode. When enabled, `member` users must wait for the cooldown period before sending another message, preventing spam.

| Value (ms)   | Duration   |
| ------------ | ---------- |
| `0`          | Off        |
| `10000`      | 10 seconds |
| `30000`      | 30 seconds |
| `60000`      | 1 minute   |
| `300000`     | 5 minutes  |
| `900000`     | 15 minutes |
| `3600000`    | 1 hour     |

```typescript
// Enable slow mode with 30-second cooldown
await channel.setSlowMode(30000);

// Disable slow mode
await channel.setSlowMode(0);
```

### Delete Channel

Only the **`owner`** can permanently delete the channel.

```typescript
await channel.delete();
```

> **Warning**: This action is irreversible. All messages, members, and metadata will be permanently removed.

---

## Messaging Channel

Messaging channels are direct conversations (1-on-1 or group). The available management operations are:

### Mute / Unmute Notifications

Any participant can mute or unmute notifications for themselves.

```typescript
// Mute for 60 minutes (pass duration in minutes, or null for indefinite)
await channel.muteNotification(60);

// Unmute
await channel.unMuteNotification();
```

### Block / Unblock User

Block or unblock the other user in a direct messaging channel.

```typescript
await channel.blockUser();
await channel.unblockUser();
```

### Accept / Reject / Skip Invite

When invited to a direct messaging channel, the invited user initially has a `pending` role. They must respond to the invite before they can send messages.

- **Accept**: Joins the channel as a full member.
- **Reject**: Declines the invitation and closes the channel for the user.
- **Skip**: Silently ignores the invitation, allowing the user to bypass the channel without formally rejecting it (useful for clearing pending queues).

```typescript
// Accept the invitation
await channel.acceptInvite();

// Reject the invitation
await channel.rejectInvite();

// Skip the invitation
await channel.skipInvite();
```

### Truncate Channel

Remove all messages from the channel while keeping the channel itself intact.

```typescript
await channel.truncate();
```
