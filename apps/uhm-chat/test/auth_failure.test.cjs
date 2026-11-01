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

test('typed refresh rejection requires login; untyped400 and WS1006 remain retryable',()=>{
 assert.equal(requiresLogin({status:400,reason:'refresh_failed'}),false);assert.equal(requiresLogin({status:400,reason:'refresh_rejected'}),true);assert.equal(requiresLogin({reason:'refresh_rejected'}),true);assert.equal(requiresLogin({status:1006}),false);
});
const {createBootstrapSessionGuard}=fixture.exports;
test('terminal auth transition fences late bootstrap success and late error presentation',()=>{
 const guard=createBootstrapSessionGuard(),old=guard.begin();let page='connecting';guard.retire();page='login';if(old())page='chat';if(old())page='retry';assert.equal(page,'login');
});
test('new login has its own bootstrap owner while the old initialization remains retired',()=>{
 const guard=createBootstrapSessionGuard(),old=guard.begin();guard.retire();const fresh=guard.begin();assert.equal(old(),false);assert.equal(fresh(),true);const replacement=guard.begin();assert.equal(fresh(),false);assert.equal(replacement(),true);
});
