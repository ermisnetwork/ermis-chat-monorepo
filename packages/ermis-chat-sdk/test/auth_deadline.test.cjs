const test = require('node:test');
const assert = require('node:assert/strict');
const {ErmisChat, EncryptionApiClient} = require('../dist/index.cjs');
const ok = data => ({status: 200, data, headers: {}, config: {}});
const never = () => new Promise(() => {});
function client() {
  const c = new ErmisChat('fixture-key', 'fixture-project', 'http://example.test', {browser: false, logger: () => {}});
  c._setUser({id: 'owner'}); c.deviceId = 'device';
  c.tokenManager.setTokenOrProvider('old-access', {id: 'owner'}, 'fixture-refresh');
  return c;
}
const deadline = e => e.code === 'key_package_ownership_deadline';
test('both transports retain timeout, signal and body limits', async () => {
  const c = client(), signal = new AbortController().signal;
  c.axiosInstance.post = async (_url, _data, config) => {
    assert.ok(config.timeout > 0 && config.timeout <= 123); assert.equal(config.signal, signal);
    assert.equal(config.maxBodyLength, 2048); assert.equal(config.maxContentLength, 1024);
    return ok({ok: true});
  };
  const options = {timeout: 123, signal, maxBodyLength: 2048, maxContentLength: 1024};
  await c.doAxiosRequest('post', 'http://example.test/protected', {}, options);
  await c._doPublicEndUserRequest('post', 'http://example.test/public', {}, options);
});
for (const stage of ['provider', 'http']) test(`shared refresh bounds hung ${stage} and ignores late token completion`, {timeout: 6500}, async () => {
  const c = client(); let release, http = 0, refreshed = 0;
  const gate = new Promise(resolve => {release = resolve;});
  c.on('auth.token_refreshed', () => {refreshed++;});
  if (stage === 'provider') c.tokenManager.getRefreshToken = () => gate;
  c.refreshNewToken = async () => {http++; return stage === 'http' ? gate : {token: 'late-token'};};
  await assert.rejects(c.refreshAccessToken(), e => e.code === 'auth_refresh_timeout');
  assert.equal(c.refreshTokenPromise, null); release(stage === 'provider' ? 'late-refresh' : {token: 'late-token'});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(c.tokenManager.token, 'old-access'); assert.equal(refreshed, 0); assert.equal(http, stage === 'provider' ? 0 : 1);
});
test('canceling one auth waiter preserves a coalesced refresh for its live peer', async () => {
  const c = client(), controller = new AbortController(); let release, calls = 0, refreshes = 0;
  const gate = new Promise(resolve => {release = resolve;});
  c.refreshNewToken = async () => {refreshes++; return gate;};
  c.axiosInstance.get = async (_url, config) => {
    calls++; if (config.headers.Authorization === 'Bearer old-access') throw Object.assign(Error('expired'), {response: {status: 401, data: {}}});
    return ok({ok: true});
  };
  const canceled = c.doAxiosRequest('get', 'http://example.test/a', null, {signal: controller.signal});
  const rejected = assert.rejects(canceled, deadline);
  const live = c.doAxiosRequest('get', 'http://example.test/b');
  await new Promise(resolve => setImmediate(resolve)); controller.abort(); await rejected;
  release({token: 'fresh'}); assert.deepEqual(await live, {ok: true});
  assert.equal(refreshes, 1); assert.equal(calls, 3);
});
for (const phase of ['token', 'proof', 'guard', 'transport', 'refresh']) test(`whole deadline bounds hung ${phase} without late retry`, {timeout: 1000}, async () => {
  const c = client(); let calls = 0;
  const options = {__mlsDeadline: Date.now() + 30};
  if (phase === 'token') c.tokenManager.tokenReady = never;
  if (phase === 'proof') options.__mlsRequestProof = never;
  if (phase === 'guard') options.__mlsRequestGuard = never;
  if (phase === 'refresh') c.refreshAccessToken = never;
  c.axiosInstance.post = async () => { calls++;
    if (phase === 'refresh') throw Object.assign(Error('expired'), {response: {status: 401, data: {}}});
    return never();
  };
  await assert.rejects(c.doAxiosRequest('post', 'http://example.test/protected', {}, options), deadline);
  assert.equal(calls, ['transport', 'refresh'].includes(phase) ? 1 : 0);
});
test('cancellation interrupts proof wait and never sends HTTP', {timeout: 1000}, async () => {
  const c = client(), controller = new AbortController(); let calls = 0;
  c.axiosInstance.post = async () => {calls++; return ok({});};
  const work = c.doAxiosRequest('post', 'http://example.test/protected', {}, {signal: controller.signal, __mlsRequestProof: never});
  const rejected = assert.rejects(work, deadline); controller.abort(); await rejected; assert.equal(calls, 0);
});
test('MLS registration and proof6 retry expired auth once with exact intent and bytes', async () => {
  const c = client(), id = '00000000-0000-4000-8000-000000000001', bodies = [], proofs = [];
  let refreshed = 0, register = 0, uploads = 0;
  c.refreshNewToken = async () => {refreshed++; return {token: 'fresh-' + refreshed};};
  const identity = {signature_public_key: () => new Uint8Array([1]), device_registration_signature: () => new Uint8Array([2]), lor_request_signature: () => new Uint8Array([3])};
  const api = new EncryptionApiClient(c, () => ({identity, userId: 'owner', projectId: 'fixture-project', deviceId: 'device', assertCurrent() {}, assertRegistrationCurrent() {}, async verifyDurable() {}}));
  c.axiosInstance.post = async (url, body, config) => {
    if (url.endsWith('/register')) {
      if (++register === 1) throw Object.assign(Error('expired'), {response: {status: 401, data: {}}});
      assert.equal(config.timeout > 0 && config.timeout <= 2000, true);
      return ok({registration: {active: true, registration_id: id, generation: 0, device_id: 'device'}});
    }
    bodies.push(body); proofs.push(JSON.parse(Buffer.from(config.headers['X-Ermis-MLS-Proof'], 'base64url')).context);
    if (++uploads === 1) throw Object.assign(Error('expired'), {response: {status: 401, data: {}}});
    assert.equal(config.headers.Authorization, 'Bearer fresh-2'); return ok({ok: true});
  };
  await api.uploadKeyPackages({key_packages: [new Uint8Array([4, 5])]}, id);
  assert.equal(refreshed, 2); assert.equal(register, 2); assert.equal(uploads, 2);
  assert.equal(bodies[0], bodies[1]); assert.equal(proofs[0].request_id, id); assert.equal(proofs[1].request_id, id);
  assert.equal(proofs[0].body_sha256, proofs[1].body_sha256);
});
