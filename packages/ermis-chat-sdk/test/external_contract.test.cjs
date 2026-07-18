const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const sdk = require('../dist/index.cjs');
const encryption = require('../dist/encryption/index.cjs');

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

test('external API selects Base64 while decoding legacy array responses', async () => {
  const calls = [];
  const client = {
    baseURL: 'https://bellboy.example',
    deviceId: 'web-migration-test',
    async doAxiosRequest(method, url, data, config) {
      calls.push({ method, url, data, config });
      if (method === 'get' && url.endsWith('/group_info')) {
        return { group_info: [1, 2, 3, 255], epoch: 7 };
      }
      return { duration: '0ms' };
    },
  };
  const api = new encryption.EncryptionApiClient(client);

  const response = await api.getGroupInfo('team', 'legacy-channel');
  assert.ok(response.group_info instanceof Uint8Array);
  assert.deepEqual(Array.from(response.group_info), [1, 2, 3, 255]);
  assert.equal(calls[0].config.headers['X-Ermis-E2EE-Bytes'], 'base64');
  assert.equal(calls[0].config.headers['X-Device-ID'], 'web-migration-test');

  await api.uploadGroupInfo('team', 'legacy-channel', {
    group_info: Uint8Array.from([1, 2, 3, 255]),
    epoch: 8,
  });
  assert.equal(calls[1].data.group_info, 'AQID/w==');
  assert.equal(calls[1].config.headers['X-Ermis-E2EE-Bytes'], 'base64');
});

test('external websocket bundle carries the Base64 selector', () => {
  for (const relative of ['dist/index.cjs', 'dist/index.mjs']) {
    const source = fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
    assert.equal(source.includes('e2ee_bytes'), true, `${relative} omits the websocket selector`);
    assert.equal(source.includes('X-Ermis-E2EE-Bytes'), true, `${relative} omits the HTTP selector`);
  }
});
