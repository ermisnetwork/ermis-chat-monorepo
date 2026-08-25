const assert = require('node:assert/strict');
const test = require('node:test');

const { ErmisChat } = require('../dist/index.cjs');

let harnessCounter = 0;

function createHarness() {
  harnessCounter += 1;
  const suffix = `${process.pid}-${harnessCounter}`;
  const client = ErmisChat.getInstance(
    `delete-api-${suffix}`,
    `delete-project-${suffix}`,
    'https://chat.example.test',
    { browser: false },
  );
  client.userID = 'me';
  client.user = { id: 'me', name: 'Me' };

  const storedMessages = new Map();
  const deletedIds = [];
  const savedIds = [];
  const storage = {
    loadMessage: async (messageId) => storedMessages.get(messageId) || null,
    deleteMessage: async (messageId) => {
      deletedIds.push(messageId);
      storedMessages.delete(messageId);
    },
    saveMessage: async (message) => {
      savedIds.push(message.id);
      storedMessages.set(message.id, message);
    },
  };
  client.encryptionManager = { initialized: true, storage };

  let persistedSyncState = 0;
  client.persistSyncState = async () => {
    persistedSyncState += 1;
  };

  const channel = client.channel('messaging', `delete-${suffix}`);
  channel.data = {
    cid: channel.cid,
    id: channel.id,
    type: channel.type,
    mls_enabled: true,
  };
  channel.initialized = true;

  const message = {
    id: `message-${suffix}`,
    cid: channel.cid,
    msg_seq: 17,
    type: 'regular',
    content_type: 'standard',
    text: 'decrypted secret',
    created_at: new Date().toISOString(),
    user: { id: 'me', name: 'Me' },
    user_id: 'me',
  };
  storedMessages.set(message.id, message);
  channel.state.addMessageSorted(message);
  savedIds.length = 0;

  return {
    channel,
    client,
    deletedIds,
    message,
    savedIds,
    storage,
    storedMessages,
    getPersistedSyncState: () => persistedSyncState,
  };
}

function waitForMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

function assertLocalTombstone(harness) {
  const tombstone = harness.channel.state.findMessage(harness.message.id);
  assert.ok(tombstone);
  assert.equal(tombstone.type, 'deleted');
  assert.equal(tombstone.display_type, 'deleted');
  assert.equal(tombstone.text, '');
  assert.deepEqual(tombstone.attachments, []);
  assert.equal(harness.channel.state.hiddenMessageSeqs.has(harness.message.msg_seq), true);
  assert.equal(harness.channel.state.unavailableMessageIds.has(harness.message.id), false);
  return tombstone;
}

test('E2EE delete-for-everyone removes plaintext immediately and survives reload hydration', async () => {
  const harness = createHarness();
  const events = [];
  let resolveDelete;
  harness.client.delete = () =>
    new Promise((resolve) => {
      resolveDelete = resolve;
    });
  harness.channel.on('message.deleted', (event) => events.push(event));

  const deletion = harness.channel.deleteMessage(harness.message.id);
  await waitForMicrotasks();

  assert.equal(harness.channel.state.findMessage(harness.message.id), undefined);
  assert.equal(harness.channel.state.hiddenMessageSeqs.has(harness.message.msg_seq), true);
  assert.equal(harness.channel.state.unavailableMessageIds.has(harness.message.id), true);
  assert.equal(harness.storedMessages.has(harness.message.id), false);
  assert.deepEqual(harness.deletedIds, [harness.message.id]);
  assert.equal(events.length, 1);
  assert.equal(events[0].hard_delete, true);

  resolveDelete({ message: { id: harness.message.id } });
  await deletion;

  const reloadedChannel = harness.client.channel('messaging', `reload-${harnessCounter}`);
  reloadedChannel.data = {
    cid: reloadedChannel.cid,
    id: reloadedChannel.id,
    type: reloadedChannel.type,
    mls_enabled: true,
  };
  reloadedChannel.state.hiddenMessageSeqs.add(harness.message.msg_seq);
  reloadedChannel.state.addMessageSorted({
    ...harness.message,
    cid: reloadedChannel.cid,
    content_type: 'mls',
    text: '',
  });
  assert.equal(reloadedChannel.state.findMessage(harness.message.id), undefined);
  assert.ok(harness.getPersistedSyncState() >= 1);
});

test('E2EE delete-for-me immediately replaces plaintext with a persisted local tombstone', async () => {
  const harness = createHarness();
  const events = [];
  harness.client.delete = async () => ({ message: { id: harness.message.id } });
  harness.channel.on('message.deleted_for_me', (event) => events.push(event));

  await harness.channel.deleteMessageForMe(harness.message.id);

  const tombstone = assertLocalTombstone(harness);
  assert.equal(harness.deletedIds.length, 0);
  assert.equal(harness.storedMessages.get(harness.message.id)?.display_type, 'deleted');
  assert.equal(harness.storedMessages.get(harness.message.id)?.text, '');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'message.deleted_for_me');
  assert.equal(events[0].message.id, tombstone.id);
});

test('E2EE delete-for-me restores a cache-only message as a tombstone in ChannelState', async () => {
  const harness = createHarness();
  harness.channel.state.removeMessage({ id: harness.message.id }, { persist: false });
  harness.client.delete = async () => ({ message: { id: harness.message.id } });

  await harness.channel.deleteMessageForMe(harness.message.id);

  assertLocalTombstone(harness);
  assert.equal(harness.storedMessages.get(harness.message.id)?.display_type, 'deleted');
});

test('failed E2EE delete-for-me rolls the plaintext state and cache back', async () => {
  const harness = createHarness();
  const events = [];
  harness.client.delete = async () => {
    throw new Error('delete failed');
  };
  harness.channel.on('message.updated', (event) => events.push(event));

  await assert.rejects(harness.channel.deleteMessageForMe(harness.message.id), /delete failed/);

  assert.equal(harness.channel.state.findMessage(harness.message.id)?.text, 'decrypted secret');
  assert.equal(harness.channel.state.hiddenMessageSeqs.has(harness.message.msg_seq), false);
  assert.equal(harness.channel.state.unavailableMessageIds.has(harness.message.id), false);
  assert.equal(harness.storedMessages.get(harness.message.id)?.text, 'decrypted secret');
  assert.ok(harness.savedIds.length >= 2);
  assert.equal(events.length, 1);
});

test('a newer remote hard deletion prevents a failed optimistic request from resurrecting plaintext', async () => {
  const harness = createHarness();
  let rejectDelete;
  harness.client.delete = () =>
    new Promise((_resolve, reject) => {
      rejectDelete = reject;
    });

  const deletion = harness.channel.deleteMessageForMe(harness.message.id);
  await waitForMicrotasks();

  await harness.channel._handleChannelEvent({
    type: 'message.deleted',
    cid: harness.channel.cid,
    message_id: harness.message.id,
    hard_delete: true,
    created_at: new Date().toISOString(),
  });
  rejectDelete(new Error('local request failed after remote delete'));
  await assert.rejects(deletion, /local request failed after remote delete/);

  assert.equal(harness.channel.state.findMessage(harness.message.id), undefined);
  assert.equal(harness.channel.state.unavailableMessageIds.has(harness.message.id), true);
  assert.equal(harness.storedMessages.has(harness.message.id), false);
});

test('minimal realtime delete-for-everyone event removes E2EE plaintext and cache', async () => {
  const harness = createHarness();

  await harness.channel._handleChannelEvent({
    type: 'message.deleted',
    cid: harness.channel.cid,
    message_id: harness.message.id,
    hard_delete: true,
    created_at: new Date().toISOString(),
  });

  assert.equal(harness.channel.state.findMessage(harness.message.id), undefined);
  assert.equal(harness.channel.state.hiddenMessageSeqs.has(harness.message.msg_seq), true);
  assert.equal(harness.storedMessages.has(harness.message.id), false);
});

test('minimal realtime delete-for-me event keeps a safe E2EE tombstone', async () => {
  const harness = createHarness();

  await harness.channel._handleChannelEvent({
    type: 'message.deleted_for_me',
    cid: harness.channel.cid,
    message_id: harness.message.id,
    created_at: new Date().toISOString(),
  });

  assertLocalTombstone(harness);
  assert.equal(harness.storedMessages.get(harness.message.id)?.display_type, 'deleted');
});

test('a later soft confirmation does not replace a local delete-for-me tombstone with plaintext', async () => {
  const harness = createHarness();
  harness.client.delete = async () => ({ message: { id: harness.message.id } });

  await harness.channel.deleteMessageForMe(harness.message.id);
  await harness.channel._handleChannelEvent({
    type: 'message.deleted',
    cid: harness.channel.cid,
    message: {
      ...harness.message,
      type: 'deleted',
      display_type: 'deleted',
      text: '',
    },
    created_at: new Date().toISOString(),
  });

  assertLocalTombstone(harness);
});

test('hidden plaintext stays suppressed after reload while its local tombstone remains visible', () => {
  const harness = createHarness();
  harness.channel.state.removeMessage({ id: harness.message.id }, { persist: false });
  harness.channel.state.hiddenMessageSeqs.add(harness.message.msg_seq);

  harness.channel.state.addMessageSorted(harness.message);
  assert.equal(harness.channel.state.findMessage(harness.message.id), undefined);

  harness.channel.state.addMessageSorted({
    ...harness.message,
    type: 'deleted',
    display_type: 'deleted',
    text: '',
    attachments: [],
  });
  assertLocalTombstone(harness);
});

test('standard delete-for-me also persists and renders a local tombstone', async () => {
  const harness = createHarness();
  harness.channel.data.mls_enabled = false;
  harness.client.messageStorage = harness.storage;
  harness.client.delete = async () => ({ message: { id: harness.message.id } });

  await harness.channel.deleteMessageForMe(harness.message.id);

  assertLocalTombstone(harness);
  assert.equal(harness.storedMessages.get(harness.message.id)?.display_type, 'deleted');
});

test('delete-for-me handles a React-only E2EE message immediately using the UI fallback', async () => {
  const harness = createHarness();
  const events = [];
  let resolveDelete;
  harness.channel.state.removeMessage({ id: harness.message.id }, { persist: false });
  harness.storedMessages.delete(harness.message.id);
  harness.client.delete = () =>
    new Promise((resolve) => {
      resolveDelete = resolve;
    });
  harness.channel.on('message.deleted_for_me', (event) => events.push(event));

  const deletion = harness.channel.deleteMessageForMe(harness.message.id, harness.message);
  await waitForMicrotasks();

  assertLocalTombstone(harness);
  assert.equal(events.length, 1);
  assert.equal(events[0].message.display_type, 'deleted');
  assert.equal(harness.storedMessages.get(harness.message.id)?.display_type, 'deleted');

  resolveDelete({ message: { id: harness.message.id } });
  await deletion;
});

test('delete-for-everyone removes a regular message even when realtime omits hard_delete', async () => {
  const harness = createHarness();

  await harness.channel._handleChannelEvent({
    type: 'message.deleted',
    cid: harness.channel.cid,
    message: {
      ...harness.message,
      type: 'deleted',
      display_type: 'deleted',
      text: '',
    },
    created_at: new Date().toISOString(),
  });

  assert.equal(harness.channel.state.findMessage(harness.message.id), undefined);
  assert.equal(harness.channel.state.unavailableMessageIds.has(harness.message.id), true);
  assert.equal(harness.storedMessages.has(harness.message.id), false);
});

test('E2EE reload hydration overlays the server ciphertext with the local delete-for-me tombstone', async () => {
  const harness = createHarness();
  harness.client.delete = async () => ({ message: { id: harness.message.id } });
  await harness.channel.deleteMessageForMe(harness.message.id);

  const reloadedChannel = harness.client.channel('messaging', `reload-for-me-${harnessCounter}`);
  reloadedChannel.data = {
    cid: reloadedChannel.cid,
    id: reloadedChannel.id,
    type: reloadedChannel.type,
    mls_enabled: true,
  };
  reloadedChannel.state.hiddenMessageSeqs.add(harness.message.msg_seq);

  const hydrated = await reloadedChannel._hydrateE2eeMessagesFromLocalCache([
    {
      ...harness.message,
      cid: reloadedChannel.cid,
      content_type: 'mls',
      text: '',
      mls_ciphertext: 'server-ciphertext',
    },
  ]);

  assert.equal(hydrated.length, 1);
  assert.equal(hydrated[0].display_type, 'deleted');
  assert.equal(hydrated[0].text, '');
  assert.equal(hydrated[0].mls_ciphertext, undefined);
  reloadedChannel.state.addMessagesSorted(hydrated);
  assert.equal(reloadedChannel.state.findMessage(harness.message.id)?.display_type, 'deleted');
});

test('delete-for-me keeps a repaired message tombstoned when msg_seq is missing and repair republishes late', async () => {
  const harness = createHarness();
  const legacyCacheWrites = [];
  harness.client.messageStorage = {
    saveMessage: async (message) => legacyCacheWrites.push(message),
    loadMessage: async () => null,
  };
  const repairedMessage = {
    ...harness.message,
    content_type: 'standard',
    text: 'plaintext restored by repair',
    isRestored: true,
    restoredFrom: 'epoch_archive',
  };
  delete repairedMessage.msg_seq;

  harness.channel.state.removeMessage({ id: harness.message.id }, { persist: false });
  harness.storedMessages.set(harness.message.id, repairedMessage);
  harness.channel.state.addMessageSorted(repairedMessage);
  await waitForMicrotasks();
  assert.equal(legacyCacheWrites.length, 0);

  harness.client.delete = async () => ({ message: { id: harness.message.id } });
  await harness.channel.deleteMessageForMe(harness.message.id, repairedMessage);
  const deletedMessage = harness.channel.state.findMessage(harness.message.id);
  assert.equal(deletedMessage?.display_type, 'deleted');
  assert.equal(deletedMessage?.text, '');
  assert.equal(harness.channel.state.locallyDeletedMessageIds.has(harness.message.id), true);

  harness.channel.state.addMessageSorted({
    ...repairedMessage,
    text: 'late repaired plaintext',
  });

  const tombstone = harness.channel.state.findMessage(harness.message.id);
  assert.equal(tombstone?.display_type, 'deleted');
  assert.equal(tombstone?.text, '');
});
