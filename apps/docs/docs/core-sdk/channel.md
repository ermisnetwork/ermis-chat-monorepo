---
sidebar_position: 5
---

# Channels

The `Channel` class encapsulates all real-time communication functionality for a specific chat channel. It handles messages, reactions, thread replies, typing indicators, and manages a localized state for rapid user interface updates.

## Querying Channels

Use `queryChannels` to retrieve a list of channels the authenticated user belongs to. The method returns an array of fully hydrated `Channel` objects ready for use.

```typescript
const channels = await chatClient.queryChannels(filterConditions, sort, options);
```

### Parameters

#### 1. `filterConditions` (required)

Defines which channels to retrieve. All filter fields are combined together.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `string[]` | ✅ Yes | Channel types to query. Possible values: `'messaging'`, `'team'`, `'meeting'`, `'topic'`. |
| `limit` | `number` | No | Maximum number of channels returned. Default depends on server config. |
| `offset` | `number` | No | Number of channels to skip (for pagination). Default: `0`. |
| `roles` | `string[]` | No | Filter by the current user's channel role. Possible values: `'owner'`, `'moder'`, `'member'`, `'pending'`, `'skipped'`. |
| `other_roles` | `string[]` | No | Filter by other members' channel roles. Same possible values as `roles`. |
| `banned` | `boolean` | No | If `true`, returns only channels where the user is banned. |
| `blocked` | `boolean` | No | If `true`, returns only channels where the user is blocked. |
| `include_pinned_messages` | `boolean` | No | If `true`, includes pinned messages in the response. |

#### 2. `sort` (optional)

An array of sorting rules applied in order. Each rule has:

| Field | Type | Description |
|-------|------|-------------|
| `field` | `string` | The field to sort by. Common values: `'last_message_at'`, `'created_at'`, `'updated_at'`. |
| `direction` | `1` \| `-1` | `1` for ascending (oldest first), `-1` for descending (newest first). |

#### 3. `options` (optional)

Controls how much message data is fetched per channel.

| Field | Type | Description |
|-------|------|-------------|
| `message_limit` | `number` | Maximum number of messages loaded per channel. Default: `25`. |

### Examples

**Basic — fetch all direct and group channels:**

```typescript
const channels = await chatClient.queryChannels(
  { type: ['messaging', 'team'] },
  [{ field: 'last_message_at', direction: -1 }],
  { message_limit: 30 },
);
```

**With pagination:**

```typescript
// Page 1
const page1 = await chatClient.queryChannels(
  { type: ['messaging', 'team'], limit: 20, offset: 0 },
);

// Page 2
const page2 = await chatClient.queryChannels(
  { type: ['messaging', 'team'], limit: 20, offset: 20 },
);
```

**Filter by role — only channels where the user is a confirmed member:**

```typescript
const confirmedChannels = await chatClient.queryChannels(
  { type: ['messaging', 'team'], roles: ['owner', 'member'] },
);
```

**Filter pending invites — channels waiting for the user to accept:**

```typescript
const pendingChannels = await chatClient.queryChannels(
  { type: ['messaging', 'team'], roles: ['pending'] },
);
```

**Include pinned messages:**

```typescript
const channels = await chatClient.queryChannels(
  { type: ['messaging', 'team'], include_pinned_messages: true },
);
```

## Pin / Unpin Channel

Users can pin channels to keep them at the top of their channel list. Pinned state is per-user and does not affect other members.

```typescript
// Pin a channel
await chatClient.pinChannel(channelType, channelId);

// Unpin a channel
await chatClient.unpinChannel(channelType, channelId);
```

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `channelType` | `string` | The type of the channel. Possible values: `'messaging'`, `'team'`, `'meeting'`. |
| `channelId` | `string` | The unique ID of the channel to pin or unpin. |

### Example

```typescript
// Pin a direct message channel
await chatClient.pinChannel('messaging', 'channel_abc123');

// Pin a team channel
await chatClient.pinChannel('team', 'channel_xyz789');

// Unpin it later
await chatClient.unpinChannel('team', 'channel_xyz789');
```

When querying channels, pinned channels are returned with `is_pinned: true` in their channel data.

## Creating Channel

### Direct Messaging Channels

Direct channels are for 1-on-1 private conversations. When created, the creator has the channel role `owner`, while the other user starts with the channel role `pending`.

```typescript
const dmChannel = chatClient.channel('messaging', {
  members: ['user_me', 'user_other'],
});
await dmChannel.create();
// 'user_me' → channel role: owner
// 'user_other' → channel role: pending
```

**Resolving a Direct Channel invite:**

- **Accept:** The pending user calls `acceptInvite('accept')` to join the conversation. Their channel role changes from `pending` to `owner`.

```typescript
await dmChannel.acceptInvite('accept');
// 'user_other' → channel role: owner (can now chat)
```

- **Skip:** The pending user can skip the invite via `skipInvite()`. Their channel role changes to `skipped`. The channel will be hidden from their active list but can be accessed later.

```typescript
await dmChannel.skipInvite();
// 'user_other' → channel role: skipped
```

> **Note:** Direct channels only support `skipInvite()`. The `rejectInvite()` method is **not available** for direct channels.

---

### Group Channels

Group channels support multiple members with configurable visibility. There are two group channel types:

- **`team`** — Requires at least 2 members when creating (the owner + at least 1 invited user).
- **`meeting`** (Quick Channel) — Only requires the creator. Other users can join later. Always public by default.

The `public` flag determines how new users can join.

#### Public Group Channel (`public: true`)

In a public channel, any user can join without needing an invitation. Users who are not yet members must call `acceptInvite('join')` to become a member.

For users who were **invited** as members during channel creation, they start with the channel role `pending` and need to accept the invite first.

```typescript
const publicGroup = chatClient.channel('team', {
  name: 'Open Community',
  members: ['user_1', 'user_me'],
  public: true,
});
await publicGroup.create();
// 'user_me' → channel role: owner
// 'user_1' → channel role: pending
```

**For invited members (pending):**

```typescript
// Invited user accepts the invite
await publicGroup.acceptInvite('accept');
// User → channel role: member (can now chat)
```

**For non-members joining a public channel:**

```typescript
// A user who was not invited joins the channel directly
await publicGroup.acceptInvite('join');
// User → channel role: member (can now chat)
```

#### Private Group Channel (`public: false`)

In a private channel, users **cannot join on their own** — they must be invited by an existing member. Invited users start with the channel role `pending`.

```typescript
const privateGroup = chatClient.channel('team', {
  name: 'Project Alpha',
  description: 'Internal team discussion',
  members: ['user_1', 'user_2', 'user_me'],
  public: false,
});
await privateGroup.create();
// 'user_me' → channel role: owner
// 'user_1', 'user_2' → channel role: pending
```

**Resolving a Group Channel invite:**

- **Accept:** The pending user calls `acceptInvite('accept')` to join. Their channel role changes from `pending` to `member`.

```typescript
await privateGroup.acceptInvite('accept');
// User → channel role: member (can now chat)
```

- **Reject:** The pending user can reject the invitation via `rejectInvite()`. This removes them from the channel entirely.

```typescript
await privateGroup.rejectInvite();
// User is removed from the channel
```

> **Note:** `rejectInvite()` is **only available** for group channels. Direct channels cannot use this method.

---

#### Quick Channel (Meeting Type)

Quick channels provide the simplest way to start a group chat. Unlike `team` channels, a quick channel **only requires the creator** — no other members needed at creation time. The channel is always **public by default**, so anyone with the channel ID can join instantly.

This is ideal for open discussions, support rooms, or any scenario where you want frictionless, instant group chat.

**Creating a quick channel:**

```typescript
// Only the creator is needed — no other members required
const channel = await chatClient.createQuickChannel('General Discussion');

// Or create without a name (a default name will be generated)
const channel = await chatClient.createQuickChannel();
```

**Joining a quick channel:**

Any user can join by channel ID. The method automatically handles membership — if you're already a member it simply watches the channel, otherwise it joins first.

```typescript
const channel = await chatClient.joinQuickChannel(channelId);
// User → channel role: member (can now chat)

await channel.sendMessage({ text: 'Hello everyone!' });
```

---

### Channel Roles Summary

| Action | Direct Channel | Group (Public) | Group (Private) | Quick Channel |
|--------|---------------|----------------|-----------------|---------------|
| Creator role | `owner` | `owner` | `owner` | `owner` |
| Invited user role | `pending` | `pending` | `pending` | — |
| `acceptInvite('accept')` | `pending` → `owner` | `pending` → `member` | `pending` → `member` | — |
| `acceptInvite('join')` | — | Joins as `member` | — | — |
| `joinQuickChannel()` | — | — | — | Joins as `member` |
| `skipInvite()` | `pending` → `skipped` | — | — | — |
| `rejectInvite()` | ❌ Not available | Removes from channel | Removes from channel | — |

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

## Local State Management

The `channel.state` provides synchronous access to the channel's mapped collections. Since it automatically listens to remote updates, you shouldn't mutate it manually but instead bind it to your React (or other framework) states:

```typescript
console.log(channel.state.messages); // Array of messages
console.log(channel.state.members); // Record of members keyed by UserID
console.log(channel.state.read); // Read status (watermarks access timestamps)
```
