import type {MlsGenerationStateResponse} from './types';

export interface RecoveryControlCheckpoint {
  version: 1;
  user_id: string;
  device_id: string;
  signing_identity_sha256: string;
  cid: string;
  group_generation: number;
  /** Canonical generation binding from generation/discovery, absent in retained legacy controls. */
  group_id?: Uint8Array | null;
  incident_id: string | null;
  recovery_action: 'none' | 'repair' | 'waiting_for_evidence' | 'manual_intervention_required';
  recovery_revision: string;
  repair_retry_until: string | null;
}

export const recoveryControlError = (code = 'recovery_metadata_invalid'): Error & {code: string} => {
  const error = new Error(`[Encryption] ${code}`) as Error & {code: string};error.code=code;return error;
};

export function validRecoveryRevision(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n;
}

export function validateRecoveryControl(record: RecoveryControlCheckpoint): void {
  const text=(v:unknown,max:number):v is string=>typeof v==='string' && v.length>0 && new TextEncoder().encode(v).length<=max && !/[\u0000-\u001f\u007f]/.test(v);
  if (!record || record.version!==1 || !text(record.user_id,512) || !text(record.device_id,256) || !text(record.cid,512) ||
      typeof record.signing_identity_sha256!=='string' || !/^[0-9a-f]{64}$/.test(record.signing_identity_sha256) ||
      !Number.isSafeInteger(record.group_generation) || record.group_generation<0 || !validRecoveryRevision(record.recovery_revision) ||
      (record.group_id!==undefined && (record.group_id===null ? record.group_generation>0 :
        !(record.group_id instanceof Uint8Array) || record.group_id.length<1 || record.group_id.length>255 || record.group_generation===0)) ||
      !['none','repair','waiting_for_evidence','manual_intervention_required'].includes(record.recovery_action) ||
      (record.incident_id!==null && (typeof record.incident_id!=='string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(record.incident_id))) ||
      (record.repair_retry_until!==null && (typeof record.repair_retry_until!=='string' ||
        record.repair_retry_until.length>40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|\+00:00)$/.test(record.repair_retry_until) ||
        !Number.isFinite(Date.parse(record.repair_retry_until)) || Date.parse(record.repair_retry_until)<=0)) ||
      (record.recovery_action!=='none' && !record.incident_id)) throw recoveryControlError();
}

export function recoveryControlFromState(state: MlsGenerationStateResponse,
  scope: Pick<RecoveryControlCheckpoint,'cid'|'user_id'|'device_id'|'signing_identity_sha256'>): RecoveryControlCheckpoint | null {
  const fields=['incident_id','recovery_action','recovery_revision','repair_retry_until'] as const;
  if (fields.every(field=>state[field]===undefined)) return null;
  if(state.group_id!==undefined && state.group_id!==null && !(state.group_id instanceof Uint8Array))throw recoveryControlError();
  const record: RecoveryControlCheckpoint = {version:1,...scope,group_generation:state.group_generation,
    ...(state.group_id!==undefined?{group_id:state.group_id===null?null:new Uint8Array(state.group_id)}:{}),
    incident_id:state.incident_id!,recovery_action:state.recovery_action!,recovery_revision:state.recovery_revision!,
    repair_retry_until:state.repair_retry_until!};
  validateRecoveryControl(record);return record;
}

/** Return the monotone snapshot. A revision identifies one immutable control state. */
export function selectRecoveryControl(previous: RecoveryControlCheckpoint | null, next: RecoveryControlCheckpoint): RecoveryControlCheckpoint {
  validateRecoveryControl(next);
  if (!previous) return next;
  validateRecoveryControl(previous);
  if (previous.cid!==next.cid || previous.user_id!==next.user_id || previous.device_id!==next.device_id ||
      previous.signing_identity_sha256!==next.signing_identity_sha256) return next;
  if (next.group_generation<previous.group_generation ||
      (next.group_generation===previous.group_generation && BigInt(next.recovery_revision)<BigInt(previous.recovery_revision))) return previous;
  const bound=(a:Uint8Array|null|undefined,b:Uint8Array|null|undefined)=>a===null?b===null:
    !!a && !!b && a.length===b.length && a.every((v,i)=>v===b[i]);
  if(next.group_generation===previous.group_generation && previous.group_id!==undefined && next.group_id!==undefined &&
      !bound(previous.group_id,next.group_id))throw recoveryControlError('recovery_generation_binding_conflict');
  if (next.group_generation===previous.group_generation && next.recovery_revision===previous.recovery_revision &&
      (next.incident_id!==previous.incident_id || next.recovery_action!==previous.recovery_action || next.repair_retry_until!==previous.repair_retry_until)) {
    throw recoveryControlError('recovery_revision_conflict');
  }
  if (next.group_generation===previous.group_generation && next.recovery_revision===previous.recovery_revision)
    return previous.group_id===undefined && next.group_id!==undefined ? {...previous,group_id:next.group_id} : previous;
  return next.group_generation===previous.group_generation && next.group_id===undefined && previous.group_id!==undefined ? {...next,group_id:previous.group_id} : next;
}

/** Numeric generation alone never establishes a nonzero canonical GroupId. */
export function recoveryControlGroupMatches(control:RecoveryControlCheckpoint|null|undefined,
  marker:{cid:string;group_generation:number;group_id?:Uint8Array|null}):boolean {
  return !!control && control.cid===marker.cid && control.group_generation===marker.group_generation &&
    (marker.group_generation===0 ? !marker.group_id && !control.group_id : !!marker.group_id && !!control.group_id &&
      marker.group_id.length===control.group_id.length && marker.group_id.every((v,i)=>v===control.group_id![i]));
}

/** New valid evidence can be checked after a request window closes. */
export const acceptsRecoveryEvidence=(action:string|undefined):boolean=>action==='repair'||action==='waiting_for_evidence';
