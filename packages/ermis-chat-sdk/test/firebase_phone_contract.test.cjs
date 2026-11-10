const test = require('node:test');
const assert = require('node:assert/strict');
const ts = require('typescript');
const fs = require('node:fs');
// Execute current adapter source; no stale dist or generated artifacts.
require.extensions['.ts'] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: filename,
  }).outputText, filename);
};
const { LegacyEndUserAuthApi } = require('../src/end_user/legacy.ts');
const { V1EndUserAuthApi } = require('../src/end_user/v1.ts');

test('Firebase exchange carries proof and API key, never an OTP or claimed phone', async () => {
  let call;
  const api = new LegacyEndUserAuthApi('https://auth.example/uss/v1', 'project-key', {
    request: async (...args) => { call = args; return {token: 'session', user_id: 'existing-user'}; },
  });
  const result = await api.loginWithFirebasePhone('test-proof');
  assert.deepEqual(call, ['post', 'https://auth.example/uss/v1/auth/firebase/phone', {id_token:'test-proof', apikey:'project-key'}]);
  assert.equal(result.user_id, 'existing-user');
});

test('Firebase exchange transport failure propagates without sending legacy SMS', async () => {
  let count = 0;
  const api = new LegacyEndUserAuthApi('https://auth.example', 'key', {
    request: async () => { count++; throw new Error('unavailable'); },
  });
  await assert.rejects(api.loginWithFirebasePhone('test-proof'), /unavailable/);
  assert.equal(count, 1);
});

test('external v1 rejects internal-only Firebase without network traffic', async () => {
  const api = new V1EndUserAuthApi('https://external.example', { request: async () => assert.fail('unexpected network') });
  await assert.rejects(api.loginWithFirebasePhone('test-proof'), {code:'END_USER_FEATURE_UNSUPPORTED'});
});
