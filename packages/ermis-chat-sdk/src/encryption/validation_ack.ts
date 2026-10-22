import {sha256Hex} from './sha256';
import {acceptsRecoveryEvidence, recoveryControlError, recoveryControlGroupMatches, validRecoveryRevision, validateRecoveryControl} from './recovery_control';
import type {RecoveryControlCheckpoint} from './recovery_control';
import type {MlsGroupGenerationMarker} from './types';

export interface GroupInfoValidationAckRequest {
  version: 1;
  cid: string;
  group_generation: number;
  epoch: number;
  hash: string;
  incident_id: string;
}
export interface GroupInfoValidationAckResponse {
  accepted: true;
  idempotent: boolean;
  recovery_action: 'none';
  recovery_revision: string;
}

/** Public, durable admission budget before fetching GI. Control records retain unadmitted intent. */
export interface GroupInfoValidationAdmission {
  version: 1;
  job_id: string;
  user_id: string;
  device_id: string;
  signing_identity_sha256: string;
  cid: string;
  group_generation: number;
  epoch: number;
  incident_id: string;
  recovery_revision: string;
  artifact_sha256: string;
  policy: 'verify' | 'allow_expired';
  /** Omitted for automatic legacy jobs; manual requires explicit local intent. */
  trigger?: 'manual';
  attempts: number;
  retry_at: number;
  outcome: 'pending' | 'prepared' | 'exhausted';
}
/** Public validation evidence only; never contains provider/tree/identity bytes. */
export interface GroupInfoValidationAckCheckpoint {
  version: 1;
  job_id: string;
  user_id: string;
  device_id: string;
  signing_identity_sha256: string;
  request: GroupInfoValidationAckRequest;
  recovery_revision: string;
  marker: MlsGroupGenerationMarker;
  provider_sha256: string;
  artifact_sha256: string;
  policy: 'verify' | 'allow_expired';
  /** Omitted for automatic legacy jobs; manual requires explicit local intent. */
  trigger?: 'manual';
  attempts: number;
  retry_at: number;
  outcome: 'pending' | 'accepted' | 'stale' | 'exhausted';
}

const uuid=(s:unknown):s is string=>typeof s==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const digest=(s:unknown):s is string=>typeof s==='string' && /^[0-9a-f]{64}$/.test(s);
const bounded=(s:unknown,max:number):s is string=>typeof s==='string' && s.length>0 &&
  new TextEncoder().encode(s).length<=max && !/[\u0000-\u001f\u007f]/.test(s);

export function validateValidationAdmission(job:GroupInfoValidationAdmission):void {
  if(!job || job.version!==1 || !uuid(job.job_id) || !bounded(job.user_id,512) || !bounded(job.device_id,256) ||
      !bounded(job.cid,512) || !digest(job.signing_identity_sha256) || !digest(job.artifact_sha256) || !uuid(job.incident_id) ||
      !Number.isSafeInteger(job.group_generation) || job.group_generation<0 || !Number.isSafeInteger(job.epoch) || job.epoch<0 ||
      (job.trigger!==undefined && job.trigger!=='manual') || !validRecoveryRevision(job.recovery_revision) || !['verify','allow_expired'].includes(job.policy) ||
      !Number.isSafeInteger(job.attempts) || job.attempts<0 || job.attempts>3 || !Number.isSafeInteger(job.retry_at) || job.retry_at<=0 ||
      !['pending','prepared','exhausted'].includes(job.outcome))throw recoveryControlError('validation_ack_admission_invalid');
}

/** Complete known v1 scheduling value, independent of object property order. */
export function sameValidationAdmissionCheckpoint(a: GroupInfoValidationAdmission, b: GroupInfoValidationAdmission): boolean {
  return sameValidationAdmission(a,b) && a.version===b.version && a.job_id===b.job_id && a.attempts===b.attempts && a.retry_at===b.retry_at && a.outcome===b.outcome;
}

export function sameValidationAdmission(a:GroupInfoValidationAdmission,b:GroupInfoValidationAdmission):boolean {
  return a.user_id===b.user_id && a.device_id===b.device_id && a.signing_identity_sha256===b.signing_identity_sha256 &&
    a.cid===b.cid && a.group_generation===b.group_generation && a.epoch===b.epoch && a.incident_id===b.incident_id &&
    a.recovery_revision===b.recovery_revision && a.artifact_sha256===b.artifact_sha256 && a.policy===b.policy && a.trigger===b.trigger;
}

export function validateValidationAckCheckpoint(job: GroupInfoValidationAckCheckpoint): void {
  const request=job?.request,marker=job?.marker;
  if (!job || job.version!==1 || !uuid(job.job_id) || !bounded(job.user_id,512) || !bounded(job.device_id,256) ||
      !digest(job.signing_identity_sha256) || !request || request.version!==1 || !bounded(request.cid,512) ||
      !uuid(request.incident_id) || !digest(request.hash) || !Number.isSafeInteger(request.group_generation) || request.group_generation<0 ||
      !Number.isSafeInteger(request.epoch) || request.epoch<0 || !validRecoveryRevision(job.recovery_revision) ||
      (job.trigger!==undefined && job.trigger!=='manual') || !digest(job.provider_sha256) || !digest(job.artifact_sha256) || !['verify','allow_expired'].includes(job.policy) ||
      !Number.isSafeInteger(job.attempts) || job.attempts<0 || job.attempts>3 || !Number.isSafeInteger(job.retry_at) || job.retry_at<=0 ||
      !['pending','accepted','stale','exhausted'].includes(job.outcome) || !marker || marker.cid!==request.cid ||
      marker.group_generation!==request.group_generation || marker.current_epoch!==request.epoch || marker.status!=='active' ||
      (marker.group_id!==null && (!(marker.group_id instanceof Uint8Array) || marker.group_id.length<1 || marker.group_id.length>255)) ||
      (marker.group_generation>0 && !marker.group_id)) throw recoveryControlError('validation_ack_checkpoint_invalid');
}

export function sameValidationAckTuple(a: GroupInfoValidationAckCheckpoint,b: GroupInfoValidationAckCheckpoint): boolean {
  return a.user_id===b.user_id && a.device_id===b.device_id && a.signing_identity_sha256===b.signing_identity_sha256 &&
    a.request.cid===b.request.cid && a.request.group_generation===b.request.group_generation && a.request.epoch===b.request.epoch &&
    a.request.hash===b.request.hash && a.request.incident_id===b.request.incident_id && a.recovery_revision===b.recovery_revision &&
    a.policy===b.policy && a.artifact_sha256===b.artifact_sha256 && a.trigger===b.trigger;
}

export function validationAckMarkerMatches(job: GroupInfoValidationAckCheckpoint,marker: MlsGroupGenerationMarker | null): boolean {
  return !!marker && marker.status==='active' && marker.cid===job.request.cid && marker.group_generation===job.request.group_generation &&
    marker.current_epoch===job.request.epoch && sha256Hex(marker.group_id || new Uint8Array())===sha256Hex(job.marker.group_id || new Uint8Array());
}

export function validationAckControlMatches(job: GroupInfoValidationAckCheckpoint,control: RecoveryControlCheckpoint | null): boolean {
  if (!control) return false;
  validateRecoveryControl(control);
  return control.user_id===job.user_id && control.device_id===job.device_id && control.signing_identity_sha256===job.signing_identity_sha256 &&
    control.cid===job.request.cid && control.group_generation===job.request.group_generation && control.incident_id===job.request.incident_id &&
    control.recovery_revision===job.recovery_revision &&
    (job.request.group_generation===0 || recoveryControlGroupMatches(control,job.marker)) &&
    (job.trigger==='manual'?control.recovery_action==='manual_intervention_required':acceptsRecoveryEvidence(control.recovery_action));
}

export function validValidationAckResponse(raw: GroupInfoValidationAckResponse,job: GroupInfoValidationAckCheckpoint): boolean {
  return !!raw && raw.accepted===true && typeof raw.idempotent==='boolean' && raw.recovery_action==='none' &&
    validRecoveryRevision(raw.recovery_revision) && BigInt(raw.recovery_revision)>BigInt(job.recovery_revision);
}
