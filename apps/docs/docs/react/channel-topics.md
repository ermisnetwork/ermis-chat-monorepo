---
sidebar_position: 10
---

# Channel Topics UI

The `ermis-chat-react` UI Kit provides built-in components and behaviors to handle Channel Topics out-of-the-box. Topics are displayed within your channel lists as enriched items with topic pill previews and aggregated message data, and can be browsed in detail through a drill-down `TopicList` panel.

## Topic Display in ChannelList

When the `ChannelList` encounters a parent channel with topics enabled, it automatically renders a `FlatTopicGroupItem` — a 3-row layout that looks like a normal channel item plus a strip of topic pills:

```
┌──────────────────────────────────────────────────┐
│ [Avatar]  Channel Name              [📌] 10:42   │
│           User: Hello everyone!            [3]   │
│           💬 topic-1  🔥 topic-2  📢 topic-3    │
└──────────────────────────────────────────────────┘
```

- **Row 1**: Channel name, pinned icon, and timestamp of the most recent message
- **Row 2**: Last message preview (aggregated across all topics + general) and total unread badge
- **Row 3**: Topic pills showing the first few topics

### Enabling Drill-Down

Pass an `onTopicDrillDown` callback to `ChannelList` to open a detail panel when a user clicks a topic-enabled channel:

```tsx
import { ChannelList } from '@ermis-network/ermis-chat-react';
import type { Channel } from '@ermis-network/ermis-chat-sdk';

const MyChannelList = () => {
  const [topicChannel, setTopicChannel] = useState<Channel | null>(null);

  return (
    <>
      <ChannelList
        onTopicDrillDown={(channel: Channel) => setTopicChannel(channel)}
        onAddTopic={(channel: Channel) => {
          // Open your topic creation modal
        }}
        maxVisibleTopics={3}
        moreTopicsLabel="..."
      />
      {topicChannel && (
        <MyTopicsPanel
          channel={topicChannel}
          onBack={() => setTopicChannel(null)}
        />
      )}
    </>
  );
};
```

### Customization Props

| Prop | Type | Description |
|---|---|---|
| `onTopicDrillDown` | `(channel: Channel) => void` | Callback when a topic-enabled channel is clicked |
| `maxVisibleTopics` | `number` (default: `3`) | Max topic pills shown in the preview strip |
| `moreTopicsLabel` | `string` (default: `'...'`) | Label for the overflow indicator |
| `TopicPillComponent` | `React.ComponentType<TopicPillProps>` | Custom component for each topic pill |
| `FlatTopicGroupItemComponent` | `React.ComponentType<any>` | Replace the entire flat topic group item |

---

## The `TopicList` Component

`TopicList` is a headless, virtualized component that renders the full list of topics for a given parent channel. It uses `VList` for high performance virtualization and is designed to be wrapped with your own header and layout.

Each topic is rendered using `ChannelRow` → `ChannelItem`, showing:
- Topic emoji avatar
- Topic name
- Last message preview + timestamp
- Unread badge
- Pinned icon
- Actions menu (edit, close/reopen)

### Basic Usage

```tsx
import { TopicList } from '@ermis-network/ermis-chat-react';

const MyTopicsPanel = ({ channel, onBack }) => (
  <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
    <header>
      <button onClick={onBack}>← Back</button>
      <h2>{channel.data?.name}</h2>
    </header>
    <div style={{ flex: 1, overflow: 'hidden' }}>
      <TopicList
        channel={channel}
        generalTopicLabel="general"
      />
    </div>
  </div>
);
```

:::tip
`TopicList` does not include any header or navigation. This is intentional — wrap it with your app's own header to match your navigation pattern (sliding panel, modal, separate page, etc.).
:::

### Props

| Prop | Type | Description |
|---|---|---|
| `channel` | `Channel` | **(required)** The parent channel with topics enabled |
| `generalTopicLabel` | `string` (default: `'general'`) | Display name for the general (parent) topic |
| `ChannelItemComponent` | `React.ComponentType<ChannelItemProps>` | Custom component for each topic item |
| `GeneralAvatarComponent` | `React.ComponentType<AvatarProps>` | Custom avatar for the general topic (default: `#`) |
| `TopicAvatarComponent` | `React.ComponentType<AvatarProps>` | Custom avatar for sub-topics (default: emoji) |
| `PinnedIconComponent` | `React.ComponentType` | Custom pinned icon |
| `ChannelActionsComponent` | `React.ComponentType<ChannelActionsProps>` | Custom actions dropdown |
| `onSelectTopic` | `(topic: Channel) => void` | Override topic selection behavior |
| `onEditTopic` | `(channel: Channel) => void` | Handler for Edit Topic action |
| `onToggleCloseTopic` | `(channel: Channel, isClosed: boolean) => void` | Handler for Close/Reopen Topic action |
| `hiddenActions` | `string[]` | Action IDs to hide from the dropdown |
| `actionLabels` | `ChannelActionLabels` | Custom labels for actions |
| `actionIcons` | `ChannelActionIcons` | Custom icons for actions |
| `closedTopicIcon` | `React.ReactNode` | Icon for closed topics |

---

## The `TopicModal` Component

Ermis provides a ready-to-use `TopicModal` component that wraps the API logic for creating and editing a topic. It provides a standard input form for a topic Name and an Emoji icon.

```tsx
import { TopicModal } from '@ermis-network/ermis-chat-react';

// Example inside your wrapper state
{isAddingTopic && (
  <TopicModal
    channel={parentChannel} // The parent channel instance
    title="Create New Topic"
    onClose={() => setIsAddingTopic(false)}
  />
)}

// If editing an existing topic, pass the topic instance as well
{isEditingTopic && (
  <TopicModal
    channel={parentChannel}
    topic={topicChannel}
    title="Edit Topic"
    onClose={() => setIsEditingTopic(false)}
  />
)}
```

## Handling Closed Topics

A topic can be "Closed" (archived) to stop incoming messages while keeping historical data intact.

### UI Indicators
When a topic is closed (`is_closed_topic = true`), the `ChannelList` detects this state and renders a specific UI treatment (e.g., locking the channel visual). You can override the default closed icon by passing `closedTopicIcon` into `ChannelList`.

### The `ClosedTopicOverlay`

When users click into a closed topic, the `VirtualMessageList` detects the closure and renders a blocking overlay over the message input area, preventing them from typing new messages.

By default, the `VirtualMessageList` internally renders `ClosedTopicOverlay` when closed. Authorized users (like `owner` or `moder`) will see a "Reopen Topic" button on the overlay itself.

```tsx
<VirtualMessageList
  // You can customize the text rendered inside the Closed Topic overlay
  closedTopicOverlayTitle="This topic has been closed"
  closedTopicOverlaySubtitle="You can no longer read or send messages in this topic."
  closedTopicReopenLabel="Reopen Topic"
/>
```

:::tip
Always ensure you provide proper `onToggleCloseTopic` handlers in your `ChannelList` if you intend to allow your users to reopen topics via the Three Dots UI.
:::

## Automatic Action Rendering

If you are using the default `ChannelActions` components via the Three Dots menu, the SDK interprets the user's role (e.g., `owner`, `moderator`) and automatically renders the "Create Topic", "Edit Topic", or "Close/Reopen Topic" dropdown items if the user possesses the right capabilities.

**Customizing Action Text and Icons:**
You can override the labels and icons for all these actions by passing `actionLabels` and/or `actionIcons` to the `ChannelList`.

```tsx
<ChannelList
  actionLabels={{
    createTopic: 'New Topic',
    editTopic: 'Change Topic Info',
    closeTopic: 'Archive Topic',
    reopenTopic: 'Restore Topic',
  }}
  actionIcons={{
    CreateTopicIcon: <MyCustomPlusIcon />,
    EditTopicIcon: <MyCustomEditIcon />,
    CloseTopicIcon: <MyCustomLockIcon />,
    ReopenTopicIcon: <MyCustomUnlockIcon />,
  }}
/>
```

## Viewing Topics in `ChannelInfo`
When a user views the `ChannelInfo` panel for a Topic, the UI Kit will adapt to show topic-specific metadata. You can configure how the info panel reacts to an active topic.

```tsx
<ChannelInfo
  isTopic={true}           // Typically inferred from your active channel type / state
  isClosedTopic={false}    // True if the active topic is closed
  onCloseTopic={() => {}}  // Handler when user clicks close from info panel
  onReopenTopic={() => {}} // Handler when user clicks reopen from info panel
  closeTopicLabel="Close this Topic"
  reopenTopicLabel="Reopen this Topic"
/>
```
