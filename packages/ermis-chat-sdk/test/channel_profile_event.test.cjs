const assert = require('node:assert/strict');
const test = require('node:test');

const { ErmisChat } = require('../dist/index.cjs');

for (const [label, flag, memberId, expected] of [
  ['missing top-level MLS flag', undefined, 'current-user', 1],
  ['explicit false MLS flag', false, 'current-user', 0],
  ['foreign membership', undefined, 'foreign-user', 0],
]) {
  test(`invite acceptance uses established channel MLS scope: ${label}`, async () => {
    const client = ErmisChat.getInstance('api-key', 'project-id', 'https://chat.example.test', {browser:false});
    client.userID = 'current-user'; client.user = {id:'current-user'};
    client.state.users[memberId] = {id:memberId};
    const channel = client.channel('team', 'invite-' + label.replaceAll(' ', '-'));
    channel.data = {cid:channel.cid, mls_enabled:true, member_count:1};
    let calls = 0;
    client.encryptionManager = {initialized:true, ensureChannelReady:async(type,id,cid,options) => {
      calls++; assert.equal(cid,channel.cid); assert.equal(options.source,'invite_accepted');
      assert.equal(channel.state.membership.channel_role,'member');
    }, isRecoveryVaultUnlocked:()=>false};
    await channel._handleChannelEvent({type:'notification.invite_accepted',cid:channel.cid,
      ...(flag === undefined ? {} : {mls_enabled:flag}),member:{user_id:memberId,channel_role:'member',user:{id:memberId}}});
    await Promise.resolve();
    assert.equal(calls,expected);
    client.encryptionManager = undefined;
  });
}

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
