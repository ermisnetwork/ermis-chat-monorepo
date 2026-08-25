const test = require('node:test');
const assert = require('node:assert/strict');

const { canStartDirectCall } = require('../dist/index.cjs');

const directChannel = (currentRole, targetRole) => ({
  type: 'messaging',
  state: {
    members: {
      current: { channel_role: currentRole },
      target: { channel_role: targetRole },
    },
  },
});

test('allows a direct call after both users have accepted the relationship', () => {
  assert.equal(canStartDirectCall(directChannel('owner', 'owner'), 'current'), true);
});

test('blocks a direct call while the recipient invitation is pending', () => {
  assert.equal(canStartDirectCall(directChannel('owner', 'pending'), 'current'), false);
});

test('blocks a direct call when the relationship state is incomplete', () => {
  assert.equal(canStartDirectCall({ type: 'messaging', state: { members: {} } }, 'current'), false);
});
