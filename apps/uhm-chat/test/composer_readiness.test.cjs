const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
function fixture(encrypted = true, enqueuePredicate = false) {
 const source = fs.readFileSync(path.join(__dirname, '../src/features/chat/UhmMessageInput.tsx'), 'utf8');
 const start = source.indexOf('  const scope = activeChannel ? secureSessionScope'), end = source.indexOf('  const [keywordError', start);
 assert.ok(start > 0 && end > start);
 const listeners = new Map(), states = new Set(); let state = 'repairing', shown, cleanup, proofReads = 0, canEnqueue = false;
 const manager = { initialized: true, userId: 'fixture', getE2eeState: () => { proofReads++; return { state }; },
   subscribeE2eeState: (cid, cb) => { assert.equal(cid, 'team:scope'); states.add(cb); cb({ state }); return { unsubscribe: () => states.delete(cb) }; } };
 if (enqueuePredicate) manager.canEnqueueApplicationSend = cid => { assert.equal(cid, 'team:scope'); return canEnqueue; };
 const activeChannel = { initialized: true, cid: 'team:scope', data: { mls_enabled: encrypted } };
 const client = { userID: 'fixture', encryptionManager: manager, activeChannels: {}, prioritizeChannelReadiness: () => {},
   on: (type, cb) => { listeners.set(type, cb); return { unsubscribe: () => listeners.delete(type) }; } };
 const code = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
 vm.runInNewContext(code, { client, activeChannel, secureSessionScope: channel => channel.cid, useState: initial => { shown = initial(); return [shown, update => { shown = update(shown); }]; }, useEffect: effect => { cleanup = effect(); } });
 return { client, manager, get shown() { return shown.ready; }, get verified() { return shown.verified; },
   get proofReads() { return proofReads; }, cleanup: () => cleanup(),
   state: (next, eligible = next === 'ready') => { state = next; canEnqueue = eligible; for (const cb of states) cb({ state }); listeners.get('e2ee.state_changed')?.({ cid: activeChannel.cid, state }); },
   event: (type, value) => listeners.get(type)?.(value), callbacks: () => [...states, ...listeners.values()] };
}
test('composer follows exact local Ready transitions without another HTTP/sync/progress event', () => {
 const h = fixture(); assert.equal(h.shown, false); h.state('ready'); assert.equal(h.shown, true);
 for (const state of ['pending_external_join', 'repairing', 'manual_intervention_required']) { h.state(state); assert.equal(h.shown, false); }
 h.state('ready'); assert.equal(h.shown, true); h.cleanup();
});
test('retired composer callbacks cannot update the new view/account', () => {
 const h = fixture(), late = h.callbacks(); h.cleanup(); h.state('ready');
 for (const cb of late) cb({ cid: 'team:scope', state: 'ready' });
 assert.equal(h.shown, false);
 const changed = fixture(); changed.client.userID = 'replacement'; changed.state('ready'); assert.equal(changed.shown, false); changed.cleanup();
});
test('standard composer requires no encryption readiness or native work', () => {
 const h = fixture(false); assert.equal(h.shown, true); assert.equal(h.proofReads, 0); h.cleanup();
});
test('composer stays usable for guarded local intent admission but blocks actual recovery and retired accounts', () => {
 const h = fixture(true, true); assert.equal(h.shown, false);
 h.state('ready'); assert.equal(h.shown, true);
 for (let i = 0; i < 3; i++) {
   h.state('repairing', true); assert.equal(h.shown, true, 'owned local checkpoint does not flicker the send button');
   assert.equal(h.verified, false, 'intent admission does not confirm recovery');
   h.state('ready'); assert.equal(h.shown, true);
   assert.equal(h.verified, true);
 }
 for (const state of ['pending_external_join', 'repairing', 'manual_intervention_required', 'upgrade_required']) {
   h.state(state, false); assert.equal(h.shown, false);
 }
 h.client.userID = 'replacement'; h.state('ready'); assert.equal(h.shown, false); h.cleanup();
});
