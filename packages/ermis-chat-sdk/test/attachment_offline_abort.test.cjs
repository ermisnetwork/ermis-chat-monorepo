const assert = require('node:assert/strict');
const test = require('node:test');

const { EncryptionManager, ErmisChat } = require('../dist/index.cjs');

let harnessCounter = 0;

function createClient(label) {
  harnessCounter += 1;
  const suffix = `${process.pid}-${harnessCounter}`;
  const client = ErmisChat.getInstance(
    `${label}-api-${suffix}`,
    `${label}-project-${suffix}`,
    'https://chat.example.test',
    { browser: false },
  );
  client.userID = 'offline-user';
  client.user = { id: 'offline-user' };
  return { client, suffix };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('connection loss pauses a standard attachment upload and resumes it with the same presign session', async () => {
  const previousXhr = global.XMLHttpRequest;
  const xhrInstances = [];

  class ResumableXMLHttpRequest {
    constructor() {
      this.upload = {};
      this.status = 0;
      this.aborted = false;
      xhrInstances.push(this);
    }

    open(_method, url) {
      this.url = url;
    }
    setRequestHeader() {}
    send(body) {
      this.body = body;
      if (xhrInstances.length === 1) return;
      this.upload.onprogress?.({ loaded: body.size });
      this.status = 200;
      this.onload?.();
    }
    abort() {
      this.aborted = true;
      this.onabort?.();
    }
  }
  let resolveConfirm;
  const confirmPromise = new Promise((resolve) => {
    resolveConfirm = resolve;
  });

  global.XMLHttpRequest = ResumableXMLHttpRequest;
  const { client, suffix } = createClient('standard-offline');
  const deletedIds = [];
  let presignCount = 0;
  client.messageStorage = {
    saveMessage: async () => {},
    deleteMessage: async (messageId) => deletedIds.push(messageId),
  };
  client.post = async (url, payload) => {
    if (url.endsWith('/file/presign')) {
      presignCount += 1;
      return {
        attachment_id: 'offline-standard-attachment',
        upload_mode: 'single',
        upload_url: 'https://storage.example.test/offline-standard',
        ttl_secs: 900,
      };
    }
    if (url.endsWith('/file/confirm')) {
      return await confirmPromise;
    }
    if (url.endsWith('/message')) {
      return {
        message: {
          ...payload.message,
          status: 'received',
          user: { id: 'offline-user' },
          created_at: new Date().toISOString(),
        },
      };
    }
    throw new Error(`Unexpected POST ${url}`);
  };
  const channel = client.channel('messaging', `standard-offline-${suffix}`);

  try {
    const file = new File([new Uint8Array(16)], 'offline.png', { type: 'image/png' });
    const result = await channel.enqueueAttachmentMessage({ text: 'cancel me' }, [file]);
    const messageId = result.message.id;
    await flush();
    assert.equal(xhrInstances.length, 1);
    client.dispatchEvent({ type: 'connection.changed', online: false });
    await flush();

    assert.equal(xhrInstances[0].aborted, true);
    assert.equal(channel.state.findMessage(messageId).status, 'failed_offline');
    assert.equal(channel.state.findMessage(messageId).attachments[0].upload_status, 'paused');
    assert.deepEqual(deletedIds, []);

    client.dispatchEvent({ type: 'connection.changed', online: true });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await flush();
      if (xhrInstances.length === 2) break;
    }
    assert.equal(channel.state.findMessage(messageId).attachments[0].upload_progress, 99);
    resolveConfirm({ file: 'https://cdn.example.test/offline.png' });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await flush();
      if (channel.state.findMessage(messageId)?.status === 'received') break;
    }

    assert.equal(xhrInstances.length, 2);
    assert.equal(xhrInstances[1].url, 'https://storage.example.test/offline-standard');
    assert.equal(presignCount, 1);
    assert.equal(channel.state.findMessage(messageId).status, 'received');
  } finally {
    if (previousXhr === undefined) delete global.XMLHttpRequest;
    else global.XMLHttpRequest = previousXhr;
  }
});

test('multipart resume uploads only missing parts while ttl is valid', async () => {
  const previousXhr = global.XMLHttpRequest;
  const xhrInstances = [];

  class MultipartXMLHttpRequest {
    constructor() {
      this.upload = {};
      this.status = 0;
      this.aborted = false;
      xhrInstances.push(this);
    }

    open(_method, url) {
      this.url = url;
    }
    setRequestHeader() {}
    getResponseHeader(name) {
      return name.toLowerCase() === 'etag' ? this.etag : null;
    }
    send(body) {
      this.body = body;
      const sameUrlAttempts = xhrInstances.filter((xhr) => xhr.url === this.url).length;
      if (this.url.endsWith('/part-2') && sameUrlAttempts === 1) return;
      this.upload.onprogress?.({ loaded: body.size });
      this.etag = this.url.endsWith('/part-1') ? '"etag-one"' : '"etag-two"';
      this.status = 200;
      this.onload?.();
    }
    abort() {
      this.aborted = true;
      this.onabort?.();
    }
  }

  global.XMLHttpRequest = MultipartXMLHttpRequest;
  const { client, suffix } = createClient('multipart-resume');
  let presignCount = 0;
  let confirmPayload;
  client.post = async (url, payload) => {
    if (url.endsWith('/file/presign')) {
      presignCount += 1;
      return {
        attachment_id: 'multipart-attachment',
        upload_mode: 'multipart',
        ttl_secs: 900,
        multipart: {
          upload_id: 'multipart-upload-id',
          part_size: 4,
          part_count: 2,
          parts: [
            { part_number: 1, upload_url: 'https://storage.example.test/part-1' },
            { part_number: 2, upload_url: 'https://storage.example.test/part-2' },
          ],
        },
      };
    }
    if (url.endsWith('/file/confirm')) {
      confirmPayload = payload;
      return { file: 'https://cdn.example.test/multipart.bin' };
    }
    if (url.endsWith('/message')) {
      return {
        message: {
          ...payload.message,
          status: 'received',
          user: { id: 'offline-user' },
          created_at: new Date().toISOString(),
        },
      };
    }
    throw new Error(`Unexpected POST ${url}`);
  };
  const channel = client.channel('messaging', `multipart-resume-${suffix}`);

  try {
    const file = new File([new Uint8Array(8)], 'large.bin', { type: 'application/octet-stream' });
    const result = await channel.enqueueAttachmentMessage({ text: 'resume parts' }, [file]);
    const messageId = result.message.id;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await flush();
      if (xhrInstances.length === 2) break;
    }

    client.dispatchEvent({ type: 'connection.changed', online: false });
    await flush();
    assert.equal(xhrInstances.find((xhr) => xhr.url.endsWith('/part-2')).aborted, true);
    assert.ok(channel.state.findMessage(messageId));

    client.dispatchEvent({ type: 'connection.changed', online: true });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await flush();
      if (channel.state.findMessage(messageId)?.status === 'received') break;
    }

    assert.equal(presignCount, 1);
    assert.equal(xhrInstances.filter((xhr) => xhr.url.endsWith('/part-1')).length, 1);
    assert.equal(xhrInstances.filter((xhr) => xhr.url.endsWith('/part-2')).length, 2);
    assert.deepEqual(confirmPayload.parts, [
      { part_number: 1, etag: '"etag-one"' },
      { part_number: 2, etag: '"etag-two"' },
    ]);
    assert.equal(channel.state.findMessage(messageId).status, 'received');
  } finally {
    if (previousXhr === undefined) delete global.XMLHttpRequest;
    else global.XMLHttpRequest = previousXhr;
  }
});

test('connection loss preserves Khoa E2EE pending work and reconnect invokes its resume queue', async () => {
  const { client, suffix } = createClient('e2ee-offline');
  const canceledIds = [];
  let resumeCount = 0;
  client.encryptionManager = {
    initialized: true,
    enqueueE2eeAttachmentMessage: async () => ({}),
    cancelPendingE2eeSend: async (messageId) => canceledIds.push(messageId),
    resumePendingE2eeSends: async () => {
      resumeCount += 1;
    },
  };
  const channel = client.channel('messaging', `e2ee-offline-${suffix}`);
  channel.data = { cid: channel.cid, id: channel.id, type: channel.type, mls_enabled: true };
  channel.initialized = true;

  const file = new File([new Uint8Array(16)], 'offline-secret.png', { type: 'image/png' });
  const result = await channel.enqueueAttachmentMessage({ text: 'cancel secret' }, [file]);
  const messageId = result.message.id;

  assert.ok(channel.state.findMessage(messageId));
  client.dispatchEvent({ type: 'connection.changed', online: false });

  assert.ok(channel.state.findMessage(messageId));
  await flush();
  assert.deepEqual(canceledIds, []);
  client.dispatchEvent({ type: 'connection.changed', online: true });
  await flush();
  assert.equal(resumeCount, 1);
});

test('Khoa E2EE resume queue restarts interrupted uploads and final send records', async () => {
  const interrupted = {
    message_id: 'interrupted-upload',
    cid: 'messaging:reload',
    channel_type: 'messaging',
    channel_id: 'reload',
    text: 'not uploaded',
    files: [new Blob([new Uint8Array(4)])],
    status: 'uploading',
  };
  const readyToSend = {
    message_id: 'ready-to-send',
    cid: 'messaging:reload',
    e2ee_group_id: 'messaging:reload',
    channel_type: 'messaging',
    channel_id: 'reload',
    text: 'already encrypted',
    files: [new Blob([new Uint8Array(4)])],
    status: 'sending',
    mls_ciphertext: 'ciphertext',
    mls_epoch: 7,
  };
  const deletedPendingIds = [];
  const deletedMessageIds = [];
  const resumedIds = [];
  const manager = new EncryptionManager();
  manager.storage = {
    listPendingE2eeSends: async () => [interrupted, readyToSend],
    deletePendingE2eeSend: async (messageId) => deletedPendingIds.push(messageId),
    deleteMessage: async (messageId) => deletedMessageIds.push(messageId),
  };
  manager._processQueuedE2eeAttachmentMessage = async (record) => resumedIds.push(record.message_id);

  await manager.resumePendingE2eeSends();
  await flush();

  assert.deepEqual(deletedPendingIds, []);
  assert.deepEqual(deletedMessageIds, []);
  assert.deepEqual(resumedIds, ['interrupted-upload', 'ready-to-send']);
});

test('F5 restore keeps the last persisted E2EE display progress and reconnect callbacks', async () => {
  const { client, suffix } = createClient('e2ee-reload-ui');
  const channelId = `e2ee-reload-ui-${suffix}`;
  const channel = client.channel('messaging', channelId);
  const messageId = `pending-${suffix}`;
  const record = {
    message_id: messageId,
    cid: channel.cid,
    e2ee_group_id: channel.cid,
    channel_type: 'messaging',
    channel_id: channelId,
    text: 'durable secret',
    files: [new File([new Uint8Array(8)], 'durable.png', { type: 'image/png' })],
    aad_metadata: { local_created_at: new Date().toISOString() },
    retry_count: 0,
    status: 'uploading',
    local_progress: 87,
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  const manager = new EncryptionManager();
  manager.client = client;
  client.encryptionManager = manager;
  manager.storage = {
    listPendingE2eeSends: async () => [record],
  };
  let resumedParams;
  manager._processQueuedE2eeAttachmentMessage = async (_record, liveParams) => {
    resumedParams = liveParams;
  };

  await manager.resumePendingE2eeSends();
  await flush();

  const restored = channel.state.findMessage(messageId);
  assert.ok(restored);
  assert.equal(restored.status, 'sending');
  assert.equal(restored.attachments[0].upload_progress, 87);
  assert.ok(resumedParams);

  resumedParams.onProgress({
    fileIndex: 0,
    phase: 'uploading',
    loaded: 6,
    total: 8,
    percentage: 75,
  });
  resumedParams.onProgress({
    fileIndex: 0,
    phase: 'uploading',
    loaded: 1,
    total: 8,
    percentage: 12,
  });
  assert.equal(channel.state.findMessage(messageId).attachments[0].upload_progress, 87);
  resumedParams.onProgress({
    fileIndex: 0,
    phase: 'uploading',
    loaded: 7,
    total: 8,
    percentage: 91,
  });
  assert.equal(channel.state.findMessage(messageId).attachments[0].upload_progress, 91);

  resumedParams.onSuccess({
    message: {
      id: messageId,
      cid: channel.cid,
      content_type: 'standard',
      text: 'durable secret',
      attachments: [],
      user: { id: client.userID },
      created_at: new Date().toISOString(),
    },
  });
  assert.equal(channel.state.findMessage(messageId).status, 'received');
});

test('channels.queried replays pending E2EE display progress without restarting the upload job', async () => {
  const { client, suffix } = createClient('e2ee-late-progress-replay');
  const channelId = `e2ee-late-progress-replay-${suffix}`;
  const channel = client.channel('messaging', channelId);
  const messageId = `pending-replay-${suffix}`;
  const baseRecord = {
    message_id: messageId,
    cid: channel.cid,
    e2ee_group_id: channel.cid,
    channel_type: 'messaging',
    channel_id: channelId,
    text: 'late progress replay',
    files: [new File([new Uint8Array(8)], 'replay.png', { type: 'image/png' })],
    retry_count: 0,
    status: 'uploading',
    local_progress: 0,
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  channel.restorePendingE2eeAttachmentUpload(baseRecord);
  const originalLocalAttachment =
    channel._pendingE2eeAttachmentSends.get(messageId).localAttachments[0];
  const replayRecord = { ...baseRecord, local_progress: 47 };
  const manager = new EncryptionManager();
  manager.client = client;
  manager.storage = {
    listPendingE2eeSends: async () => [replayRecord],
    loadPendingE2eeSend: async () => replayRecord,
  };
  let processedJobs = 0;
  manager._processQueuedE2eeAttachmentMessage = async () => {
    processedJobs += 1;
  };
  const restorePresentations = manager._restorePendingE2eeAttachmentPresentations.bind(manager);
  let replayPromise;
  manager._restorePendingE2eeAttachmentPresentations = () => {
    replayPromise = restorePresentations();
    return replayPromise;
  };
  manager._registerKnownChannelBootstrapListener();
  const replayedPercentages = [];
  const eventSub = channel.on('message.updated', (event) => {
    if (event.message?.id === messageId) {
      replayedPercentages.push(event.message.attachments?.[0]?.upload_progress);
    }
  });

  client.dispatchEvent({ type: 'channels.queried' });
  await flush();
  assert.ok(replayPromise);
  await replayPromise;

  assert.equal(channel.state.findMessage(messageId).attachments[0].upload_progress, 47);
  assert.equal(processedJobs, 0);
  assert.equal(
    channel._pendingE2eeAttachmentSends.get(messageId).localAttachments[0],
    originalLocalAttachment,
  );
  assert.equal(replayedPercentages[replayedPercentages.length - 1], 47);
  eventSub.unsubscribe?.();
  manager._channelBootstrapSub?.unsubscribe?.();
});

test('failed E2EE final send retries persisted MLS ciphertext without re-uploading files', async () => {
  const messageId = 'failed-final-send';
  const record = {
    message_id: messageId,
    cid: 'messaging:retry-ciphertext',
    e2ee_group_id: 'messaging:retry-ciphertext',
    channel_type: 'messaging',
    channel_id: 'retry-ciphertext',
    text: 'already encrypted',
    mls_ciphertext: new Uint8Array([1, 2, 3]),
    mls_epoch: 9,
    retry_count: 1,
    status: 'failed_retryable',
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  const deleted = [];
  let sent = 0;
  const stored = [];
  const manager = new EncryptionManager();
  const progress = [];
  const savedPending = [];
  manager.e2eeClient = {
    sendMessage: async () => {
      sent += 1;
      return { message: { id: messageId, content_type: 'mls' } };
    },
  };
  manager.storage = {
    deletePendingE2eeSend: async (id) => deleted.push(id),
    savePendingE2eeSend: async (pending) => savedPending.push(pending),
    saveMessage: async (message) => stored.push(message),
  };
  manager.uploadE2eeAttachments = async () => {
    throw new Error('upload must not run for persisted ciphertext');
  };

  await manager._processQueuedE2eeAttachmentMessage(record, {
    onProgress: (event) => progress.push(event.percentage),
  });

  assert.equal(sent, 1);
  assert.deepEqual(deleted, [messageId]);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].content_type, 'standard');
  assert.deepEqual(progress, [99]);
  assert.equal(savedPending[0].local_progress, 99);
});

test('F5 restore keeps display progress while multipart resumes from durable completed parts', async () => {
  const { client, suffix } = createClient('e2ee-reload-checkpoint-ui');
  const channelId = `e2ee-reload-checkpoint-ui-${suffix}`;
  const channel = client.channel('messaging', channelId);
  const messageId = `pending-checkpoint-${suffix}`;
  const file = new File([new Uint8Array(8)], 'durable.bin', {
    type: 'application/octet-stream',
    lastModified: 123,
  });
  const uploadExpiresAt = '2030-01-01T00:00:00.000Z';
  const record = {
    message_id: messageId,
    cid: channel.cid,
    e2ee_group_id: channel.cid,
    channel_type: 'messaging',
    channel_id: channelId,
    text: 'durable multipart progress',
    files: [file],
    aad_metadata: { local_created_at: new Date().toISOString() },
    attachment_upload_checkpoints: [{
      version: 1,
      file: { name: file.name, size: file.size, type: file.type, last_modified: file.lastModified },
      attachment_id: 'durable-attachment',
      upload_expires_at: uploadExpiresAt,
      init: {
        attachment_id: 'durable-attachment',
        upload_expires_at: uploadExpiresAt,
        assets: [{
          asset_id: 'durable-original',
          kind: 'original',
          upload_mode: 'multipart',
          multipart: {
            multipart_upload_id: 'durable-upload',
            part_size: 16,
            part_count: 2,
            parts: [
              { part_number: 1, put_url: 'https://storage.example.test/part-1' },
              { part_number: 2, put_url: 'https://storage.example.test/part-2' },
            ],
          },
        }],
      },
      original: {
        content_key: Buffer.alloc(32).toString('base64'),
        nonce_prefix: Buffer.alloc(8).toString('base64'),
        frame_size: 256 * 1024,
        completed_parts: [{ part_number: 1, etag: 'etag-1' }],
      },
      completion_lease_id: 'durable-lease',
    }],
    retry_count: 0,
    status: 'uploading',
    local_progress: 95,
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  const manager = new EncryptionManager();
  manager.client = client;
  client.encryptionManager = manager;
  manager.storage = { listPendingE2eeSends: async () => [record] };
  manager._processQueuedE2eeAttachmentMessage = async () => {};

  await manager.resumePendingE2eeSends();
  await flush();

  assert.equal(channel.state.findMessage(messageId).attachments[0].upload_progress, 95);

  let latestRecord = record;
  const processingManager = new EncryptionManager();
  processingManager.storage = {
    savePendingE2eeSend: async (pending) => { latestRecord = pending; },
    loadPendingE2eeSend: async () => latestRecord,
  };
  processingManager.uploadE2eeAttachments = async (_channelType, _channelId, _files, options) => {
    options.onProgress({
      fileIndex: 0,
      phase: 'encrypting',
      loaded: 1,
      total: file.size,
      percentage: 39,
    });
    options.onProgress({
      fileIndex: 0,
      phase: 'uploading',
      loaded: file.size,
      total: file.size,
      percentage: 96,
    });
    throw new Error('stop after resumed progress');
  };
  await processingManager._processQueuedE2eeAttachmentMessage(record, {
    onProgress: (progress) => channel.updatePendingE2eeAttachmentUpload(messageId, progress),
  });

  assert.equal(channel.state.findMessage(messageId).attachments[0].upload_progress, 96);
});

test('F5 restore shows 99% when the E2EE attachment manifest is already durable', () => {
  const { client, suffix } = createClient('e2ee-reload-manifest-ui');
  const channelId = `e2ee-reload-manifest-ui-${suffix}`;
  const channel = client.channel('messaging', channelId);
  const messageId = `pending-manifest-${suffix}`;
  channel.restorePendingE2eeAttachmentUpload({
    message_id: messageId,
    cid: channel.cid,
    e2ee_group_id: channel.cid,
    channel_type: 'messaging',
    channel_id: channelId,
    text: 'manifest already uploaded',
    files: [new File([new Uint8Array(8)], 'uploaded.bin')],
    manifest: [{ attachment_id: 'uploaded-attachment', version: 1, assets: [] }],
    e2ee_attachment_ids: ['uploaded-attachment'],
    retry_count: 0,
    status: 'sending',
    local_progress: 0,
    created_at: Date.now(),
    updated_at: Date.now(),
  });

  assert.equal(channel.state.findMessage(messageId).attachments[0].upload_progress, 99);
});
