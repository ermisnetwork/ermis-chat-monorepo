const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildE2eeMessageAadV1,
  canonicalAttachmentIds,
  ciphertextSha256,
  Sha256,
  sha256Hex,
} = require('../dist/index.cjs');

test('E2EE AAD sorts attachment UUIDs by raw bytes and rejects duplicates', () => {
  const a = '00000000-0000-0000-0000-0000000000ff';
  const b = '00000000-0000-0000-0000-000000000001';
  assert.deepEqual(canonicalAttachmentIds([a, b]), [b, a]);
  assert.throws(() => canonicalAttachmentIds([a, a]), /Duplicate E2EE attachment id/);
});

test('E2EE AAD builder is deterministic', () => {
  const params = {
    cid: 'messaging:dest',
    e2ee_group_id: 'messaging:dest',
    message_id: '11111111-1111-4111-8111-111111111111',
    forward_cid: 'messaging:source',
    forward_message_id: '22222222-2222-4222-8222-222222222222',
    forward_parent_cid: 'team:parent',
    e2ee_attachment_ids: [
      '00000000-0000-0000-0000-0000000000ff',
      '00000000-0000-0000-0000-000000000001',
    ],
  };
  const first = buildE2eeMessageAadV1(params);
  const second = buildE2eeMessageAadV1({
    ...params,
    e2ee_attachment_ids: [...params.e2ee_attachment_ids].reverse(),
  });
  assert.deepEqual([...first], [...second]);
  assert.equal(
    sha256Hex(first),
    '10478e38376e07f02e5f7618355d21fa30fe70fe8a826505269705565d910fac',
  );
});

test('SDK SHA-256 helper matches known vector', () => {
  assert.equal(
    sha256Hex(new TextEncoder().encode('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});

test('E2EE attachment ciphertext hash accepts injected crypto provider', () => {
  let used = false;
  const provider = {
    randomBytes() {
      throw new Error('not used');
    },
    generateAesGcmKey() {
      throw new Error('not used');
    },
    async aesGcmEncrypt() {
      throw new Error('not used');
    },
    async aesGcmDecrypt() {
      throw new Error('not used');
    },
    createSha256() {
      used = true;
      return new Sha256();
    },
  };
  const bytes = new TextEncoder().encode('provider-hash');
  assert.equal(ciphertextSha256(bytes, provider), sha256Hex(bytes));
  assert.equal(used, true);
});
