const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildUserMap,
  replaceMentionsForPreview,
} = require('../dist/index.cjs');

test('buildUserMap correctly handles members as an Array', () => {
  const channelState = {
    members: [
      { user_id: 'user-1', user: { id: 'user-1', name: 'Alice Nguyen' } },
      { user: { id: 'user-2', display_name: 'Bob Tran' } },
    ],
  };

  const userMap = buildUserMap(channelState);
  assert.equal(userMap['user-1'], 'Alice Nguyen');
  assert.equal(userMap['user-2'], 'Bob Tran');
});

test('buildUserMap correctly handles members as an Object Record', () => {
  const channelState = {
    members: {
      'user-1': { user: { id: 'user-1', name: 'Alice Nguyen' } },
      'user-2': { user_id: 'user-2', user: { name: 'Bob Tran' } },
    },
  };

  const userMap = buildUserMap(channelState);
  assert.equal(userMap['user-1'], 'Alice Nguyen');
  assert.equal(userMap['user-2'], 'Bob Tran');
});

test('buildUserMap merges client.state.users as extraUsers', () => {
  const channelState = {
    members: [
      { user_id: 'user-1', user: { id: 'user-1', name: 'Alice' } },
    ],
  };
  const extraUsers = {
    'user-3': { id: 'user-3', name: 'Charlie Pham' },
  };

  const userMap = buildUserMap(channelState, extraUsers);
  assert.equal(userMap['user-1'], 'Alice');
  assert.equal(userMap['user-3'], 'Charlie Pham');
});

test('replaceMentionsForPreview formats @user_id to @DisplayName', () => {
  const userMap = {
    'user-1': 'Alice Nguyen',
    '3409158c4df53d353d469ac9500c22684196': 'Thang Admin',
  };

  const message = {
    text: 'Hello @user-1 and @3409158c4df53d353d469ac9500c22684196 please check this!',
    mentioned_users: ['user-1', '3409158c4df53d353d469ac9500c22684196'],
  };

  const result = replaceMentionsForPreview(message.text, message, userMap);
  assert.equal(result, 'Hello @Alice Nguyen and @Thang Admin please check this!');
});

test('replaceMentionsForPreview handles mentioned_all alongside mentioned_users', () => {
  const userMap = {
    'user-1': 'Alice',
  };

  const message = {
    text: 'Hi @all and @user-1',
    mentioned_all: true,
    mentioned_users: ['user-1'],
  };

  const result = replaceMentionsForPreview(message.text, message, userMap);
  assert.equal(result, 'Hi @all and @Alice');
});
