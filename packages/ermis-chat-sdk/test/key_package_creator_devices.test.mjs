import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import init, * as wasm from '../src/encryption/wasm/openmls_wasm.js';

await init({ module_or_path: fs.readFileSync(new URL('../src/encryption/wasm/openmls_wasm_bg.wasm', import.meta.url)) });

function device(user) {
  const provider = new wasm.Provider();
  const identity = new wasm.Identity(provider, user);
  return { provider, identity, kp: identity.key_package(provider) };
}
function join(device, bundle, tree) {
  return wasm.Group.join_with_welcome_typed(device.provider, bundle.welcome, wasm.RatchetTree.from_bytes(tree));
}

test('creator current leaf plus four other creator devices and five receiver devices share the initial Welcome', () => {
  const creator = device('creator');
  const others = Array.from({length:4}, () => device('creator'));
  const receivers = Array.from({length:5}, () => device('receiver'));
  const group = wasm.Group.create_with_cid(creator.provider, creator.identity, 'team:creator-device-coverage');
  // Including current creator KP exercises the existing duplicate-leaf guard.
  const bundle = group.add_members(creator.provider, creator.identity, [creator.kp, ...others.map(d => d.kp), ...receivers.map(d => d.kp)]);
  const tree = group.export_ratchet_tree().to_bytes();
  group.merge_pending_commit(creator.provider);
  assert.equal(group.members_by_user_id('creator').length, 5);
  assert.equal(group.members_by_user_id('receiver').length, 5);
  assert.equal(Number(group.epoch()), 1);
  const message = new TextEncoder().encode('public synthetic before-accept fixture');
  const ciphertext = group.create_message(creator.provider, creator.identity, message);
  for (const candidate of [...others, ...receivers]) {
    const joined = join(candidate, bundle, tree);
    assert.equal(Number(joined.epoch()), 1);
    const result = joined.process_message(candidate.provider, ciphertext);
    assert.deepEqual(result.content, message);
    joined.free();
  }
});

test('existing creator-other-device signer is skipped during an ordinary AddMembers commit', () => {
  const creator = device('creator'), other = device('creator'), receiver = device('new-user');
  const group = wasm.Group.create_with_cid(creator.provider, creator.identity, 'team:existing-device-skip');
  group.add_members(creator.provider, creator.identity, [other.kp]);
  group.merge_pending_commit(creator.provider);
  const freshExistingKp = other.identity.key_package(other.provider);
  const bundle = group.commit_member_add_with_removals(creator.provider, creator.identity, [], [freshExistingKp, receiver.kp]);
  const tree = group.export_ratchet_tree().to_bytes();
  group.merge_pending_commit(creator.provider);
  assert.equal(group.members_by_user_id('creator').length, 2);
  assert.equal(group.members_by_user_id('new-user').length, 1);
  assert.equal(Number(group.epoch()), 2);
  assert.equal(Number(join(receiver, bundle, tree).epoch()), 2);
});

test('composite remove then re-add admits the removed signer and still fences removing the creator leaf', () => {
  const creator = device('creator'), receiver = device('receiver');
  const group = wasm.Group.create_with_cid(creator.provider, creator.identity, 'team:remove-and-readd');
  group.add_members(creator.provider, creator.identity, [receiver.kp]);
  group.merge_pending_commit(creator.provider);
  const freshKp = receiver.identity.key_package(receiver.provider);
  const bundle = group.commit_member_add_with_removals(creator.provider, creator.identity, ['receiver'], [freshKp]);
  const tree = group.export_ratchet_tree().to_bytes();
  group.merge_pending_commit(creator.provider);
  assert.equal(group.members_by_user_id('creator').length, 1);
  assert.equal(group.members_by_user_id('receiver').length, 1);
  assert.equal(Number(join(receiver, bundle, tree).epoch()), 2);
  assert.throws(() => group.commit_member_add_with_removals(creator.provider, creator.identity, ['creator'], []));
});
