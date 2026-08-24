const assert = require('node:assert/strict');
const test = require('node:test');

const { ErmisChat } = require('../dist/index.cjs');

test('direct channel profile survives an E2EE channel.updated payload without display metadata', async () => {
  const client = ErmisChat.getInstance('api-key', 'project-id', 'https://chat.example.test', {
    browser: false,
  });
  client.userID = 'current-user';
  client.user = { id: 'current-user', name: 'Current User' };

  const channel = client.channel('messaging', 'direct-channel');
  channel.data = {
    cid: channel.cid,
    id: channel.id,
    type: channel.type,
    name: 'friend@example.test',
    image: 'https://cdn.example.test/friend.png',
  };
  channel.state.members = {
    'current-user': {
      user_id: 'current-user',
      user: client.user,
    },
    friend: {
      user_id: 'friend',
      user: {
        id: 'friend',
        name: 'friend@example.test',
        avatar: 'https://cdn.example.test/friend.png',
      },
    },
  };

  await channel._handleChannelEvent({
    type: 'channel.updated',
    cid: channel.cid,
    channel: {
      cid: channel.cid,
      id: channel.id,
      type: channel.type,
      name: '',
      image: '',
      mls_enabled: true,
      mls_epoch: 1,
    },
  });

  assert.equal(channel.data.name, 'friend@example.test');
  assert.equal(channel.data.image, 'https://cdn.example.test/friend.png');
  assert.equal(channel.data.mls_enabled, true);
  assert.equal(channel.data.mls_epoch, 1);
});
