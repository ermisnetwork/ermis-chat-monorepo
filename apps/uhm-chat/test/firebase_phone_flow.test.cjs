const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
function fixture(configured = true) {
  let pending, clears = 0, signouts = 0, confirms = 0;
  const rendered = new WeakSet();
  const children = new Set();
  const container = {
    ownerDocument: {createElement: () => ({remove() {children.delete(this)}})},
    appendChild(node) {children.add(node)},
  };
  const source = fs.readFileSync(require.resolve('../src/utils/firebasePhone.ts'), 'utf8')
    .replaceAll('import.meta.env', 'runtimeEnv');
  const env = configured ? {VITE_FIREBASE_API_KEY:'test-key',VITE_FIREBASE_AUTH_DOMAIN:'auth.example',VITE_FIREBASE_PROJECT_ID:'fixture',VITE_FIREBASE_APP_ID:'fixture-app'} : {};
  const code = ts.transpileModule('const runtimeEnv = '+JSON.stringify(env)+';\n'+source,
    {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const exports = {};
  const auth = {
    getAuth: () => ({}),
    RecaptchaVerifier: class {
      constructor(_auth, node) {
        if (rendered.has(node)) throw new Error('reCAPTCHA has already been rendered in this element');
        rendered.add(node);
      }
      clear() { clears++; }
    },
    signInWithPhoneNumber: () => new Promise(resolve => { pending = resolve; }),
    signOut: async () => { signouts++; },
  };
  new Function('require','exports',code)(name => name === '@firebase/auth' ? auth : {
    getApps: () => [], initializeApp: () => ({}), getApp: () => ({}),
  },exports);
  return {
    challenge: new exports.FirebasePhoneChallenge(),
    container,
    errorKey: exports.firebasePhoneErrorKey,
    childCount: () => children.size,
    resolve: () => pending({confirm: async () => { confirms++; return {user:{getIdToken:async ()=>'fixture-proof'}}; }}),
    counts: () => ({clears,signouts,confirms}),
  };
}
test('phone verification obtains proof and releases verifier/session after exchange',async () => {
  const f=fixture(), send=f.challenge.send('+84900000000',f.container); f.resolve();await send;
  assert.equal(await f.challenge.verify('fixture-code'),'fixture-proof');
  await f.challenge.finish();assert.equal(f.counts().confirms,1);assert.equal(f.counts().signouts,1);assert.ok(f.counts().clears>0);
  await assert.rejects(f.challenge.verify('fixture-code'));
});
test('cancel rejects a late SMS challenge callback',async () => {
  const f=fixture(),send=f.challenge.send('+84900000000',f.container);f.challenge.clear();f.resolve();
  await assert.rejects(send,/hủy/);await assert.rejects(f.challenge.verify('fixture-code'));
});
test('resend supersedes old challenge without accepting stale confirmation',async () => {
  const f=fixture(),first=f.challenge.send('+84900000000',f.container);const oldResolve=f.resolve;
  // Resolve old send before issuing next challenge, then cancel via resend.
  oldResolve();await first;
  const second=f.challenge.send('+84900000001',f.container);
  await assert.rejects(f.challenge.verify('fixture-code'));
  f.resolve();await second;assert.equal(await f.challenge.verify('fixture-code'),'fixture-proof');
});
test('missing Firebase Web configuration fails before requesting SMS',async () => {
  const f=fixture(false);await assert.rejects(f.challenge.send('+84900000000',f.container),/chưa được cấu hình/);
  assert.equal(f.counts().confirms,0);
});

test('same React container supports back/change-phone/resend without re-rendering one widget element', async () => {
  const f=fixture();
  for (let i=0;i<3;i++) {
    const send=f.challenge.send('+84900000000',f.container);f.resolve();await send;
    assert.equal(f.childCount(),1);
    f.challenge.clear();assert.equal(f.childCount(),0);
  }
});

test('Firebase service failures are distinguished from invalid/expired codes', () => {
  const f=fixture();
  for(const code of ['auth/network-request-failed','auth/quota-exceeded','auth/invalid-app-credential','auth/invalid-api-key']) {
    assert.equal(f.errorKey({code}),'phone_service_unavailable');
  }
  assert.equal(f.errorKey({code:'auth/too-many-requests'}),'phone_rate_limited');
  assert.equal(f.errorKey({code:'auth/invalid-verification-code'}),'wrong_otp');
  assert.equal(f.errorKey({code:'auth/code-expired'}),'phone_otp_expired');
  assert.equal(f.errorKey(new Error('unclassified')),undefined);
});
