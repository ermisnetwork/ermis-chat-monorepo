import type {MlsCleanupState, ProviderStorageCheckpoint, ProviderWriteGuard} from './types';
import type {RecoveryControlCheckpoint} from './recovery_control';
import type {GroupInfoValidationAckCheckpoint, GroupInfoValidationAdmission} from './validation_ack';

export type E2eeCommonState = 'pending_external_join' | 'repairing' | 'manual_intervention_required' | 'upgrade_required' | 'ready';
/** Public metadata only; a snapshot is not permission to bypass an async Ready boundary. */
export interface E2eeStateSnapshot {
  cid: string;
  group_generation: number;
  state: E2eeCommonState;
  reason: string;
  retryable: boolean;
  stage?: 'identity'|'storage'|'state'|'epoch'|'group_info'|'checkpoint'|'ready';
  next_action?: 'retry'|'sync'|'upload_group_info'|'continue_recovery'|'wait_for_evidence'|'upgrade'|'report_error'|'none';
  recovery_revision: string | null;
  provider_revision: string | null;
  epoch: number | null;
}
export interface MlsReadyBase extends ProviderStorageCheckpoint {
  identity_bytes: Uint8Array | null;
  cleanup: MlsCleanupState;
  control: RecoveryControlCheckpoint | null;
  ack: GroupInfoValidationAckCheckpoint | null;
  admission: GroupInfoValidationAdmission | null;
  admission_pending: GroupInfoValidationAdmission | null;
  admission_paused: {job_id: string; reason: 'manual_intervention_required'} | null;
  ready: E2eeStateSnapshot | null;
}
export interface MlsReadyCheckpoint {
  user_id: string;
  device_id: string;
  cid: string;
  expected: MlsReadyBase;
  provider_write_guard: ProviderWriteGuard;
  /** Opt-in private-noop Ready admission: full CAS/readback, unchanged provider revision. */
  provider_observation?: true;
  snapshot: E2eeStateSnapshot;
  admission: GroupInfoValidationAdmission | null;
  /** Joined-external Ready additionally proves exact canonical receipt/Welcome records. */
  external_join_base?: import('./external_join_work').ExternalJoinWorkBase;
}
export const sameE2eeSnapshot = (a: E2eeStateSnapshot | null, b: E2eeStateSnapshot): boolean =>
  !!a && a.cid===b.cid && a.group_generation===b.group_generation && a.state===b.state && a.reason===b.reason &&
  a.retryable===b.retryable && a.recovery_revision===b.recovery_revision && a.provider_revision===b.provider_revision && a.epoch===b.epoch && a.stage===b.stage && a.next_action===b.next_action;

/** Private read set stays in memory; only the public ACK and its due row are written. */
export interface ValidationAckWorkBase {state: MlsReadyBase; pending: GroupInfoValidationAckCheckpoint | null}

/** Public admission transition; the complete private read set remains captured in memory. */
export type ValidationAdmissionWorkChange =
  | {kind:'reserve'; job:GroupInfoValidationAdmission; now:number}
  | {kind:'finish'; job_id:string; attempt:number; prepared:boolean}
  | {kind:'defer'; now:number; pause:boolean};
