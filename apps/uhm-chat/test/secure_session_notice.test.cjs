const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const filename = path.resolve(__dirname, '../src/features/chat/secureSessionNotice.ts');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const fixture = new Module(filename, module);
fixture._compile(compiled.outputText, filename);
const { updateSecureSessionNotice: update, secureSessionPresentation: present, secureSessionScope: scope } = fixture.exports;
const cid = 'messaging:active';
const event = (repair_status, reason) => ({ cid, repair_status, reason });

test('invalid GroupInfo and missing local group are waiting states without a spinner', () => {
  for (const reason of ['group_info_invalid', 'no_local_group', 'awaiting_newer_group_info']) {
    const notice = update(null, event('retryable', reason), cid, 1000);
    assert.deepEqual(present(notice, 1000), { working: false, message: 'waiting_member', canRetry: true });
  }
});

test('exhausted attempts end active repair and expose retry', () => {
  const running = update(null, event('refreshing'), cid, 1000);
  const finished = update(running, event('retryable', 'repair_attempts_exhausted'), cid, 1500);
  assert.deepEqual(present(finished, 1500), { working: false, message: 'retry', canRetry: true });
});

test('duplicate progress cannot extend the active-work timeout', () => {
  const running = update(null, event('refreshing'), cid, 1000);
  const repeated = update(running, event('refreshing'), cid, 30_999);
  assert.equal(repeated, running);
  assert.equal(present(repeated, 30_999).working, true);
  assert.deepEqual(present(repeated, 31_000), { working: false, message: 'retry', canRetry: true });
});

test('preparation is bounded and waiting for repair never pretends work is active', () => {
  const preparing = update(null, { cid, status: 'preparing' }, cid, 1000);
  assert.equal(present(preparing, 1000).working, true);
  assert.equal(present(preparing, 31_000).working, false);
  const waiting = update(null, { cid, status: 'waiting_for_repair' }, cid, 1000);
  assert.equal(present(waiting, 1000).working, false);
});

test('background channels cannot change or clear the active notice', () => {
  const running = update(null, event('refreshing'), cid, 1000);
  assert.equal(update(running, { cid: 'messaging:background', status: 'recovered' }, cid, 1500), running);
  assert.equal(update(null, { cid: 'messaging:background', repair_status: 'retryable' }, cid, 1500), null);
});

test('ready clears repair but cannot clear generation preparation', () => {
  const repair = update(null, event('refreshing'), cid, 1000);
  assert.equal(update(repair, event('ready'), cid, 1500), null);
  const preparation = update(null, { cid, status: 'preparing' }, cid, 1000);
  assert.equal(update(preparation, event('ready'), cid, 1500), preparation);
  assert.equal(update(preparation, { cid, status: 'recovered' }, cid, 1500), null);
});

test('generation waiting does not overwrite a bounded active GroupInfo repair', () => {
  const running = update(null, event('refreshing'), cid, 1000);
  assert.equal(update(running, { cid, status: 'waiting_for_repair' }, cid, 1500), running);
  const waiting = update(running, { cid, status: 'waiting_for_repair' }, cid, 31_000);
  assert.equal(present(waiting, 31_000).working, false);
});

test('history and required upgrades do not offer repair retry', () => {
  for (const status of ['history_incomplete', 'client_upgrade_required']) {
    const notice = update(null, { cid, status }, cid, 1000);
    assert.equal(present(notice, 1000).canRetry, false);
    assert.equal(present(notice, 1000).working, false);
  }
});

test('topics use the authoritative encryption scope without using gated parents', () => {
  assert.equal(scope({ cid: 'team:topic', data: { parent_cid: cid } }), cid);
  assert.equal(scope({ cid: 'team:topic', data: { parent_cid: cid, gate: true } }), 'team:topic');
  assert.equal(scope({ cid: 'team:topic', data: { parent_cid: cid, e2ee_group_id: 'team:own' } }), 'team:own');
  assert.equal(scope({ cid: 'team:topic', data: { mls_cid: 'team:scope' } }), 'team:scope');
});
