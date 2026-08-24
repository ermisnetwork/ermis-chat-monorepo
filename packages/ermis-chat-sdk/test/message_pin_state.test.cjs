const assert = require('node:assert/strict');
const test = require('node:test');

const { ErmisChat } = require('../dist/index.cjs');

function makeChannel(id) {
  const client = ErmisChat.getInstance('pin-state-key', 'pin-state-project', 'https://chat.example.test', {
    browser: false,
  });
  client.userID = 'pin-user';
  client.user = { id: 'pin-user', name: 'Pin User' };
  return { client, channel: client.channel('messaging', id) };
}

function addMessage(channel, { id, pinned }) {
  const now = new Date().toISOString();
  const message = {
    id,
    text: `message-${id}`,
    created_at: now,
    updated_at: now,
    user: { id: 'pin-user' },
    pinned,
    pinned_at: pinned ? now : null,
  };
  channel.state.addMessageSorted(message);
  if (pinned) channel.state.addPinnedMessage(message);
}

test('unpinMessage removes the message icon and pinned-list entry before API completion', async () => {
  const { client, channel } = makeChannel('pin-optimistic');
  addMessage(channel, { id: 'message-1', pinned: true });

  let releaseRequest;
  client.post = () =>
    new Promise((resolve) => {
      releaseRequest = resolve;
    });
  let unpinnedEvents = 0;
  const subscription = channel.on('message.unpinned', () => {
    unpinnedEvents += 1;
  });

  const request = channel.unpinMessage('message-1');
  const optimistic = channel.state.findMessage('message-1');
  assert.equal(optimistic.pinned, false);
  assert.equal(optimistic.pinned_at, null);
  assert.equal(channel.state.pinnedMessages.length, 0);
  assert.equal(unpinnedEvents, 1);

  releaseRequest({});
  await request;
  subscription.unsubscribe();
});

test('pinMessage rolls optimistic state back when the API fails', async () => {
  const { client, channel } = makeChannel('pin-rollback');
  addMessage(channel, { id: 'message-2', pinned: false });

  const apiError = new Error('pin rejected');
  client.post = async () => {
    throw apiError;
  };

  const request = channel.pinMessage('message-2');
  assert.equal(channel.state.findMessage('message-2').pinned, true);
  assert.equal(channel.state.pinnedMessages.length, 1);

  await assert.rejects(request, apiError);
  const rolledBack = channel.state.findMessage('message-2');
  assert.equal(rolledBack.pinned, false);
  assert.equal(rolledBack.pinned_at, null);
  assert.equal(channel.state.pinnedMessages.length, 0);
});

test('message.unpinned event clears stale pin fields even when backend omits them', async () => {
  const { channel } = makeChannel('pin-realtime');
  addMessage(channel, { id: 'message-3', pinned: true });

  const existing = channel.state.findMessage('message-3');
  await channel._handleChannelEvent({
    type: 'message.unpinned',
    cid: channel.cid,
    created_at: new Date().toISOString(),
    user: { id: 'pin-user' },
    message: {
      id: existing.id,
      text: existing.text,
      created_at: existing.created_at.toISOString(),
      updated_at: new Date().toISOString(),
      user: { id: 'pin-user' },
    },
  });

  const unpinned = channel.state.findMessage('message-3');
  assert.equal(unpinned.pinned, false);
  assert.equal(unpinned.pinned_at, null);
  assert.equal(channel.state.pinnedMessages.length, 0);
});
