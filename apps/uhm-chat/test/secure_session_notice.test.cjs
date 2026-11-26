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
const { hasSecureSessionIssue, scopedRecoveryPresentation, secureSessionPresentation: present, secureSessionScope: scope } = fixture.exports;

test('late channel open reads a retained stop before any new event', () => {
  const retained = Object.freeze({ phase: 'waiting', startedAt: 1000 });
  assert.equal(scopedRecoveryPresentation(retained, 'blocked'), retained);
  assert.equal(hasSecureSessionIssue(retained, 'blocked'), true);
  assert.equal(scopedRecoveryPresentation(undefined, 'failed').phase, 'retry');
  assert.equal(scopedRecoveryPresentation(undefined, 'pending'), undefined);
  assert.equal(hasSecureSessionIssue(undefined, 'pending'), false);
  assert.equal(hasSecureSessionIssue({ phase: 'syncing' }, 'pending'), false);
  assert.equal(scopedRecoveryPresentation(retained, 'ready'), undefined);
  assert.equal(hasSecureSessionIssue(retained, 'ready'), false);
});

test('server retry time only enables a check, never generation recovery', () => {
  const retryAt = new Date(20_000).toISOString();
  assert.deepEqual(present({ phase: 'waiting', retryAt }, 15_000, true),
    { message: 'waiting', working: false, action: undefined, nextCheck: 20_000 });
  assert.equal(present({ phase: 'waiting', retryAt }, 20_000, true).action, 'check');
  assert.equal(present({ phase: 'waiting_for_evidence', actionable: false }, 20_001, true).action, undefined);
  assert.equal(present({ phase: 'eligible' }, 1000, true).action, 'restore');
});

test('work timelines have a bounded spinner and keep confirmation distinct', () => {
  for (const phase of ['checking', 'restoring', 'syncing']) {
    assert.deepEqual(present({ phase, startedAt: 1000 }, 30_999, true), { message: phase, working: true });
    assert.deepEqual(present({ phase, startedAt: 1000 }, 31_000, true), { message: 'pending', working: false });
  }
  assert.deepEqual(present({ phase: 'confirming', startedAt: 1000, actionable: false }, 31_000, true),
    { message: 'unconfirmed', working: false });
  assert.equal(present({ phase: 'confirming', actionable: true }, 31_000, true).action, 'receipt');
});

test('offline, unsupported and support states expose truthful next steps', () => {
  assert.deepEqual(present({ phase: 'eligible' }, 1000, false), { message: 'offline', working: false });
  for (const phase of ['support', 'upgrade', 'server_upgrade']) {
    assert.equal(present({ phase }, 1000, true).action, 'help');
  }
  assert.equal(present({ phase: 'retry' }, 1000, true).action, 'retry');
});

test('inherited topics use the parent scope and gated topics keep their own', () => {
  const cid = 'team:parent';
  assert.equal(scope({ cid: 'topic:child', data: { parent_cid: cid } }), cid);
  assert.equal(scope({ cid: 'topic:gated', data: { parent_cid: cid, gate: true } }), 'topic:gated');
  assert.equal(scope({ cid: 'topic:child', data: { parent_cid: cid, e2ee_group_id: 'team:own' } }), 'team:own');
});
