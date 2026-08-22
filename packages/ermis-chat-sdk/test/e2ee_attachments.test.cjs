const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const test = require('node:test');

const {
  buildE2eeMessageAadV1,
  canonicalAttachmentIds,
  ciphertextSha256,
  e2eeAttachmentMultipartUploadUrlExpiresAtMs,
  encryptAndUploadE2eeAssetMultipart,
  encryptE2eeAsset,
  estimateE2eeEncryptedAssetSize,
  resolveE2eeAttachmentMultipartUploadConcurrency,
  Sha256,
  sha256Hex,
} = require('../dist/index.cjs');

test('E2EE attachment empty file matches the shared iOS and Bellboy vector', async () => {
  const rawKey = Uint8Array.from({ length: 32 }, (_, index) => index);
  const noncePrefix = Uint8Array.from({ length: 8 }, (_, index) => 0xf0 + index);
  const cryptoProvider = {
    randomBytes(length) {
      assert.equal(length, noncePrefix.length);
      return noncePrefix.slice();
    },
    async generateAesGcmKey() {
      return rawKey.slice();
    },
    async aesGcmEncrypt(key, nonce, plain) {
      const importedKey = await webcrypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
      return new Uint8Array(
        await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, importedKey, plain),
      );
    },
    async aesGcmDecrypt() {
      throw new Error('not used');
    },
    createSha256() {
      return new Sha256();
    },
  };

  const encrypted = await encryptE2eeAsset(new Blob([]), {
    kind: 'original',
    cryptoProvider,
  });
  const wireBytes = new Uint8Array(await encrypted.encryptedBlob.arrayBuffer());

  assert.equal(encrypted.plaintext_size, 0);
  assert.equal(encrypted.cipher_size, 24);
  assert.equal(
    Buffer.from(wireBytes).toString('hex'),
    '0000000000000010715896cfbf80df8c10223beeb74b78b9',
  );
  assert.equal(encrypted.cipher_sha256, 'dd60f2d52e14bace6b197f7fc6c36ba7c931b6f8dd1b6e2307be70d588dd30a7');
});

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
    e2ee_attachment_ids: ['00000000-0000-0000-0000-0000000000ff', '00000000-0000-0000-0000-000000000001'],
  };
  const first = buildE2eeMessageAadV1(params);
  const second = buildE2eeMessageAadV1({
    ...params,
    e2ee_attachment_ids: [...params.e2ee_attachment_ids].reverse(),
  });
  assert.deepEqual([...first], [...second]);
  assert.equal(sha256Hex(first), '10478e38376e07f02e5f7618355d21fa30fe70fe8a826505269705565d910fac');
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

function fakeAttachmentCryptoProvider() {
  return {
    randomBytes(length) {
      return new Uint8Array(length);
    },
    async generateAesGcmKey() {
      return new Uint8Array(32);
    },
    async aesGcmEncrypt(_key, _nonce, plain) {
      const out = new Uint8Array(plain.length + 16);
      out.set(plain);
      return out;
    },
    async aesGcmDecrypt(_key, _nonce, cipher) {
      return cipher.slice(0, Math.max(0, cipher.length - 16));
    },
    createSha256() {
      return new Sha256();
    },
  };
}

function multipartUrl(partNumber, { date = '20300101T000000Z', expires = 3600 } = {}) {
  return `https://r2.example.test/bucket/key?partNumber=${partNumber}&uploadId=test-upload&X-Amz-Date=${date}&X-Amz-Expires=${expires}`;
}

function multipartFor(totalCipherSize, partSize, options = {}) {
  const partCount = Math.max(1, Math.ceil(totalCipherSize / partSize));
  return {
    multipart_upload_id: 'test-upload',
    part_size: partSize,
    part_count: partCount,
    max_part_retries: options.maxPartRetries ?? 0,
    retry_max_elapsed_secs: options.retryMaxElapsedSecs ?? 900,
    parts: Array.from({ length: partCount }, (_, index) => ({
      part_number: index + 1,
      put_url: options.urls?.[index + 1] || multipartUrl(index + 1),
    })),
  };
}

function partNumberFromUrl(url) {
  return Number(new URL(url).searchParams.get('partNumber'));
}

function installFakeXhr(handler, options = {}) {
  const previous = global.XMLHttpRequest;
  const requests = [];

  class FakeXMLHttpRequest {
    constructor() {
      this.upload = {};
      this.status = 0;
      this.responseHeaders = new Map();
      this.aborted = false;
    }

    open(method, url) {
      this.method = method;
      this.url = url;
    }

    setRequestHeader() {}

    getResponseHeader(name) {
      return this.responseHeaders.get(name.toLowerCase()) || undefined;
    }

    send(body) {
      requests.push(this);
      handler(this, body);
    }

    abort() {
      if (this.aborted) return;
      this.aborted = true;
      this.onabort?.();
      options.onAbort?.(this);
    }
  }

  global.XMLHttpRequest = FakeXMLHttpRequest;
  return {
    requests,
    restore() {
      if (previous === undefined) delete global.XMLHttpRequest;
      else global.XMLHttpRequest = previous;
    },
  };
}

function finishXhr(xhr, status, etag) {
  if (xhr.aborted) return;
  xhr.status = status;
  xhr.responseHeaders = new Map();
  if (etag) xhr.responseHeaders.set('etag', etag);
  xhr.onload?.();
}

test('E2EE multipart upload concurrency option clamps to default and 1..4', () => {
  assert.equal(resolveE2eeAttachmentMultipartUploadConcurrency(), 3);
  assert.equal(resolveE2eeAttachmentMultipartUploadConcurrency(0), 3);
  assert.equal(resolveE2eeAttachmentMultipartUploadConcurrency(Number.NaN), 3);
  assert.equal(resolveE2eeAttachmentMultipartUploadConcurrency(1), 1);
  assert.equal(resolveE2eeAttachmentMultipartUploadConcurrency(2.9), 2);
  assert.equal(resolveE2eeAttachmentMultipartUploadConcurrency(9), 4);
});

test('E2EE multipart upload parses SigV4 part URL expiry', () => {
  assert.equal(
    e2eeAttachmentMultipartUploadUrlExpiresAtMs(multipartUrl(1, { date: '20300101T000000Z', expires: 10 })),
    Date.UTC(2030, 0, 1, 0, 0, 10),
  );
  assert.equal(e2eeAttachmentMultipartUploadUrlExpiresAtMs('not a url'), undefined);
});

test('E2EE multipart upload limits in-flight PUTs and returns sorted parts', async () => {
  const input = new Blob([new Uint8Array(96)]);
  const frameSize = 16;
  const totalCipherSize = estimateE2eeEncryptedAssetSize(input.size, frameSize);
  const multipart = multipartFor(totalCipherSize, 50);
  let active = 0;
  let maxActive = 0;
  const delays = new Map([
    [1, 30],
    [2, 5],
    [3, 20],
    [4, 1],
    [5, 10],
  ]);
  const fake = installFakeXhr((xhr, body) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    const partNumber = partNumberFromUrl(xhr.url);
    xhr.upload.onprogress?.({ loaded: body.size, total: body.size });
    setTimeout(() => {
      active -= 1;
      finishXhr(xhr, 200, `etag-${partNumber}`);
    }, delays.get(partNumber) || 1);
  });

  try {
    const uploaded = await encryptAndUploadE2eeAssetMultipart(input, {
      kind: 'original',
      frameSize,
      multipart,
      uploadConcurrency: 2,
      cryptoProvider: fakeAttachmentCryptoProvider(),
    });
    assert.equal(maxActive, 2);
    assert.deepEqual(
      uploaded.parts.map((part) => part.part_number),
      [1, 2, 3, 4, 5],
    );
    assert.deepEqual(
      uploaded.parts.map((part) => part.etag),
      ['etag-1', 'etag-2', 'etag-3', 'etag-4', 'etag-5'],
    );
  } finally {
    fake.restore();
  }
});

test('E2EE multipart upload progress remains monotonic across part retry', async () => {
  const input = new Blob([new Uint8Array(40)]);
  const frameSize = 20;
  const totalCipherSize = estimateE2eeEncryptedAssetSize(input.size, frameSize);
  const multipart = multipartFor(totalCipherSize, 50, { maxPartRetries: 1 });
  const attempts = new Map();
  const loadedValues = [];
  const fake = installFakeXhr((xhr, body) => {
    const partNumber = partNumberFromUrl(xhr.url);
    const attempt = (attempts.get(partNumber) || 0) + 1;
    attempts.set(partNumber, attempt);
    xhr.upload.onprogress?.({ loaded: body.size, total: body.size });
    setTimeout(() => {
      if (partNumber === 1 && attempt === 1) finishXhr(xhr, 500);
      else finishXhr(xhr, 200, `etag-${partNumber}`);
    }, 1);
  });

  try {
    await encryptAndUploadE2eeAssetMultipart(input, {
      kind: 'original',
      frameSize,
      multipart,
      uploadConcurrency: 1,
      cryptoProvider: fakeAttachmentCryptoProvider(),
      onProgress: (progress) => loadedValues.push(progress.loaded),
    });
    for (let i = 1; i < loadedValues.length; i += 1) {
      assert.ok(loadedValues[i] >= loadedValues[i - 1], `progress went backward at ${i}`);
    }
    assert.equal(loadedValues.at(-1), totalCipherSize);
  } finally {
    fake.restore();
  }
});

test('E2EE multipart upload treats missing ETag after 2xx as non-retryable', async () => {
  const input = new Blob([new Uint8Array(8)]);
  const frameSize = 8;
  const multipart = multipartFor(estimateE2eeEncryptedAssetSize(input.size, frameSize), 64, { maxPartRetries: 2 });
  const fake = installFakeXhr((xhr) => setTimeout(() => finishXhr(xhr, 200), 1));

  try {
    await assert.rejects(
      () =>
        encryptAndUploadE2eeAssetMultipart(input, {
          kind: 'original',
          frameSize,
          multipart,
          uploadConcurrency: 1,
          cryptoProvider: fakeAttachmentCryptoProvider(),
        }),
      /did not expose ETag/,
    );
    assert.equal(fake.requests.length, 1);
  } finally {
    fake.restore();
  }
});

test('E2EE multipart upload fails expired presigned part URLs before PUT', async () => {
  const input = new Blob([new Uint8Array(8)]);
  const frameSize = 8;
  const totalCipherSize = estimateE2eeEncryptedAssetSize(input.size, frameSize);
  const multipart = multipartFor(totalCipherSize, 64, {
    urls: { 1: multipartUrl(1, { date: '20200101T000000Z', expires: 1 }) },
  });
  const fake = installFakeXhr(() => {});

  try {
    await assert.rejects(
      () =>
        encryptAndUploadE2eeAssetMultipart(input, {
          kind: 'original',
          frameSize,
          multipart,
          uploadConcurrency: 1,
          cryptoProvider: fakeAttachmentCryptoProvider(),
        }),
      /multipart_upload_url_expired/,
    );
    assert.equal(fake.requests.length, 0);
  } finally {
    fake.restore();
  }
});

test('E2EE multipart upload does not retry 403 after part URL expiry', async () => {
  const input = new Blob([new Uint8Array(8)]);
  const frameSize = 8;
  const totalCipherSize = estimateE2eeEncryptedAssetSize(input.size, frameSize);
  const signedAtMs = Date.UTC(2030, 0, 1, 0, 0, 0);
  const beforeSafetyWindowMs = signedAtMs + 100_000;
  const expiredAtMs = signedAtMs + 301_000;
  const multipart = multipartFor(totalCipherSize, 64, {
    maxPartRetries: 2,
    urls: { 1: multipartUrl(1, { date: '20300101T000000Z', expires: 300 }) },
  });
  const previousNow = Date.now;
  let nowCalls = 0;
  Date.now = () => {
    nowCalls += 1;
    return nowCalls <= 3 ? beforeSafetyWindowMs : expiredAtMs;
  };
  const fake = installFakeXhr((xhr) => setTimeout(() => finishXhr(xhr, 403), 1));

  try {
    await assert.rejects(
      () =>
        encryptAndUploadE2eeAssetMultipart(input, {
          kind: 'original',
          frameSize,
          multipart,
          uploadConcurrency: 1,
          cryptoProvider: fakeAttachmentCryptoProvider(),
        }),
      /multipart_upload_url_expired/,
    );
    assert.equal(fake.requests.length, 1);
  } finally {
    Date.now = previousNow;
    fake.restore();
  }
});

test('E2EE multipart upload abort cancels all in-flight PUTs', async () => {
  const input = new Blob([new Uint8Array(96)]);
  const frameSize = 16;
  const multipart = multipartFor(estimateE2eeEncryptedAssetSize(input.size, frameSize), 50);
  const controller = new AbortController();
  let aborted = 0;
  const fake = installFakeXhr(
    (xhr) => {
      if (fake.requests.length === 2) setTimeout(() => controller.abort(), 1);
    },
    {
      onAbort: () => {
        aborted += 1;
      },
    },
  );

  try {
    await assert.rejects(
      () =>
        encryptAndUploadE2eeAssetMultipart(input, {
          kind: 'original',
          frameSize,
          multipart,
          uploadConcurrency: 2,
          cryptoProvider: fakeAttachmentCryptoProvider(),
          signal: controller.signal,
        }),
      /aborted/,
    );
    assert.equal(fake.requests.length, 2);
    assert.equal(aborted, 2);
  } finally {
    fake.restore();
  }
});
