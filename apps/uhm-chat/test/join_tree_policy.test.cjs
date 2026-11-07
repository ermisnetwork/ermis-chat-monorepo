const assert = require('node:assert/strict'), test = require('node:test');
const fs = require('node:fs'), Module = require('node:module'), path = require('node:path'), ts = require('typescript');
const filename = path.resolve(__dirname, '../src/utils/joinTreePolicy.ts'), fixture = new Module(filename, module);
fixture._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS}}).outputText, filename);
const {selectUhmJoinTreePolicy: policy} = fixture.exports;
test('standard Uhm selects the checked expired-tree policy on its production HTTPS origin', () => {
  for (const origin of ['https://api-trieve.ermis.network', 'https://api-trieve.ermis.network/']) assert.equal(policy(origin, undefined), true);
});
test('other environments and QA providers retain strict defaults', () => {
  for (const origin of ['http://api-trieve.ermis.network', 'https://api-trieve.ermis.network.attacker.test', 'https://api-trieve.ermis.network:444', 'https://api-mac.khoakheu.pro', 'invalid']) assert.equal(policy(origin, undefined), false);
  assert.equal(policy('https://api-trieve.ermis.network', undefined, 'clone-1'), false);
});
test('explicit consumer policy remains selectable in either direction', () => {
  assert.equal(policy('https://api-trieve.ermis.network', 'false'), false);
  assert.equal(policy('https://api-mac.khoakheu.pro', 'true', 'clone-1'), true);
});
