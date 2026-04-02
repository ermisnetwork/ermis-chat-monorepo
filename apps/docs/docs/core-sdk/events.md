---
sidebar_position: 7
---

# Events & WebSockets

The Ermis Chat SDK handles real-time data using persistent WebSockets (`isomorphic-ws`). When `client.connectUser()` is called, a persistent connection is established. The `StableWSConnection` class will automatically monitor connection health and attempt to reconnect upon failure.

## Listening to Channel Events

You can listen to specific events occurring inside a channel. By binding listeners directly to the channel, you filter out events from other channels the user might be watching.

```typescript
channel.on('message.new', (event) => {
    console.log('Received a new message', event.message);
});

channel.on('typing.start', (event) => {
    console.log(`${event.user?.name} is typing...`);
});
```

Here is a list of common channel events:
- `message.new`
- `message.updated`
- `message.deleted`
- `message.deleted_for_me`
- `message.read`
- `reaction.new`
- `reaction.deleted`
- `member.added`
- `member.removed`
- `channel.updated`

## Listening to Client Events

Client events are global and report on connection health, broad unread notification counts, or invitations across the entire user scope.

```typescript
chatClient.on('connection.changed', (event) => {
   if (event.online) {
       console.log('Back online!');
   } else {
       console.log('Connection dropped. Currently reconnecting...');
   }
});

chatClient.on('connection.recovered', () => {
    console.log('Connection successfully recovered!');
});
```

Here is a list of common global client events:
- `connection.changed`
- `connection.recovered`
- `health.check`
- `notification.invite_accepted`

## Offline Modes & Reconnection

The `StableWSConnection` issues a `health.check` message every 25 seconds. If the health check fails, it forces a reconnection. 

If the client disconnects and goes offline, sent messages that fail will be flagged as `failed_offline` in the channel state. When the `connection.recovered` event triggers, you can catch this and display a "Retry" mechanism for the user, or let the SDK attempt auto-retry if configured.

```typescript
// Example: Tracking connection health manually (if needed)
const isHealthy = chatClient.wsConnection?.isHealthy;
```
