import type {ExternalJoinCandidateCheckpoint, ExternalJoinReceipt} from './types';
import {sha256Hex} from './sha256';

/** Only the exact authenticated server rejection permits dropping a private candidate. */
export function validateExternalJoinRejection(job: ExternalJoinCandidateCheckpoint, receipt: ExternalJoinReceipt, now = Date.now()): void {
  const equal = (a: Uint8Array | null | undefined, b: Uint8Array | null | undefined) => {
    if (a == null || b == null) return a == null && b == null;
    return a instanceof Uint8Array && b instanceof Uint8Array && a.length === b.length && a.every((v,i) => v === b[i]);
  };
  const rejectedAt = typeof receipt?.rejected_at === 'string' && receipt.rejected_at.length <= 64 ? Date.parse(receipt.rejected_at) : NaN;
  if (!Number.isSafeInteger(now) || now <= 0 || receipt?.version !== 1 || receipt.state !== 'rejected' ||
      receipt.operation_id !== job.body.operation_id || receipt.cid !== job.cid || receipt.rejection_reason !== 'head_conflict' ||
      receipt.delivery_pending !== false || receipt.event_id !== null || receipt.acceptance_context !== null ||
      receipt.group_generation !== job.marker.group_generation || receipt.epoch !== job.body.epoch ||
      !equal(receipt.group_id,job.marker.group_id) || receipt.commit_sha256 !== job.commit_sha256 ||
      (job.body.group_info !== undefined && (receipt.group_info_sha256 !== job.group_info_sha256 || sha256Hex(job.body.group_info) !== job.group_info_sha256)) ||
      !Number.isFinite(rejectedAt) || rejectedAt <= 0 || rejectedAt > now + 300_000 ||
      sha256Hex(job.body.commit) !== job.commit_sha256 || sha256Hex(job.base_provider_bytes) !== job.base_sha256 ||
      sha256Hex(job.candidate_provider_bytes) !== job.candidate_sha256) {
    const error = new Error('External Join rejection identity is invalid') as Error & {code:string};
    error.code = 'acceptance_metadata_invalid'; throw error;
  }
}
