import type {EncryptionStorageAdapter, MlsGroupGenerationMarker, MlsRecoveryDiscoveryAppliedItem} from './types';
import {parseRecoveryChangedHint} from './recovery_discovery';
import type {RecoveryChangedHint, RecoveryDiscoveryResult} from './recovery_discovery';
import {recoveryControlError, validRecoveryRevision} from './recovery_control';

/** A validated public HTTP head can replace a lost event; it grants no MLS authority. */
export interface RecoveryDiscoveryHead {group_generation: number; recovery_revision: string}
const validHead = (head: RecoveryDiscoveryHead): boolean => !!head && Number.isSafeInteger(head.group_generation) &&
  head.group_generation >= 0 && validRecoveryRevision(head.recovery_revision);
const newerHead = (next: RecoveryDiscoveryHead, prior: RecoveryDiscoveryHead | null): boolean => !prior ||
  next.group_generation > prior.group_generation || next.group_generation === prior.group_generation &&
  BigInt(next.recovery_revision) > BigInt(prior.recovery_revision);

export interface RecoveryDiscoveryWork {
  version: 1; user_id: string; device_id: string; cid: string; job_id: string;
  signing_identity_sha256: string; artifact_sha256: string;
  hint: RecoveryChangedHint | null; retry_at: number; attempts: number;
  observed_head?: RecoveryDiscoveryHead;
  lease_id: string | null; disposition: 'pending' | 'deferred' | 'settled';
  reason: 'requested' | 'transport' | 'manual' | 'upgrade' | 'authorization' | 'budget' | 'scope';
}
export interface RecoveryDiscoveryOwner {
  provider_revision: string | null;
  markers: Record<string, MlsGroupGenerationMarker | null>;
}
export interface RecoveryDiscoveryChange {cid: string; expected: RecoveryDiscoveryWork | null; next: RecoveryDiscoveryWork}
export const discoveryWorkKey = (device: string, cid: string) => `mls_discovery:v1:${encodeURIComponent(device)}:${encodeURIComponent(cid)}`;
export const discoveryDueKey = (row: RecoveryDiscoveryWork) => `mls_discovery_due:v1:${encodeURIComponent(row.device_id)}:${String(row.retry_at).padStart(16,'0')}:${encodeURIComponent(row.cid)}`;
export function validateDiscoveryWork(row: RecoveryDiscoveryWork): void {
  if (!row || row.version !== 1 || !row.user_id || !row.device_id || !row.cid || row.cid.length > 512 || row.cid.indexOf(':') <= 0 ||
      !row.job_id || !/^[a-f0-9]{64}$/.test(row.signing_identity_sha256) || !/^[a-f0-9]{64}$/.test(row.artifact_sha256) ||
      !Number.isSafeInteger(row.retry_at) || row.retry_at <= 0 || !Number.isSafeInteger(row.attempts) || row.attempts < 0 || row.attempts > 3 ||
      !['pending','deferred','settled'].includes(row.disposition) || !['requested','transport','manual','upgrade','authorization','budget','scope'].includes(row.reason) ||
      (row.lease_id !== null && typeof row.lease_id !== 'string') || (row.hint !== null && (!parseRecoveryChangedHint(row.hint) || row.hint.cid !== row.cid)) ||
      (row.observed_head !== undefined && !validHead(row.observed_head)) ||
      new TextEncoder().encode(JSON.stringify(row)).length > 2048) throw recoveryControlError('storage_corruption');
}
const knownHead = (row: RecoveryDiscoveryWork | null): RecoveryDiscoveryHead | null => {
  const observed = row?.observed_head || null, hinted = row?.hint?.data || null;
  return hinted && newerHead(hinted, observed) ? hinted : observed;
};

export interface DurableDiscoveryContext {
  storage: EncryptionStorageAdapter; userId: string; deviceId: string; signer: string; artifact: string;
  assertScope(): void;
  captureOwner(cids: string[]): {owner: RecoveryDiscoveryOwner; assertOwner(): void; onCheckpointFailure?(error:unknown):Promise<void>};
  automaticAllowed(cid: string): boolean;
  observedHead?(cid: string): RecoveryDiscoveryHead | null;
  maintain(): Promise<void>;
}
/** Public discovery obligations only. No private state, membership, rejection or Ready authority. */
export class DurableRecoveryDiscoveryCoordinator {
  private work: Promise<RecoveryDiscoveryResult<MlsRecoveryDiscoveryAppliedItem>> | null = null;
  private sharingGuard: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  constructor(private readonly context: DurableDiscoveryContext,
    private readonly fetchBatch: (cids: string[]) => Promise<RecoveryDiscoveryResult<MlsRecoveryDiscoveryAppliedItem>>,
    private readonly now: () => number = () => Date.now()) {}
  private current(): void {this.context.assertScope(); if(this.stopped)throw recoveryControlError('recovery_scope_changed');}
  /** Internal lifecycle check; scheduling cannot revive a retired continuation. */
  assertCurrent(): void {this.current();}
  private capabilities(): void {const s=this.context.storage;if(s.recoveryDiscoveryWorkVersion!==1 || !s.loadRecoveryDiscoveryWork || !s.listDueRecoveryDiscoveryWork || !s.saveRecoveryDiscoveryWork)throw recoveryControlError('client_upgrade_required');}
  private clock(): number {const n=this.now();if(!Number.isSafeInteger(n) || n<=0 || !Number.isSafeInteger(n+30_000))throw recoveryControlError('invalid_clock');return n;}
  private async enqueue(cids: string[], hint?: RecoveryChangedHint): Promise<Record<string,MlsRecoveryDiscoveryAppliedItem>> {
    this.current();this.capabilities();const s=this.context.storage,now=this.clock();
    const errors:Record<string,MlsRecoveryDiscoveryAppliedItem>={};
    for(let offset=0;offset<cids.length;offset+=200){
      const page=cids.slice(offset,offset+200),guard=this.context.captureOwner(page);
      const prior=await s.loadRecoveryDiscoveryWork!(this.context.deviceId,page);this.current();guard.assertOwner();
      const changes: RecoveryDiscoveryChange[]=[];
      for(const cid of page){const old=prior[cid]||null;
        try{if(old){if(old.version!==1)throw recoveryControlError('client_upgrade_required');validateDiscoveryWork(old);}
          if(old && (old.user_id!==this.context.userId || old.device_id!==this.context.deviceId || old.signing_identity_sha256!==this.context.signer || old.artifact_sha256!==this.context.artifact))throw recoveryControlError('client_upgrade_required');
        }catch(error){errors[cid]={result:'error',reason:(error as {code?:string})?.code==='client_upgrade_required'?'client_upgrade_required':'state_unavailable',retryable:false};continue;}
        const observed=this.context.observedHead?.(cid)||null;
        if(observed && !validHead(observed))throw recoveryControlError('storage_corruption');
        const changedHead=observed && newerHead(observed,knownHead(old));
        if(old && (hint ? !newerHead(hint.data,knownHead(old)) : old.disposition!=='settled' && !changedHead))continue;
        const retainedHead=observed && newerHead(observed,old?.observed_head||null)?observed:old?.observed_head;
        const next: RecoveryDiscoveryWork={version:1,user_id:this.context.userId,device_id:this.context.deviceId,cid,job_id:crypto.randomUUID(),
          signing_identity_sha256:this.context.signer,artifact_sha256:this.context.artifact,hint:hint?structuredClone(hint):old?.hint||null,
          ...(retainedHead?{observed_head:structuredClone(retainedHead)}:{}),
          retry_at:Math.max(now+(hint?250:0),old?.lease_id?old.retry_at:0),attempts:0,lease_id:null,disposition:'pending',reason:'requested'};
        changes.push({cid,expected:old,next});
      }
      if(changes.length){await this.change(changes,guard);this.current();guard.assertOwner();}
    }
    return errors;
  }
  async request(cids: string[]): Promise<RecoveryDiscoveryResult<MlsRecoveryDiscoveryAppliedItem>> {
    const unique=[...new Set(cids)];await this.context.maintain();this.current();const errors=await this.enqueue(unique);const result=await this.run();this.current();
    const states: Record<string,MlsRecoveryDiscoveryAppliedItem>={...Object.fromEntries(unique.filter(cid=>result.states[cid]).map(cid=>[cid,result.states[cid]])),...errors},missing=unique.filter(cid=>!states[cid]);
    // A retained terminal scheduling reason must not turn into a fresh infrastructure retry loop.
    // This projects only an error; durable discovery metadata never restores a Ready/server state.
    for(let offset=0;offset<missing.length;offset+=200){
      const page=missing.slice(offset,offset+200),guard=this.context.captureOwner(page);
      const rows=await this.context.storage.loadRecoveryDiscoveryWork!(this.context.deviceId,page);this.current();guard.assertOwner();
      for(const cid of page){const row=rows[cid];if(row)validateDiscoveryWork(row);
        const terminal=row?.disposition==='deferred';
        states[cid]={result:'error',reason:terminal&&row.reason==='upgrade'?'client_upgrade_required':terminal&&row.reason==='authorization'?'not_authorized':'state_unavailable',retryable:!terminal};
      }
    }
    return{states,unsupported:result.unsupported};
  }
  async invalidate(cids: string[], hint?: RecoveryChangedHint): Promise<void> {const errors=await this.enqueue([...new Set(cids)],hint);this.arm(250);if(Object.keys(errors).length)throw recoveryControlError('client_upgrade_required');}
  async restore(): Promise<void> {this.current();this.capabilities();await this.context.maintain();this.current();const guard=this.context.captureOwner([]);
    try{const next=await this.context.storage.listDueRecoveryDiscoveryWork!(this.context.deviceId,Number.MAX_SAFE_INTEGER,1);this.current();guard.assertOwner();if(next.length)this.arm(Math.min(30_000,Math.max(250,next[0].retry_at-this.clock())));}
    catch(error){this.current();guard.assertOwner();if((error as {code?:string})?.code!=='storage_corruption')throw error;this.arm(250);}}
  async resume(): Promise<void> {this.current();this.capabilities();await this.run();}
  private arm(delay=30_000): void {if(this.stopped || this.timer)return;this.timer=setTimeout(()=>{this.timer=null;void this.run().catch(error=>{
    if((error as {code?:string})?.code==='recovery_scope_changed')this.stop();else this.arm();
  });},delay);(this.timer as ReturnType<typeof setTimeout>&{unref?:()=>void}).unref?.();}
  async run(): Promise<RecoveryDiscoveryResult<MlsRecoveryDiscoveryAppliedItem>> {
    this.current();this.capabilities();if(this.work){this.sharingGuard?.();return this.work;}
    const sharing=this.context.captureOwner([]).assertOwner;this.sharingGuard=sharing;
    const work=(async()=>{
      const all: RecoveryDiscoveryResult<MlsRecoveryDiscoveryAppliedItem>={states:{},unsupported:false},s=this.context.storage;
      for(let batch=0;batch<2;batch++){
        await this.context.maintain();this.current();
        const now=this.clock(),guardBeforeScan=this.context.captureOwner([]);
        const due=await s.listDueRecoveryDiscoveryWork!(this.context.deviceId,now,200);this.current();guardBeforeScan.assertOwner();
        if(!due.length)break;
        const cids=due.map(row=>row.cid),guard=this.context.captureOwner(cids),changes:RecoveryDiscoveryChange[]=[];
        for(const row of due){validateDiscoveryWork(row);
          const bound=row.user_id===this.context.userId && row.device_id===this.context.deviceId && row.signing_identity_sha256===this.context.signer && row.artifact_sha256===this.context.artifact;
          changes.push({cid:row.cid,expected:row,next:{...row,retry_at:now+30_000,
            lease_id:bound&&row.attempts<3?crypto.randomUUID():null,attempts:bound&&row.attempts<3?row.attempts+1:row.attempts,
            disposition:bound&&row.attempts<3?'pending':'deferred',reason:bound?'budget':'upgrade'}});
        }
        const reserved=await this.change(changes,guard);this.current();guard.assertOwner();
        const admitted=changes.filter((change,i)=>reserved[i] && change.next.lease_id).map(change=>change.next);
        if(!admitted.length)continue;
        let result: RecoveryDiscoveryResult<MlsRecoveryDiscoveryAppliedItem>;
        try{result=await this.fetchBatch(admitted.map(row=>row.cid));this.current();guard.assertOwner();}
        catch(error){this.current();guard.assertOwner();result={states:Object.fromEntries(admitted.map(row=>[row.cid,{result:'error',reason:'infrastructure_unavailable',retryable:true}])),unsupported:false};}
        const finish=admitted.map(row=>{
          const item=result.states[row.cid],reason:RecoveryDiscoveryWork['reason']=result.unsupported || item?.result==='error'&&item.reason==='client_upgrade_required'?'upgrade':
            item?.result==='error'&&item.reason==='not_authorized'?'authorization':!this.context.automaticAllowed(row.cid)?'manual':row.attempts>=3?'budget':'transport';
          return{cid:row.cid,expected:row,next:{...row,lease_id:null,disposition:item?.result==='state'?'settled':reason==='transport'?'pending':'deferred',reason}} as RecoveryDiscoveryChange;
        });
        await this.change(finish,guard);this.current();guard.assertOwner();
        Object.assign(all.states,result.states);all.unsupported ||= result.unsupported;
      }
      await this.restore();return all;
    })();this.work=work;
    try{return await work;}finally{if(this.work===work)this.work=null;}
  }
  private async change(changes:RecoveryDiscoveryChange[],guard:ReturnType<DurableDiscoveryContext['captureOwner']>):Promise<boolean[]> {
    try{return await this.context.storage.saveRecoveryDiscoveryWork!(this.context.userId,this.context.deviceId,changes,guard.owner,guard.assertOwner);}
    catch(error){await guard.onCheckpointFailure?.(error);throw error;}
  }
  stop(): void {this.stopped=true;if(this.timer)clearTimeout(this.timer);this.timer=null;}
}
