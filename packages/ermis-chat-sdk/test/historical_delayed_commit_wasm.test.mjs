import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import initOpenMls, * as openMls from '../src/encryption/wasm/openmls_wasm.js';

const wasmBytes = fs.readFileSync(
  new URL('../src/encryption/wasm/openmls_wasm_bg.wasm', import.meta.url),
);

test('generated WASM replays a delayed Add at trusted server acceptance time', async () => {
  await initOpenMls({ module_or_path: wasmBytes });
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
    const cid = 'team:generated-wasm-delayed-add';

    const aliceGroup = openMls.Group.create_with_cid(aliceProvider, alice, cid);
    const welcomeBob = aliceGroup.add_members(aliceProvider, alice, [bob.key_package(bobProvider)]);
    aliceGroup.merge_pending_commit(aliceProvider);
    const bobGroup = openMls.Group.join_with_welcome(
      bobProvider,
      welcomeBob.welcome,
      aliceGroup.export_ratchet_tree(),
    );
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
    assert.equal(typeof historicalGroup.process_message_at, 'function');
    historicalGroup.process_message_at(
      historicalProvider,
      addCharlie.commit,
      BigInt(Math.floor(acceptedAtMilliseconds / 1000)),
    );
    assert.equal(Number(historicalGroup.epoch()), Number(bobGroup.epoch()));
    historicalGroup.save_state(historicalProvider);

    const restartedProvider = openMls.Provider.from_bytes(historicalProvider.to_bytes());
    const restartedGroup = openMls.Group.load(restartedProvider, cid);
    assert.equal(Number(restartedGroup.epoch()), Number(bobGroup.epoch()));
  } finally {
    Date.now = originalNow;
  }
});
