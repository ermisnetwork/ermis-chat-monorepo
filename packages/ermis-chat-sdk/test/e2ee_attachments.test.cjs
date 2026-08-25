const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildE2eeMessageAadV1,
  canonicalAttachmentIds,
  ciphertextSha256,
  EncryptionManager,
  e2eeAttachmentMultipartUploadUrlExpiresAtMs,
  encryptAndUploadE2eeAssetMultipart,
  estimateE2eeEncryptedAssetSize,
  resolveE2eeAttachmentMultipartUploadConcurrency,
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

test('E2EE attachment progress is monotonic and reaches 100 only after complete succeeds', async () => {
  const manager = new EncryptionManager();
  manager._attachmentCryptoProvider = fakeAttachmentCryptoProvider();
  let completeSucceeded = false;
  manager.e2eeClient = {
    initAttachment: async () => ({
      attachment_id: 'attachment-progress',
      assets: [
        {
          asset_id: 'original-progress',
          kind: 'original',
          upload_mode: 'single_put',
          put_url: 'https://storage.example.test/e2ee-progress',
        },
      ],
    }),
    completeAttachment: async () => {
      completeSucceeded = true;
    },
    deleteAttachment: async () => {},
  };
  const progressValues = [];
  let observedPrematureHundred = false;
  const fake = installFakeXhr((xhr, body) => {
    xhr.upload.onprogress?.({ loaded: body.size, total: body.size });
    finishXhr(xhr, 200);
  });

  try {
    const file = new File([new Uint8Array(64)], 'progress.bin', {
      type: 'application/octet-stream',
    });
    await manager.uploadE2eeAttachments('messaging', 'progress', [file], {
      onProgress: (progress) => {
        progressValues.push(progress.percentage);
        if (progress.percentage === 100 && !completeSucceeded) observedPrematureHundred = true;
      },
    });

    assert.equal(observedPrematureHundred, false);
    assert.equal(progressValues.at(-1), 100);
    assert.ok(progressValues.includes(99));
    assert.ok(progressValues.every((value, index) => index === 0 || value >= progressValues[index - 1]));
  } finally {
    fake.restore();
  }
});

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

test('E2EE multipart upload reports encryption progress before the first PUT', async () => {
  const input = new Blob([new Uint8Array(64)]);
  const frameSize = 8;
  const totalCipherSize = estimateE2eeEncryptedAssetSize(input.size, frameSize);
  const multipart = multipartFor(totalCipherSize, totalCipherSize + 1);
  const progressEvents = [];
  let progressBeforeFirstPut = [];
  let progressBeforePutCompleted = [];
  const fake = installFakeXhr((xhr, body) => {
    progressBeforeFirstPut = [...progressEvents];
    xhr.upload.onprogress?.({ loaded: body.size, total: body.size });
    progressBeforePutCompleted = [...progressEvents];
    finishXhr(xhr, 200, 'etag-1');
  });

  try {
    await encryptAndUploadE2eeAssetMultipart(input, {
      kind: 'original',
      frameSize,
      multipart,
      uploadConcurrency: 1,
      cryptoProvider: fakeAttachmentCryptoProvider(),
      onProgress: (progress) => progressEvents.push(progress),
    });

    assert.ok(
      progressBeforeFirstPut.some(
        (progress) => progress.phase === 'encrypting' && progress.percentage > 0,
      ),
      'expected visible encryption progress before upload starts',
    );
    assert.equal(
      progressBeforePutCompleted.some((progress) => progress.percentage === 100),
      false,
    );
    assert.equal(progressEvents.at(-1).percentage, 100);
    assert.ok(
      progressEvents.every(
        (progress, index) => index === 0 || progress.percentage >= progressEvents[index - 1].percentage,
      ),
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

test('E2EE manager resumes missing multipart parts from a persisted F5 checkpoint', async () => {
  const file = new File([new Uint8Array(700_000)], 'resume.bin', {
    type: 'application/octet-stream',
    lastModified: 1234,
  });
  const totalCipherSize = estimateE2eeEncryptedAssetSize(file.size);
  const multipart = multipartFor(totalCipherSize, 300_000);
  let initCount = 0;
  let checkpoint;

  const firstManager = new EncryptionManager();
  firstManager._attachmentCryptoProvider = fakeAttachmentCryptoProvider();
  firstManager._e2eeAttachmentMultipartEnabled = true;
  firstManager._e2eeAttachmentMultipartUploadConcurrency = 1;
  firstManager.e2eeClient = {
    initAttachment: async () => {
      initCount += 1;
      return {
        attachment_id: 'resume-attachment',
        upload_expires_at: '2030-01-01T00:00:00.000Z',
        assets: [{
          asset_id: 'resume-original',
          kind: 'original',
          upload_mode: 'multipart',
          multipart,
          cipher_size_estimate: totalCipherSize,
        }],
      };
    },
    completeAttachment: async () => { throw new Error('complete must not run before all parts upload'); },
    deleteAttachment: async () => {},
  };

  const firstXhr = installFakeXhr((xhr) => {
    const partNumber = partNumberFromUrl(xhr.url);
    finishXhr(xhr, partNumber === 2 ? 500 : 200, partNumber === 2 ? undefined : `etag-${partNumber}`);
  });
  try {
    await assert.rejects(
      firstManager.uploadE2eeAttachments('messaging', 'resume', [file], {
        onCheckpointChange: async (_fileIndex, nextCheckpoint) => { checkpoint = structuredClone(nextCheckpoint); },
      }),
    );
  } finally {
    firstXhr.restore();
  }

  assert.ok(checkpoint);
  assert.deepEqual(checkpoint.original.completed_parts, [{ part_number: 1, etag: 'etag-1' }]);
  const persistedLease = checkpoint.completion_lease_id;
  const persistedKey = checkpoint.original.content_key;
  let completeRequest;

  const resumedManager = new EncryptionManager();
  resumedManager._attachmentCryptoProvider = fakeAttachmentCryptoProvider();
  resumedManager._e2eeAttachmentMultipartEnabled = true;
  resumedManager._e2eeAttachmentMultipartUploadConcurrency = 1;
  resumedManager.e2eeClient = {
    initAttachment: async () => {
      initCount += 1;
      throw new Error('resume must reuse the persisted init session');
    },
    completeAttachment: async (_channelType, _channelId, _attachmentId, request) => { completeRequest = request; },
    deleteAttachment: async () => {},
  };

  const resumedXhr = installFakeXhr((xhr) => {
    const partNumber = partNumberFromUrl(xhr.url);
    finishXhr(xhr, 200, `etag-${partNumber}`);
  });
  try {
    const result = await resumedManager.uploadE2eeAttachments('messaging', 'resume', [file], {
      resumeCheckpoints: [checkpoint],
      onCheckpointChange: async (_fileIndex, nextCheckpoint) => { checkpoint = structuredClone(nextCheckpoint); },
    });
    assert.equal(result.attachments[0].assets[0].content_key, persistedKey);
  } finally {
    resumedXhr.restore();
  }

  assert.equal(initCount, 1);
  assert.deepEqual(resumedXhr.requests.map((xhr) => partNumberFromUrl(xhr.url)), [2, 3]);
  assert.equal(completeRequest.completion_lease_id, persistedLease);
  assert.deepEqual(completeRequest.assets[0].multipart.parts, [
    { part_number: 1, etag: 'etag-1' },
    { part_number: 2, etag: 'etag-2' },
    { part_number: 3, etag: 'etag-3' },
  ]);
});

test('E2EE manager discards an expired checkpoint and starts with a fresh session', async () => {
  const file = new File([new Uint8Array(64)], 'expired.bin', { type: 'application/octet-stream', lastModified: 9 });
  const totalCipherSize = estimateE2eeEncryptedAssetSize(file.size);
  const oldMultipart = multipartFor(totalCipherSize, 50);
  const expiredCheckpoint = {
    version: 1,
    file: { name: file.name, size: file.size, type: file.type, last_modified: file.lastModified },
    attachment_id: 'expired-attachment',
    upload_expires_at: '2020-01-01T00:00:00.000Z',
    init: {
      attachment_id: 'expired-attachment',
      upload_expires_at: '2020-01-01T00:00:00.000Z',
      assets: [{ asset_id: 'expired-original', kind: 'original', upload_mode: 'multipart', multipart: oldMultipart }],
    },
    original: {
      content_key: Buffer.alloc(32).toString('base64'),
      nonce_prefix: Buffer.alloc(8).toString('base64'),
      frame_size: 256 * 1024,
      completed_parts: [{ part_number: 1, etag: 'old-etag' }],
    },
    completion_lease_id: 'expired-lease',
  };
  const deleted = [];
  const checkpointChanges = [];
  let initCount = 0;
  const manager = new EncryptionManager();
  manager._attachmentCryptoProvider = fakeAttachmentCryptoProvider();
  manager._e2eeAttachmentMultipartEnabled = true;
  manager.e2eeClient = {
    initAttachment: async () => {
      initCount += 1;
      return {
        attachment_id: 'fresh-attachment',
        upload_expires_at: '2030-01-01T00:00:00.000Z',
        assets: [{
          asset_id: 'fresh-original',
          kind: 'original',
          upload_mode: 'single_put',
          put_url: 'https://storage.example.test/fresh-upload',
          cipher_size_estimate: totalCipherSize,
        }],
      };
    },
    completeAttachment: async () => {},
    deleteAttachment: async (_channelType, _channelId, attachmentId) => { deleted.push(attachmentId); },
  };
  const fake = installFakeXhr((xhr, body) => {
    xhr.upload.onprogress?.({ loaded: body.size, total: body.size });
    finishXhr(xhr, 200);
  });
  try {
    await manager.uploadE2eeAttachments('messaging', 'expired', [file], {
      resumeCheckpoints: [expiredCheckpoint],
      onCheckpointChange: async (_fileIndex, checkpoint) => { checkpointChanges.push(checkpoint); },
    });
  } finally {
    fake.restore();
  }
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(initCount, 1);
  assert.deepEqual(checkpointChanges, [undefined]);
  assert.deepEqual(deleted, ['expired-attachment']);
  assert.deepEqual(fake.requests.map((xhr) => xhr.url), ['https://storage.example.test/fresh-upload']);
});
