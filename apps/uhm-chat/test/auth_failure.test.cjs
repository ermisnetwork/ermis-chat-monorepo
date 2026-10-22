const assert = require('node:assert/strict'), test = require('node:test');
const fs = require('node:fs'), Module = require('node:module'), path = require('node:path'), ts = require('typescript');
const filename = path.resolve(__dirname, '../src/utils/authFailure.ts');
const fixture = new Module(filename, module);
fixture._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS}}).outputText, filename);
const {requiresLoginAfterRefreshFailure: requiresLogin} = fixture.exports;
test('missing refresh credentials and canonical refresh rejections require login', () => {
  for (const event of [{reason: 'missing_refresh_token'}, {status: 401}, {status: 403}]) assert.equal(requiresLogin(event), true);
});
test('timeout, disconnected transport and server failure retain the saved session', () => {
  for (const event of [{reason: 'refresh_failed'}, {reason: 'auth_refresh_timeout'}, {status: 500}, {status: 503}, {}]) assert.equal(requiresLogin(event), false);
});
