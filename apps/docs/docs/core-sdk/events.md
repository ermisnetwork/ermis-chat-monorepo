---
sidebar_position: 9
---

# Events & WebSockets

The Ermis Chat SDK handles real-time data using persistent WebSockets (`isomorphic-ws`). When `client.connectUser()` is called, a persistent connection is established. The `StableWSConnection` class will automatically monitor connection health and attempt to reconnect upon failure.

## Listening to Events

You can listen to events globally on the `chatClient` instance or specifically scoped to a `channel` instance.

```typescript
// Global client event
chatClient.on('connection.changed', (event) => {
   if (event.online) {
       console.log('Back online!');
   }
});

// Channel-scoped event
channel.on('message.new', (event) => {
    console.log('Received a new message', event.message);
});
```

Here is a comprehensive list of all supported events categorized by their domain:

### Connection & Client Events

Track connection health, capabilities, and system-wide notifications globally via `chatClient.on(...)`:

- `connection.changed` - Fired when the WebSocket connection state changes (online/offline).
- `connection.recovered` - Fired when the client successfully reconnects after an unexpected drop.
- `health.check` - Internal ping/pong event tracking WS stable state.
- `capabilities.changed` - Fired when the client encounters feature-flag or capability shifts.
- `notification.channel_deleted` - Sent to users when a channel they belong to is deleted globally.
- `notification.invite_accepted` - Triggered when a team/channel invite is accepted.
- `notification.invite_rejected` - Triggered when an invite is rejected.
- `notification.invite_messaging_skipped` - Triggered when an invite triggers skipping logical workflows.

### Message Events

Primarily listened to on `channel.on(...)` to monitor chat stream activity:

- `message.new` - Triggered when a message is received in the channel.
- `message.updated` - Triggered when an existing message gets edited.
- `message.read` - Triggered when members update their read markers.
- `message.deleted` - Triggered when a message is hard or soft deleted globally.
- `message.deleted_for_me` - Triggered when a message is hidden locally for the active user.
- `message.pinned` - Fired when a message is pinned.
- `message.unpinned` - Fired when a message is unpinned.

### Channel Management Events

Fired during core channel lifecycle functions:

- `channel.created` - A new channel is established.
- `channel.updated` - Core channel metadata (name, image) changes.
- `channel.deleted` - A channel gets permanently removed.
- `channel.truncate` - Channel message history is completely wiped.
- `channel.pinned` / `channel.unpinned` - Channel gets pinned or unpinned in the workspace.

**Topic Events**
If channel topics are utilized to thread content, these govern them:
- `channel.topic.created`, `channel.topic.updated`, `channel.topic.closed`, `channel.topic.reopen`
- `channel.topic.enabled`, `channel.topic.disabled` - Fired when the topic module configuration toggles.

### Member Events

Fired when channel membership and roles change:

- `member.added` / `member.removed` - Users are added or removed manually.
- `member.joined` - A user voluntarily joins an open channel.
- `member.updated` - Member attributes shift.
- `member.promoted` / `member.demoted` - A user's role in the channel (e.g., to admin) escalates or decreases.
- `member.banned` / `member.unbanned` - A user experiences a channel-level moderation block shift.
- `member.blocked` / `member.unblocked` - General peer-to-peer user blocks context within the channel.

### Interactions & Presence

Capture micro-interactions globally or per-channel:

- `reaction.new` / `reaction.deleted` - A user adds or removes an emoji reaction to a specific message.
- `typing.start` / `typing.stop` - A user begins or ceases typing in the text input.
- `user.watching.start` / `user.watching.stop` - A user focuses their active view onto the channel scope or navigates away.
- `pollchoice.new` - Triggers when a user adds or votes on an interactive poll constraint.

## Offline Modes & Reconnection

The `StableWSConnection` issues a `health.check` message every 25 seconds. If the health check fails, it forces a reconnection. 

If the client disconnects and goes offline, sent messages that fail will be flagged as `failed_offline` in the channel state. When the `connection.recovered` event triggers, you can catch this and display a "Retry" mechanism for the user, or let the SDK attempt auto-retry if configured.

```typescript
// Example: Tracking connection health manually (if needed)
const isHealthy = chatClient.wsConnection?.isHealthy;
```
