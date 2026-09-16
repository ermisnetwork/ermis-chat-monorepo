import type {
  EncryptionStorageAdapter,
  MlsGenerationRecoveryResult,
  MlsRebootstrapReason,
  MlsRebootstrapState,
  MlsRebootstrapClaimIntent,
} from './types';

export interface MlsRebootstrapClaimBoundary {
  user_id: string;
  device_id: string;
  cid: string;
  expected_generation: number;
  expected_epoch: number;
}

const REBOOTSTRAP_STATES = new Set<MlsRebootstrapState>([
  'repairing',
  'eligible',
  'preparing',
  'activated',
  'cancelled_repair_won',
  'preparation_failed_retryable',
  'delivery_failed_retryable',
  'upgrade_required',
  'incompatible_server_client',
]);

const REBOOTSTRAP_REASONS = new Set<MlsRebootstrapReason>([
  'group_info_missing',
  'group_info_stale',
  'group_info_invalid',
  'repair_window_open',
  'repair_timeout_elapsed',
  'repair_won_race',
  'lease_unavailable',
  'lease_expired',
  'membership_changed',
  'generation_changed',
  'operation_conflict',
  'feature_disabled',
  'client_upgrade_required',
  'unsupported_protocol_version',
  'invalid_request',
  'infrastructure_unavailable',
  'delivery_pending',
  'history_incomplete',
]);

type HttpLikeError = {
  status?: number;
  response?: { status?: number; data?: unknown };
};

/** Convert only the allowlisted server envelope (or an unsupported route) to UI state. */
export function classifyMlsRebootstrapFailure(
  error: unknown,
  cid: string,
  fallbackGeneration: number,
  fallbackEpoch: number,
): MlsGenerationRecoveryResult {
  const candidate = error as HttpLikeError;
  const status = candidate?.response?.status ?? candidate?.status;
  if (status === 404 || status === 405 || status === 501) {
    return {
      cid,
      generation: fallbackGeneration,
      epoch: fallbackEpoch,
      status: 'client_upgrade_required',
      reason: 'unsupported_protocol_version',
      retryable: false,
    };
  }
  const data = candidate?.response?.data;
  if (data && typeof data === 'object') {
    const envelope = data as { state?: unknown; reason?: unknown; retryable?: unknown };
    if (
      typeof envelope.state === 'string' &&
      REBOOTSTRAP_STATES.has(envelope.state as MlsRebootstrapState) &&
      typeof envelope.reason === 'string' &&
      REBOOTSTRAP_REASONS.has(envelope.reason as MlsRebootstrapReason) &&
      typeof envelope.retryable === 'boolean'
    ) {
      const state = envelope.state as MlsRebootstrapState;
      const reason = envelope.reason as MlsRebootstrapReason;
      const resultStatus =
        state === 'upgrade_required' || state === 'incompatible_server_client'
          ? 'client_upgrade_required'
          : state === 'preparing'
            ? 'preparing'
            : state === 'repairing' || state === 'eligible' || state === 'cancelled_repair_won'
              ? 'waiting_for_repair'
              : 'retryable_infrastructure_failure';
      return {
        cid,
        generation: fallbackGeneration,
        epoch: fallbackEpoch,
        status: resultStatus,
        reason,
        retryable: envelope.retryable,
      };
    }
  }
  return {
    cid,
    generation: fallbackGeneration,
    epoch: fallbackEpoch,
    status: 'retryable_infrastructure_failure',
    reason: 'infrastructure_unavailable',
    retryable: true,
  };
}

/**
 * Persist the idempotency key before claim I/O. A restarted client must reuse
 * the key for the same authoritative generation/epoch, while a changed CAS
 * boundary invalidates the old intent before a new key is allocated.
 */
export async function resolveMlsRebootstrapClaimIntent(
  storage: EncryptionStorageAdapter,
  boundary: MlsRebootstrapClaimBoundary,
  createOperationKey: () => string,
  now: () => number = Date.now,
): Promise<MlsRebootstrapClaimIntent> {
  if (
    !storage.loadRebootstrapClaimIntent ||
    !storage.saveRebootstrapClaimIntent ||
    !storage.deleteRebootstrapClaimIntent
  ) {
    throw new Error('generation-aware storage does not support durable rebootstrap claim intent');
  }
  const existing = await storage.loadRebootstrapClaimIntent(boundary.cid);
  if (
    existing?.user_id === boundary.user_id &&
    existing.device_id === boundary.device_id &&
    existing.expected_generation === boundary.expected_generation &&
    existing.expected_epoch === boundary.expected_epoch &&
    existing.protocol_version === 1
  ) {
    return existing;
  }
  if (existing) await storage.deleteRebootstrapClaimIntent(boundary.cid);
  const intent: MlsRebootstrapClaimIntent = {
    ...boundary,
    operation_key: createOperationKey(),
    protocol_version: 1,
    created_at: now(),
  };
  await storage.saveRebootstrapClaimIntent(intent);
  return intent;
}
