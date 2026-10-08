import type { EncryptionManagerOptions, MlsRolloutMetricObservation } from './types';

export interface ResolvedMlsRolloutControls {
  historicalReplay: boolean;
  partialWelcomeFallback: boolean;
  groupInfoRepair: boolean;
  clientTelemetry: boolean;
  emitMetric: ((observation: MlsRolloutMetricObservation) => void) | null;
}

export function resolveMlsRolloutControls(options?: EncryptionManagerOptions): ResolvedMlsRolloutControls {
  return {
    historicalReplay: options?.enableHistoricalReplay !== false,
    partialWelcomeFallback: options?.enablePartialWelcomeFallback !== false,
    groupInfoRepair: options?.enableGroupInfoRepair !== false,
    clientTelemetry: options?.enableMlsRolloutTelemetry === true,
    emitMetric: options?.onMlsRolloutMetric ?? null,
  };
}

export function emitMlsRolloutMetricSafely(
  observer: ((observation: MlsRolloutMetricObservation) => void) | null,
  observation: MlsRolloutMetricObservation,
  onFailure: (category: 'callback_exception') => void,
): void {
  try {
    observer?.(observation);
  } catch {
    onFailure('callback_exception');
  }
}
