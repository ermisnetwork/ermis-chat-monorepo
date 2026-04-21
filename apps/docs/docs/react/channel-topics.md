---
sidebar_position: 10
---

# Channel Topics UI

The `ermis-chat-react` UI Kit provides built-in components and behaviors to handle Channel Topics out-of-the-box. Topics are displayed seamlessly within your application's channel lists, complete with specific icons, modal editors, and "closed" states.

## Topic Integration in ChannelList

When you fetch a parent `team` channel that has topics enabled, the React UI Kit automatically synchronizes those sub-channels as distinct visual items.

By default, the `ChannelList` component provides callbacks that allow you to dictate how creating, editing, and closing topics should be handled in your UI state. 

```tsx
import { ChannelList, Channel } from '@ermis-network/ermis-chat-react';

const MyChannelList = () => {
  return (
    <ChannelList
      filters={{ type: 'team' }}
      // Action Callbacks
      onAddTopic={(channel: Channel) => {
        // Triggered when a user clicks "Create Topic" from channel actions
      }}
      onEditTopic={(channel: Channel) => {
        // Triggered to edit an existing topic
      }}
      onToggleCloseTopic={(channel: Channel, isClosed: boolean) => {
         // Triggered when closing or reopening a topic
      }}
      
      // Topic Customization Props
      generalTopicLabel="General Chat"
      closedTopicIcon={<MyCustomClosedIcon />}
      TopicAvatarComponent={({ image }) => <MyEmojiRenderer image={image} />}
      GeneralTopicAvatarComponent={() => <div>#</div>}
    />
  );
};
```

### The `ChannelTopicGroup` Component
When `ChannelList` encounters a `team` channel with topics enabled, it internally wraps the channel items using the `ChannelTopicGroup` component. This component provides an expandable accordion UI.

Built-in logic for the `ChannelTopicGroup`:
- **General Proxy**: It automatically generates a `general` topic proxy at the top of the list so that the parent channel still feels like a chat room. By default, its label is `'general'` and it has a hashtag icon.
- **Sorting**: Topics within the dropdown are automatically sorted. Pinned topics appear first, followed by the most recently active topics.
- **Emoji Avatars**: Instead of standard image avatars, Topics rely string prefixes such as `emoji://💬` to render topic icons.

You can override the entire group layout by passing a `ChannelTopicGroupComponent` to `ChannelList`.

### Automatic Action Rendering

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
