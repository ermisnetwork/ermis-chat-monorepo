const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const sdk = require('../dist/index.cjs');

const forbiddenPublicName = /(recovery|Recovery|vault|Vault|archive|Archive|historical|Historical|Pin)/;
const forbiddenEndpoint = /(\/v1\/e2ee\/recovery\/vault|epoch_archives)/i;

test('external root exports and manager prototype omit encrypted-history APIs', () => {
  const rootNames = Object.keys(sdk).filter((name) => forbiddenPublicName.test(name));
  const managerNames = Object.getOwnPropertyNames(sdk.EncryptionManager.prototype).filter((name) =>
    forbiddenPublicName.test(name),
  );

  assert.deepEqual(rootNames, []);
  assert.deepEqual(managerNames, []);
  assert.equal(typeof sdk.EncryptionManager.prototype.repairEncryptedChannel, 'function');
  assert.equal(typeof sdk.EncryptionManager.prototype.keyRotation, 'function');
});

test('public declarations omit encrypted-history contracts', () => {
  const files = [
    'dist/index.d.ts',
    'dist/encryption/index.d.ts',
    ...fs
      .readdirSync(path.join(__dirname, '..', 'dist'))
      .filter((name) => /^index-.+\.d\.ts$/.test(name))
      .map((name) => `dist/${name}`),
  ];
  const forbidden =
    /(useRecoveryPin|RecoveryVault|EpochArchive|RestoreProgressRecord|e2ee_recovery_policy|archiveCurrentEpoch)/i;

  for (const relative of files) {
    const source = fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
    assert.equal(forbidden.test(source), false, `${relative} exposes an encrypted-history contract`);
    assert.equal(source.includes('sourcesContent'), false, `${relative} contains sourcesContent`);
  }
});

test('external runtime has no encrypted-history endpoint strings', () => {
  for (const relative of [
    'dist/index.cjs',
    'dist/index.mjs',
    'dist/encryption/index.cjs',
    'dist/encryption/index.mjs',
  ]) {
    const source = fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
    assert.equal(forbiddenEndpoint.test(source), false, `${relative} contains a forbidden endpoint`);
  }
});
