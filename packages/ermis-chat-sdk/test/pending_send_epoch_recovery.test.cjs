const assert = require('node:assert/strict');
const test = require('node:test');
const { EncryptionManager } = require('../dist/index.cjs');

function harness(extra = {}) {
  const manager = new EncryptionManager();
  const record = {
    message_id: '00000000-0000-4000-8000-000000000001', cid: 'messaging:retained',
    e2ee_group_id: 'messaging:retained', channel_type: 'messaging', channel_id: 'retained',
    text: 'durable text', mls_ciphertext: new Uint8Array([20]), mls_epoch: 20,
    group_generation: 0, retry_count: 1, status: 'failed_retryable',
    created_at: 1, updated_at: 2, ...extra,
  };
  let current = structuredClone(record);
  let epoch = 20;
  const operations = [];
  const requests = [];
  const encryptedPayloads = [];
  const cached = [];
  manager.userId = 'fixture-user';
  manager.client = { user: { id: 'fixture-user' }, state: { users: {} }, activeChannels: {} };
  manager.groups.set(record.e2ee_group_id, { epoch: () => epoch });
  manager._buildFullMessageWithQuoted = async (message) => message;
  manager._recoverEpochStaleGroup = async () => { operations.push('recover'); epoch = 25; return epoch; };
  manager.encryptMessage = (_cid, payload, aad) => {
    operations.push('encrypt'); encryptedPayloads.push({ payload, aad }); return new Uint8Array([epoch]);
  };
  manager._persistProvider = async () => { operations.push('provider'); };
  manager.storage = {
    loadPendingE2eeSend: async () => structuredClone(current),
    savePendingE2eeSend: async (value) => { operations.push(`pending:${value.mls_epoch}:${value.status}`); current = structuredClone(value); },
    deletePendingE2eeSend: async () => { operations.push('delete'); current = null; },
    saveMessage: async (value) => { operations.push('cache'); cached.push(value); },
  };
  manager.e2eeClient = { sendMessage: async (_type, _id, body) => {
    operations.push(`send:${body.message.mls_epoch}`); requests.push(structuredClone(body.message));
    if (body.message.mls_epoch === 20) throw new Error('epoch_stale: message encrypted with epoch 20, current group epoch is 25');
    return { message: { id: body.message.id, created_at: '2026-10-05T02:05:00Z' } };
  } };
  return { manager, record, operations, requests, encryptedPayloads, cached, current: () => current };
}

test('persisted epoch20 send recovers once, saves retry before network and clears only after cache publication', async () => {
  const h = harness({ send_envelope: { parent_id: 'parent', quoted_message_id: 'quote', mentioned_users: ['peer'] } });
  await h.manager._processQueuedE2eeAttachmentMessage(h.record);
  assert.deepEqual(h.requests.map(r => r.mls_epoch), [20, 25]);
  assert.ok(h.requests.every(r => r.id === h.record.message_id));
  assert.equal(h.requests[1].parent_id, 'parent');
  assert.equal(h.requests[1].quoted_message_id, 'quote');
  assert.deepEqual(h.requests[1].mentioned_users, ['peer']);
  assert.ok(h.requests.every(r => !('text' in r) && !('payload' in r)));
  assert.deepEqual(h.operations, ['pending:20:sending', 'send:20', 'recover', 'encrypt', 'provider', 'pending:25:sending', 'send:25', 'cache', 'delete']);
  assert.equal(h.cached[0].text, h.record.text);
  assert.equal(h.current(), null);
});

test('actual Axios HTTP400 generic message uses server epoch_stale response for recovery', async () => {
  const { AxiosError } = require('axios');
  const h = harness();
  h.manager.e2eeClient.sendMessage = async (_t, _i, body) => {
    h.requests.push(structuredClone(body.message));
    if (body.message.mls_epoch === 20) {
      throw new AxiosError('Request failed with status code 400', 'ERR_BAD_REQUEST', undefined, undefined, {
        status: 400,
        data: { ermis_code: 4, message: 'epoch_stale: message encrypted with epoch 20, current group epoch is 25' },
      });
    }
    return { message: { id: body.message.id } };
  };
  await h.manager._processQueuedE2eeAttachmentMessage(h.record);
  assert.deepEqual(h.requests.map(r => r.mls_epoch), [20, 25]);
  assert.equal(h.current(), null);
});

test('Axios HTTP400 with another server reason does not trigger epoch recovery', async () => {
  const { AxiosError } = require('axios');
  const h = harness();
  h.manager.e2eeClient.sendMessage = async (_t, _i, body) => {
    h.requests.push(body.message);
    throw new AxiosError('Request failed with status code 400', 'ERR_BAD_REQUEST', undefined, undefined, {
      status: 400, data: { ermis_code: 4, message: 'invalid message envelope' },
    });
  };
  await h.manager._processQueuedE2eeAttachmentMessage(h.record);
  assert.equal(h.requests.length, 1);
  assert.equal(h.operations.includes('recover'), false);
  assert.equal(h.current().status, 'failed_retryable');
  assert.equal(h.current().last_error, 'invalid message envelope');
});

test('shared Axios classifier also recovers ordinary encrypted send once', async () => {
  const { AxiosError } = require('axios');
  const h = harness();
  h.manager._resolveChannelE2eeGroupId = () => h.record.cid;
  h.manager.e2eeClient.sendMessage = async (_t, _i, body) => {
    h.requests.push(structuredClone(body.message));
    if (body.message.mls_epoch === 20) throw new AxiosError('Request failed with status code 400', 'ERR_BAD_REQUEST', undefined, undefined, {
      status: 400, data: { ermis_code: 4, message: 'epoch_stale: current group epoch is 25' },
    });
    return { message: { id: body.message.id } };
  };
  await h.manager.sendMessage('messaging', 'retained', h.record.cid, 'content', h.record.message_id);
  assert.deepEqual(h.requests.map(r => r.mls_epoch), [20, 25]);
  assert.equal(h.current().status, 'sent');
});

test('durable full payload and attachment/forward AAD survive stale recovery', async () => {
  const asset = '00000000-0000-4000-8000-000000000002';
  const payload = { text: 'content', attachments: [{ version: 1, attachment_id: asset }], sticker_url: 'sticker', poll_type: 'single', poll_choice_counts: { a: 1 }, allow_change_choice: false, poll_closed: true };
  const h = harness({ payload, manifest: payload.attachments, e2ee_attachment_ids: [asset], forward_cid: 'messaging:source', forward_message_id: 'source-message' });
  await h.manager._processQueuedE2eeAttachmentMessage(h.record);
  assert.deepEqual(h.encryptedPayloads[0].payload, payload);
  assert.ok(h.encryptedPayloads[0].aad instanceof Uint8Array);
  const aad = Buffer.from(h.encryptedPayloads[0].aad);
  assert.ok(aad.includes(Buffer.from(h.record.message_id.replaceAll('-', ''), 'hex')));
  assert.ok(aad.includes(Buffer.from(h.record.cid)));
  assert.ok(aad.includes(Buffer.from('source-message')));
  assert.ok(aad.includes(Buffer.from(asset.replaceAll('-', ''), 'hex')));
  assert.deepEqual(h.requests[1].e2ee_attachment_ids, [asset]);
  assert.equal(h.cached[0].sticker_url, 'sticker');
  assert.deepEqual(h.cached[0].poll_choice_counts, { a: 1 });
});

test('a second stale rejection is bounded and retains updated durable retry material', async () => {
  const h = harness();
  h.manager.e2eeClient.sendMessage = async (_t, _i, body) => { h.requests.push(structuredClone(body.message)); throw new Error('epoch_stale: current group epoch is 26'); };
  await h.manager._processQueuedE2eeAttachmentMessage(h.record);
  assert.equal(h.requests.length, 2);
  assert.equal(h.current().mls_epoch, 25);
  assert.deepEqual(h.current().mls_ciphertext, new Uint8Array([25]));
  assert.equal(h.current().status, 'failed_retryable');
  assert.match(h.current().last_error, /epoch_stale/);
  assert.equal(h.cached.length, 0);
  assert.equal(h.operations.includes('delete'), false);
});

test('ambiguous network error keeps exact ciphertext and never re-encrypts or deletes', async () => {
  const h = harness();
  h.manager.e2eeClient.sendMessage = async (_t, _i, body) => { h.requests.push(body.message); throw new Error('network unavailable'); };
  await h.manager._processQueuedE2eeAttachmentMessage(h.record);
  assert.equal(h.requests.length, 1);
  assert.equal(h.encryptedPayloads.length, 0);
  assert.equal(h.operations.includes('recover'), false);
  assert.equal(h.current().mls_epoch, 20);
  assert.deepEqual(h.current().mls_ciphertext, h.record.mls_ciphertext);
  assert.equal(h.current().status, 'failed_retryable');
});

for (const failure of ['recovery', 'provider', 'pending']) {
  test(`${failure} failure prevents retry network request and retains queue`, async () => {
    const h = harness();
    if (failure === 'recovery') h.manager._recoverEpochStaleGroup = async () => { throw new Error('sync unavailable'); };
    if (failure === 'provider') h.manager._persistProvider = async () => { throw new Error('provider unavailable'); };
    if (failure === 'pending') {
      const save = h.manager.storage.savePendingE2eeSend;
      h.manager.storage.savePendingE2eeSend = async r => {
        if (r.mls_epoch === 25) throw new Error('pending unavailable');
        await save(r);
      };
    }
    await h.manager._processQueuedE2eeAttachmentMessage(h.record);
    assert.equal(h.requests.length, 1);
    assert.equal(h.current().mls_epoch, 20);
    assert.equal(h.current().status, 'failed_retryable');
    assert.equal(h.operations.includes('delete'), false);
  });
}

for (const boundary of ['before send', 'after recovery']) {
  test(`generation change ${boundary} fails closed and retains terminal record`, async () => {
    const h = harness();
    if (boundary === 'before send') h.manager._groupGenerations.set(h.record.e2ee_group_id, { group_generation: 1 });
    else {
      h.manager._recoverEpochStaleGroup = async () => { h.manager._groupGenerations.set(h.record.e2ee_group_id, { group_generation: 1 }); return 25; };
    }
    await h.manager._processQueuedE2eeAttachmentMessage(h.record);
    assert.equal(h.requests.length, boundary === 'before send' ? 0 : 1);
    assert.equal(h.encryptedPayloads.length, 0);
    assert.equal(h.current().status, 'failed_terminal');
    assert.equal(h.current().mls_epoch, 20);
  });
}

test('cache write failure after accepted retry retains new bytes for restart and avoids premature deletion', async () => {
  const h = harness();
  h.manager.storage.saveMessage = async () => { throw new Error('cache unavailable'); };
  await h.manager._processQueuedE2eeAttachmentMessage(h.record);
  assert.equal(h.requests.length, 2);
  assert.equal(h.current().mls_epoch, 25);
  assert.equal(h.current().status, 'failed_retryable');
  assert.equal(h.operations.includes('delete'), false);
});

test('actual IndexedDB adapter retains recovered retry through reopen and removes only the confirmed record', async () => {
  require('fake-indexeddb/auto');
  const { IndexedDBEncryptionStorage } = require('../dist/encryption/index.cjs');
  const scope = `pending-epoch-fixture-${process.pid}`;
  let storage = new IndexedDBEncryptionStorage(scope);
  const h = harness({ payload: { text: 'content', sticker_url: 'sticker' } });
  h.manager.storage = storage;
  await storage.savePendingE2eeSend(h.record);
  h.manager.e2eeClient.sendMessage = async (_t, _i, body) => {
    h.requests.push(structuredClone(body.message));
    throw new Error(body.message.mls_epoch === 20 ? 'epoch_stale: current group epoch is 25' : 'network unavailable');
  };
  await h.manager._processQueuedE2eeAttachmentMessage(h.record);
  (await storage.getDB()).close();
  storage = new IndexedDBEncryptionStorage(scope);
  h.manager.storage = storage;
  try {
    const reopened = await storage.loadPendingE2eeSend(h.record.message_id);
    assert.equal(reopened.mls_epoch, 25);
    assert.equal(reopened.status, 'failed_retryable');
    assert.deepEqual(reopened.mls_ciphertext, new Uint8Array([25]));
    assert.deepEqual(reopened.payload, h.record.payload);
    h.manager.e2eeClient.sendMessage = async (_t, _i, body) => {
      h.requests.push(structuredClone(body.message));
      return { message: { id: body.message.id } };
    };
    await h.manager._processQueuedE2eeAttachmentMessage(reopened);
    assert.deepEqual(h.requests.map(r => r.mls_epoch), [20, 25, 25]);
    assert.equal(h.encryptedPayloads.length, 1);
    assert.equal(await storage.loadPendingE2eeSend(h.record.message_id), null);
    assert.equal((await storage.loadMessage(h.record.message_id)).sticker_url, 'sticker');
  } finally {
    (await storage.getDB()).close();
  }
});

test('new send persists full retry payload and clears previous last_error', async () => {
  const h = harness();
  h.manager._resolveChannelE2eeGroupId = () => h.record.cid;
  h.manager.storage.loadPendingE2eeSend = async () => ({ ...h.record, last_error: 'old failure' });
  h.manager.e2eeClient.sendMessage = async (_t, _i, body) => ({ message: { id: body.message.id } });
  await h.manager.sendMessage('messaging', 'retained', h.record.cid, 'new content', h.record.message_id, {
    sticker_url: 'sticker', poll_type: 'single', poll_choice_counts: { a: 1 },
  });
  assert.deepEqual(h.current().payload, { text: 'new content', sticker_url: 'sticker', poll_type: 'single', poll_choice_counts: { a: 1 } });
  assert.equal(h.current().status, 'sent');
  assert.equal(h.current().last_error, undefined);
});
