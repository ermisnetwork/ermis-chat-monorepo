export const E2EE_MEDIA_STREAM_PREFETCH_FRAMES = 8;
export const E2EE_MEDIA_STREAM_PREFETCH_THRESHOLD_FRAMES = 2;
export const E2EE_MEDIA_STREAM_SEQUENTIAL_PREFETCH_HITS = 2;
export const E2EE_MEDIA_STREAM_BASE_SESSION_CACHE_LIMIT = 16 * 1024 * 1024;
export const E2EE_MEDIA_STREAM_FULL_REPLAY_CACHE_LIMIT = 128 * 1024 * 1024;
export const E2EE_MEDIA_STREAM_GLOBAL_CACHE_LIMIT = 256 * 1024 * 1024;

export type E2eeMediaFrameBatchPlan = {
  firstFrame: number;
  lastFrame: number;
  prefetch: boolean;
};

export type E2eeMediaFrameBatchPlanInput = {
  currentFrame: number;
  lastFrame: number;
  rangeFrameSpan?: number;
  noRange?: boolean;
  sequentialHits?: number;
  prefetchedUntilFrame?: number;
  prefetchFrames?: number;
  prefetchThresholdFrames?: number;
  sequentialPrefetchHits?: number;
};

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

export function planE2eeMediaFrameBatch(input: E2eeMediaFrameBatchPlanInput): E2eeMediaFrameBatchPlan {
  const currentFrame = nonNegativeInteger(input.currentFrame, 'currentFrame');
  const lastFrame = nonNegativeInteger(input.lastFrame, 'lastFrame');
  if (currentFrame > lastFrame) throw new Error('currentFrame must be <= lastFrame');

  const prefetchFrames = positiveInteger(input.prefetchFrames || E2EE_MEDIA_STREAM_PREFETCH_FRAMES, 'prefetchFrames');
  const prefetchThresholdFrames = positiveInteger(
    input.prefetchThresholdFrames || E2EE_MEDIA_STREAM_PREFETCH_THRESHOLD_FRAMES,
    'prefetchThresholdFrames',
  );
  const sequentialPrefetchHits = positiveInteger(
    input.sequentialPrefetchHits || E2EE_MEDIA_STREAM_SEQUENTIAL_PREFETCH_HITS,
    'sequentialPrefetchHits',
  );
  const sequentialHits =
    input.sequentialHits === undefined ? 0 : nonNegativeInteger(input.sequentialHits, 'sequentialHits');
  const prefetchedUntilFrame =
    input.prefetchedUntilFrame === undefined
      ? -1
      : nonNegativeInteger(input.prefetchedUntilFrame, 'prefetchedUntilFrame');
  const rangeFrameSpan =
    input.rangeFrameSpan === undefined
      ? lastFrame - currentFrame + 1
      : positiveInteger(input.rangeFrameSpan, 'rangeFrameSpan');
  const prefetch =
    Boolean(input.noRange) || rangeFrameSpan > prefetchThresholdFrames || sequentialHits >= sequentialPrefetchHits;
  const shouldExtendPrefetch = prefetch && currentFrame > prefetchedUntilFrame;

  return {
    firstFrame: currentFrame,
    lastFrame: shouldExtendPrefetch ? Math.min(lastFrame, currentFrame + prefetchFrames - 1) : currentFrame,
    prefetch,
  };
}

export function e2eeMediaFramePlainLength(input: {
  frameIndex: number;
  frameSize: number;
  plaintextSize: number;
}): number {
  const frameIndex = nonNegativeInteger(input.frameIndex, 'frameIndex');
  const frameSize = positiveInteger(input.frameSize, 'frameSize');
  const plaintextSize = nonNegativeInteger(input.plaintextSize, 'plaintextSize');
  const start = frameIndex * frameSize;
  return Math.max(0, Math.min(frameSize, plaintextSize - start));
}

export function e2eeMediaSessionCacheLimit(input: {
  plaintextSize: number;
  baseSessionCacheLimit?: number;
  fullReplayCacheLimit?: number;
}): number {
  const plaintextSize = nonNegativeInteger(input.plaintextSize, 'plaintextSize');
  const baseSessionCacheLimit = positiveInteger(
    input.baseSessionCacheLimit || E2EE_MEDIA_STREAM_BASE_SESSION_CACHE_LIMIT,
    'baseSessionCacheLimit',
  );
  const fullReplayCacheLimit = positiveInteger(
    input.fullReplayCacheLimit || E2EE_MEDIA_STREAM_FULL_REPLAY_CACHE_LIMIT,
    'fullReplayCacheLimit',
  );
  if (plaintextSize > 0 && plaintextSize <= fullReplayCacheLimit) {
    return Math.max(baseSessionCacheLimit, plaintextSize);
  }
  return baseSessionCacheLimit;
}
