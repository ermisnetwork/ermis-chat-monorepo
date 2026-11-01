const assert = require('node:assert/strict');
const test = require('node:test');

const { EncryptionManager } = require('../dist/index.cjs');

function makeSendHarness() {
  const manager = new EncryptionManager();
  const cid = 'team:rapid-send';
  const sentBodies = [];
  const savedMessages = [];
  let pending;

  manager.userId = 'sender';
  manager.client = {
    user: { id: 'sender', name: 'Sender' },
    state: { users: {} },
    activeChannels: {},
  };
  manager.groups.set(cid, { epoch: () => 4 });
  manager._resolveChannelE2eeGroupId = () => cid;
  manager.encryptMessage = () => new Uint8Array([1, 2, 3]);
  manager._persistProvider = async () => {};
  manager.storage = {
    savePendingE2eeSend: async r => { pending = structuredClone(r); },
    loadPendingE2eeSend: async () => pending,
    loadMessage: async id => savedMessages.findLast(m => m.id === id) || null,
    savePendingE2eeSendOutcome: async (expected, next, message) => { if (!pending || !Buffer.from(pending.mls_ciphertext).equals(Buffer.from(expected.mls_ciphertext))) return false; if (message) savedMessages.push(message); pending = structuredClone(next); return true; },
    saveMessage: async (message) => {
      savedMessages.push(message);
    },
  };
  // Isolate ordering projection; real atomic cryptography is exercised by application_send_checkpoint.
  manager._prepareApplicationSend = async r => { const next = {...r, mls_ciphertext: manager.encryptMessage(), mls_epoch: 4}; await manager.storage.savePendingE2eeSend(next); manager._freshApplicationSendRecords.add(next); return next; };
  manager.e2eeClient = {
    sendMessage: async (_channelType, _channelId, body) => {
      sentBodies.push(body);
      return {
        message: {
          id: body.message.id,
          user: { id: 'sender' },
          created_at: '2026-07-27T10:00:10.000Z',
          updated_at: '2026-07-27T10:00:10.000Z',
          msg_seq: 42,
          last_event_seq: 77,
        },
      };
    },
  };

  return { manager, cid, sentBodies, savedMessages };
}

test('E2EE send keeps optimistic ordering time and carries server sequence metadata', async () => {
  const { manager, cid, sentBodies, savedMessages } = makeSendHarness();
  const optimisticCreatedAt = '2026-07-27T10:00:00.001Z';

  const response = await manager.sendMessage('team', 'rapid-send', cid, 'first', 'message-1', {
    local_created_at: optimisticCreatedAt,
  });

  assert.equal(response.message.created_at, optimisticCreatedAt);
  assert.equal(response.message.msg_seq, 42);
  assert.equal(response.message.last_event_seq, 77);
  assert.equal(savedMessages.at(-1).created_at, optimisticCreatedAt);
  assert.equal(savedMessages.at(-1).msg_seq, 42);
  assert.equal(savedMessages.at(-1).last_event_seq, 77);
  assert.equal('local_created_at' in sentBodies[0].message, false);
});

test('decrypted E2EE projections retain authoritative ordering metadata', () => {
  const { manager, cid } = makeSendHarness();
  const stored = manager._storedFromPayload(
    cid,
    { text: 'hello' },
    {
      id: 'message-2',
      user: { id: 'other-user' },
      created_at: '2026-07-27T10:01:00.000Z',
      msg_seq: 43,
      last_event_seq: 78,
    },
  );
  const projected = manager._buildFullMessage(stored, {});

  assert.equal(stored.msg_seq, 43);
  assert.equal(stored.last_event_seq, 78);
  assert.equal(projected.msg_seq, 43);
  assert.equal(projected.last_event_seq, 78);
});
