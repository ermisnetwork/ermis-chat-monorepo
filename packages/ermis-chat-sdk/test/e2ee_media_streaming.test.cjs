const assert = require('node:assert/strict');
const test = require('node:test');

const {
  E2EE_MEDIA_STREAM_BASE_SESSION_CACHE_LIMIT,
  E2EE_MEDIA_STREAM_FULL_REPLAY_CACHE_LIMIT,
  E2EE_MEDIA_STREAM_PREFETCH_FRAMES,
  e2eeMediaFramePlainLength,
  e2eeMediaSessionCacheLimit,
  isE2eeMediaMsePlaybackAllowed,
  isE2eeMediaMsePlaybackEnabled,
  planE2eeMediaFrameBatch,
  probeE2eeMediaMp4ForMse,
} = require('../dist/index.cjs');

function box(type, payload = new Uint8Array()) {
  const bytes = new Uint8Array(8 + payload.length);
  const size = bytes.length;
  bytes[0] = (size >>> 24) & 0xff;
  bytes[1] = (size >>> 16) & 0xff;
  bytes[2] = (size >>> 8) & 0xff;
  bytes[3] = size & 0xff;
  for (let i = 0; i < 4; i += 1) bytes[4 + i] = type.charCodeAt(i);
  bytes.set(payload, 8);
  return bytes;
}

function bytes(value) {
  return new TextEncoder().encode(value);
}

function concat(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

test('E2EE media planner prefetches sequential ranges in 8-frame batches', () => {
  const plan = planE2eeMediaFrameBatch({
    currentFrame: 4,
    lastFrame: 40,
    rangeFrameSpan: 37,
  });
  assert.deepEqual(plan, {
    firstFrame: 4,
    lastFrame: 4 + E2EE_MEDIA_STREAM_PREFETCH_FRAMES - 1,
    prefetch: true,
  });
});

test('E2EE media planner keeps small/random ranges exact', () => {
  assert.deepEqual(
    planE2eeMediaFrameBatch({
      currentFrame: 9,
      lastFrame: 10,
      rangeFrameSpan: 2,
    }),
    { firstFrame: 9, lastFrame: 9, prefetch: false },
  );
});

test('E2EE media planner prefetches small ranges after sequential access is detected', () => {
  assert.deepEqual(
    planE2eeMediaFrameBatch({
      currentFrame: 11,
      lastFrame: 80,
      rangeFrameSpan: 1,
      sequentialHits: 2,
    }),
    { firstFrame: 11, lastFrame: 18, prefetch: true },
  );
});

test('E2EE media planner does not slide prefetch window inside cached batch', () => {
  assert.deepEqual(
    planE2eeMediaFrameBatch({
      currentFrame: 12,
      lastFrame: 80,
      rangeFrameSpan: 1,
      sequentialHits: 3,
      prefetchedUntilFrame: 18,
    }),
    { firstFrame: 12, lastFrame: 12, prefetch: true },
  );
});

test('E2EE media planner prefetches no-range sequential playback', () => {
  assert.deepEqual(
    planE2eeMediaFrameBatch({
      currentFrame: 0,
      lastFrame: 3,
      noRange: true,
    }),
    { firstFrame: 0, lastFrame: 3, prefetch: true },
  );
});

test('E2EE media planner opens next batch only after cached prefetch is passed', () => {
  assert.deepEqual(
    planE2eeMediaFrameBatch({
      currentFrame: 8,
      lastFrame: 80,
      noRange: true,
      prefetchedUntilFrame: 7,
    }),
    { firstFrame: 8, lastFrame: 15, prefetch: true },
  );
});

test('E2EE media frame length maps the last partial frame', () => {
  assert.equal(
    e2eeMediaFramePlainLength({
      frameIndex: 2,
      frameSize: 256 * 1024,
      plaintextSize: 2 * 256 * 1024 + 123,
    }),
    123,
  );
});

test('E2EE media session cache keeps replay-sized videos in memory only', () => {
  const oneHundredMiB = 100 * 1024 * 1024;
  assert.equal(e2eeMediaSessionCacheLimit({ plaintextSize: oneHundredMiB }), oneHundredMiB);
  assert.equal(
    e2eeMediaSessionCacheLimit({ plaintextSize: E2EE_MEDIA_STREAM_FULL_REPLAY_CACHE_LIMIT + 1 }),
    E2EE_MEDIA_STREAM_BASE_SESSION_CACHE_LIMIT,
  );
});

test('E2EE media MSE flag requires streaming flag as prerequisite', () => {
  assert.equal(isE2eeMediaMsePlaybackEnabled({ streamingEnabled: false, mseEnabled: true }), false);
  assert.equal(isE2eeMediaMsePlaybackEnabled({ streamingEnabled: true, mseEnabled: true }), true);
});

test('E2EE media MSE gate excludes iOS WebKit and requires codec support', () => {
  const mediaSource = {
    isTypeSupported(mimeType) {
      return mimeType === 'video/mp4; codecs="avc1.64001f, mp4a.40.2"';
    },
  };
  assert.equal(
    isE2eeMediaMsePlaybackAllowed({
      streamingEnabled: true,
      mseEnabled: true,
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      mediaSource,
      codecMimeType: 'video/mp4; codecs="avc1.64001f, mp4a.40.2"',
    }),
    false,
  );
  assert.equal(
    isE2eeMediaMsePlaybackAllowed({
      streamingEnabled: true,
      mseEnabled: true,
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      mediaSource,
      codecMimeType: 'video/mp4; codecs="hvc1.1.6.L93.B0"',
    }),
    false,
  );
  assert.equal(
    isE2eeMediaMsePlaybackAllowed({
      streamingEnabled: true,
      mseEnabled: true,
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      mediaSource,
      codecMimeType: 'video/mp4; codecs="avc1.64001f, mp4a.40.2"',
    }),
    true,
  );
});

test('E2EE media MP4 probe accepts fMP4 H.264/AAC', () => {
  const probe = probeE2eeMediaMp4ForMse({
    bytes: concat(box('ftyp', bytes('isom')), box('moov', bytes('avc1 mp4a')), box('moof'), box('mdat', bytes('x'))),
    mimeType: 'video/mp4',
    fileName: 'clip.mp4',
  });
  assert.equal(probe.ok, true);
  assert.equal(probe.codecMimeType, 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"');
});

test('E2EE media MP4 probe rejects non-fragmented MP4, MOV, HEVC, and missing moov', () => {
  assert.equal(
    probeE2eeMediaMp4ForMse({
      bytes: concat(box('ftyp', bytes('isom')), box('moov', bytes('avc1 mp4a')), box('mdat', bytes('x'))),
      mimeType: 'video/mp4',
    }).reason,
    'moof_missing',
  );
  assert.equal(
    probeE2eeMediaMp4ForMse({
      bytes: concat(box('ftyp', bytes('qt  ')), box('moov', bytes('avc1 mp4a')), box('moof'), box('mdat')),
      mimeType: 'video/quicktime',
      fileName: 'clip.mov',
    }).reason,
    'mov_unsupported',
  );
  assert.equal(
    probeE2eeMediaMp4ForMse({
      bytes: concat(box('ftyp', bytes('isom')), box('moov', bytes('hvc1 mp4a')), box('moof'), box('mdat')),
      mimeType: 'video/mp4',
    }).reason,
    'hevc_unsupported',
  );
  assert.equal(
    probeE2eeMediaMp4ForMse({
      bytes: concat(box('ftyp', bytes('isom')), box('moof'), box('mdat')),
      mimeType: 'video/mp4',
    }).reason,
    'moov_missing_in_probe',
  );
});
