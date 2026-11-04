const test = require('node:test');
const assert = require('node:assert/strict');
require('fake-indexeddb/auto');
const { ErmisChat } = require('../dist/index.cjs');
const { IndexedDBEncryptionStorage } = require('../dist/encryption/index.cjs');

let serial = 0;
async function fixture() {
  const suffix = `${process.pid}-${++serial}`;
  const owner = `query-provenance-${suffix}`;
  const storage = new IndexedDBEncryptionStorage(owner, undefined, 'query-provenance-regression');
  const clients = [];
  const client = () => {
    const c = ErmisChat.getInstance(`${owner}-${clients.length}`, 'fixture', 'https://chat.example.test', { browser: false });
    c.userID = owner;
    c.user = { id: owner };
    c.messageStorage = storage;
    const ch = c.channel('team', `query-${suffix}`);
    ch.data = { cid: ch.cid, id: ch.id, type: 'team', mls_enabled: false, members: [] };
    ch.initialized = true;
    ch.state.lastSyncedEventSeq = 7;
    clients.push(c);
    return { c, ch };
  };
  const first = client();
  const message = {
    id: `canonical-${suffix}`, cid: first.ch.cid, msg_seq: 36, last_event_seq: 7,
    display_type: 'normal', type: 'regular', content_type: 'standard', text: 'canonical fixture',
    created_at: '2026-11-04T00:00:00Z', user: { id: owner }, user_id: owner,
  };
  const response = (messages, watermark = 7) => ({
    channel: { ...first.ch.data, latest_event_seq: watermark }, messages, pinned_messages: [],
  });
  const gap = () => ({ cid: first.ch.cid, msg_seq: 36, display_type: 'unavailable' });
  const apply = async (ch, data) => {
    const observed = ch.state.captureQueryUnavailableMessageSeqs?.();
    await ch._applyQueryHistoryBoundary(data, true, observed);
    ch.state.addMessagesSorted(data.messages);
  };
  return { ...first, storage, client, message, response, gap, apply, close: () => storage.close() };
}

test('query-only absence survives IndexedDB restart and a canonical query restores exactly one message', async () => {
  const f = await fixture();
  try {
    await f.apply(f.ch, f.response([f.gap()]));
    assert.equal(f.ch.state.messages.length, 0);
    assert.equal(f.ch.state.isFakeMessageGap(35, 37), true);
    await f.c.persistSyncState();
    const restarted = f.client();
    await restarted.c.restoreSyncState({ strict: true });
    restarted.ch.state.addMessagesSorted([f.message]);
    assert.equal(restarted.ch.state.messages.length, 0, 'cache/realtime cannot remove the privacy barrier');
    await f.apply(restarted.ch, f.response([f.message]));
    await f.apply(restarted.ch, f.response([f.message]));
    assert.equal(restarted.ch.state.messages.filter(m => m.id === f.message.id).length, 1);
    await restarted.c.persistSyncState();
    const second = f.client();
    await second.c.restoreSyncState({ strict: true });
    second.ch.state.addMessagesSorted([f.message]);
    assert.equal(second.ch.state.messages.length, 1, 'successful revalidation is durable');
  } finally { await f.close(); }
});

for (const control of ['per-ID unavailable', 'sync hidden', 'local tombstone', 'clear history', 'legacy hidden', 'missing watermark', 'stale canonical', 'foreign CID', 'same-response unavailable']) {
  test(`canonical query cannot override ${control}`, async () => {
    const f = await fixture();
    try {
      if (control === 'legacy hidden') f.ch.state.hiddenMessageSeqs.add(36);
      await f.apply(f.ch, f.response([f.gap()], control === 'missing watermark' ? undefined : 7));
      if (control === 'missing watermark') {
        // Exercise an actually omitted field, rather than the response helper's default parameter.
        const cold = f.client();
        const unknown = f.response([f.gap()]);
        delete unknown.channel.latest_event_seq;
        await f.apply(cold.ch, unknown);
        await f.apply(cold.ch, f.response([f.message]));
        assert.equal(cold.ch.state.messages.length, 0);
        return;
      }
      if (control === 'per-ID unavailable') await f.apply(f.ch, f.response([{ ...f.gap(), id: f.message.id }]));
      if (control === 'sync hidden') f.ch.state.mergeHiddenSequences([], [36]);
      if (control === 'local tombstone') f.ch.state.locallyDeletedMessageIds.add(f.message.id);
      if (control === 'clear history') await f.ch.state.truncateMessagesBySeq(36);
      const candidate = { ...f.message };
      if (control === 'stale canonical') candidate.last_event_seq = 6;
      if (control === 'foreign CID') candidate.cid = 'team:foreign';
      const rows = control === 'same-response unavailable' ? [candidate, f.gap()] : [candidate];
      await f.apply(f.ch, f.response(rows));
      assert.equal(f.ch.state.messages.length, 0);
      assert.equal(f.ch.state.hiddenMessageSeqs.has(36), true);
      await f.c.persistSyncState();
      const restarted = f.client();
      await restarted.c.restoreSyncState({ strict: true });
      restarted.ch.state.addMessagesSorted([f.message]);
      assert.equal(restarted.ch.state.messages.length, 0, 'cold cached plaintext stays suppressed');
    } finally { await f.close(); }
  });
}

test('restoring the saved gap metadata through the UI does not promote a query absence to a confirmed deletion', async () => {
  const f = await fixture();
  try {
    await f.apply(f.ch, f.response([f.gap()]));
    const saved = await f.storage.loadSyncState(f.ch.cid);
    const restarted = f.client();
    restarted.ch.state.restoreHiddenSequences(saved);
    await f.apply(restarted.ch, f.response([f.message]));
    assert.equal(restarted.ch.state.messages.length, 1);
  } finally { await f.close(); }
});

test('a public channel query issued after the observed absence revalidates the canonical row', async () => {
  const f = await fixture();
  try {
    await f.apply(f.ch, f.response([f.gap()]));
    f.c.post = async () => f.response([f.message]);
    await f.ch.query({ messages_seq: { seq: 36 } });
    assert.equal(f.ch.state.messages.filter(m => m.id === f.message.id).length, 1);
  } finally { await f.close(); }
});

test('an earlier public query returning after a later absence cannot resurrect cached plaintext', async () => {
  const f = await fixture();
  try {
    let resolveQuery;
    let started;
    const dispatched = new Promise(resolve => { started = resolve; });
    f.c.post = () => { started(); return new Promise(resolve => { resolveQuery = resolve; }); };
    const pending = f.ch.query({ messages_seq: { seq: 36 } });
    await dispatched;
    await f.apply(f.ch, f.response([f.gap()]));
    resolveQuery(f.response([f.message]));
    await pending;
    assert.equal(f.ch.state.messages.length, 0);
    assert.equal(f.ch.state.hiddenMessageSeqs.has(36), true);
  } finally { await f.close(); }
});
