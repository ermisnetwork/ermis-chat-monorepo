const assert = require('node:assert/strict');
const test = require('node:test');

const { ErmisAuthProvider, ErmisChat, UnsupportedEndUserFeatureError } = require('../dist/index.cjs');

function axiosResponse(data) {
  return { data, status: 200, statusText: 'OK', headers: {}, config: {} };
}

async function authenticatedClient(options = {}) {
  const client = new ErmisChat('api-key', 'project-id', 'https://chat.example.test', {
    browser: false,
    ...options,
  });
  client.userID = 'me';
  client.user = { id: 'me' };
  await client.tokenManager.setTokenOrProvider('access-token', { id: 'me' }, 'refresh-token');
  return client;
}

test('end-user mode defaults to legacy and explicit mode overrides it', () => {
  const cloud = new ErmisChat('key', 'project', 'https://chat.example.test', { browser: false });
  const selfHosted = new ErmisChat({ baseURL: 'https://chat.example.test', selfHosted: true, browser: false });
  const selfHostedLegacy = new ErmisChat({
    baseURL: 'https://chat.example.test',
    selfHosted: true,
    endUserApiMode: 'legacy',
    browser: false,
  });
  const cloudV1 = new ErmisChat('key', 'project', 'https://chat.example.test', {
    endUserApiMode: 'v1',
    browser: false,
  });

  assert.equal(cloud.endUserApiMode, 'legacy');
  assert.equal(selfHosted.endUserApiMode, 'legacy');
  assert.equal(selfHostedLegacy.endUserApiMode, 'legacy');
  assert.equal(cloudV1.endUserApiMode, 'v1');
  assert.throws(
    () => new ErmisChat('key', 'project', 'https://chat.example.test', { endUserApiMode: 'future', browser: false }),
    /Invalid endUserApiMode/,
  );
});

test('legacy auth adapter preserves OTP endpoints and payloads', async () => {
  const auth = new ErmisAuthProvider('legacy-key', 'https://users.example.test', {
    endUserApiMode: 'legacy',
    browser: false,
  });
  const calls = [];
  auth.axiosInstance.post = async (url, data) => {
    calls.push({ url, data });
    return axiosResponse({ success: true, token: 'token', refresh_token: 'refresh' });
  };

  await auth.sendOtpToPhone('+84900000000', 'Sms');
  await auth.sendOtpToEmail('user@example.test');
  await auth.verifyOtp('123456');
  await auth.loginWithGoogle('google-token');

  assert.deepEqual(
    calls.map((call) => call.url),
    [
      'https://users.example.test/uss/v1/auth/get_otp_new',
      'https://users.example.test/uss/v1/auth/get_otp_new',
      'https://users.example.test/uss/v1/auth/otp_login',
      'https://users.example.test/uss/v1/auth/google_login',
    ],
  );
  assert.equal(calls[0].data.apikey, 'legacy-key');
  assert.equal(calls[0].data.method, 'Sms');
  assert.equal(calls[2].data.method, 'Email');
});

test('legacy userBaseURL always includes the USS v1 prefix without duplicating it', () => {
  const auth = new ErmisAuthProvider('legacy-key', 'https://chat.example.test', {
    endUserApiMode: 'legacy',
    userBaseURL: 'https://users.example.test',
    browser: false,
  });
  const prefixedAuth = new ErmisAuthProvider('legacy-key', 'https://chat.example.test', {
    endUserApiMode: 'legacy',
    userBaseURL: 'https://users.example.test/uss/v1',
    browser: false,
  });

  assert.equal(auth.baseURL, 'https://users.example.test/uss/v1');
  assert.equal(prefixedAuth.baseURL, 'https://users.example.test/uss/v1');
});

test('legacy client adapter preserves refresh and user request contracts', async () => {
  const client = await authenticatedClient({ endUserApiMode: 'legacy' });
  const calls = [];
  client.axiosInstance.post = async (url, data, config) => {
    calls.push({ method: 'post', url, data, config });
    if (url.endsWith('/refresh_token')) {
      return axiosResponse({ token: 'new-token', refresh_token: 'new-refresh', user_id: 'me' });
    }
    if (url.includes('/users/batch')) {
      return axiosResponse({ data: [{ id: 'user-1', name: 'Alice' }], count: 1, total: 1, page: 1, page_count: 1 });
    }
    return axiosResponse({ data: [{ id: 'user-1', name: 'Alice' }], count: 1, total: 1, page: 1, page_count: 1 });
  };
  client.axiosInstance.get = async (url, config) => {
    calls.push({ method: 'get', url, config });
    return axiosResponse({ id: 'user-1', name: 'Alice' });
  };

  await client.refreshNewToken('refresh-token');
  await client.queryUser('user-1');
  await client.getBatchUsers(['user-1'], 2, 25);
  await client.searchUsers(2, 25, 'Alice');

  assert.equal(calls[0].url, 'https://chat.example.test/uss/v1/refresh_token');
  assert.equal(calls[0].config.headers.Authorization, undefined);
  assert.equal(calls[1].config.params.project_id, 'project-id');
  assert.deepEqual(calls[2].data, { users: ['user-1'], project_id: 'project-id' });
  assert.deepEqual(calls[3].config.params, { page: 2, page_size: 25, name: 'Alice', project_id: 'project-id' });
});

test('v1 unsupported capabilities expose a stable typed error', async () => {
  const client = await authenticatedClient({ endUserApiMode: 'v1' });
  const auth = new ErmisAuthProvider({
    baseURL: 'https://chat.example.test',
    selfHosted: true,
    endUserApiMode: 'v1',
    browser: false,
  });
  const cases = [
    [() => client.queryUsers(), 'unrestricted_listing'],
    [() => client.connectToSSE(), 'sse'],
    [() => client.connectUser({ id: 'other' }, 'token', { externalAuth: true }), 'external_auth'],
    [() => client.updateProfile({ about_me: 'unsupported' }), 'profile.about_me'],
    [() => auth.getWalletChallenge('0x0'), 'wallet'],
  ];

  for (const [run, feature] of cases) {
    await assert.rejects(
      run,
      (error) =>
        error instanceof UnsupportedEndUserFeatureError &&
        error.code === 'END_USER_FEATURE_UNSUPPORTED' &&
        error.feature === feature &&
        error.endUserApiMode === 'v1',
    );
  }
});

test('user cache namespace includes the end-user API mode', () => {
  const legacy = new ErmisChat('key', 'project', 'https://chat.example.test', {
    browser: true,
    endUserApiMode: 'legacy',
  });
  const v1 = new ErmisChat('key', 'project', 'https://chat.example.test', { browser: true, endUserApiMode: 'v1' });
  legacy.userID = 'me';
  v1.userID = 'me';

  assert.notEqual(legacy._getUserCache().dbName, v1._getUserCache().dbName);
  assert.match(legacy._getUserCache().dbName, /legacy/);
  assert.match(v1._getUserCache().dbName, /v1/);
});
