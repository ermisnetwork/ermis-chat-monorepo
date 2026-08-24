const assert = require('node:assert/strict');
const test = require('node:test');

const { ErmisChat } = require('../dist/index.cjs');

function makeChannel(post) {
  const client = ErmisChat.getInstance('presign-test-key', 'presign-test-project', 'https://chat.example.test', {
    browser: false,
  });
  client.userID = 'presign-user';
  client.user = { id: 'presign-user' };
  client.post = post;
  return client.channel('messaging', `presign-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function installFakeXhr({ missingEtag = false } = {}) {
  const requests = [];
  const previous = global.XMLHttpRequest;

  class FakeXMLHttpRequest {
    constructor() {
      this.upload = {};
      this.status = 0;
      this.headers = {};
    }

    open(method, url) {
      this.method = method;
      this.url = url;
    }

    setRequestHeader(name, value) {
      this.headers[name] = value;
    }

    getResponseHeader(name) {
      if (name.toLowerCase() !== 'etag' || missingEtag) return null;
      return `"etag-${this.url.split('/').pop()}"`;
    }

    send(body) {
      requests.push({ method: this.method, url: this.url, headers: this.headers, size: body.size ?? body.length });
      queueMicrotask(() => {
        this.upload.onprogress?.({ loaded: body.size ?? body.length, total: body.size ?? body.length });
        this.status = 200;
        this.onload?.();
      });
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

test('standard single presign includes file_size and confirms after upload', async () => {
  const xhr = installFakeXhr();
  const calls = [];
  const channel = makeChannel(async (url, payload) => {
    calls.push({ url, payload });
    if (url.endsWith('/file/presign')) {
      return {
        attachment_id: 'single-attachment',
        upload_mode: 'single',
        upload_url: 'https://storage.example.test/single',
      };
    }
    if (url.endsWith('/file/confirm')) return { file: 'https://cdn.example.test/single.png' };
    throw new Error(`Unexpected POST ${url}`);
  });

  try {
    const progress = [];
    const result = await channel.uploadFilePresigned(
      new Blob([new Uint8Array(12)], { type: 'image/png' }),
      'photo.png',
      'image/png',
      (value) => progress.push(value.percentage),
    );

    assert.equal(result.file, 'https://cdn.example.test/single.png');
    assert.equal(calls[0].payload.file_size, 12);
    assert.deepEqual(calls[1].payload, {
      attachment_id: 'single-attachment',
      file_name: 'photo.png',
      content_type: 'image/png',
    });
    assert.deepEqual(xhr.requests, [
      {
        method: 'PUT',
        url: 'https://storage.example.test/single',
        headers: { 'Content-Type': 'image/png' },
        size: 12,
      },
    ]);
    assert.equal(progress.at(-1), 100);
  } finally {
    xhr.restore();
  }
});

test('standard multipart presign uploads bounded chunks and confirms sorted ETags', async () => {
  const xhr = installFakeXhr();
  const calls = [];
  const channel = makeChannel(async (url, payload) => {
    calls.push({ url, payload });
    if (url.endsWith('/file/presign')) {
      return {
        attachment_id: 'multipart-attachment',
        upload_mode: 'multipart',
        upload_url: null,
        multipart: {
          upload_id: 'multipart-upload-id',
          part_size: 10,
          part_count: 3,
          parts: [
            { part_number: 3, upload_url: 'https://storage.example.test/part-3' },
            { part_number: 1, upload_url: 'https://storage.example.test/part-1' },
            { part_number: 2, upload_url: 'https://storage.example.test/part-2' },
          ],
        },
      };
    }
    if (url.endsWith('/file/confirm')) return { file: 'https://cdn.example.test/video.mp4' };
    throw new Error(`Unexpected POST ${url}`);
  });

  try {
    const progress = [];
    await channel.uploadFilePresigned(
      new Blob([new Uint8Array(25)], { type: 'video/mp4' }),
      'video.mp4',
      'video/mp4',
      (value) => progress.push(value.percentage),
    );

    assert.deepEqual(
      xhr.requests
        .map((request) => ({ url: request.url, size: request.size, contentType: request.headers['Content-Type'] }))
        .sort((a, b) => a.url.localeCompare(b.url)),
      [
        { url: 'https://storage.example.test/part-1', size: 10, contentType: 'application/octet-stream' },
        { url: 'https://storage.example.test/part-2', size: 10, contentType: 'application/octet-stream' },
        { url: 'https://storage.example.test/part-3', size: 5, contentType: 'application/octet-stream' },
      ],
    );
    assert.deepEqual(calls[1].payload, {
      attachment_id: 'multipart-attachment',
      file_name: 'video.mp4',
      content_type: 'video/mp4',
      multipart_upload_id: 'multipart-upload-id',
      parts: [
        { part_number: 1, etag: '"etag-part-1"' },
        { part_number: 2, etag: '"etag-part-2"' },
        { part_number: 3, etag: '"etag-part-3"' },
      ],
    });
    assert.equal(progress.at(-1), 100);
  } finally {
    xhr.restore();
  }
});

test('standard multipart upload refuses confirm when storage does not expose ETag', async () => {
  const xhr = installFakeXhr({ missingEtag: true });
  let confirmCalled = false;
  const channel = makeChannel(async (url) => {
    if (url.endsWith('/file/presign')) {
      return {
        attachment_id: 'missing-etag',
        upload_mode: 'multipart',
        multipart: {
          upload_id: 'missing-etag-upload',
          part_size: 10,
          part_count: 1,
          parts: [{ part_number: 1, upload_url: 'https://storage.example.test/no-etag' }],
        },
      };
    }
    if (url.endsWith('/file/confirm')) confirmCalled = true;
    return { file: 'unexpected' };
  });

  try {
    await assert.rejects(
      channel.uploadFilePresigned(
        new Blob([new Uint8Array(5)], { type: 'application/octet-stream' }),
        'binary.bin',
        'application/octet-stream',
      ),
      /did not expose ETag/,
    );
    assert.equal(confirmCalled, false);
  } finally {
    xhr.restore();
  }
});

test('standard attachment send inserts a local bubble before background upload completes', async () => {
  const previousXhr = global.XMLHttpRequest;
  const xhrInstances = [];

  class ControlledXMLHttpRequest {
    constructor() {
      this.upload = {};
      this.status = 0;
      xhrInstances.push(this);
    }

    open(method, url) {
      this.method = method;
      this.url = url;
    }

    setRequestHeader() {}

    send(body) {
      this.body = body;
    }
  }

  global.XMLHttpRequest = ControlledXMLHttpRequest;
  let releasePresign;
  const presignGate = new Promise((resolve) => {
    releasePresign = resolve;
  });
  const postedMessages = [];
  const channel = makeChannel(async (url, payload) => {
    if (url.endsWith('/file/presign')) return await presignGate;
    if (url.endsWith('/file/confirm')) return { file: 'https://cdn.example.test/local-preview.png' };
    if (url.endsWith('/message')) {
      postedMessages.push(payload.message);
      return {
        message: {
          ...payload.message,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          user: { id: 'presign-user' },
        },
      };
    }
    throw new Error(`Unexpected POST ${url}`);
  });

  try {
    const file = new File([new Uint8Array(10)], 'local-preview.png', { type: 'image/png' });
    const result = await channel.enqueueAttachmentMessage({ text: 'caption' }, [file]);
    const messageId = result.message.id;
    const optimistic = channel.state.messages.find((message) => message.id === messageId);

    assert.equal(optimistic.status, 'sending');
    assert.equal(optimistic.text, 'caption');
    assert.equal(optimistic.attachments[0].upload_progress, 0);
    assert.match(optimistic.attachments[0].image_url, /^blob:/);
    assert.equal(postedMessages.length, 0);

    releasePresign({
      attachment_id: 'optimistic-attachment',
      upload_mode: 'single',
      upload_url: 'https://storage.example.test/optimistic',
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(xhrInstances.length, 1);
    xhrInstances[0].upload.onprogress?.({ loaded: 5, total: 10 });
    assert.equal(
      channel.state.messages.find((message) => message.id === messageId).attachments[0].upload_progress,
      50,
    );

    xhrInstances[0].status = 200;
    xhrInstances[0].onload?.();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(postedMessages.length, 1);
    assert.equal(postedMessages[0].attachments[0].image_url, 'https://cdn.example.test/local-preview.png');
    assert.equal(channel.state.messages.find((message) => message.id === messageId).status, 'received');
  } finally {
    if (previousXhr === undefined) delete global.XMLHttpRequest;
    else global.XMLHttpRequest = previousXhr;
  }
});