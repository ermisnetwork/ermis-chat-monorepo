const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  Channel,
  END_USER_V1_UNSUPPORTED_EXTERNAL_AUTH,
  END_USER_V1_UNSUPPORTED_LISTING,
  END_USER_V1_UNSUPPORTED_SSE,
  END_USER_V1_UNSUPPORTED_WALLET,
  ErmisAuthProvider,
  ErmisChat,
  adaptEndUserV1AuthResponse,
  normalizeEndUserV1BaseURL,
} = require('../dist/index.cjs');

function axiosResponse(data) {
  return {
    data,
    status: 200,
    statusText: 'OK',
    headers: {},
    config: {},
  };
}

function jwtWithPayload(payload) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

async function makeClient(token = 'user-token') {
  const client = new ErmisChat({
    baseURL: 'https://chat.example.test',
    userBaseURL: 'https://users.example.test/uss/v1',
    selfHosted: true,
    browser: false,
  });
  client.userID = 'me';
  client.user = { id: 'me', name: 'Me' };
  await client.tokenManager.setTokenOrProvider(token, { id: 'me' });
  return client;
}

test('normalizes end-user v1 base URLs without rewriting future versions', () => {
  assert.equal(normalizeEndUserV1BaseURL('https://api.ermis.network/'), 'https://api.ermis.network/v1');
  assert.equal(normalizeEndUserV1BaseURL('https://api.ermis.network/v1/'), 'https://api.ermis.network/v1');
  assert.equal(normalizeEndUserV1BaseURL('https://api.ermis.network/uss/v1/'), 'https://api.ermis.network/v1');
  assert.equal(normalizeEndUserV1BaseURL('https://api.ermis.network:8080/v1'), 'https://api.ermis.network:8080/v1');
  assert.equal(normalizeEndUserV1BaseURL('https://api.ermis.network/v2'), 'https://api.ermis.network/v2');
});

test('auth provider sends v1 auth bodies without apikey and adds compatibility aliases', async () => {
  const auth = new ErmisAuthProvider({
    apiKey: 'legacy-api-key',
    baseURL: 'https://api.example.test/uss/v1',
    selfHosted: true,
  });
  const calls = [];
  auth.axiosInstance.post = async (url, data, config) => {
    calls.push({ url, data, config });
    return axiosResponse({ access_token: 'access-token', refresh_token: 'refresh-token', user_id: 'user-1' });
  };

  const otp = await auth.sendOtpToPhone('+84900000000', 'Sms');
  await auth.sendOtpToEmail('user@example.test');
  const verified = await auth.verifyOtp('123456');
  await auth.loginWithGoogle('google-token');

  assert.deepEqual(
    calls.map((call) => call.url),
    [
      'https://api.example.test/v1/auth/otp/request',
      'https://api.example.test/v1/auth/otp/request',
      'https://api.example.test/v1/auth/otp/verify',
      'https://api.example.test/v1/auth/google',
    ],
  );
  assert.deepEqual(calls[0].data, { identifier: '+84900000000', language: 'en', method: 'sms' });
  assert.deepEqual(calls[1].data, { identifier: 'user@example.test', language: 'en', method: 'email' });
  assert.deepEqual(calls[2].data, { identifier: 'user@example.test', otp: '123456' });
  assert.deepEqual(calls[3].data, { token: 'google-token' });
  assert.equal('apikey' in calls[0].data, false);
  assert.equal(otp.success, true);
  assert.equal(verified.token, 'access-token');
  assert.equal(verified.user_id, 'user-1');
});

test('auth adapter falls back to JWT payload for top-level user_id', () => {
  const token = jwtWithPayload({ sub: 'jwt-user' });
  const response = adaptEndUserV1AuthResponse({ access_token: token });
  assert.equal(response.success, true);
  assert.equal(response.token, token);
  assert.equal(response.user_id, 'jwt-user');
});

test('refreshNewToken uses /auth/refresh without Bearer auth', async () => {
  const client = await makeClient('old-token');
  let call;
  client.axiosInstance.post = async (url, data, config) => {
    call = { url, data, config };
    return axiosResponse({ access_token: 'new-token', refresh_token: 'new-refresh', user_id: 'me' });
  };

  const response = await client.refreshNewToken('refresh-token');

  assert.equal(call.url, 'https://users.example.test/v1/auth/refresh');
  assert.deepEqual(call.data, { refresh_token: 'refresh-token' });
  assert.equal(call.config.headers.Authorization, undefined);
  assert.equal(response.success, true);
  assert.equal(response.token, 'new-token');
});

test('authenticated requests refresh expired access token and retry once', async () => {
  let storedRefreshToken = 'refresh-token';
  const refreshedTokens = [];
  const client = new ErmisChat({
    baseURL: 'https://chat.example.test',
    userBaseURL: 'https://users.example.test/v1',
    selfHosted: true,
    browser: false,
    refreshToken: () => storedRefreshToken,
    onTokenRefresh: (tokens) => {
      refreshedTokens.push(tokens);
      storedRefreshToken = tokens.refresh_token || storedRefreshToken;
    },
  });
  client.userID = 'me';
  client.user = { id: 'me', name: 'Me' };
  await client.tokenManager.setTokenOrProvider('old-token', { id: 'me' }, () => storedRefreshToken);

  const getCalls = [];
  const refreshCalls = [];
  client.axiosInstance.get = async (url, config) => {
    getCalls.push({ url, config });
    if (getCalls.length === 1) {
      const error = new Error('access token expired');
      error.response = {
        data: { code: 40, message: 'token expired' },
        status: 401,
        statusText: 'Unauthorized',
        headers: {},
        config: {},
      };
      throw error;
    }
    return axiosResponse({ ok: true });
  };
  client.axiosInstance.post = async (url, data, config) => {
    refreshCalls.push({ url, data, config });
    return axiosResponse({ access_token: 'new-token', refresh_token: 'refresh-token-2', user_id: 'me' });
  };

  const response = await client.get('https://chat.example.test/protected');

  assert.deepEqual(response, { ok: true });
  assert.equal(getCalls.length, 2);
  assert.equal(refreshCalls.length, 1);
  assert.equal(refreshCalls[0].url, 'https://users.example.test/v1/auth/refresh');
  assert.deepEqual(refreshCalls[0].data, { refresh_token: 'refresh-token' });
  assert.equal(refreshCalls[0].config.headers.Authorization, undefined);
  assert.equal(getCalls[0].config.headers.Authorization, 'Bearer old-token');
  assert.equal(getCalls[1].config.headers.Authorization, 'Bearer new-token');
  assert.equal(refreshedTokens[0].token, 'new-token');
  assert.equal(storedRefreshToken, 'refresh-token-2');
});

test('queryUser uses Bearer auth, no project_id, and normalizes v1 user fields', async () => {
  const client = await makeClient();
  let call;
  client.axiosInstance.get = async (url, config) => {
    call = { url, config };
    return axiosResponse({
      id: 'user-1',
      display_name: 'Alice',
      avatar_url: 'https://cdn.example.test/alice.png',
      status: 'online',
      services: ['chat'],
    });
  };

  const user = await client.queryUser('user-1');

  assert.equal(call.url, 'https://users.example.test/v1/users/user-1');
  assert.equal(call.config.headers.Authorization, 'Bearer user-token');
  assert.equal(call.config.params.project_id, undefined);
  assert.equal(user.name, 'Alice');
  assert.equal(user.avatar, 'https://cdn.example.test/alice.png');
  assert.equal(user.display_name, 'Alice');
  assert.equal(user.avatar_url, 'https://cdn.example.test/alice.png');
  assert.deepEqual(user.services, ['chat']);
  assert.equal(client.state.users['user-1'].name, 'Alice');
});

test('getBatchUsers de-dupes IDs, chunks by 100, and omits project_id', async () => {
  const client = await makeClient();
  const ids = Array.from({ length: 205 }, (_, index) => `user-${index + 1}`);
  const calls = [];
  client.axiosInstance.post = async (url, data, config) => {
    calls.push({ url, data, config });
    return axiosResponse(data.user_ids.map((id) => ({ id, display_name: id.toUpperCase() })));
  };

  const users = await client.getBatchUsers([...ids, ids[0]]);

  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map((call) => call.data.user_ids.length),
    [100, 100, 5],
  );
  assert.equal(
    calls.every((call) => call.url === 'https://users.example.test/v1/users/batch'),
    true,
  );
  assert.equal(
    calls.every((call) => call.config.headers.Authorization === 'Bearer user-token'),
    true,
  );
  assert.equal(
    calls.some((call) => 'project_id' in call.data),
    false,
  );
  assert.equal(users.length, 205);
  assert.equal(users[0].name, 'USER-1');
});

test('searchUsers supports preferred and legacy overloads with limit cap', async () => {
  const client = await makeClient();
  const calls = [];
  client.axiosInstance.get = async (url, config) => {
    calls.push({ url, config });
    return axiosResponse([{ id: 'user-search', display_name: 'Search User' }]);
  };

  const preferred = await client.searchUsers(' search text ', 150);
  const legacy = await client.searchUsers(9, 25, 'legacy text');
  const empty = await client.searchUsers('', 25);

  assert.equal(preferred.data[0].name, 'Search User');
  assert.deepEqual(calls[0].config.params, { q: 'search text', limit: 100 });
  assert.deepEqual(calls[1].config.params, { q: 'legacy text', limit: 25 });
  assert.equal(calls.length, 2);
  assert.deepEqual(empty.data, []);
  assert.equal(legacy.page, 1);
});

test('updateProfile maps v1 profile fields and rejects about_me', async () => {
  const client = await makeClient();
  let call;
  client.axiosInstance.patch = async (url, data, config) => {
    call = { url, data, config };
    return axiosResponse({ id: 'me', display_name: data.display_name, avatar_url: data.avatar_url });
  };

  const user = await client.updateProfile({ name: 'Renamed', avatar: 'https://cdn.example.test/me.png' });

  assert.equal(call.url, 'https://users.example.test/v1/users/me');
  assert.deepEqual(call.data, { display_name: 'Renamed', avatar_url: 'https://cdn.example.test/me.png' });
  assert.equal(call.config.headers.Authorization, 'Bearer user-token');
  assert.equal(user.name, 'Renamed');
  await assert.rejects(() => client.updateProfile({ about_me: 'unsupported' }), /about_me/);
});

test('uploadAvatar posts multipart form to /users/me/avatar and normalizes full user response', async () => {
  const client = await makeClient();
  let call;
  client.axiosInstance.postForm = async (url, data, config) => {
    call = { url, data, config };
    return axiosResponse({ id: 'me', display_name: 'Avatar User', avatar_url: 'https://cdn.example.test/avatar.png' });
  };

  const file = new Blob(['avatar-bytes'], { type: 'image/png' });
  const user = await client.uploadAvatar(file);

  assert.equal(call.url, 'https://users.example.test/v1/users/me/avatar');
  assert.equal(call.config.headers.Authorization, 'Bearer user-token');
  assert.equal(typeof call.data.get, 'function');
  assert.equal(user.name, 'Avatar User');
  assert.equal(user.avatar, 'https://cdn.example.test/avatar.png');
});

test('legacy unrestricted listing, SSE, external auth, and wallet flows throw explicit v1 errors', async () => {
  const client = await makeClient();
  const auth = new ErmisAuthProvider({ baseURL: 'https://api.example.test/v1', selfHosted: true });

  await assert.rejects(() => client.queryUsers(), { message: END_USER_V1_UNSUPPORTED_LISTING });
  await assert.rejects(() => client.syncUserCache(), { message: END_USER_V1_UNSUPPORTED_LISTING });
  await assert.rejects(() => client.connectToSSE(), { message: END_USER_V1_UNSUPPORTED_SSE });
  await assert.rejects(() => client.getExternalAuthToken({ id: 'me' }, 'token'), {
    message: END_USER_V1_UNSUPPORTED_EXTERNAL_AUTH,
  });
  await assert.rejects(() => client.connectUser({ id: 'other' }, 'token', true), {
    message: END_USER_V1_UNSUPPORTED_EXTERNAL_AUTH,
  });
  await assert.rejects(() => auth.getWalletChallenge('0x0'), { message: END_USER_V1_UNSUPPORTED_WALLET });
  await assert.rejects(() => auth.verifyWalletSignature('signature'), { message: END_USER_V1_UNSUPPORTED_WALLET });
});

test('acceptInvite maps accept and join to chat API invite routes', async () => {
  const client = await makeClient();
  const channel = new Channel(client, 'messaging', 'channel-1', {});
  const calls = [];
  client.post = async (url) => {
    calls.push(url);
    return { success: true };
  };

  await channel.acceptInvite('accept');
  await channel.acceptInvite('join');

  assert.deepEqual(calls, [
    'https://chat.example.test/invites/messaging/channel-1/accept',
    'https://chat.example.test/invites/messaging/channel-1/join',
  ]);
});

test('React UserPicker stays search-driven for end-user v1', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../ermis-chat-react/src/components/UserPicker.tsx'), 'utf8');

  assert.equal(source.includes('queryUsers('), false);
  assert.equal(source.includes('loadMore'), false);
  assert.equal(source.includes('onScroll='), false);
  assert.equal(source.includes('client.searchUsers(search.trim(), pageSize)'), true);
  assert.equal(source.includes('Object.values(client.state.users || {})'), true);
});
