const assert = require('node:assert/strict');
const test = require('node:test');
const { ErmisChat } = require('../dist/index.cjs');

function harness(encrypted = true) {
  const client = new ErmisChat('fixture-key', 'fixture-project', 'https://fixture.test', { browser: false });
  client.userID = 'creator';
  client.user = { id: 'creator', name: 'Creator' };
  client.state.users = { creator: client.user, recipient: { id: 'recipient', name: 'Recipient' } };
  client.wsPromise = Promise.resolve();
  client.logger = () => {};
  const data = { name: 'Fixture', members: ['creator', 'recipient'] };
  if (encrypted) Object.assign(data, {
    mls_enabled: true, e2ee_recovery_policy: 'member_assisted',
    welcome: new Uint8Array([1]), ratchet_tree: new Uint8Array([2]),
    group_info: new Uint8Array([3]), epoch: 0,
  });
  const channel = client.channel('team', 'fixture-channel', data);
  const bodies = [];
  const response = () => ({
    channel: { id: channel.id, cid: channel.cid, type: 'team', name: 'Fixture', mls_enabled: encrypted,
      members: ['creator', 'recipient'].map(id => ({ user_id: id, user: client.state.users[id] })),
      own_capabilities: [], created_at: '2026-10-05T00:00:00Z' },
    messages: [], pinned_messages: [], read: [], watchers: [],
  });
  client.post = async (_url, body) => { bodies.push(body); return response(); };
  return { client, channel, data, bodies, response };
}

test('E2EE create sends bundle once, subsequent watch/query omit creation data', async () => {
  const { channel, data, bodies } = harness();
  await channel.create();
  await channel.watch();
  await channel.query({});
  assert.equal(bodies.length, 3);
  assert.ok(bodies[0].data.welcome);
  assert.equal(bodies[0].data.epoch, 0);
  assert.equal(bodies[1].data, undefined);
  assert.equal(bodies[2].data, undefined);
  assert.equal(channel.data.mls_enabled, true);
  assert.ok(data.welcome, 'caller-owned constructor object stays unchanged');
});

test('failed HTTP create retains identical bundle for retry', async () => {
  const { client, channel, bodies, response } = harness();
  client.post = async (_url, body) => {
    bodies.push(body);
    if (bodies.length === 1) throw new Error('fixture HTTP failure');
    return response();
  };
  await assert.rejects(channel.create(), /fixture HTTP failure/);
  await channel.create();
  assert.deepEqual(bodies[1], bodies[0]);
  await channel.watch();
  assert.equal(bodies[2].data, undefined);
});

test('server acceptance retires bundle even when local history hydration fails', async () => {
  const { channel, bodies } = harness();
  channel._applyQueryHistoryBoundary = async () => { throw new Error('fixture local storage failure'); };
  await assert.rejects(channel.create(), /fixture local storage failure/);
  channel._applyQueryHistoryBoundary = async () => {};
  await channel.watch();
  assert.equal(bodies[1].data, undefined);
});

test('non-MLS constructor metadata keeps existing query behavior', async () => {
  const { channel, bodies } = harness(false);
  await channel.create();
  await channel.watch();
  assert.deepEqual(bodies[1].data, bodies[0].data);
});

test('an in-flight accepted request does not retire newer caller data', async () => {
  const { client, channel, bodies, response } = harness();
  let started, release;
  const startedPromise = new Promise(resolve => { started = resolve; });
  client.post = async (_url, body) => {
    bodies.push(body);
    started();
    return await new Promise(resolve => { release = () => resolve(response()); });
  };
  const pending = channel.create();
  await startedPromise;
  const newer = { name: 'Replacement', members: ['creator', 'recipient'] };
  client.channel('team', channel.id, newer);
  release();
  await pending;
  assert.deepEqual(channel._queryDataPayload(), newer);
});
