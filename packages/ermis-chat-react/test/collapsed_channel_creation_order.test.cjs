const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, require) {
  const module = {exports: {}};
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX},
  }).outputText;
  vm.runInNewContext(code, {module, exports: module.exports, require, Date, setTimeout, clearTimeout});
  return module.exports;
}

test('collapsed sidebar uses parent creation recency and observes channel.created without changing pinned/role groups', () => {
  const activity = load(path.join(__dirname, '../src/channelListActivity.ts'), () => ({}));
  const listeners = new Map();
  const client = {activeChannels: {}, on(type, callback) { listeners.set(type, callback); return {unsubscribe() {}}; }};
  const row = (id, created, message, extra = {}) => ({cid: 'team:' + id, type: 'team',
    data: {created_at: created, ...extra}, state: {last_message_at: message},
    countUnread: () => 0, getClient: () => client});
  const old = row('old', '2026-11-18T08:00:00Z', '2026-11-19T08:00:00Z');
  const pinned = row('pinned', '2026-11-17T08:00:00Z', null, {is_pinned: true});
  client.activeChannels = {[old.cid]: old, [pinned.cid]: pinned};
  let sorted, ticks = 0;
  const react = {useState: () => [ticks, fn => {ticks = fn(ticks);}],
    useMemo: fn => (sorted = fn()), useEffect: fn => fn()};
  const ui = {useChatCore: () => ({client}), useInviteCount: () => ({inviteCount: 0}),
    isTopicChannel: ch => ch.type === 'topic', isGroupChannel: () => true,
    hasTopicsEnabled: () => false, isPendingMember: role => role === 'pending',
    isSkippedMember: role => role === 'skipped', ...activity};
  const component = load(path.join(__dirname, '../../../apps/uhm-chat/src/features/chat/CollapsedChannelSidebar.tsx'), name => {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return {jsx: () => null, jsxs: () => null};
    if (name === '@ermis-network/ermis-chat-react') return ui;
    return {};
  });
  const render = () => component.CollapsedChannelSidebar({onSwitchChannel() {}});
  render();
  const fresh = row('fresh', '2026-11-19T09:00:00Z', null);
  client.activeChannels[fresh.cid] = fresh;
  const pending = row('pending', '2026-11-19T10:00:00Z', null);
  pending.state.membership = {channel_role: 'pending'};
  client.activeChannels[pending.cid] = pending;
  assert.equal(typeof listeners.get('channel.created'), 'function');
  listeners.get('channel.created')({cid: fresh.cid});
  assert.equal(ticks, 1);
  render();
  assert.deepEqual(Array.from(sorted, ch => ch.cid), [pinned.cid, fresh.cid, old.cid]);
});
