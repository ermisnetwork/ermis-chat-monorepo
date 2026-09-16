const assert = require('node:assert/strict');
const test = require('node:test');

const { ErmisChat, StableWSConnection, chatCodes } = require('../dist/index.cjs');

const axiosResponse = (data) => ({ data, status: 200, statusText: 'OK', headers: {}, config: {} });

const makeClient = () => {
  const client = new ErmisChat('api-key', 'project-id', 'http://example.test', {
    browser: false,
    logger: () => {},
  });
  client.tokenManager.setTokenOrProvider('access-old', { id: 'user-1' }, 'refresh-old');
  return client;
};

test('refreshAccessToken shares one refresh request and updates token state', async () => {
  const client = makeClient();
  const events = [];
  let calls = 0;

  client.on('auth.token_refreshed', (event) => events.push(event));
  client.refreshNewToken = async (refreshToken) => {
    calls += 1;
    assert.equal(refreshToken, 'refresh-old');
    await new Promise((resolve) => setTimeout(resolve, 10));
    return {
      token: 'access-new',
      refresh_token: 'refresh-new',
      user_id: 'user-1',
      project_id: 'project-id',
    };
  };

  const [first, second] = await Promise.all([client.refreshAccessToken(), client.refreshAccessToken()]);

  assert.equal(calls, 1);
  assert.equal(first.token, 'access-new');
  assert.equal(second.refresh_token, 'refresh-new');
  assert.equal(client.tokenManager.getToken(), 'access-new');
  assert.equal(await client.tokenManager.getRefreshToken(), 'refresh-new');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'auth.token_refreshed');
  assert.equal(events[0].token, 'access-new');
});

test('refreshAccessToken keeps the current refresh token when the backend does not rotate it', async () => {
  const client = makeClient();
  client.refreshNewToken = async () => ({ token: 'access-new' });

  const result = await client.refreshAccessToken();

  assert.equal(result.token, 'access-new');
  assert.equal(client.tokenManager.getToken(), 'access-new');
  assert.equal(await client.tokenManager.getRefreshToken(), 'refresh-old');
});

test('API 401 refreshes access token once and retries with the new Authorization header', async () => {
  const client = makeClient();
  let refreshCalls = 0;
  let getCalls = 0;
  const authorizationHeaders = [];

  client.refreshNewToken = async () => {
    refreshCalls += 1;
    return {
      token: 'access-new',
      refresh_token: 'refresh-new',
      user_id: 'user-1',
      project_id: 'project-id',
    };
  };
  client.axiosInstance.get = async (_url, config) => {
    getCalls += 1;
    authorizationHeaders.push(config.headers.Authorization);
    if (getCalls === 1) {
      const error = new Error('unauthorized');
      error.response = { status: 401, data: {} };
      throw error;
    }
    return {
      data: { ok: true },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    };
  };

  const response = await client.get('http://example.test/protected');

  assert.deepEqual(response, { ok: true });
  assert.equal(refreshCalls, 1);
  assert.equal(getCalls, 2);
  assert.deepEqual(authorizationHeaders, ['Bearer access-old', 'Bearer access-new']);
});

test('legacy API 401 calls the configured refresh endpoint, rotates tokens, and retries once', async () => {
  const persisted = [];
  const client = new ErmisChat({
    apiKey: 'api-key',
    projectId: 'project-id',
    baseURL: 'http://chat.test',
    userBaseURL: 'http://users.test',
    endUserApiMode: 'legacy',
    browser: false,
    logger: () => {},
    onTokenRefresh: (tokens) => persisted.push(tokens),
  });
  client.tokenManager.setTokenOrProvider('access-old', { id: 'user-1' }, 'refresh-old');

  const authorizationHeaders = [];
  let protectedCalls = 0;
  let refreshCalls = 0;
  client.axiosInstance.get = async (_url, config) => {
    protectedCalls += 1;
    authorizationHeaders.push(config.headers.Authorization);
    if (protectedCalls === 1) {
      const error = new Error('expired');
      error.response = { status: 401, data: {} };
      throw error;
    }
    return axiosResponse({ ok: true });
  };
  client.axiosInstance.post = async (url, data, config) => {
    refreshCalls += 1;
    assert.equal(url, 'http://users.test/uss/v1/refresh_token');
    assert.deepEqual(data, { refresh_token: 'refresh-old' });
    assert.equal(config.headers.Authorization, undefined);
    return axiosResponse({
      token: 'access-new',
      refresh_token: 'refresh-new',
      user_id: 'user-1',
    });
  };

  const response = await client.get('http://chat.test/protected');

  assert.deepEqual(response, { ok: true });
  assert.equal(refreshCalls, 1);
  assert.equal(protectedCalls, 2);
  assert.deepEqual(authorizationHeaders, ['Bearer access-old', 'Bearer access-new']);
  assert.equal(client.tokenManager.getToken(), 'access-new');
  assert.equal(await client.tokenManager.getRefreshToken(), 'refresh-new');
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].token, 'access-new');
  assert.equal(persisted[0].refresh_token, 'refresh-new');
});

test('API logs omit request payloads, credentials, identities, and raw errors', async () => {
  const entries = [];
  const client = new ErmisChat('private-api-key-sentinel', 'project-id', 'http://example.test', {
    browser: false,
    logger: (level, message, extra) => entries.push({ level, message, extra }),
  });
  client.tokenManager.setTokenOrProvider('private-access-token-sentinel', { id: 'private-user-sentinel' });
  client.deviceId = 'private-device-sentinel';
  client.axiosInstance.post = async (_url, _data, config) => {
    const error = new Error('private-raw-error-sentinel');
    error.config = config;
    error.response = {
      status: 503,
      data: { error: 'private-response-sentinel' },
    };
    throw error;
  };

  await assert.rejects(() =>
    client.post('http://example.test/v1/e2ee/scope_sync?api_key=private-query-sentinel', {
      cid: 'private-cid-sentinel',
      mls_bytes: 'private-mls-sentinel',
    }),
  );

  const output = JSON.stringify(entries);
  for (const sentinel of [
    'private-api-key-sentinel',
    'private-access-token-sentinel',
    'private-user-sentinel',
    'private-device-sentinel',
    'private-query-sentinel',
    'private-raw-error-sentinel',
    'private-response-sentinel',
    'private-cid-sentinel',
    'private-mls-sentinel',
  ]) {
    assert.equal(output.includes(sentinel), false, `log contained ${sentinel}`);
  }
  assert.match(output, /REDACTED/);
  assert.match(output, /"category":"response"/);
  assert.match(output, /"status":503/);
});

test('API 403 and TOKEN_EXPIRED codes share the same one-retry refresh path', async () => {
  for (const response of [
    { status: 403, data: {} },
    { status: 400, data: { code: String(chatCodes.TOKEN_EXPIRED) } },
    { status: 400, data: { code: 'TOKEN_EXPIRED' } },
  ]) {
    const client = makeClient();
    let calls = 0;
    let refreshCalls = 0;
    client.refreshNewToken = async () => {
      refreshCalls += 1;
      return { token: 'access-new', refresh_token: 'refresh-new' };
    };
    client.axiosInstance.get = async (_url, config) => {
      calls += 1;
      if (calls === 1) {
        const error = new Error('expired');
        error.response = response;
        throw error;
      }
      return axiosResponse({ authorization: config.headers.Authorization });
    };

    const result = await client.get('http://example.test/protected');
    assert.equal(result.authorization, 'Bearer access-new');
    assert.equal(refreshCalls, 1);
    assert.equal(calls, 2);
  }
});

test('refresh failure dispatches auth.refresh_failed and does not retry refresh endpoint', async () => {
  const client = makeClient();
  const events = [];
  let calls = 0;

  client.on('auth.refresh_failed', (event) => events.push(event));
  client.refreshNewToken = async () => {
    calls += 1;
    const error = new Error('refresh expired');
    error.response = { status: 401, data: {} };
    throw error;
  };

  await assert.rejects(client.refreshAccessToken(), /refresh expired/);

  assert.equal(calls, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'auth.refresh_failed');
  assert.equal(events[0].status, 401);
});

test('active websocket close 4001 reconnects with token refresh', () => {
  const connection = new StableWSConnection({
    client: {
      logger: () => {},
    },
  });
  let reconnectOptions;

  connection.wsID = 7;
  connection.isResolved = true;
  connection._setHealth = () => {};
  connection._reconnect = (options) => {
    reconnectOptions = options;
  };

  connection.onclose(7, {
    code: chatCodes.WS_TOKEN_EXPIRED,
    reason: 'JWT Expire',
  });

  assert.deepEqual(reconnectOptions, { interval: 0, refreshToken: true });
});

test('initial websocket handshake retries once with a refreshed token after close 4001', async () => {
  let connectCalls = 0;
  let refreshCalls = 0;
  const connection = new StableWSConnection({
    client: {
      logger: () => {},
      refreshAccessToken: async () => {
        refreshCalls += 1;
      },
    },
  });

  connection._connect = async () => {
    connectCalls += 1;
    if (connectCalls === 1) {
      const error = new Error('WS failed with code 4001 and reason - JWT Expire');
      error.code = chatCodes.WS_TOKEN_EXPIRED;
      throw error;
    }
    return { type: 'health.check' };
  };
  connection._waitForHealthy = async () => ({ type: 'health.check' });

  await connection.connect();

  assert.equal(refreshCalls, 1);
  assert.equal(connectCalls, 2);
});
