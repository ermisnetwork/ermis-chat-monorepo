import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './flat_publication_fixture.mjs';
for (const completed of [true, false]) test('activation wake uses existing completed catch-up only when bound, completed=' + completed, async () => {
 const h = await fixture('ready'); let requests = 0;
 try {
  h.marker.operation_id = crypto.randomUUID(); await h.s.saveGroupState(h.cid, h.marker);
  const cursor = {created_at: '2026-11-01T00:00:00.000Z', event_id: '00000000-0000-0000-0000-000000000001'};
  await h.s.saveScopeSyncCursor(h.cid, cursor);
  h.m.e2eeClient.scopeSync = async cursors => { requests++; return {channels: Object.fromEntries(Object.entries(cursors).map(([cid, value]) => [cid, {events: [], next_cursor: value, has_more: false}]))}; };
  assert.equal((await h.m.refreshE2eeState(h.cid)).state, 'ready');
  if (completed) h.m._emitSyncState(h.m._makeSyncState(h.cid, 'ready', cursor, cursor));
  h.m._hotReadyScopes.length = 0;
  await h.m._persistProviderStrict();
  assert.notEqual(h.m.getE2eeState(h.cid)?.state, 'ready', 'unrelated private checkpoint retires exact Ready proof');
  h.m._wakeReadinessAfterExternalJoinActivation(h.cid, h.marker.operation_id);
  await h.m._externalJoinReadinessWakes.get(h.cid)?.work;
  assert.equal(requests, completed ? 0 : 1, 'completed account catch-up is not another per-channel HTTP sync');
  assert.equal(h.m.getE2eeState(h.cid)?.state, 'ready', 'normal native and durable Ready proof still required');
 } finally { await h.close(); }
});

for (const condition of ['complete', 'no_delivery', 'newer_epoch', 'unproved', 'pending_mutation']) test('local Ready publication refreshes bootstrap progress only with current delivered proof: ' + condition, async () => {
 const h = await fixture('ready'), observations = [];
 try {
  h.m.client._recordSessionReadiness = (cid, result) => observations.push({cid, result});
  const cursor = {created_at: '2026-11-01T00:00:00.000Z', event_id: '00000000-0000-0000-0000-000000000001'};
  await h.s.saveScopeSyncCursor(h.cid, cursor);
  assert.equal((await h.m.refreshE2eeState(h.cid)).state, 'ready');
  assert.equal(observations.length, 0, 'native-only Ready cannot claim full delivery');
  if (condition !== 'no_delivery') h.m._emitSyncState(h.m._makeSyncState(h.cid, 'ready', cursor, cursor));
  if (condition === 'newer_epoch') h.m.observeChannelE2ee({...h.metadata, epoch: 1}, true);
  if (condition === 'pending_mutation') h.m._pendingMlsMutations.set(h.cid, {operation_id: 'retained'});
  if (condition === 'unproved') h.m._publishCommonState(h.m._commonSnapshot(h.cid, 'ready', 'local_checkpoint_verified'));
  else await h.m.refreshE2eeState(h.cid);
  assert.equal(observations.filter(x => x.result === 'ready').length, condition === 'complete' ? 1 : 0);
 } finally { await h.close(); }
});
