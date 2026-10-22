const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

function fixture(dev = true) {
  const filename = path.resolve(__dirname, '../src/utils/mlsRepairDiagnostics.ts');
  const source = fs.readFileSync(filename, 'utf8').replace('import.meta.env.DEV', String(dev));
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const batches = [], timers = [], exports = {};
  vm.runInNewContext(compiled.outputText, {
    exports, Error, Uint8Array, URL,
    window: { location: { hostname: 'localhost', origin: 'http://localhost:3001' }, setTimeout: cb => timers.push(cb) },
    fetch: async (url, options) => batches.push({ url, ...options, records: JSON.parse(options.body) }),
  }, { filename });
  return { ...exports, batches, flush: () => timers.splice(0).forEach(cb => cb()) };
}

test('external join preserves successful results and the exact thrown error', () => {
  const f = fixture(), result = {}, failure = new Error('Lifetime is not acceptable.');
  const group = { join_external: function (provider) { assert.equal(this, group); if (provider === 'bad') throw failure; return result; } };
  f.instrumentMlsExternalJoin(group);
  f.instrumentMlsExternalJoin(group);
  assert.equal(group.join_external('good'), result);
  assert.throws(() => group.join_external('bad', {}, new Uint8Array([0, 1, 0, 4, 99])), error => error === failure);
  f.flush();
  assert.equal(f.batches[0].records.length, 1);
  assert.equal(f.batches[0].records[0].error_message, failure.message);
  assert.equal(f.batches[0].records[0].wire_prefix, '00010004');
  assert.equal(f.batches[0].records[0].group_info_bytes, 5);
});

test('response summaries exclude headers and MLS blobs, redact tokens and read discovery capability', () => {
  const f = fixture();
  let success;
  const client = { axiosInstance: { interceptors: { response: { use: callback => { success = callback; } } } }, on() {} };
  f.installMlsRepairDiagnostics(client);
  const response = {
    config: { url: '/v1/e2ee/mls/recovery/discover?token=secret', method: 'post', headers: { authorization: 'Bearer secret-header' } },
    status: 200,
    data: { message: 'Bearer secret-message', group_info: 'secret-mls-blob', capability: { automatic_enabled: false },
      states: { 'messaging:test': { result: 'state', generation: { state: 'activated', group_generation: 0, current_epoch: 41 } } } },
  };
  assert.equal(success(response), response);
  f.flush();
  const serialized = JSON.stringify(f.batches);
  assert.equal(serialized.includes('secret'), false);
  assert.equal(f.batches[0].credentials, 'omit');
  assert.equal(f.batches[0].url, '/__mls-repair-diagnostics');
  const discovery = f.batches[0].records.find(record => record.kind === 'generation_discovery');
  assert.equal(discovery.automatic_enabled, false);
  assert.equal(discovery.current_epoch, 41);
});

test('production builds leave join and client untouched and send no diagnostics', () => {
  const f = fixture(false), original = () => 'ok', group = { join_external: original };
  f.instrumentMlsExternalJoin(group);
  f.installMlsRepairDiagnostics({});
  f.recordMlsRepairDiagnostic('test', { message: 'anything' });
  f.flush();
  assert.equal(group.join_external, original);
  assert.equal(f.batches.length, 0);
});
