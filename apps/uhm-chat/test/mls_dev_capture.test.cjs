const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { webcrypto, createHash } = require('node:crypto');
const marker = 'archive_upload_checkpoint result=permission_blocked';
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

async function harness(fetchEvent = async () => ({ ok: true }), cryptoProvider = webcrypto) {
  const requests = [], logs = [], warnings = [], timers = new Map(); let timerId = 0;
  const context = { exports: {}, AbortController, crypto: cryptoProvider, TextEncoder,
    window: { location: { hostname: 'localhost', port: '3001' } },
    console: { log: (...args) => logs.push(args), warn: (...args) => warnings.push(args), error: () => {} },
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    fetch: async (url, options) => {
      if (url.endsWith('/health')) return { ok: true };
      requests.push(options.body); return fetchEvent(options);
    },
  };
  const source = fs.readFileSync(path.join(__dirname, '../src/utils/mlsDevLogger.ts'), 'utf8').replaceAll('import.meta.env.DEV', 'true');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(compiled, context); await settle();
  const devLogger = context.exports.mlsDevLogger;
  const sdkContext = { ...context, exports: {} };
  const sdkSource = fs.readFileSync(path.join(__dirname, '../../../packages/ermis-chat-sdk/src/logger.ts'), 'utf8');
  vm.runInNewContext(ts.transpileModule(sdkSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, sdkContext);
  sdkContext.exports.setSdkLogger(devLogger);
  return { requests, logs, warnings, timers, emit: () => context.exports.mlsDevLogger('info', marker),
    emitSdk: (level, ...args) => sdkContext.exports.sdkLog(level, ...args),
    finish: () => context.window.__mlsFieldCapture.finish(),
    runTimer: delay => { const item = [...timers].find(([, v]) => v.delay === delay); assert.ok(item); timers.delete(item[0]); item[1].fn(); } };
}

test('batching preserves all marker order and finish boundary with at most32 per POST', async () => {
  const h = await harness(); for (let i = 0; i < 103; i++) h.emit(); await h.finish();
  const markers = h.requests.flatMap(body => body.split('\n'));
  assert.deepEqual(markers, ['capture_ready', ...Array(103).fill(marker), 'capture_finished']);
  assert.equal(h.requests.length, 4); assert.ok(h.requests.every(body => body.split('\n').length <= 32));
  assert.deepEqual(h.logs.at(-1), ['MLS capture failures:', 0]);
});

test('small batch flushes on timer and leaves capture active after finish', async () => {
  const h = await harness(); h.emit(); assert.equal(h.requests.length, 0);
  h.runTimer(200); await settle(); assert.equal(h.requests.length, 1);
  await h.finish(); h.emit(); await h.finish();
  assert.deepEqual(h.requests.flatMap(b => b.split('\n')), ['capture_ready', marker, 'capture_finished', marker, 'capture_finished']);
});

test('non200 counts each undelivered marker instead of claiming one lost request', async () => {
  const h = await harness(async () => ({ ok: false })); h.emit(); await h.finish();
  assert.deepEqual(h.logs.at(-1), ['MLS capture failures:', 3]);
});

test('stalled fetch abort deadline lets finish settle and counts lost markers', async () => {
  const h = await harness(options => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('fixture abort')));
  }));
  h.emit(); const finished = h.finish(); await settle(); h.runTimer(5_000); await finished;
  assert.deepEqual(h.logs.at(-1), ['MLS capture failures:', 3]);
});

test('existing capture cap bounds backlog and reports every dropped marker', async () => {
  const h = await harness(); for (let i = 0; i < 10_010; i++) h.emit(); await h.finish();
  assert.equal(h.requests.flatMap(b => b.split('\n')).length, 10_001);
  assert.deepEqual(h.logs.at(-1), ['MLS capture failures:', 11]);
});

test('actual SDK info bridge projects error class and epoch relation without private values', async () => {
  const h = await harness();
  h.emitSdk('info', '[Encryption] Message is waiting for encrypted history recovery:', {
    cid: 'PRIVATE_CID', msgId: 'PRIVATE_ID', groupEpoch: 6, msgEpoch: 6,
    error: 'AEAD decryption failed PRIVATE_TOKEN',
  });
  await h.finish();
  const scope = createHash('sha256').update('PRIVATE_CID').digest('hex');
  assert.deepEqual(h.requests.flatMap(b => b.split('\n')), [
    'capture_ready', 'receive_diagnostic error=aead epoch_relation=same',
    `receive_epoch scope=${scope} local=6 incoming=6 error=aead`, 'capture_finished',
  ]);
  assert.equal(h.requests.some(b => b.includes('PRIVATE_')), false);
});

test('info-level replay outcome reaches Console and capture with only validated scope/epoch/enums', async () => {
  const h = await harness();
  for (let n=0;n<100;n++) h.emitSdk('info', '[Encryption] Protocol replay diagnostic:', {
    cid: 'PRIVATE_SCOPE', groupEpoch: 5, targetEpoch: 7, result: 'failed', reason: 'epoch_gap',
    error: 'PRIVATE_TOKEN', payload: 'PRIVATE_TEXT',
  });
  await h.finish();
  const scope = createHash('sha256').update('PRIVATE_SCOPE').digest('hex');
  const marker = `protocol_replay scope=${scope} local=5 target=7 result=failed reason=epoch_gap`;
  assert.deepEqual(h.requests.flatMap(b => b.split('\n')), ['capture_ready', marker, 'capture_finished']);
  assert.equal(h.warnings.filter(row => row[0] === `[MLS] ${marker}`).length, 1);
  assert.equal(h.requests.join('').includes('PRIVATE_'), false);
});

test('own Commit diagnostics expose only candidate disposition and bounded metadata', async () => {
  const h = await harness();
  const reasons = ['own_commit_candidate_mismatch', 'own_commit_unjournaled_candidate', 'own_commit_no_candidate'];
  for (const reason of reasons) h.emitSdk('info', '[Encryption] Protocol replay diagnostic:', {
    cid: 'PRIVATE_SCOPE', groupEpoch: 4, targetEpoch: 5, result: 'pending', reason, candidate: 'PRIVATE_SECRET',
  });
  await h.finish();
  const scope = createHash('sha256').update('PRIVATE_SCOPE').digest('hex');
  assert.deepEqual(h.requests.flatMap(b => b.split('\n')), ['capture_ready',
    ...reasons.map(reason => `protocol_replay scope=${scope} local=4 target=5 result=pending reason=${reason}`), 'capture_finished']);
  assert.equal(h.requests.join('').includes('PRIVATE_'), false);
});

test('unknown replay enums/raw errors are projected and unsafe numeric epochs are unavailable', async () => {
  const h = await harness();
  h.emitSdk('info', '[Encryption] Protocol replay diagnostic:', {
    cid: 'fixture', groupEpoch: Number.MAX_SAFE_INTEGER + 1, targetEpoch: -1,
    result: 'pending', reason: 'PRIVATE_REASON',
  });
  h.emitSdk('info', '[Encryption] Protocol replay diagnostic:', { cid: 'fixture', result: 'PRIVATE_RESULT' });
  h.emitSdk('info', '[Encryption] Protocol replay diagnostic:', { cid: 'x'.repeat(513), result: 'pending' });
  await h.finish();
  const scope = createHash('sha256').update('fixture').digest('hex');
  assert.deepEqual(h.requests.flatMap(b => b.split('\n')), ['capture_ready',
    `protocol_replay scope=${scope} local=unknown target=unknown result=pending reason=other`, 'capture_finished']);
});
test('healthy scopes remain in bounded capture without new Console noise', async () => {
  const h = await harness();
  h.emitSdk('info', '[Encryption] Protocol replay diagnostic:', {
    cid: 'healthy', groupEpoch: 7, targetEpoch: 7, result: 'skipped', reason: 'epoch_current',
  });
  await h.finish();
  assert.ok(h.requests.join('\n').includes('local=7 target=7 result=skipped reason=epoch_current'));
  assert.equal(h.warnings.length, 0);
});
test('scoped diagnostic inflight work is bounded and any dropped projection is reported', async () => {
  const h = await harness();
  for (let n=0;n<129;n++) h.emitSdk('info', '[Encryption] Protocol replay diagnostic:', {
    cid: `fixture-${n}`, groupEpoch: 7, targetEpoch: 7, result: 'skipped', reason: 'epoch_current',
  });
  await h.finish();
  assert.equal(h.requests.flatMap(body => body.split('\n')).filter(row => row.startsWith('protocol_replay')).length, 128);
  assert.deepEqual(h.logs.at(-1), ['MLS capture failures:', 1]);
});
test('unavailable hashing cannot throw into MLS processing and the missing projection is reported', async () => {
  const h = await harness(undefined, {});
  assert.doesNotThrow(() => h.emitSdk('info', '[Encryption] Protocol replay diagnostic:', {
    cid: 'fixture', groupEpoch: 5, targetEpoch: 7, result: 'pending', reason: 'none',
  }));
  await h.finish();
  assert.deepEqual(h.requests.flatMap(body => body.split('\n')), ['capture_ready', 'capture_finished']);
  assert.deepEqual(h.logs.at(-1), ['MLS capture failures:', 1]);
});

test('actual SDK error bridge handles route argument and throttles repeated failures', async () => {
  const h = await harness();
  for (let i = 0; i < 100; i++) h.emitSdk('error', '[Encryption] Failed to decrypt message:', 'PRIVATE_CID', {
    groupEpoch: 5, msgEpoch: 6, error: 'WrongEpoch PRIVATE_PAYLOAD',
  });
  await h.finish();
  assert.equal(h.requests.flatMap(b => b.split('\n')).filter(m => m.startsWith('receive_diagnostic')).length, 1);
  assert.ok(h.requests.join('\n').includes('receive_diagnostic error=epoch epoch_relation=future'));
  assert.equal(h.requests.some(b => b.includes('PRIVATE_')), false);
});

test('diagnostics reject invalid epochs and inspect only bounded raw error prefix', async () => {
  const h = await harness();
  h.emitSdk('info', '[Encryption] Message is waiting for encrypted history recovery:', {
    groupEpoch: NaN, msgEpoch: -1, error: 'x'.repeat(512) + 'WrongEpoch PRIVATE_TOKEN',
  });
  h.emitSdk('info', 'PRIVATE unrelated message', { error: 'WrongEpoch', groupEpoch: 1, msgEpoch: 2 });
  await h.finish();
  assert.deepEqual(h.requests.flatMap(b => b.split('\n')), [
    'capture_ready', 'receive_diagnostic error=other epoch_relation=unknown', 'capture_finished',
  ]);
});
