import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import initOpenMls, * as openMls from '../src/encryption/wasm/openmls_wasm.js';

const wasmBytes = fs.readFileSync(
  new URL('../src/encryption/wasm/openmls_wasm_bg.wasm', import.meta.url),
);

test('promoted WASM stores and reloads two generations for one CID', async () => {
  await initOpenMls({ module_or_path: wasmBytes });
  assert.equal(typeof openMls.Group.create_with_group_id, 'function');
  assert.equal(typeof openMls.Group.load_with_group_id, 'function');

  const provider = new openMls.Provider();
  const founder = new openMls.Identity(provider, 'alice');
  const cid = 'team:artifact-generation';
  const nextGroupId = Uint8Array.from([255, 1, 0, 42, 7, 99]);
  const legacy = openMls.Group.create_with_cid(provider, founder, cid);
  const next = openMls.Group.create_with_group_id(provider, founder, nextGroupId);
  legacy.save_state(provider);
  next.save_state(provider);

  const restarted = openMls.Provider.from_bytes(provider.to_bytes());
  const loadedLegacy = openMls.Group.load(restarted, cid);
  const loadedNext = openMls.Group.load_with_group_id(restarted, nextGroupId);
  assert.deepEqual(Array.from(loadedLegacy.group_id()), Array.from(new TextEncoder().encode(cid)));
  assert.deepEqual(Array.from(loadedNext.group_id()), Array.from(nextGroupId));
  assert.equal(Number(loadedLegacy.epoch()), 0);
  assert.equal(Number(loadedNext.epoch()), 0);
});

test('promoted WASM fails closed for invalid explicit GroupIds', async () => {
  await initOpenMls({ module_or_path: wasmBytes });
  const provider = new openMls.Provider();
  const founder = new openMls.Identity(provider, 'alice');
  assert.throws(() => openMls.Group.create_with_group_id(provider, founder, new Uint8Array()));
  assert.throws(() => openMls.Group.load_with_group_id(provider, new Uint8Array(256)));
});

test('promoted WASM creates one bounded Welcome for a recipient device', async () => {
  await initOpenMls({ module_or_path: wasmBytes });
  const founderProvider = new openMls.Provider();
  const founder = new openMls.Identity(founderProvider, 'alice');
  const recipientProvider = new openMls.Provider();
  const recipient = new openMls.Identity(recipientProvider, 'bob');
  const groupId = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const candidate = openMls.Group.create_with_group_id(founderProvider, founder, groupId);
  const bundle = candidate.add_members(founderProvider, founder, [recipient.key_package(recipientProvider)]);

  assert.ok(bundle.welcome instanceof Uint8Array);
  assert.ok(bundle.welcome.length > 0);
  candidate.merge_pending_commit(founderProvider);
  candidate.save_state(founderProvider);
  const ratchetTree = candidate.export_ratchet_tree();
  const joined = openMls.Group.join_with_welcome(
    recipientProvider,
    bundle.welcome,
    ratchetTree,
  );
  assert.deepEqual(Array.from(joined.group_id()), Array.from(groupId));
  assert.equal(Number(candidate.epoch()), 1);
  assert.equal(Number(joined.epoch()), 1);
});

test('promoted WASM keeps generation zero archive AAD stable and namespaces later generations', async () => {
  await initOpenMls({ module_or_path: wasmBytes });
  assert.equal(typeof openMls.ArchiveBlobAad.forGeneration, 'function');
  assert.equal(typeof openMls.ArchiveKeyWrapInfo.forGeneration, 'function');

  const legacy = new openMls.ArchiveBlobAad('team:archive', 7n, 'account_owned', 'blob-1', 'snapshot-1');
  const explicitZero = openMls.ArchiveBlobAad.forGeneration(
    'team:archive',
    0n,
    7n,
    'account_owned',
    'blob-1',
    'snapshot-1',
  );
  const next = openMls.ArchiveBlobAad.forGeneration(
    'team:archive',
    1n,
    7n,
    'account_owned',
    'blob-1',
    'snapshot-1',
  );

  assert.deepEqual(Array.from(explicitZero.to_bytes()), Array.from(legacy.to_bytes()));
  assert.notDeepEqual(Array.from(next.to_bytes()), Array.from(legacy.to_bytes()));
  assert.equal(JSON.parse(new TextDecoder().decode(legacy.to_bytes())).group_generation, undefined);
  assert.equal(JSON.parse(new TextDecoder().decode(next.to_bytes())).group_generation, 1);
});
