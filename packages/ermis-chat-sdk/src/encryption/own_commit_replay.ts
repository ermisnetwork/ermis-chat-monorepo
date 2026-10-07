/** Own logical-device Commit replay. Mutation journals remain owned by the manager. */
export interface OwnCommitProtocol {
  epoch?: number;
  group_generation?: number;
  group_id?: Uint8Array;
  commit?: Uint8Array;
}

export interface OwnCommitReplayOptions {
  flushPending?: boolean;
  historicalReplay?: boolean;
  serverAcceptedAt?: string;
}

export type OwnCommitReplayReason = 'own_commit_unresolved' | 'own_commit_candidate_mismatch'
  | 'own_commit_unjournaled_candidate' | 'own_commit_no_candidate';

interface ReplayGroup {
  has_pending_commit?: () => boolean;
}

export interface OwnCommitReplayContext {
  reconcile: (protocol: OwnCommitProtocol) => Promise<void>;
  pendingKind: () => string | undefined;
  generation: () => { group_generation: number; group_id?: Uint8Array | null } | undefined;
  group: () => ReplayGroup | undefined;
  epoch: () => number;
  processCommit: (commit: Uint8Array, epoch: number, options: OwnCommitReplayOptions) => Promise<unknown>;
  diagnostic: (details: { groupEpoch: number; targetEpoch: number; result: 'pending'; reason: OwnCommitReplayReason }) => void;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/** Reconcile exact journal first; the logical device tag never substitutes for MLS authentication. */
export async function replayOwnCommit(
  context: OwnCommitReplayContext,
  protocol: OwnCommitProtocol,
  options: OwnCommitReplayOptions = {},
): Promise<void> {
  await context.reconcile(protocol);
  const pendingKind = context.pendingKind();
  if (pendingKind === 'topic_join' || pendingKind === 'external_join') {
    throw new Error('[Encryption] mls_mutation_outcome_pending: external Commit has not matched its candidate');
  }
  const marker = context.generation();
  if ((protocol.group_generation || 0) !== (marker?.group_generation || 0) ||
      ((marker?.group_generation || 0) > 0 &&
        (!protocol.group_id || !marker?.group_id || !bytesEqual(protocol.group_id, marker.group_id)))) {
    throw new Error('[Encryption] Own Commit generation identity does not match installed group');
  }
  const group = context.group();
  if (!group || !Number.isSafeInteger(protocol.epoch) || protocol.epoch! < 0) {
    throw new Error('[Encryption] Own Commit cannot be acknowledged without group and epoch');
  }
  if (context.epoch() >= protocol.epoch!) return;
  const reason: OwnCommitReplayReason = pendingKind ? 'own_commit_candidate_mismatch'
    : typeof group.has_pending_commit !== 'function' ? 'own_commit_unresolved'
    : group.has_pending_commit() ? 'own_commit_unjournaled_candidate' : 'own_commit_no_candidate';
  context.diagnostic({ groupEpoch: context.epoch(), targetEpoch: protocol.epoch!, result: 'pending', reason });
  // The restored group may use another leaf despite the stable logical device ID.
  // Process real bytes; an unrecoverable own Commit must retain provider/journal/cursor.
  try {
    await context.processCommit(protocol.commit as Uint8Array, protocol.epoch!, options);
  } catch (cause) {
    if ((cause as { code?: string })?.code) throw cause;
    const error = new Error('[Encryption] Own Commit cannot be replayed from installed state') as Error & {
      code: string; cause: unknown; repair_reason?: string;
    };
    error.code = 'mls_own_commit_unresolved';
    error.cause = cause;
    if (reason === 'own_commit_no_candidate') error.repair_reason = 'missing_own_commit_candidate';
    throw error;
  }
  if (context.epoch() < protocol.epoch!) {
    const error = new Error('[Encryption] Own Commit remains unapplied') as Error & { code: string };
    error.code = 'mls_protocol_epoch_gap';
    throw error;
  }
}
