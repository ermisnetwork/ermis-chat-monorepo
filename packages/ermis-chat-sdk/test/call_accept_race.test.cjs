const assert = require('node:assert/strict');
const test = require('node:test');

const { CallAction, CallStatus, ErmisCallNode } = require('../dist/index.cjs');

function createCallNodeHarness() {
  const node = Object.create(ErmisCallNode.prototype);
  Object.assign(node, {
    acceptPromise: null,
    callLifecycleId: 1,
    callStatus: CallStatus.RINGING,
    cid: 'messaging:test',
    connectionTimeoutMs: 50,
    connectionWaiters: new Set(),
    healthCallServerInterval: null,
    isDestroyed: false,
    lastMediaErrorCode: 'call_media_error',
    localStream: null,
    metadata: { address: 'peer-address' },
    missCallTimeout: null,
    callType: 'audio',
  });
  return node;
}

function createStream() {
  return {
    getTracks: () => [],
    getAudioTracks: () => [],
    getVideoTracks: () => [],
  };
}

test('accept waits for media permission and transport readiness before signaling once', async () => {
  const node = createCallNodeHarness();
  const events = [];
  let resolvePermission;
  const permission = new Promise((resolve) => {
    resolvePermission = resolve;
  });

  node.startLocalStream = async () => {
    events.push('permission:requested');
    const stream = await permission;
    node.localStream = stream;
    events.push('permission:granted');
    return stream;
  };
  node.initialize = async () => {
    events.push('transport:ready');
    node.mediaSender = {
      connect: async () => events.push('transport:connected'),
      initEncoders: () => events.push('encoders:ready'),
      sendConfigs: async () => {
        events.push('configs:sent');
        queueMicrotask(() => node.setCallStatus(CallStatus.CONNECTED));
      },
    };
    node.mediaReceiver = {
      initDecoders: () => events.push('decoders:ready'),
    };
    return {};
  };
  node._sendSignal = async ({ action }) => events.push(`signal:${action}`);

  const firstAccept = node.acceptCall();
  const secondAccept = node.acceptCall();
  assert.strictEqual(firstAccept, secondAccept);

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['permission:requested']);

  resolvePermission(createStream());
  await firstAccept;

  assert.equal(events.filter((event) => event === `signal:${CallAction.ACCEPT_CALL}`).length, 1);
  assert.deepEqual(events, [
    'permission:requested',
    'permission:granted',
    'transport:ready',
    `signal:${CallAction.ACCEPT_CALL}`,
    'transport:connected',
    'encoders:ready',
    'decoders:ready',
    'configs:sent',
  ]);
});

test('permission denial never signals accept and reports a recoverable error', async () => {
  const node = createCallNodeHarness();
  const signals = [];
  const errors = [];
  let cleanupCalls = 0;

  node.lastMediaErrorCode = 'call_permission_denied';
  node.startLocalStream = async () => null;
  node._sendSignal = async ({ action }) => signals.push(action);
  node.cleanupCall = async () => {
    cleanupCalls += 1;
    node.callLifecycleId += 1;
  };
  node.onError = (error) => errors.push(error);

  await assert.rejects(node.acceptCall(), /call_permission_denied/);

  assert.equal(signals.includes(CallAction.ACCEPT_CALL), false);
  assert.deepEqual(signals, []);
  assert.equal(cleanupCalls, 0);
  assert.equal(node.callStatus, CallStatus.RINGING);
  assert.deepEqual(errors, ['call_permission_denied']);
});

test('accept can be retried after permission is granted', async () => {
  const node = createCallNodeHarness();
  const signals = [];
  const errors = [];
  let permissionGranted = false;

  node.startLocalStream = async () => {
    if (!permissionGranted) {
      node.lastMediaErrorCode = 'call_permission_denied';
      return null;
    }
    const stream = createStream();
    node.localStream = stream;
    return stream;
  };
  node.initialize = async () => {
    node.mediaSender = {
      connect: async () => {},
      initEncoders: () => {},
      sendConfigs: async () => queueMicrotask(() => node.setCallStatus(CallStatus.CONNECTED)),
    };
    node.mediaReceiver = { initDecoders: () => {} };
    return {};
  };
  node._sendSignal = async ({ action }) => signals.push(action);
  node.onError = (error) => errors.push(error);

  await assert.rejects(node.acceptCall(), /call_permission_denied/);
  assert.equal(node.callStatus, CallStatus.RINGING);
  assert.deepEqual(signals, []);

  permissionGranted = true;
  await node.acceptCall();

  assert.equal(node.callStatus, CallStatus.CONNECTED);
  assert.deepEqual(signals, [CallAction.ACCEPT_CALL]);
  assert.deepEqual(errors, ['call_permission_denied']);
});
test('accept handshake times out instead of leaving the UI pending forever', async () => {
  const node = createCallNodeHarness();
  const errors = [];
  let cleanupCalls = 0;

  node.connectionTimeoutMs = 5;
  node.localStream = createStream();
  node.initialize = async () => {
    node.mediaSender = {
      connect: async () => {},
      initEncoders: () => {},
      sendConfigs: async () => {},
    };
    node.mediaReceiver = { initDecoders: () => {} };
    return {};
  };
  node._sendSignal = async () => {};
  node.cleanupCall = async () => {
    cleanupCalls += 1;
    node.callLifecycleId += 1;
  };
  node.onError = (error) => errors.push(error);

  await assert.rejects(node.acceptCall(), /call_connection_timeout/);

  assert.equal(cleanupCalls, 1);
  assert.deepEqual(errors, ['call_connection_timeout']);
});
