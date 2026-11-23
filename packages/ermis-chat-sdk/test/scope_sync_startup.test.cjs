const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), {pathToFileURL} = require('node:url');
const {webcrypto} = require('node:crypto');
require('fake-indexeddb/auto'); globalThis.crypto ??= webcrypto;
const {EncryptionManager, IndexedDBEncryptionStorage, E2eeClient, sha256Hex} = require('../dist/encryption/index.cjs');
const {Channel, ErmisChat} = require('../dist/index.cjs');
let seq = 0, wasmPromise;
const start = {created_at: '2026-11-01T00:00:00Z', event_id: '00000000-0000-4000-8000-000000000000'};
const cursor = n => ({created_at: new Date(Date.UTC(2026, 10, 1, 0, 0, n)).toISOString(), event_id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`});
const latch = () => {let resolve; const promise = new Promise(r => resolve = r); return {promise, resolve};};
async function fixture(n = 1, cold = false) {
  const w = await (wasmPromise ??= (async () => {
    const w = await import(pathToFileURL(path.resolve(__dirname, '../src/encryption/wasm/openmls_wasm.js')));
    await w.default({module_or_path: fs.readFileSync(path.resolve(__dirname, '../src/encryption/wasm/openmls_wasm_bg.wasm'))}); return w;
  })());
  const user = `scope-startup-${++seq}`, device = 'device', storage = new IndexedDBEncryptionStorage(user), events = [];
  const m = new EncryptionManager(); Object.assign(m, {userId: user, deviceId: device, storage, _injectedWasm: w,
    _wasmArtifactSha256: sha256Hex(fs.readFileSync(path.resolve(__dirname, '../src/encryption/wasm/openmls_wasm_bg.wasm')))});
  await m._initWasm(); await m._initIdentity(); await m._persistProviderStrict(); m.initialized = true;
  const channels = Array.from({length: n}, (_, i) => ({cid: `team:${user}-${i}`, channelType: 'team', channelId: `${user}-${i}`}));
  m.client = {baseURL: 'https://fixture.invalid', activeChannels: {}, dispatchEvent: e => events.push(e)};
  for (const c of channels) {
    m.client.activeChannels[c.cid] = {id: c.channelId, type: 'team', cid: c.cid, data: {mls_enabled: true},
      state: {members: {[user]: {user_id: user, channel_role: 'member', created_at: start.created_at}}}};
    if (!cold) {
      const group = w.Group.create_with_cid(m.provider, m.identity, c.cid);
      m.groups.set(c.cid, group); m._groupGenerations.set(c.cid, {cid: c.cid, group_generation: 0, group_id: null, current_epoch: 0, status: 'active', updated_at: 1});
      await m._writeMlsMutation(c.cid, null);
    }
    await storage.saveScopeSyncCursor(c.cid, start);
  }
  // These tests stress an explicitly scheduled batch, independently of startup warm selection.
  // Default scheduling bounds are covered with1000metadata rows in bounded_bootstrap_page.
  m._warmScopeCids = () => channels.map(channel=>channel.cid);
  m._discoverMlsRecoveryStates = async () => ({states: {}, unsupported: false});
  m.recoverMlsGeneration = async () => ({status: 'active'});
  m._replayLaggingEpochs = async () => {}; m._resumeExternalJoinCandidates = async () => {};
  m._resumePendingMlsMutations = async () => {}; m._ensureWelcomeHistorySubscription = () => {};
  m._drainWelcomeHistoryWork = async () => {}; m._markKnownChannelsPendingRecoveryUnlock = async () => {};
  m.safeArchiveCurrentEpochForCid = async () => {}; m.ensureKeyPackagesFromServer = async () => {};
  return {m, w, storage, channels, events, user, device, close: async () => {await m.destroy(); await storage.close();}};
}
function transport(f, page) {
  const calls = [];
  f.m.e2eeClient = {scopeSync: async cursors => {calls.push(structuredClone(cursors)); return {channels: await page(cursors, calls.length)};}};
  return calls;
}
const empty = cursors => Object.fromEntries(Object.keys(cursors).map(cid => [cid, {events: [], next_cursor: start, has_more: false}]));
function welcome(f, cid) {
  const p = new f.w.Provider(), sender = new f.w.Identity(p, 'sender'), group = f.w.Group.create_with_cid(p, sender, cid);
  const kp = f.m.identity.key_package(f.m.provider), ref = kp.hash_ref(f.m.provider);
  const invite = group.add_members(p, sender, [kp]); group.merge_pending_commit(p);
  const envelope = {event_id: cursor(1).event_id, cid, group_generation: 0, epoch: 1};
  const context = {version: 1, ...envelope, accepted_at: Math.floor(Date.now() / 1000), payload_sha256: sha256Hex(invite.welcome), provenance: 'bellboy_transition_v1'};
  const data = {type: 'welcome', ...envelope, welcome: invite.welcome, ratchet_tree: group.export_ratchet_tree().to_bytes(),
    target_user_ids: [f.user], target_device_ids: [f.device], acceptance_context: context};
  return {event: {type: 'protocol', ...envelope, created_at: cursor(1).created_at, data}, context, ref, p, sender, group};
}

test('session counter stage starts after held preparation and before its single native-backed sync request',async()=>{
 const f=await fixture(8),gate=latch(),stages=[];
 try {
  const original=f.m.bootstrapKnownE2eeChannels.bind(f.m);
  f.m.bootstrapKnownE2eeChannels=async options=>{stages.push('preparing');await gate.promise;return original(options);};
  f.m.client._startSessionReadinessSync=()=>stages.push('readiness');
  const calls=transport(f,async cursors=>{assert.equal(stages.at(-1),'readiness');return empty(cursors);});
  const work=f.m.sync();
  for(let i=0;i<100&&!stages.length;i++)await new Promise(setImmediate);
  assert.deepEqual(stages,['preparing']);assert.equal(calls.length,0);
  gate.resolve();await work;assert.deepEqual(stages,['preparing','readiness']);assert.deepEqual(calls.map(c=>Object.keys(c).length),[8]);
 } finally {gate.resolve();await f.close();}
});
test('32 healthy scopes use bounded batches and actual durable Ready proofs', async () => {
  const f = await fixture(32); try {
    const calls = transport(f, empty); await f.m.sync();
    assert.deepEqual(calls.map(call => Object.keys(call).length), [32]);
    assert.equal(new Set(calls.flatMap(call => Object.keys(call))).size,32);
    for (const c of f.channels) {
      assert.equal(f.m.getE2eeState(c.cid).state, 'ready');
      assert.ok((await f.storage.loadMlsReadyBase(f.user, f.device, c.cid)).ready);
    }
  } finally {await f.close();}
});
test('session sync excludes hydrated stale channels missing from the current authorized inventory',async()=>{
 const f=await fixture(2),live=f.channels[0].cid,stale=f.channels[1].cid;
 try{
  f.m.client._sessionE2eeInventoryScopes=()=>new Set([live]);
  f.m._warmScopeCids=EncryptionManager.prototype._warmScopeCids.bind(f.m);
  const calls=transport(f,empty);await f.m.sync();
  assert.deepEqual(calls.map(c=>Object.keys(c)),[[live]]);
  assert.deepEqual(await f.storage.loadScopeSyncCursor(stale),start);
 }finally{await f.close();}
});

test('26 late rejected own-Commit notifications already covered by durable batch do not reread each scope', async () => {
  const f = await fixture(26), channelViews = [], recoveryWork = [];
  try {
    Object.assign(f.m.client, {state: {users: {}}, logger: () => {}, encryptionManager: f.m});
    for (const c of f.channels) {
      const old = f.m.client.activeChannels[c.cid], view = new Channel(f.m.client, c.channelType, c.channelId, old.data);
      view.state.members = old.state.members; view.initialized = true;
      f.m.client.activeChannels[c.cid] = view; channelViews.push(view);
    }
    const calls = transport(f, empty); await f.m.sync();
    assert.deepEqual(calls.map(c => Object.keys(c).length), [26]);
    const provider = await f.storage.loadProviderState(f.user, f.device);
    let rejected = 0;
    const process = f.m.processOwnMlsCommit.bind(f.m), recover = f.m.requestScopeSyncAfterRepair.bind(f.m);
    f.m.processOwnMlsCommit = async (...args) => {
      try { return await process(...args); }
      catch (error) { assert.equal(error.code, 'acceptance_metadata_invalid'); rejected++; throw error; }
    };
    f.m.requestScopeSyncAfterRepair = (...args) => {
      recover(...args); recoveryWork.push(...(f.m._channelReadyAdmissions.get(args[0]) || []));
    };
    for (const view of channelViews) {
      await view._handleChannelEvent({type: 'protocol', cid: view.cid, ...start,
        protocol_data: {type: 'external_commit', epoch: 0, group_generation: 0,
          commit: new Uint8Array([1]), user: {id: f.user}, device_id: f.device}});
      await Promise.all(recoveryWork);
    }
    assert.equal(rejected, 0, 'already-applied own notifications are ignored without acknowledging delivery');
    assert.equal(calls.length, 1, 'completed batch must not be followed by one recovery read per notification');
    assert.deepEqual(await f.storage.loadProviderState(f.user, f.device), provider);
    for (const c of f.channels) {
      assert.deepEqual(await f.storage.loadScopeSyncCursor(c.cid), start);
      assert.equal(f.m.getEpoch(c.cid), 0);
      assert.equal(f.m.getE2eeState(c.cid).state, 'ready');
    }
  } finally {await Promise.allSettled(recoveryWork); await f.close();}
});

for (const canonicalDuplicate of [false, true]) test(
  `${canonicalDuplicate ? 'canonical' : 'unidentified'} paired External Join publications preserve delivery admission`, async t => {
  const f = await fixture(34), channelViews = new Map(), work = [], recoveryWork = [], readiness = new Map();
  const receiver = new ErmisChat('fixture', 'fixture', 'https://fixture.invalid', {browser: false});
  try {
    Object.assign(f.m.client, {state: {users: {}}, logger: () => {}, encryptionManager: f.m});
    f.m.client._recordSessionReadiness = (cid, status) => readiness.set(cid, status);
    for (const c of f.channels) {
      const old = f.m.client.activeChannels[c.cid], view = new Channel(f.m.client, c.channelType, c.channelId, old.data);
      view.state.members = old.state.members; view.initialized = true;
      f.m.client.activeChannels[c.cid] = view; channelViews.set(c.cid, view);
    }
    // Exercise the real websocket byte normalizer as well as channel/manager admission.
    receiver.dispatchEvent = event => work.push(channelViews.get(event.cid)._handleChannelEvent(event));
    const commit = new Uint8Array([1, 2, 3]), payload_sha256 = sha256Hex(commit);
    const canonical = cid => ({type: 'protocol', cid, ...start,
      acceptance_context: {version: 1, ...start, cid, group_generation: 0, epoch: 0,
        accepted_at: Math.floor(Date.now() / 1000), payload_sha256, provenance: 'bellboy_transition_v1'},
      protocol_data: {type: 'external_commit', epoch: 0, group_generation: 0,
        commit: Buffer.from(commit).toString('base64'), user: {id: f.user}, device_id: f.device}});
    const calls = transport(f, cursors => Object.fromEntries(Object.keys(cursors).map(cid => [cid, {
      events: [{type: 'protocol', cid, ...start,
        data: {...canonical(cid).protocol_data, commit, acceptance_context: canonical(cid).acceptance_context}}],
      next_cursor: start, has_more: false,
    }])));
    await f.m.sync();
    assert.equal(calls.length, 1);
    const recover = f.m.requestScopeSyncAfterRepair.bind(f.m);
    f.m.requestScopeSyncAfterRepair = (...args) => {
      recover(...args); recoveryWork.push(...(f.m._channelReadyAdmissions.get(args[0]) || []));
    };
    for (const c of f.channels) {
      const event = canonical(c.cid);
      receiver.handleEvent({data: JSON.stringify(event)});
      const duplicate = canonicalDuplicate ? event : {...event,
        created_at: '2026-11-01T00:00:00.000001Z', event_id: undefined, acceptance_context: undefined};
      receiver.handleEvent({data: JSON.stringify(duplicate)});
    }
    await Promise.all(work);
    const outcomes = await Promise.allSettled(recoveryWork);
    const rejected = outcomes.filter(result => result.status === 'rejected');
    const statuses = Array.from(readiness.values());
    t.diagnostic(JSON.stringify({scopes: f.channels.length, sync_requests: calls.length,
      ready_scopes: statuses.filter(status => status === 'ready').length,
      nonready_scopes: statuses.filter(status => status !== 'ready').length,
      rejected_admissions: rejected.length}));
    assert.equal(calls.length, 1, 'realtime duplicates never initiate HTTP sync');
    for (const c of f.channels) assert.deepEqual(await f.storage.loadScopeSyncCursor(c.cid), start);
    if (canonicalDuplicate) for (const c of f.channels) {
      assert.equal(f.m.getE2eeState(c.cid).state, 'ready');
      assert.equal(readiness.get(c.cid), 'ready');
    }
    if (canonicalDuplicate) assert.equal(rejected.length, 0);
    else {
      assert.equal(rejected.length, 0, 'no repair admission is created by unidentified realtime echoes');
      assert(statuses.every(status => status === 'ready'), 'completed progress remains unchanged');
    }
  } finally {await Promise.allSettled(work); await Promise.allSettled(recoveryWork); await f.close();}
});

test('fresh External Join receipts, one account batch and both canonical realtime routes settle without repair reads', async () => {
  const f = await fixture(8, true), remote = new Map(), receipts = new Map(), protocols = new Map(), views = new Map();
  const work = [], recoveryWork = [], readiness = new Map(), requests = [];
  const receiver = new ErmisChat('fixture', 'fixture', 'https://fixture.invalid', {browser: false});
  try {
    Object.assign(f.m.client, {state: {users: {}}, logger: () => {}, encryptionManager: f.m,
      _recordSessionReadiness: (cid, status) => readiness.set(cid, status)});
    for (const c of f.channels) {
      const old = f.m.client.activeChannels[c.cid], view = new Channel(f.m.client, c.channelType, c.channelId, old.data);
      view.state.members = old.state.members; view.initialized = true;
      f.m.client.activeChannels[c.cid] = view; views.set(c.cid, view);
      const provider = new f.w.Provider(), identity = new f.w.Identity(provider, 'remote');
      remote.set(c.cid, {provider, identity, group: f.w.Group.create_with_cid(provider, identity, c.cid)});
    }
    receiver.dispatchEvent = event => work.push(views.get(event.cid)._handleChannelEvent(event));
    const unknown = (cid, operation_id) => ({version: 1, operation_id, cid, state: 'outcome_unknown',
      delivery_pending: false, group_generation: null, epoch: null, group_id: null,
      commit_sha256: null, event_id: null, acceptance_context: null});
    f.m.e2eeClient = {
      getGroupInfo: async (_type, id) => {
        const r = remote.get(`team:${id}`);
        return {group_info: r.group.export_group_info(r.provider, r.identity, true), epoch: 0,
          hash: 'fixture', is_stale: false, group_generation: 0, group_id: null,
          external_join_prerequisite: {reason: 'active_member_recovery'}};
      },
      getExternalJoinReceipt: async (_type, id, op) => receipts.get(op) || unknown(`team:${id}`, op),
      externalJoin: async (_type, id, body) => {
        const cid = `team:${id}`, event_id = crypto.randomUUID(), created_at = new Date().toISOString();
        const context = {version: 1, event_id, cid, group_generation: body.group_generation, epoch: body.epoch,
          accepted_at: Math.floor(Date.now() / 1000), payload_sha256: sha256Hex(body.commit), provenance: 'bellboy_transition_v1'};
        receipts.set(body.operation_id, {version: 1, operation_id: body.operation_id, cid, state: 'accepted',
          delivery_pending: true, group_generation: body.group_generation, epoch: body.epoch, group_id: body.group_id || null,
          commit_sha256: context.payload_sha256, group_info_sha256: sha256Hex(body.group_info), event_id, acceptance_context: context});
        const data = {type: 'external_commit', epoch: body.epoch, group_generation: body.group_generation,
          commit: body.commit, user: {id: f.user}, device_id: f.device};
        protocols.set(cid, {type: 'protocol', cid, created_at, event_id, data: {...data, acceptance_context: context}});
        const wire = {type: 'protocol', cid, created_at, event_id, acceptance_context: context,
          protocol_data: {...data, commit: Buffer.from(body.commit).toString('base64')}};
        receiver.handleEvent({data: JSON.stringify(wire)}); receiver.handleEvent({data: JSON.stringify(wire)});
      },
      scopeSync: async cursors => {
        requests.push(Object.keys(cursors));
        return {channels: Object.fromEntries(Object.keys(cursors).map(cid => [cid, {
          events: protocols.has(cid) ? [protocols.get(cid)] : [],
          next_cursor: protocols.has(cid) ? {created_at: protocols.get(cid).created_at, event_id: protocols.get(cid).event_id} : start,
          has_more: false,
        }]))};
      },
    };
    const recover = f.m.requestScopeSyncAfterRepair.bind(f.m);
    f.m.requestScopeSyncAfterRepair = (...args) => {
      recover(...args); recoveryWork.push(...(f.m._channelReadyAdmissions.get(args[0]) || []));
    };
    await f.m.sync(); await Promise.all(work); await Promise.all(recoveryWork);
    assert.equal(receipts.size, 8); assert.deepEqual(requests.map(cids => cids.length), [8]);
    assert.equal(recoveryWork.length, 0);
    for (const c of f.channels) {
      assert.equal(f.m.getE2eeState(c.cid).state, 'ready');
      assert.equal(readiness.get(c.cid), 'ready');
      assert.equal((await f.storage.loadExternalJoinReceipt(c.cid)).state, 'accepted');
      assert.equal(await f.storage.loadExternalJoinCandidateCheckpoint(c.cid), null);
    }
  } finally {
    await Promise.allSettled(work); await Promise.allSettled(recoveryWork); await f.close();
    for (const r of remote.values()) {r.group.free(); r.identity.free(); r.provider.free();}
  }
});

for (const [name, observation] of [
  ['newer composite event in same timestamp', {...start, event_id: cursor(1).event_id, epoch: 0, group_generation: 0}],
  ['newer epoch', {...start, epoch: 1, group_generation: 0}],
  ['different generation', {...start, epoch: 0, group_generation: 1}],
  ['unidentified event', {created_at: start.created_at, epoch: 0, group_generation: 0}],
]) test(`protocol recovery still fetches ${name} after completed batch`, async () => {
  const f = await fixture(), cid = f.channels[0].cid;
  try {
    const calls = transport(f, empty); await f.m.sync();
    f.m.requestScopeSyncAfterRepair(cid, observation);
    await Promise.all(f.m._channelReadyAdmissions.get(cid) || []);
    assert.equal(calls.length, 2);
  } finally {await f.close();}
});

test('a covered realtime cursor cannot reuse partial or uncertain delivery', async () => {
  const f = await fixture(), cid = f.channels[0].cid;
  try {
    const calls = transport(f, empty); await f.m.sync();
    f.m._emitSyncState({...f.m.getSyncState(cid), status: 'needs_retry', needs_retry: true});
    f.m.requestScopeSyncAfterRepair(cid, {...start, epoch: 0, group_generation: 0});
    await Promise.all(f.m._channelReadyAdmissions.get(cid) || []);
    assert.equal(calls.length, 2, 'partial delivery must be fetched again');
    f.m._providerPersistenceUncertain = true;
    assert.equal(f.m._getCompletedSyncProgress(cid), null);
    const ensure = f.m.ensureChannelReady.bind(f.m); let reused;
    f.m.ensureChannelReady = (...args) => {reused = args[3].initialScopeSyncCompleted; return ensure(...args);};
    f.m.requestScopeSyncAfterRepair(cid, {...start, epoch: 0, group_generation: 0});
    await Promise.all(f.m._channelReadyAdmissions.get(cid) || []);
    assert.equal(reused, false, 'recovery must reprove through the existing durable path');
  } finally {await f.close();}
});

test('one initial map publishes completed scopes while a true event page remains held', async () => {
 const f=await fixture(32), reached=latch(), release=latch(), tail=f.channels.at(-1).cid;
 let work;
 try {
  const checkpointSizes=[],save=f.storage.saveEncryptionSyncCheckpoint.bind(f.storage);
  f.storage.saveEncryptionSyncCheckpoint=async cp=>{checkpointSizes.push(Object.keys(cp.scope_cursors||{}).length);return save(cp);};
  const calls=transport(f,async(cursors,n)=>{
   if(n===2){reached.resolve();await release.promise;}
   const result=empty(cursors);
   if(n===1)result[tail]={events:[{type:'member_removed',cid:tail,event_id:cursor(1).event_id,created_at:cursor(1).created_at,
    data:{member:{user_id:'other'},user_id:'owner',self_remove:false}}],next_cursor:cursor(1),has_more:true};
   return result;
  });
  work=f.m.sync();await reached.promise;
  assert.deepEqual(calls.map(c=>Object.keys(c).length),[32,1]);assert.equal(checkpointSizes[0],31);
  for(const c of f.channels.slice(0,-1))assert.equal(f.m.getE2eeState(c.cid)?.state,'ready');
  assert.notEqual(f.m.getE2eeState(tail)?.state,'ready');
 }finally{release.resolve();if(work)await work;await f.close();}
});

test('an uncertain incremental checkpoint never publishes Ready or admits the next batch', async () => {
  const f = await fixture(32);
  try {
    const calls = transport(f, empty);
    f.storage.verifyEncryptionSyncCheckpoint = async () => false;
    await assert.rejects(f.m.sync(), error => error.code === 'provider_persistence_uncertain');
    assert.equal(calls.length, 1);
    for (const c of f.channels) assert.notEqual(f.m.getE2eeState(c.cid)?.state, 'ready');
    assert.equal(f.m._providerPersistenceUncertain, true);
  } finally { await f.close(); }
});

test('restored groups prove batch Ready despite transient public recovery discovery errors', async () => {
  const f = await fixture(32);
  let joins = 0;
  try {
    f.m._discoverMlsRecoveryStates = async () => ({states: Object.fromEntries(f.channels.map(c => [c.cid,
      {result: 'error', reason: 'state_unavailable', retryable: true}])), unsupported: false});
    f.m.joinExternal = async () => { joins++; throw new Error('Restored groups must not External Join'); };
    const calls = transport(f, empty);
    await f.m.sync();
    assert.deepEqual(calls.map(call => Object.keys(call).length), [32]);
    assert.equal(joins, 0);
    for (const c of f.channels) {
      assert.equal(f.m.getE2eeState(c.cid)?.state, 'ready');
      assert.ok((await f.storage.loadMlsReadyBase(f.user, f.device, c.cid)).ready);
    }
  } finally { await f.close(); }
});

test('invalid MLS protocol blocks only its scope while independent scopes finish batch Ready', async () => {
  const f = await fixture(32), bad = f.channels[0].cid;
  try {
    const commit = new Uint8Array([0, 1, 2, 3]), eventId = cursor(1).event_id;
    const context = {version: 1, cid: bad, group_generation: 0, epoch: 1, event_id: eventId,
      accepted_at: Math.floor(Date.now() / 1000), payload_sha256: sha256Hex(commit), provenance: 'bellboy_transition_v1'};
    const event = {type: 'protocol', event_id: eventId, cid: bad, group_generation: 0, epoch: 1,
      created_at: cursor(1).created_at, data: {type: 'commit', cid: bad, group_generation: 0,
        epoch: 1, event_id: eventId, commit, acceptance_context: context}};
    const calls = transport(f, cursors => Object.fromEntries(Object.keys(cursors).map(cid => [cid,
      {events: cid === bad ? [event] : [], next_cursor: cid === bad ? cursor(1) : start, has_more: false}])));
    await f.m.sync();
    assert.deepEqual(calls.map(call => Object.keys(call).length), [32]);
    assert.deepEqual(await f.storage.loadScopeSyncCursor(bad), start);
    assert.equal(f.m.getEpoch(bad), 0);
    assert.notEqual(f.m.getE2eeState(bad)?.state, 'ready');
    for (const c of f.channels.slice(1)) {
      assert.equal(f.m.getE2eeState(c.cid)?.state, 'ready');
      assert.ok((await f.storage.loadMlsReadyBase(f.user, f.device, c.cid)).ready);
    }
  } finally { await f.close(); }
});

test('cold private KeyPackage plus canonical Welcome installs durable group and Ready without duplicate read', async () => {
  const f = await fixture(1, true), cid = f.channels[0].cid, invite = welcome(f, cid);
  try {
    await f.m._persistProviderStrict();
    const calls = transport(f, () => ({[cid]: {events: [invite.event], next_cursor: cursor(1), has_more: false}}));
    await f.m.sync(); assert.equal(calls.length, 1); assert.equal(f.m.getEpoch(cid), 1);
    assert.equal(f.m.identity.owns_key_package_ref(f.m.provider, invite.ref), false);
    assert.equal(f.m.getE2eeState(cid).state, 'ready');
    const base = await f.storage.loadMlsReadyBase(f.user, f.device, cid); assert.ok(base.ready);
    const reloaded = f.w.Provider.from_bytes(base.provider_bytes);
    assert.equal(Number(f.w.Group.load(reloaded, cid).epoch()), 1);
  } finally {await f.close();}
});

for (const tamper of [false, true]) test(`32 ${tamper ? 'tampered' : 'missing'} acceptance scopes hold cursors/private keys, no reread, healthy scope completes`, async () => {
  const f = await fixture(33, true), invalid = new Map();
  try {
    for (const c of f.channels.slice(0, 32)) {
      const invite = welcome(f, c.cid);
      if (tamper) invite.event.data.acceptance_context = {...invite.context, payload_sha256: '0'.repeat(64)};
      else delete invite.event.data.acceptance_context;
      invalid.set(c.cid, invite);
    }
    const good = f.channels[32].cid, valid = welcome(f, good); await f.m._persistProviderStrict();
    const calls = transport(f, cursors => Object.fromEntries(Object.keys(cursors).map(cid => [cid,
      {events: [(invalid.get(cid) || valid).event], next_cursor: cursor(1), has_more: false}])));
    await f.m.sync(); assert.deepEqual(calls.map(call => Object.keys(call).length), [33]); assert.equal(f.m.getE2eeState(good).state, 'ready');
    for (const [cid, invite] of invalid) {
      assert.equal(f.m.groups.has(cid), false); assert.deepEqual(await f.storage.loadScopeSyncCursor(cid), start);
      assert.equal(f.m.identity.owns_key_package_ref(f.m.provider, invite.ref), true);
      const result = await f.m.ensureChannelReady('team', cid.slice(5), cid, {source: 'open'});
      assert.equal(result.status, 'needs_retry'); assert.equal(result.error, 'acceptance_metadata_invalid');
    }
    assert.equal(calls.length, 1); assert.equal(f.m.groups.size, 1);
  } finally {await f.close();}
});

test('repaired server metadata on a fresh observation retries the held cursor and becomes Ready', async () => {
  const f = await fixture(1, true), cid = f.channels[0].cid, invite = welcome(f, cid); let fixed = false;
  try {
    await f.m._persistProviderStrict();
    const calls = transport(f, () => ({[cid]: {events: [{...invite.event, data: {...invite.event.data, acceptance_context: fixed ? invite.context : undefined}}], next_cursor: cursor(1), has_more: false}}));
    await f.m.sync(); assert.equal(calls.length, 1); assert.equal(f.m.groups.has(cid), false);
    fixed = true; await f.m.sync(); assert.equal(calls.length, 2); assert.deepEqual(calls[0], calls[1]);
    assert.equal(f.m.getE2eeState(cid).state, 'ready'); assert.deepEqual(await f.storage.loadScopeSyncCursor(cid), cursor(1));
  } finally {await f.close();}
});

test('ordered multipage real commits checkpoint all events without loss; valid post-join catch-up still reads', async () => {
  const f = await fixture(1, true), cid = f.channels[0].cid, invite = welcome(f, cid);
  try {
    await f.m._persistProviderStrict(); const pages = [invite.event];
    for (let n = 2; n <= 102; n++) {
      const update = invite.group.self_update(invite.p, invite.sender); invite.group.merge_pending_commit(invite.p);
      const envelope = {event_id: cursor(n).event_id, cid, group_generation: 0, epoch: n};
      pages.push({type: 'protocol', ...envelope, created_at: cursor(n).created_at, data: {type: 'commit', ...envelope, commit: update.commit,
        user: {id: 'sender'}, acceptance_context: {version: 1, ...envelope, accepted_at: Math.floor(Date.now()/1000), payload_sha256: sha256Hex(update.commit), provenance: 'bellboy_transition_v1'}}});
    }
    const calls = transport(f, (c) => {
      const offset = c[cid].event_id === start.event_id ? 0 : Number(c[cid].event_id.slice(-12));
      const next = Math.min(offset + 100, 102);
      return {[cid]: {events: pages.slice(offset, next), next_cursor: cursor(next), has_more: next < 102}};
    });
    await f.m.sync(); assert.equal(calls.length, 2); assert.equal(f.m.getEpoch(cid), 102);
    assert.deepEqual(calls.map(c => c[cid]), [start, cursor(100)]);
    assert.deepEqual(await f.storage.loadScopeSyncCursor(cid), cursor(102));
    await f.m.syncAfterExternalJoin('team', cid.slice(5), cid); assert.equal(calls.length, 3);
  } finally {await f.close();}
});

test('startup/open/reconnect share work and current ownership; no duplicate checkpoint processing', async () => {
  const f = await fixture(), cid = f.channels[0].cid, entered = latch(), release = latch();
  try {
    const calls = transport(f, async cursors => {entered.resolve(); await release.promise; return empty(cursors);});
    const startup = f.m.sync(); await entered.promise;
    const open = f.m.ensureChannelReady('team', cid.slice(5), cid, {source: 'open'}), reconnect = f.m.sync();
    release.resolve(); await Promise.all([startup, open, reconnect]); assert.equal(calls.length, 1);
    const first = f.m._syncChannelFromCursor(cid, start), second = f.m._syncChannelFromCursor(cid, start);
    await Promise.all([first, second]); assert.equal(calls.length, 2);
  } finally {release.resolve(); await f.close();}
});

function apiHost() {
  let epoch = 0; const c = {baseURL: 'https://fixture.invalid', userID: 'user', deviceId: 'device',
    _captureAuthScope: () => {const captured = epoch; return {assertCurrent() {if (epoch !== captured) throw Object.assign(Error('retired'), {code: 'recovery_scope_changed'});}};}};
  return {c, api: new E2eeClient(c), replace: () => {epoch++;}};
}
for (const mode of ['429-seconds', '429-date', 'network']) test(`${mode}: 32 distinct reads stop after first HTTP; coalesce, honor delay, resume due`, async t => {
  t.mock.timers.enable({apis: ['Date'], now: 1_800_000_000_000});
  const {c, api} = apiHost(); let calls = 0;
  c.doAxiosRequest = async () => {calls++; throw mode === 'network' ? Object.assign(Error('CORS'), {code: 'ERR_NETWORK'}) :
    {response: {status: 429, headers: {'retry-after': mode === '429-date' ? new Date(Date.now()+10_000).toUTCString() : '10'}}};};
  const results = await Promise.allSettled(Array.from({length: 32}, (_, i) => api.scopeSync({['team:'+i]: start})));
  assert.equal(calls, 1); assert.equal(results.filter(r => r.status === 'rejected').length, 32);
  const retryAt = results[0].reason.retry_at; assert.equal(retryAt-Date.now(), mode === 'network' ? 1000 : 10_000);
  await assert.rejects(api.scopeSync({'team:0': start}), e => e.code === 'scope_sync_throttled'); assert.equal(calls, 1);
  t.mock.timers.setTime(retryAt); c.doAxiosRequest = async (_m, _u, body) => {calls++; return {channels: empty(body.cursors)};};
  await Promise.all([api.scopeSync({'team:0': start}), api.scopeSync({'team:0': start})]); assert.equal(calls, 2);
});

for (const dimension of ['session', 'backend', 'device', 'user', 'signer', 'storage_revision', 'artifact']) test(`API stale ${dimension} results and cooldown never cross ownership`, async () => {
  const {c, api, replace} = apiHost(), entered = latch(), release = latch(); let calls = 0;
  c.encryptionManager = {identity: {}, storage: {storageScopeRevision: 0}, _wasmArtifactSha256: 'fixture'};
  c.doAxiosRequest = async (_m, _u, body) => {calls++; if (calls === 1) {entered.resolve(); await release.promise;} return {channels: empty(body.cursors)};};
  const old = api.scopeSync({'team:scope': start}), rejected = assert.rejects(old, e => e.code === 'recovery_scope_changed'); await entered.promise;
  if (dimension === 'session') replace(); if (dimension === 'backend') c.baseURL += '/new'; if (dimension === 'device') c.deviceId += '-new'; if (dimension === 'user') c.userID += '-new';
  if (dimension === 'signer') c.encryptionManager.identity = {};
  if (dimension === 'storage_revision') c.encryptionManager.storage.storageScopeRevision++;
  if (dimension === 'artifact') c.encryptionManager._wasmArtifactSha256 = 'replacement';
  await api.scopeSync({'team:scope': start}); release.resolve(); await rejected; assert.equal(calls, 2);
});

test('bootstrap stops its remaining channel loop after rate limit and reports deferred scopes', async () => {
  const f = await fixture(32, true); let calls = 0;
  try {
    f.m.ensureChannelReady = async () => {calls++; throw Object.assign(Error('limited'), {code: 'rate_limited'});};
    const result = await f.m.bootstrapKnownE2eeChannels(); assert.equal(calls, 1); assert.equal(result.results.length, 32);
    assert.equal(result.results.filter(r => r.status === 'needs_retry').length, 31); assert.equal(result.status, 'failed');
  } finally {await f.close();}
});

test('manager schedules three coalesced due probes, stops an outage, and resets after genuine success', async t => {
  const f = await fixture(); let calls = 0;
  try {
    t.mock.timers.enable({apis: ['Date', 'setTimeout'], now: Date.now()});
    const failure = () => Object.assign(Error('limited'), {code: 'rate_limited', retry_at: Date.now() + 1000});
    f.m._syncAndRestoreGroups = async () => {calls++; throw failure();};
    for (let i = 0; i < 32; i++) f.m._scheduleScopeSyncRetry(failure());
    for (let i = 0; i < 5; i++) {t.mock.timers.tick(1000); await new Promise(r => setImmediate(r));}
    assert.equal(calls, 3); assert.equal(f.m._scopeSyncRetry.attempts, 3); assert.equal(f.m._scopeSyncRetry.timer, undefined);
    f.m._syncAndRestoreGroups = async () => {}; await f.m.sync(); assert.equal(f.m._scopeSyncRetry, null);
    f.m._scheduleScopeSyncRetry(failure()); assert.ok(f.m._scopeSyncRetry.timer);
    f.m.userId += '-replacement'; t.mock.timers.tick(1000); await new Promise(r => setImmediate(r)); assert.equal(calls, 3);
  } finally {await f.close();}
});

test('blocked rejection remains pinned through a slow batch cycle; expiry then permits a new observation', async t => {
  const f = await fixture(1, true), cid = f.channels[0].cid, invite = welcome(f, cid);
  try {
    await f.m._persistProviderStrict(); delete invite.event.data.acceptance_context;
    t.mock.timers.enable({apis: ['Date'], now: Date.now()});
    const calls = transport(f, () => ({[cid]: {events: [invite.event], next_cursor: cursor(1), has_more: false}}));
    f.m._discoverMlsRecoveryStates = async () => {t.mock.timers.setTime(Date.now()+60_000); return {states: {}, unsupported: false};};
    await f.m.sync(); assert.equal(calls.length, 1);
    t.mock.timers.setTime(Date.now()+60_000);
    await assert.rejects(f.m._syncChannelFromCursor(cid, start), e => e.code === 'acceptance_metadata_invalid');
    assert.equal(calls.length, 2, 'bounded expiry permits a fresh observation outside that batch');
  } finally {await f.close();}
});

test('new valid protocol observation clears a prior rejection without cursor skipping or replacement identity', async () => {
  const f = await fixture(1, true), cid = f.channels[0].cid, invite = welcome(f, cid);
  try {
    await f.m._persistProviderStrict();
    const calls = transport(f, () => ({[cid]: {events: [{...invite.event, data: {...invite.event.data, acceptance_context: undefined}}], next_cursor: cursor(1), has_more: false}}));
    await f.m.sync(); assert.equal(calls.length, 1);
    await f.m.processMlsWelcome(cid, invite.event.data, {acceptanceContext: invite.context, acceptanceEnvelope: invite.context}, cursor(1));
    assert.equal(await f.m._scopeSyncBlockedResult(cid), undefined);
    assert.equal(f.m._scopeSyncBlocked.has(cid), false); assert.equal(f.m.getEpoch(cid), 1);
    f.m.e2eeClient.scopeSync = async () => {calls.push({[cid]: start}); return {channels: {[cid]: {events: [invite.event], next_cursor: cursor(1), has_more: false}}};};
    await f.m._syncChannelFromCursor(cid, start); assert.equal(calls.length, 2);
    assert.deepEqual(await f.storage.loadScopeSyncCursor(cid), cursor(1));
  } finally {await f.close();}
});

test('equivalent API requests share across wrappers; different limit/cursor/removed obligation never shares', async () => {
  const {c, api} = apiHost(), second = new E2eeClient(c), entered = latch(), release = latch(); let calls = 0;
  c.doAxiosRequest = async (_m, _u, body) => {calls++; if (calls === 1) {entered.resolve(); await release.promise;} return {channels: empty(body.cursors)};};
  const mutable = {'team:one': {...start}}, first = api.scopeSync(mutable); await entered.promise;
  const same = second.scopeSync({'team:one': {event_id: start.event_id, created_at: start.created_at}});
  mutable['team:one'].event_id = 'caller-mutation';
    const different = [api.scopeSync({'team:one': start}, 50), api.scopeSync({'team:one': cursor(1)}), api.scopeSync({'team:one': start}, 100, null),
    api.scopeSync({'team:one': start}, 100, {removed_at: start.created_at, event_id: start.event_id})];
  release.resolve(); await Promise.all([first, same, ...different]); assert.equal(calls, 5);
});

test('acceptance diagnostics expose only hashes, public numeric binding and closed reason', async () => {
  const {validateMlsAcceptanceContext} = require('../dist/encryption/index.cjs');
  const envelope = {event_id: 'test-event', cid: 'team:private-label', group_generation: 1, epoch: 2};
  assert.throws(() => validateMlsAcceptanceContext(null, envelope, Uint8Array.of(1, 2)), error => {
    assert.equal(error.reason, 'context_missing'); assert.equal(error.diagnostic.context_present, false);
    const text = JSON.stringify(error.diagnostic); assert.equal(text.includes(envelope.cid), false);
    assert.equal(text.includes(envelope.event_id), false); assert.equal(error.diagnostic.observed_payload_sha256.length, 64); return true;
  });
});

test('acceptance failure after an applied earlier page stays blocked at its pre-batch durable cursor', async () => {
  const f = await fixture(), cid = f.channels[0].cid; let page = 0;
  try {
    // Real non-mutating protocol projection on page1; page2 rejects before
    // private processing. Only this event processor is fault-injected.
    f.m._processChannelEvents = async (_cid, _events, since) => {
      if (++page === 2) throw Object.assign(Error('bad context'), {code: 'acceptance_metadata_invalid', reason: 'context_missing'});
      return {processedEventCursor: cursor(1), processedEvents: 1, bufferedMessages: 0, decrypted: []};
    };
    const calls = transport(f, (_c, n) => ({[cid]: {events: [{type: 'fixture', event_id: cursor(n).event_id}], next_cursor: cursor(n), has_more: n === 1}}));
    await f.m.sync(); assert.equal(calls.length, 2); assert.deepEqual(await f.storage.loadScopeSyncCursor(cid), start);
    assert.equal((await f.m.ensureChannelReady('team', cid.slice(5), cid, {source: 'open'})).error, 'acceptance_metadata_invalid');
    assert.equal(calls.length, 2);
  } finally {await f.close();}
});

test('explicit user Retry observes repaired metadata immediately and still proves durable Ready', async () => {
  const f = await fixture(1, true), cid = f.channels[0].cid, invite = welcome(f, cid); let fixed = false;
  try {
    await f.m._persistProviderStrict();
    const calls = transport(f, () => ({[cid]: {events: [{...invite.event, data: {...invite.event.data, acceptance_context: fixed ? invite.context : undefined}}], next_cursor: cursor(1), has_more: false}}));
    await f.m.sync(); assert.equal(calls.length, 1); fixed = true;
    const result = await f.m.ensureChannelReady('team', cid.slice(5), cid, {source: 'manual_retry'});
    assert.equal(calls.length, 2); assert.equal(result.status, 'ready'); assert.equal(f.m.getE2eeState(cid).state, 'ready');
  } finally {await f.close();}
});

test('authenticated metadata progress reopens observation; identical and unauthenticated metadata do not', async () => {
  const f = await fixture(), cid = f.channels[0].cid;
  try {
    const metadata = {cid, group_generation: 0, group_id: null, epoch: 0,
      group_info: {status: 'ready', ready: true, epoch: 0, last_uploaded_at: null, refresh_requested: false}, recovery: null};
    f.m.observeChannelE2ee(metadata, true);
    f.m._rememberScopeSyncBlocked(cid, start, {code: 'acceptance_metadata_invalid'});
    f.m.observeChannelE2ee(metadata, true); assert.ok(f.m._scopeSyncBlocked.has(cid));
    f.m.observeChannelE2ee({...metadata, epoch: 1}, false); assert.ok(f.m._scopeSyncBlocked.has(cid));
    f.m.observeChannelE2ee({...metadata, epoch: 2}, true); assert.equal(f.m._scopeSyncBlocked.has(cid), false);
  } finally {await f.close();}
});

test('bootstrap that precedes global sync cannot wait on the sync which is awaiting its completion', {timeout: 3000}, async () => {
  const f = await fixture(), entered = latch(), release = latch(); let held = false;
  try {
    const readBlocked = f.m._scopeSyncBlockedResult.bind(f.m);
    f.m._scopeSyncBlockedResult = async (...args) => {if (!held) {held = true; entered.resolve(); await release.promise;} return readBlocked(...args);};
    const calls = transport(f, empty), bootstrap = f.m.bootstrapKnownE2eeChannels({source: 'startup'}); await entered.promise;
    const sync = f.m.sync(); await new Promise(r => setImmediate(r)); release.resolve();
    await Promise.all([bootstrap, sync]); assert.ok(calls.length <= 2);
    assert.equal(f.m.getE2eeState(f.channels[0].cid).state, 'ready');
  } finally {release.resolve(); await f.close();}
});

test('authoritative recovery activates before its one batched catch-up and durable Ready proof', async () => {
  const f = await fixture(1, true), cid = f.channels[0].cid, invite = welcome(f, cid); let recoveries = 0;
  try {
    await f.m._persistProviderStrict();
    f.m._discoverMlsRecoveryStates = async () => ({states: {[cid]: {result: 'state', generation: {}}}, unsupported: false});
    // Fault-inject the recovery observation boundary, using a real validated
    // Welcome/private-KP checkpoint for activation. Transport/admission details
    // of External Join are covered by the existing owned-external suites.
    f.m.recoverMlsGeneration = async () => {
      recoveries++; await f.m.processMlsWelcome(cid, invite.event.data,
        {acceptanceContext: invite.context, acceptanceEnvelope: invite.context}, cursor(1));
      return {status: 'recovered'};
    };
    const calls = transport(f, () => ({[cid]: {events: [], next_cursor: cursor(1), has_more: false}}));
    await f.m.sync(); assert.equal(recoveries, 1); assert.equal(calls.length, 1, 'activation precedes catch-up; no pre-join point read');
    assert.equal(f.m.getE2eeState(cid).state, 'ready'); assert.equal(f.m.identity.owns_key_package_ref(f.m.provider, invite.ref), false);
  } finally {await f.close();}
});


test('completed batch is not reread after an unrelated durable provider write before Ready admission', async () => {
  const f = await fixture(5);
  try {
    const calls = transport(f, empty);
    const ensure = f.m.ensureChannelReady.bind(f.m);
    let changed = false;
    f.m.ensureChannelReady = async (...args) => {
      if (!changed) { changed = true; await f.m._persistProviderStrict(); }
      return ensure(...args);
    };
    await f.m.sync();
    assert.equal(calls.length, 1, 'a provider revision is not a new server event observation');
    for (const c of f.channels) {
      assert.equal(f.m.getE2eeState(c.cid).state, 'ready');
      assert.ok((await f.storage.loadMlsReadyBase(f.user, f.device, c.cid)).ready);
    }
  } finally { await f.close(); }
});


test('reused event delivery still requires current durable Ready evidence', async () => {
  const f = await fixture(1); const c = f.channels[0];
  try {
    const calls = transport(f, empty); await f.m.sync();
    await f.m._persistProviderStrict();
    let proofs = 0;
    f.m._checkChannelEvidence = async () => { proofs++; throw Object.assign(new Error('checkpoint unavailable'), {code:'local_checkpoint_pending'}); };
    const result = await f.m.ensureChannelReady(c.channelType, c.channelId, c.cid, {source:'sync', initialScopeSyncCompleted:true});
    assert.equal(calls.length, 1); assert.equal(proofs, 1);
    assert.equal(result.status, 'needs_retry'); assert.notEqual(f.m.getE2eeState(c.cid).state, 'ready');
  } finally { await f.close(); }
});

test('completed event delivery rejects changed scope ownership and uncertain provider', async () => {
  const f = await fixture(1); const cid = f.channels[0].cid;
  try {
    transport(f, empty); await f.m.sync();
    assert.ok(f.m._getCompletedSyncProgress(cid));
    f.m._providerPersistenceUncertain = true; assert.equal(f.m._getCompletedSyncProgress(cid), null);
    f.m._providerPersistenceUncertain = false;
    const marker = f.m._groupGenerations.get(cid);
    f.m._groupGenerations.set(cid, {...marker}); assert.ok(f.m._getCompletedSyncProgress(cid), 'equivalent marker materialization preserves event delivery');
    f.m._groupGenerations.set(cid, {...marker, group_generation: marker.group_generation + 1});
    assert.equal(f.m._getCompletedSyncProgress(cid), null, 'a real generation replacement retires delivery');
    f.m._groupGenerations.set(cid, marker);
    f.m._mlsCleanupRevisions.set(cid, 1); assert.equal(f.m._getCompletedSyncProgress(cid), null);
  } finally { await f.close(); }
});

test('quiet restart with 32 completed scopes performs batch delta without native restoration or recovery discovery', async () => {
 const f = await fixture(32);
 try {
   for (const c of f.channels) {
     const channel = f.m.client.activeChannels[c.cid];
     channel.state.membership = channel.state.members[f.user];
     await f.m._checkpointBootstrap(c.cid);
     await f.storage.savePendingE2eeSnapshots(c.cid, [{ version: 'retained-' + c.cid, cid: c.cid,
       received_cursor: start, message: {id: 'old-' + c.cid, cid: c.cid, created_at: start.created_at,
         mls_epoch: 0, group_generation: 0, mls_ciphertext: new Uint8Array([1])} }]);
   }
   f.m.groups.clear();
   let flushes = 0;
   const flush = f.m._flushPendingSnapshotsForScope.bind(f.m);
   f.m._flushPendingSnapshotsForScope = async cid => { flushes++; return flush(cid); };
   let nativeRestores = 0, discovered = [], prepared = [];
   const restore = f.m._restoreGroupsLocally.bind(f.m);
   f.m._restoreGroupsLocally = async targets => { nativeRestores += targets?.length || 0; return restore(targets); };
   f.m._discoverMlsRecoveryStates = async cids => { discovered.push(...cids); return { states: {}, unsupported: false }; };
   const bootstrap = f.m.bootstrapKnownE2eeChannels.bind(f.m);
   f.m.bootstrapKnownE2eeChannels = async options => { prepared.push(...options.targetCids); return bootstrap(options); };
   const calls = transport(f, empty); await f.m.sync();
   assert.deepEqual(calls.map(c => Object.keys(c).length), [32]);
   assert.equal(flushes, 0, 'Empty delta must not retry every retained history ciphertext from the previous login');
   assert.equal(nativeRestores, 0); assert.equal(f.m.groups.size, 0);
   for (const c of f.channels) assert.equal((await f.storage.loadPendingE2eeSnapshots(c.cid)).length, 1);
   assert.deepEqual(discovered, []); assert.deepEqual(prepared, []);
   for (const c of f.channels) assert.deepEqual(await f.storage.loadScopeSyncCursor(c.cid), start);
 } finally { await f.close(); }
});

test('cold open joins the in-flight account response without a second sync or global restore', async () => {
 const f=await fixture(8),http=latch(),release=latch();let open;
 try {
  for(const c of f.channels){const ch=f.m.client.activeChannels[c.cid];ch.state.membership=ch.state.members[f.user];await f.m._checkpointBootstrap(c.cid);}
  f.m.groups.clear();f.m._groupGenerations.clear();
  const calls=transport(f,async cursors=>{http.resolve();await release.promise;return empty(cursors);});
  const work=f.m.sync();await http.promise;
  const c=f.channels.at(-1);open=f.m.ensureChannelReady(c.channelType,c.channelId,c.cid,{source:'open'});
  const observed=open.then(value=>({value}),error=>({error}));
  release.resolve();await work;
  const result=await observed;assert.equal(result.error,undefined);assert.equal(result.value.status,'ready');
  assert.equal(f.m.getEpoch(c.cid),0);assert.equal(f.m.getE2eeState(c.cid)?.state,'ready');
  assert.deepEqual(calls.map(c=>Object.keys(c).length),[8]);
  assert.equal(f.m.groups.size,1,'only the selected dormant scope is materialized');
 } finally {release.resolve();if(open)await open.catch(()=>{});await f.close();}
});


test('restart loads a dormant scope on its actual protocol event before the missing-group dispatch guard', async () => {
 const f = await fixture(1), cid = f.channels[0].cid;
 try {
   const channel = f.m.client.activeChannels[cid]; channel.state.membership = channel.state.members[f.user];
   await f.m._checkpointBootstrap(cid); f.m.groups.clear();
   let inspected = 0;
   // Validate the actual ingress ordering before contextual native processing,
   // whose signature/acceptance rules are covered by packaged WASM tests.
   f.m.processCommit = async scope => { inspected++; assert.equal(scope, cid); assert.ok(f.m.groups.has(cid)); };
   const event = { type: 'protocol', cid, event_id: cursor(1).event_id, created_at: cursor(1).created_at,
     data: { type: 'commit', epoch: 1, group_generation: 0, commit: new Uint8Array([1]), user_id: 'peer', device_id: 'peer-device' } };
   await f.m._processChannelEvents(cid, [event], start);
   assert.equal(inspected, 1); assert.equal(f.m.groups.size, 1);
 } finally { await f.close(); }
});
