---
sidebar_position: 6
---

# Channel Topics

Topics are an organizational feature designed for `team` channels. They allow users to create and group conversations into specific threads or sub-channels (topics) under a single parent channel. Topics act similarly to standard channels but are logically nested and have their own distinct states, members, and events.

Topics are particularly useful for structuring discussions in large team channels, keeping the main channel clutter-free.

:::note
Topics can only be used on channels of type `team`. Attempting to use them on `messaging` or `meeting` types will not work out-of-the-box in the same nested manner.
:::

## Enabling and Disabling Topics

Before you can create topics, the parent channel must have topics enabled. By default, topics might be disabled depending on your application's global configuration.

### Enable Topics
You can enable topics for a specific channel using the `channel.enableTopics()` method.

```javascript
// Ensure you have an initialized client and a team channel
const channel = client.channel('team', 'engineering');

// Enable topics for this channel
await channel.enableTopics();
```

### Disable Topics
Similarly, topics can be disabled using `channel.disableTopics()`. This action usually hides the topic interface but may not destroy the underlying topic data.

```javascript
await channel.disableTopics();
```

## Managing Topics

Once topics are enabled, you can manage them just like specialized channels. 

### Create a Topic

To create a new topic under a parent channel, use `channel.createTopic(data)`. You must provide a payload containing the initial configuration of the topic, such as its name and description.

```javascript
const topicData = {
  name: 'frontend-architecture',
  description: 'Discussions related to our frontend redesign',
  // You can also pass custom properties if needed
};

// Create the topic
const response = await channel.createTopic(topicData);
const newTopicCid = response.channel.cid;
```

### Edit a Topic

You can update a topic's metadata using `channel.editTopic(topicCID, data)`. Note that you must provide the specific `topicCID`.

```javascript
const updatedData = {
  name: 'frontend-v2',
  description: 'Discussions related to the new V2 frontend architecture',
};

// Update the topic
const updatedTopicData = await channel.editTopic(topicCID, updatedData);
```

## Closing and Reopening Topics

Depending on the conversation flow, you may want to archive or "close" a topic to prevent future messages while preserving the chat history.

### Close a Topic
A closed topic is typically marked as read-only in the UI.

```javascript
await channel.closeTopic(topicCID);
```

### Reopen a Topic
A closed topic can be brought back to an active state using the reopen method.

```javascript
await channel.reopenTopic(topicCID);
```

## Accessing Topic State

Topics connected to a parent channel can be accessed through the channel's local state. The parent `channel.state.topics` array contains the metadata and references to its child topics.

```javascript
const topics = channel.state.topics;

topics.forEach((topic) => {
  console.log(`Topic ID: ${topic.id}, Name: ${topic.name}`);
  console.log(`Is Closed: ${topic.is_closed_topic}`);
});
```

:::tip Handling Messages within Topics
Under the hood, a topic functions exactly like a channel. This means you can initialize and interact with it using `client.channel('topic', topicId)` and listen to its events exactly as you would with a `team` channel.
:::

## Lắng nghe Sự kiện Topic (Topic Events)

The SDK fires specific events on the parent channel when topic settings or lifecycle changes occur. You can listen to these to perform optimistic UI updates.

### Topic Lifecycle Events

- `channel.topic.created`: Fired when a new topic is created.
- `channel.topic.updated`: Fired when a topic's metadata is changed via `editTopic`.
- `channel.topic.closed`: Fired when a topic is closed.
- `channel.topic.reopen`: Fired when a topic is reopened.

### Topic Configuration Events

- `channel.topic.enabled`: Fired when topics are enabled on the parent channel.
- `channel.topic.disabled`: Fired when topics are disabled.

### Example Usage

```javascript
const handleTopicCreated = (event) => {
  console.log('A new topic was created:', event.channel.name);
};

// Listen to topic creation
channel.on('channel.topic.created', handleTopicCreated);

// Don't forget to cleanup listeners when components unmount
// channel.off('channel.topic.created', handleTopicCreated);
```
