---
sidebar_position: 11
---

# Meeting Channels

Meeting channels are specialized streams designed to accommodate audio-video conferencing spaces with simple and constrained setups. 

## Creating a Meeting Channel

The SDK provides a simple convenience method for creating interactive meeting channels. Meeting channels are initialized automatically with the creator as the sole initial member and the `public: true` flag set under the hood.

```typescript
// Create a meeting channel with an optional custom name
const meetingChannel = await chatClient.createMeetingChannel('Q3 Planning Sync');

// Or create without providing a name (will use a default ISO string name)
const emptyMeetingChannel = await chatClient.createMeetingChannel();
```

## Joining a Meeting Channel

To join a Meeting channel safely, use the `joinMeetingChannel` method. This handler gracefully accommodates both existing members and newcomers. 

If you are not yet a member, it accepts the invitation and synchronizes the channel implicitly:

```typescript
const channelId = 'meeting-12345';

// Automatically checks membership -> joins if needed -> watches
const meetingChannel = await chatClient.joinMeetingChannel(channelId);
```
