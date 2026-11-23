const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Exercise the real hook and its registered SDK callback without a browser/backend.
function mount(initial, sortByRecency = true) {
  const listeners = new Map();
  const refs = [], effects = [];
  let cursor = 0, rows = initial, writes = 0;
  const client = { userID: 'fixture', activeChannels: {}, on(type, fn) {
    listeners.set(type, fn); return { unsubscribe() {} };
  }, channel(type, id) { return client.activeChannels[`${type}:${id}`]; } };
  const react = {
    useRef(value) { const index = cursor++; return refs[index] ||= { current: value }; },
    useEffect(fn, deps) {
      const index = cursor++;
      if (!effects[index] || deps.some((v, i) => v !== effects[index][i])) {
        effects[index] = deps; fn();
      }
    },
  };
  const module = { exports: {} };
  const filename = path.join(__dirname, '../src/hooks/useChannelListUpdates.ts');
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const setActiveChannel = () => {};
  const setRows = update => { rows = update(rows); writes++; };
  vm.runInNewContext(code, { exports: module.exports, module, Date, setTimeout, setInterval, clearInterval, console,
    require(name) {
      if (name === 'react') return react;
      if (name === './useChatCore') return { useChatCore: () => ({ client, activeChannel: null, setActiveChannel }) };
      if (name === '../channelTypeUtils') return { isDirectChannel: () => false, isGroupChannel: () => true };
      if (name === '../channelRoleUtils') return { isPendingMember: () => false };
      if (name === '../channelListActivity') {
        const file = path.join(__dirname, '../src/channelListActivity.ts'), mod = {exports:{}};
        const code = ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
        vm.runInNewContext(code,{exports:mod.exports,module:mod,Date});return mod.exports;
      }
      throw new Error(name);
    },
  }, { filename });
  const render = () => { cursor = 0; module.exports.useChannelListUpdates(rows, setRows, undefined, sortByRecency); };
  render();
  return { emit: (type, event = {}) => listeners.get(type)?.({ type, ...event }), render,
    register: channel => { client.activeChannels[channel.cid] = channel; },
    rows: () => Array.from(rows, r => r.cid), writes: () => writes };
}
const channel = (cid, time) => ({ cid, state: { last_message_at: new Date(time), latestMessages: [] }, data: {} });

test('sync sorts loaded channels by canonical recency when only metadata timestamps change', () => {
  const a = channel('older', '2026-11-18T07:24:50Z');
  const b = channel('newer', '2026-11-18T07:23:00Z');
  const view = mount([a, b]);
  b.state.last_message_at = new Date('2026-11-18T07:25:17Z');
  view.emit('sync.completed');
  assert.deepEqual(view.rows(), ['newer', 'older']);
  view.render();
  const writes = view.writes();
  view.emit('sync.completed');
  assert.equal(view.writes(), writes, 'duplicate sync should not flush unchanged rows');
});

test('sync keeps stable equal/missing timestamps and uses metadata fallback', () => {
  const a = { cid: 'fallback', state: { latestMessages: [] }, data: { last_message_at: '2026-11-18T07:20:00Z' } };
  const b = channel('equal', '2026-11-18T07:20:00Z');
  const missing = { cid: 'missing', state: { latestMessages: [] }, data: {} };
  const invalid = { cid: 'invalid', state: { latestMessages: [] }, data: { last_message_at: 'invalid' } };
  const view = mount([missing, a, b, invalid]);
  // A completed sync also changes the preview projection.
  a.state.latestMessages.push({ id: 'synced-preview' });
  view.emit('sync.completed');
  assert.deepEqual(view.rows(), ['fallback', 'equal', 'missing', 'invalid']);
});

for (const event of ['e2ee.post_join_sync', 'e2ee.sync_state', 'e2ee.local_messages_loaded', 'connection.recovered']) {
  test(event + ' reorders late decrypted state after normal sync already completed', () => {
    const a = channel('older', '2026-11-18T07:24:50Z');
    const b = channel('newer', '2026-11-18T07:23:00Z');
    const view = mount([a, b]);
    view.emit('sync.completed');
    b.state.last_message_at = new Date('2026-11-18T07:25:17Z');
    b.state.latestMessages = [{ id: 'late-decrypted' }];
    view.emit(event, { cid: b.cid });
    assert.deepEqual(view.rows(), ['newer', 'older']);
  });
}


test('topic activity after offline replay moves its parent above newer general-only rows',()=>{
 const parent=channel('parent','2026-11-18T07:00:00Z'),other=channel('other','2026-11-18T08:00:00Z');
 parent.data.topics_enabled=true;const topic=channel('topic','2026-11-18T07:10:00Z');parent.state.topics=[topic];
 const view=mount([other,parent]);topic.state.last_message_at=new Date('2026-11-18T09:00:00Z');
 view.emit('sync.completed');assert.deepEqual(view.rows(),['parent','other']);
});
test('same-time topic cache publication invalidates a parent list revision without restarting sync',()=>{
 const parent=channel('parent','2026-11-18T07:00:00Z');parent.data.topics_enabled=true;
 const topic=channel('topic','2026-11-18T08:00:00Z');topic.state.latestMessages=[{id:'cipher',text:''}];parent.state.topics=[topic];
 const view=mount([parent]);view.emit('sync.completed');view.render();const before=view.writes();
 topic.state.latestMessages[0]={id:'cipher',text:'authenticated'};view.emit('e2ee.local_messages_loaded',{cid:'topic'});
 assert.equal(view.writes(),before+1);
});


for (const event of ['message.new','channel.updated','channels.queried']) test(event+' cannot leave loaded rows in replay arrival order',()=>{
 const newer=channel('newer','2026-11-18T12:20:00Z'),older=channel('older','2026-11-18T12:10:00Z');
 const view=mount([newer,older]);view.emit('sync.completed');view.render();
 if(event!=='message.new')older.state.last_message_at=new Date('2026-11-18T12:21:00Z');
 view.emit(event,{cid:older.cid,user:{id:'peer'}});
 assert.deepEqual(view.rows(),event==='message.new'?['newer','older']:['older','newer']);
});
test('reverse-order offline message replay stays in canonical newest-first order',()=>{
 const rows=[channel('newest','2026-11-18T12:20:00Z'),channel('middle','2026-11-18T12:10:00Z'),channel('oldest','2026-11-18T12:00:00Z')];
 const view=mount(rows);for(const ch of rows){view.emit('message.new',{cid:ch.cid,user:{id:'peer'}});view.render()}
 assert.deepEqual(view.rows(),['newest','middle','oldest']);
});
test('explicit caller query order survives sync/cache/realtime publication',()=>{
 const older=channel('older','2026-11-18T12:00:00Z'),newer=channel('newer','2026-11-18T12:20:00Z');
 const view=mount([older,newer],false);for(const type of ['sync.completed','e2ee.local_messages_loaded','channels.queried','message.new']){view.emit(type,{cid:newer.cid,user:{id:'peer'}});view.render();assert.deepEqual(view.rows(),['older','newer'])}
});

test('new empty channel stays above an older active channel after channel.created and sync', async () => {
  const older = channel('team:older', '2026-11-19T08:00:00Z');
  older.data.created_at = '2026-11-18T08:00:00Z';
  const fresh = {cid: 'team:fresh', initialized: true, data: {created_at: '2026-11-19T09:00:00Z'}, state: {latestMessages: []}};
  const view = mount([older]); view.register(fresh);
  await view.emit('channel.created', {channel: {type: 'team', id: 'fresh', cid: fresh.cid}});
  assert.deepEqual(view.rows(), ['team:fresh', 'team:older']);
  view.render(); view.emit('sync.completed');
  view.render(); view.emit('message.new', {cid: older.cid, user: {id: 'peer'}});
  assert.deepEqual(view.rows(), ['team:fresh', 'team:older'], 'late replay cannot undo the creation boundary');
});

test('parent creation remains the floor when an older message is loaded', () => {
  const fresh = channel('fresh', '2026-11-18T08:00:00Z');
  fresh.data.created_at = '2026-11-19T09:00:00Z';
  const older = channel('older', '2026-11-19T08:00:00Z');
  const view = mount([older, fresh]); view.emit('sync.completed');
  assert.deepEqual(view.rows(), ['fresh', 'older']);
});

test('loaded topic message can outrank parent creation, but empty topic creation cannot', () => {
  const parent = {cid: 'parent', data: {topics_enabled: true, created_at: '2026-11-19T08:00:00Z'}, state: {topics: []}};
  const other = channel('other', '2026-11-19T09:00:00Z');
  const topic = {cid: 'topic', data: {created_at: '2026-11-19T11:00:00Z'}, state: {latestMessages: []}};
  parent.state.topics.push(topic);
  const view = mount([parent, other]); view.emit('sync.completed');
  assert.deepEqual(view.rows(), ['other', 'parent']);
  topic.state.last_message_at = new Date('2026-11-19T10:00:00Z');
  view.render(); view.emit('sync.completed');
  assert.deepEqual(view.rows(), ['parent', 'other']);
});

test('invalid creation timestamp cannot hide a valid message or destabilize equal rows', () => {
  const a = channel('a', '2026-11-19T08:00:00Z'), b = channel('b', '2026-11-19T08:00:00Z');
  a.data.created_at = 'invalid'; b.data.created_at = new Date(NaN);
  const missing = {cid:'missing', data:{created_at:'invalid'}, state:{}};
  const view = mount([missing, a, b]); view.emit('sync.completed');
  assert.deepEqual(view.rows(), ['a','b','missing']);
});
