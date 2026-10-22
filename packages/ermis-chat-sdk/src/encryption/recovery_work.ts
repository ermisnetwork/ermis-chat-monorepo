import type {RecoveryControlCheckpoint} from './recovery_control';
import type {MlsGroupGenerationMarker} from './types';
import type {GroupInfoValidationAdmission, GroupInfoValidationAckCheckpoint} from './validation_ack';

export type RecoveryWorkLane = 'discovery' | 'gi' | 'admission' | 'ack' | 'legacy_gi';
export interface RecoveryWorkScanRows {
  admission: GroupInfoValidationAdmission;
  ack: GroupInfoValidationAckCheckpoint;
}
export type RecoveryWorkScanLane = keyof RecoveryWorkScanRows;
/** Page selection only. All jobs, budgets and protocol cursors remain independent. */
export interface RecoveryWorkScanCheckpoint {
  version: 1;
  user_id: string;
  device_id: string;
  signing_identity_sha256: string;
  artifact_sha256: string;
  lane: RecoveryWorkScanLane;
  operation_id: string;
  after: string | null;
}
/** Captured before any await. Private bytes are witnesses only and are never journaled. */
export interface RecoveryWorkOwner {
  provider_bytes: Uint8Array;
  identity_bytes: Uint8Array;
  revision: string | null;
  signer: string;
  artifact: string;
  controls: Record<string, RecoveryControlCheckpoint | null>;
  markers: Record<string, MlsGroupGenerationMarker | null>;
}
/** Retains the exact public evidence. This is scheduling disposition, never MLS rejection. */
export interface RecoveryWorkDisposition {
  version: 1;
  lane: RecoveryWorkLane;
  source_key: string;
  primary_key: string | null;
  reason: 'corrupt' | 'upgrade' | 'scope' | 'index_mismatch' | 'superseded';
  source: unknown;
  primary: unknown;
  control: RecoveryControlCheckpoint | null;
  marker: MlsGroupGenerationMarker | null;
  /** Present only when replacing a known-v1 malformed selection pointer, never a job. */
  replacement?: RecoveryWorkScanCheckpoint;
}
