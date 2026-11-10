const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const source = fs.readFileSync(require.resolve('../src/utils/helpers.ts'), 'utf8');
const code = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const exportsObject={};
new Function('exports', code)(exportsObject);
for (const phone of ['0900000000', '900000000', '84900000000', '+84900000000', '+84 900 000 000']) {
  test(`phone variant ${phone.startsWith('+') ? 'international' : phone.length} produces Firebase E.164`, () => {
    assert.equal(exportsObject.normalizePhone(phone), '+84900000000');
    assert.ok(exportsObject.validatePhone(phone));
  });
}

test('a national number starting84 is not mistaken for the country code', () => {
  assert.equal(exportsObject.normalizePhone('849000000'), '+84849000000');
});
test('invalid phone lengths and mobile prefixes cannot request Firebase SMS', () => {
  for(const value of ['', '123456789', '090000000', '+849000000000', 'abc']) {
    assert.equal(exportsObject.validatePhone(value),false);
    assert.equal(exportsObject.normalizePhone(value),'');
  }
});
