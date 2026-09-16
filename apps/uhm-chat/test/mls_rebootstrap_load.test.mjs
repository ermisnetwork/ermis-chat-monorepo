import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import initOpenMls, * as openMls from '../public/openmls_wasm.js';

const wasmBytes = fs.readFileSync(new URL('../public/openmls_wasm_bg.wasm', import.meta.url));
await initOpenMls({ module_or_path: wasmBytes });
openMls.init();

const elapsedMilliseconds = (started) => Number(process.hrtime.bigint() - started) / 1_000_000;

const runSample = (sampleIndex) => {
  global.gc?.();
  const provider = new openMls.Provider();
  const founder = new openMls.Identity(provider, 'founder');
  const groupId = new TextEncoder().encode(`rebootstrap-load-generation-1-sample-${sampleIndex}`);
  const group = openMls.Group.create_with_group_id(provider, founder, groupId);
  const recipients = [];
  const keyPackages = [];
  let keyPackageBytes = 0;
  let peakRssBytes = process.memoryUsage().rss;

  const preparationStarted = process.hrtime.bigint();
  for (let userIndex = 0; userIndex < 100; userIndex += 1) {
    for (let deviceIndex = 0; deviceIndex < 2; deviceIndex += 1) {
      const recipientProvider = new openMls.Provider();
      const identity = new openMls.Identity(recipientProvider, `user-${userIndex}`);
      const keyPackage = identity.key_package(recipientProvider);
      keyPackageBytes += keyPackage.to_bytes().byteLength;
      recipients.push({ recipientProvider, identity });
      keyPackages.push(keyPackage);
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    }
  }
  assert.equal(keyPackages.length, 200);
  const preparationMs = elapsedMilliseconds(preparationStarted);

  const rssBeforeWelcome = process.memoryUsage().rss;
  const welcomeStarted = process.hrtime.bigint();
  const bundle = group.add_members(provider, founder, keyPackages);
  const welcomeMs = elapsedMilliseconds(welcomeStarted);
  const welcomeBytes = bundle.welcome_as_uint8array().byteLength;
  const commitBytes = bundle.commit_as_uint8array().byteLength;
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  group.merge_pending_commit(provider);

  const groupInfoStarted = process.hrtime.bigint();
  const groupInfo = group.export_group_info(provider, founder, false);
  const ratchetTree = group.export_ratchet_tree();
  const ratchetTreeBytes = ratchetTree.to_bytes().byteLength;
  const groupInfoMs = elapsedMilliseconds(groupInfoStarted);
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);

  const device201Provider = new openMls.Provider();
  const device201 = new openMls.Identity(device201Provider, 'user-99');
  const externalJoinStarted = process.hrtime.bigint();
  const externalJoin = openMls.Group.join_external(
    device201Provider,
    device201,
    groupInfo,
    ratchetTree,
  );
  const externalJoinMs = elapsedMilliseconds(externalJoinStarted);
  const externalJoinCommitBytes = externalJoin.commit.byteLength;
  const externallyJoinedGroup = externalJoin.group;
  assert.ok(externallyJoinedGroup);
  assert.deepEqual(Array.from(externallyJoinedGroup.group_id()), Array.from(groupId));
  assert.equal(group.members().length, 201);

  const result = {
    sampleIndex,
    activeUsers: 100,
    welcomeRecipients: recipients.length,
    externalJoinDeviceOrdinal: 201,
    preparationMs,
    welcomeGenerationMs: welcomeMs,
    groupInfoAndTreeSerializationMs: groupInfoMs,
    externalJoinMs,
    keyPackageBytes,
    welcomeBytes,
    commitBytes,
    groupInfoBytes: groupInfo.byteLength,
    ratchetTreeBytes,
    externalJoinCommitBytes,
    rssBeforeWelcomeBytes: rssBeforeWelcome,
    peakRssBytes,
    peakRssDeltaBytes: peakRssBytes - rssBeforeWelcome,
  };

  assert.ok(welcomeBytes > 0 && welcomeBytes <= 6 * 1024 * 1024);
  assert.ok(groupInfo.byteLength > 0 && groupInfo.byteLength <= 6 * 1024 * 1024);
  return result;
};

const percentile = (samples, field, quantile) => {
  const values = samples.map((sample) => sample[field]).sort((left, right) => left - right);
  return values[Math.max(0, Math.ceil(values.length * quantile) - 1)];
};

test('current UHM artifact bootstraps 100 users / 200 devices and external-joins device 201', () => {
  const startedAt = new Date().toISOString();
  global.gc?.();
  const rssStartBytes = process.memoryUsage().rss;
  const samples = Array.from({ length: 10 }, (_, index) => runSample(index + 1));
  global.gc?.();
  const rssAfterFinalGcBytes = process.memoryUsage().rss;
  const result = {
    sampleSize: samples.length,
    activeUsers: 100,
    welcomeRecipients: 200,
    externalJoinDeviceOrdinal: 201,
    welcomeGenerationP95Ms: percentile(samples, 'welcomeGenerationMs', 0.95),
    welcomeGenerationP99Ms: percentile(samples, 'welcomeGenerationMs', 0.99),
    externalJoinP95Ms: percentile(samples, 'externalJoinMs', 0.95),
    externalJoinP99Ms: percentile(samples, 'externalJoinMs', 0.99),
    groupInfoSerializationP95Ms: percentile(samples, 'groupInfoAndTreeSerializationMs', 0.95),
    groupInfoSerializationP99Ms: percentile(samples, 'groupInfoAndTreeSerializationMs', 0.99),
    welcomeBytes: samples[0].welcomeBytes,
    groupInfoBytes: samples[0].groupInfoBytes,
    ratchetTreeBytes: samples[0].ratchetTreeBytes,
    keyPackageBytes: samples[0].keyPackageBytes,
    peakRssDeltaBytes: Math.max(...samples.map((sample) => sample.peakRssDeltaBytes)),
    rssStartBytes,
    rssAfterFinalGcBytes,
    retainedRssDeltaBytes: rssAfterFinalGcBytes - rssStartBytes,
    processId: process.pid,
    startedAt,
    endedAt: new Date().toISOString(),
    samples,
  };
  console.log(`REBOOTSTRAP_LOAD_RESULT=${JSON.stringify(result)}`);
});
