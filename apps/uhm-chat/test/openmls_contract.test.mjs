import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import initOpenMls, * as openMls from '../public/openmls_wasm.js';

const wasmBytes = fs.readFileSync(new URL('../public/openmls_wasm_bg.wasm', import.meta.url));
await initOpenMls({ module_or_path: wasmBytes });
openMls.init();

test('UHM OpenMLS artifact supports recovery PIN serialization and unlock', () => {
  assert.equal(typeof openMls.WrappedRecoveryKey?.from_bytes, 'function');
  assert.equal(typeof openMls.generate_recovery_keypair, 'function');
  assert.equal(typeof openMls.wrap_recovery_private_key, 'function');
  assert.equal(typeof openMls.unwrap_recovery_private_key, 'function');

  const provider = new openMls.Provider();
  const keypair = openMls.generate_recovery_keypair(provider);
  const wrapped = openMls.wrap_recovery_private_key(
    provider,
    '12345678',
    keypair.private_key,
    keypair.public_key,
    keypair.key_id,
    keypair.ciphersuite,
    600_000,
  );
  const restored = openMls.WrappedRecoveryKey.from_bytes(wrapped.to_bytes());
  const unwrapped = openMls.unwrap_recovery_private_key(provider, '12345678', restored);

  assert.deepEqual(unwrapped, keypair.private_key);
});

test('UHM OpenMLS artifact exports generation-aware archive identities', () => {
  assert.equal(typeof openMls.ArchiveBlobAad.forGeneration, 'function');
  assert.equal(typeof openMls.ArchiveKeyWrapInfo.forGeneration, 'function');
  const zero = openMls.ArchiveBlobAad.forGeneration('team:uhm', 0n, 3n, 'account_owned', 'blob', 'snapshot');
  const next = openMls.ArchiveBlobAad.forGeneration('team:uhm', 2n, 3n, 'account_owned', 'blob', 'snapshot');
  assert.notDeepEqual(Array.from(zero.to_bytes()), Array.from(next.to_bytes()));
});

test('UHM OpenMLS artifact reloads a fresh GroupId alongside generation zero', () => {
  assert.equal(typeof openMls.Group.create_with_group_id, 'function');
  assert.equal(typeof openMls.Group.load_with_group_id, 'function');
  const provider = new openMls.Provider();
  const identity = new openMls.Identity(provider, 'uhm-user');
  const cid = 'team:uhm-generation';
  const groupId = Uint8Array.from([9, 8, 7, 6, 5, 4]);
  openMls.Group.create_with_cid(provider, identity, cid).save_state(provider);
  openMls.Group.create_with_group_id(provider, identity, groupId).save_state(provider);

  const restarted = openMls.Provider.from_bytes(provider.to_bytes());
  assert.deepEqual(
    Array.from(openMls.Group.load(restarted, cid).group_id()),
    Array.from(new TextEncoder().encode(cid)),
  );
  assert.deepEqual(
    Array.from(openMls.Group.load_with_group_id(restarted, groupId).group_id()),
    Array.from(groupId),
  );
});

test('UHM OpenMLS artifact replays a delayed Add at trusted server acceptance time', () => {
  const originalNow = Date.now;
  const acceptedAtMilliseconds = originalNow();
  Date.now = () => acceptedAtMilliseconds;

  try {
    const aliceProvider = new openMls.Provider();
    const bobProvider = new openMls.Provider();
    const charlieProvider = new openMls.Provider();
    const alice = new openMls.Identity(aliceProvider, 'alice');
    const bob = new openMls.Identity(bobProvider, 'bob');
    const charlie = new openMls.Identity(charlieProvider, 'charlie');
    const cid = 'team:uhm-combined-wasm-delayed-add';

    const aliceGroup = openMls.Group.create_with_cid(aliceProvider, alice, cid);
    const welcomeBob = aliceGroup.add_members(aliceProvider, alice, [bob.key_package(bobProvider)]);
    aliceGroup.merge_pending_commit(aliceProvider);
    const bobGroup = openMls.Group.join_with_welcome(bobProvider, welcomeBob.welcome, aliceGroup.export_ratchet_tree());
    const addCharlie = bobGroup.add_members(bobProvider, bob, [charlie.key_package(charlieProvider)]);
    bobGroup.merge_pending_commit(bobProvider);
    aliceGroup.save_state(aliceProvider);
    const durableAliceProvider = aliceProvider.to_bytes();

    Date.now = () => acceptedAtMilliseconds + 366 * 24 * 60 * 60 * 1000;
    const liveProvider = openMls.Provider.from_bytes(durableAliceProvider);
    const liveGroup = openMls.Group.load(liveProvider, cid);
    assert.throws(() => liveGroup.process_message(liveProvider, addCharlie.commit));

    const historicalProvider = openMls.Provider.from_bytes(durableAliceProvider);
    const historicalGroup = openMls.Group.load(historicalProvider, cid);
    historicalGroup.process_message_at(
      historicalProvider,
      addCharlie.commit,
      BigInt(Math.floor(acceptedAtMilliseconds / 1000)),
    );
    assert.equal(Number(historicalGroup.epoch()), Number(bobGroup.epoch()));
  } finally {
    Date.now = originalNow;
  }
});
