---
sidebar_position: 5
---

# The Channel

The `Channel` class encapsulates all real-time communication functionality for a specific chat channel. It handles messages, reactions, thread replies, typing indicators, and manages a localized state for rapid user interface updates.

## Querying Channels

To retrieve a list of channels that the user is a part of (or matches specific criteria), use the `queryChannels` method on the `chatClient`.

```typescript
const filter = {
  type: ['messaging', 'team'],
  limit: 10,
  offset: 0,
  include_pinned_messages: true,
};

// Sort channels properties
const sort = [
  { field: 'last_message_at', direction: -1 }
];

// Additional fetch options (e.g., limit the number of messages fetched per channel)
const options = { message_limit: 30 };

const response = await chatClient.queryChannels(filter, sort, options);

// Returns an array of Channel objects populated with data
console.log(response); 
```

### Parameter Interfaces

#### 1. `filterConditions (ChannelFilters)`
This explicitly defines how to aggregate the subset of channels available to the authenticated user.
- **`type`**: Required. An array of channel types to look up, e.g. `['messaging', 'team']`.
- **`limit`**: Maximum number of channels returned per page.
- **`offset`**: Channel offset sequence. 
- **`roles` / `other_roles`**: Array of strings to filter by required user roles.
- **`include_pinned_messages`**: Flag to fetch pinned messages metadata.

#### 2. `sort (ChannelSort)`
An array of objects mapping strict sorting metrics.
- **`field`**: A field mapping string, e.g., `'last_message_at'`, `'created_at'`.
- **`direction`**: Determines ascending `1` or descending `-1` precedence. 

#### 3. `options`
Settings primarily concerning the inner pagination per channel item.
- **`message_limit`**: Caps the number of message objects hydrated inside each channel's `.messages` array list on querying.


## Creating Channels

If you need to create a brand new channel on the server and invite peers, you can pass members inside a payload and call `.create()`.

**Direct Messaging Channels**
```typescript
// For 1-on-1 or group messaging, use the members array
const dmChannel = chatClient.channel('messaging', {
   members: ['user_me', 'user_other'] 
});
await dmChannel.create(); 
// At this point, 'user_other' has a pending invite for this channel
```

**Team Channels**
If you create a `team` channel, you can assign metadata (name, description, visibility) in the payload:
```typescript
const payload = {
  name: 'Project Alpha',
  description: 'Team for Project Alpha',
  members: ['user_1', 'user_2', 'user_me'],
  public: true,
};

const teamChannel = chatClient.channel('team', payload);
await teamChannel.create();

// Create a nested topic inside the team
await teamChannel.createTopic({ name: "General Discussion" });
```

## Managing Invites

For the invited users, the channel stays in a pending state until resolved. To enter the channel details and start chatting or watching, the user must explicitly decide what to do with the invitation:

```typescript
// Accept the invite
await channel.acceptInvite('accept');

// Reject the invite
await channel.rejectInvite();

// Skip the invite (e.g. for messaging channels to ignore it)
await channel.skipInvite();
```

## Initialization & Watching

Channels are obtained from the `chatClient`.

```typescript
// Type can be 'messaging', 'team', or 'topic'.
// ID is an alphanumeric channel identifier.
const channel = chatClient.channel('messaging', 'channel_1');

// .watch() queries the state AND explicitly instructs the server to forward real-time WS events to this client
const state = await channel.watch({
   limit: 30, // Get the last 30 messages
});
```

Because both `.watch()` and `.query()` share the same core implementation, invoking `.query()` will also configure local event listeners by registering the channel internally. The primary difference is `.watch()` automatically enforces `watch: true` in the API payload to the server.
```typescript
await channel.query({ limit: 30, watch: true });
```


## Members & Access Control

Channel managers can quickly invite or revoke members.

- **Add / Remove**: `channel.addMembers(['user_2'])` / `channel.removeMembers(['user_2'])`
- **Ban / Unban**: `channel.banMembers(['user_bad'])` / `channel.unbanMembers(['user_bad'])`
- **Moderators**: `channel.addModerators(['user_2'])` / `channel.demoteModerators(['user_2'])`


## Local State Management

The `channel.state` provides synchronous access to the channel's mapped collections. Since it automatically listens to remote updates, you shouldn't mutate it manually but instead bind it to your React (or other framework) states:

```typescript
console.log(channel.state.messages); // Array of messages
console.log(channel.state.members);  // Record of members keyed by UserID
console.log(channel.state.read);     // Read status (watermarks access timestamps)
```
