import type {MlsReadyBase} from './common_state';
import {recoveryControlError, validRecoveryRevision} from './recovery_control';

/** Public channel summary. It is an observation, never a private-state Ready proof. */
export interface ChannelE2ee {
  cid:string; group_generation:number|null; group_id:string|null; epoch:number|null;
  group_info:{refresh_requested?:boolean;status:'ready'|'missing'|'stale'|'validation_required'|'unavailable';ready:boolean|null;epoch:number|null;last_uploaded_at:string|null};
  recovery:{action:'none'|'repair'|'waiting_for_evidence'|'manual_intervention_required';incident_id:string|null;revision:string;repair_retry_until:string|null}|null;
}
export function parseChannelE2ee(value:unknown):ChannelE2ee|null {
  const row=value as ChannelE2ee|null, integer=(n:unknown)=>n===null || Number.isSafeInteger(n)&&Number(n)>=0;
  if(!row || typeof row.cid!=='string' || row.cid.length>512 || row.cid.indexOf(':')<=0 || !integer(row.group_generation) || !integer(row.epoch) ||
    (row.group_id!==null && (typeof row.group_id!=='string' || row.group_id.length>344)) || !row.group_info ||
    !['ready','missing','stale','validation_required','unavailable'].includes(row.group_info.status) || !integer(row.group_info.epoch) ||
    (row.group_info.last_uploaded_at!==null && !Number.isFinite(Date.parse(row.group_info.last_uploaded_at))) ||
    row.group_info.ready!==(row.group_info.status==='unavailable'?null:row.group_info.status==='ready') ||
    (row.recovery!==null && (!row.recovery || !validRecoveryRevision(row.recovery.revision) ||
      !['none','repair','waiting_for_evidence','manual_intervention_required'].includes(row.recovery.action) ||
      (row.recovery.action!=='none' && typeof row.recovery.incident_id!=='string') ||
      (row.recovery.repair_retry_until!==null && !Number.isFinite(Date.parse(row.recovery.repair_retry_until))))))return null;
  return structuredClone(row);
}
export interface RecoveryContinuationRequest {
  version:1;continuation_id:string;incident_id:string;expected_generation:number;expected_group_id:string|null;
  expected_epoch:number;recovery_revision:string;trigger:'local_state_available'|'transport_recovered';trigger_id:string|null;local_epoch:number;ratchet_tree_sha256:string;
  group_info_sha256:string;artifact_sha256:string;policy:'verify'|'allow_expired';
}
export interface RecoveryContinuationResponse {
  status:'admitted'|'existing'|'resolved'|'deferred'|'rediscover'|'rebootstrap_in_progress'|'evidence_seen';cid:string;
  group_generation:number;epoch:number;recovery_action:NonNullable<ChannelE2ee['recovery']>['action'];
  recovery_revision:string;incident_id:string|null;repair_retry_until:string|null;retry_after:string|null;
}
export interface ChannelEvidenceWork {
  version:1;user_id:string;device_id:string;cid:string;signer:string;evidence:string;
  job_id?:string;observation?:string;transport_id?:string;resume_transport_id?:string;last_reason?:string;last_failure?:'transport'|'coordination';
  request:RecoveryContinuationRequest|null;phase?:'upload'|'continue';attempts:number;retry_at:number;outcome:'pending'|'finished'|'exhausted';
}
export interface ChannelEvidenceBase {state:MlsReadyBase;work:ChannelEvidenceWork|null}
export const channelEvidenceKey=(device:string,cid:string,evidence:string)=>`channel_evidence:v1:${encodeURIComponent(device)}:${encodeURIComponent(cid)}:${evidence}`;
export function validateChannelEvidence(row:ChannelEvidenceWork):void {
  const uuid=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v)&&v!=='00000000-0000-0000-0000-000000000000';
  const digest=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
  const text=(v:unknown,n:number)=>typeof v==='string'&&v.length>0&&new TextEncoder().encode(v).length<=n&&!/[\u0000-\u001f\u007f]/.test(v);
  if(row?.version!==1)throw recoveryControlError('client_upgrade_required');
  const keys=['version','user_id','device_id','cid','signer','evidence','job_id','observation','transport_id','resume_transport_id','last_reason','last_failure','request','phase','attempts','retry_at','outcome'];
  if(Object.keys(row).some(k=>!keys.includes(k)))throw recoveryControlError('client_upgrade_required');
  const request=row.request;
  if(request){
    const allowed=['version','continuation_id','incident_id','expected_generation','expected_group_id','expected_epoch','recovery_revision','trigger','trigger_id','local_epoch','group_info_sha256','ratchet_tree_sha256','artifact_sha256','policy'];
    if(request.version!==1 || Object.keys(request).some(k=>!allowed.includes(k)))throw recoveryControlError('client_upgrade_required');
    if(!uuid(request.continuation_id)||!uuid(request.incident_id)||!Number.isSafeInteger(request.expected_generation)||request.expected_generation<0||
      !Number.isSafeInteger(request.expected_epoch)||request.expected_epoch<0||request.local_epoch!==request.expected_epoch||
      !validRecoveryRevision(request.recovery_revision)||request.recovery_revision==='0'||!digest(request.group_info_sha256)||!digest(request.ratchet_tree_sha256)||!digest(request.artifact_sha256)||
      !['verify','allow_expired'].includes(request.policy)||!['local_state_available','transport_recovered'].includes(request.trigger)||
      (request.trigger==='local_state_available'?request.trigger_id!==null:!uuid(request.trigger_id))||
      (request.expected_group_id!==null&&(typeof request.expected_group_id!=='string'||request.expected_group_id.length>344))||
      (request.expected_generation>0&&!request.expected_group_id))throw recoveryControlError('storage_corruption');
  }
  if(!text(row.user_id,512)||!text(row.device_id,256)||!text(row.cid,512)||!digest(row.evidence)||!digest(row.signer)||
    !Number.isSafeInteger(row.attempts)||row.attempts<0||row.attempts>3||!Number.isSafeInteger(row.retry_at)||row.retry_at<1||
    !['pending','finished','exhausted'].includes(row.outcome)||
    [row.job_id,row.observation,row.transport_id,row.resume_transport_id].some(v=>v!==undefined&&!uuid(v))||
    (row.last_reason!==undefined&&!text(row.last_reason,128))||
    (row.phase!==undefined&&!['upload','continue'].includes(row.phase))||
    (row.last_failure!==undefined&&!['transport','coordination'].includes(row.last_failure))||
    new TextEncoder().encode(JSON.stringify(row)).length>8192)throw recoveryControlError('storage_corruption');
}

/** A replayed result is a receipt; it never overwrites newer discovery control. */
export function validateContinuationResponse(row:RecoveryContinuationResponse,cid:string):void {
  const time=(v:unknown)=>v===null || typeof v==='string'&&v.length<=40&&Number.isFinite(Date.parse(v));
  if(!row || row.cid!==cid || !['admitted','existing','resolved','deferred','rediscover','rebootstrap_in_progress','evidence_seen'].includes(row.status) ||
    !Number.isSafeInteger(row.group_generation)||row.group_generation<0||!Number.isSafeInteger(row.epoch)||row.epoch<0||!validRecoveryRevision(row.recovery_revision)||
    !['none','repair','waiting_for_evidence','manual_intervention_required'].includes(row.recovery_action)||
    (row.incident_id!==null && (typeof row.incident_id!=='string'||!/^[a-f0-9-]{36}$/i.test(row.incident_id)))||
    (row.recovery_action!=='none'&&!row.incident_id)||!time(row.repair_retry_until)||!time(row.retry_after))throw recoveryControlError('client_upgrade_required');
}
