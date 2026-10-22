import type {EncryptionStorageAdapter, GroupInfoRefreshRequest, StoredGroupInfoRefreshRequest, UploadGroupInfoRequest} from './types';
import type {RecoveryDiscoveryOwner} from './discovery_work';
import type {RecoveryControlCheckpoint} from './recovery_control';
import {recoveryControlError,recoveryControlGroupMatches} from './recovery_control';
import {GroupInfoRepairCoordinator, GroupInfoRepairApi, GroupInfoRepairCallbacks} from './group_info_repair';

export interface GroupInfoWorkScope {user_id:string; device_id:string; signing_identity_sha256:string; artifact_sha256:string}
export interface GroupInfoWork extends GroupInfoWorkScope {
  version:1; cid:string; request:GroupInfoRefreshRequest; job_id:string; retry_at:number; lease_id:string|null;
  stage:'observe'|'claim'|'prepare'|'upload'|'reconcile'; disposition:'pending'|'deferred'|'settled';
  reason:'requested'|'transport'|'manual'|'upgrade'|'budget'|'scope'|'binding'|'request_changed'|'lease_expired'|'local_state';
  observations:number; claims:number; uploads:number;
  generation:number; group_id:Uint8Array|null; control_revision:string|null;
  claimed_lease:{lease_token:string;lease_expires_at:string}|null;
  material:{bytes:Uint8Array;epoch:number;lease_token:string;lease_expires_at:string}|null;
}
export interface GroupInfoWorkOwner extends RecoveryDiscoveryOwner {controls:Record<string,RecoveryControlCheckpoint|null>; obligations?:Record<string,{mutation:unknown;external:unknown;removal:unknown}>}
export interface GroupInfoWorkChange {cid:string;request_id:string;expected:GroupInfoWork|null;next:GroupInfoWork}
export interface GroupInfoWorkPage {cursor:string|null; next_cursor:string|null; requests:StoredGroupInfoRefreshRequest[]; more:boolean}
export interface GroupInfoWorkAdmission {page:GroupInfoWorkPage}
export const groupInfoWorkKey=(device:string,cid:string,id:string)=>`gi_work:v1:${encodeURIComponent(device)}:${encodeURIComponent(cid)}:${encodeURIComponent(id)}`;
export const groupInfoWorkDueKey=(r:GroupInfoWork)=>`gi_work_due:v1:${encodeURIComponent(r.device_id)}:${String(r.retry_at).padStart(16,'0')}:${encodeURIComponent(r.cid)}:${encodeURIComponent(r.request.request_id)}`;
export const groupInfoWorkCursorKey=(device:string)=>`gi_work_cursor:v1:${encodeURIComponent(device)}`;
export function validateGroupInfoRequest(r:GroupInfoRefreshRequest):void {
  if(!r || typeof r.request_id!=='string' || !r.request_id || r.request_id.length>512 || !Number.isSafeInteger(r.minimum_epoch)||r.minimum_epoch<0 ||
    !Number.isFinite(Date.parse(r.deadline_at)) || !Number.isFinite(Date.parse(r.expires_at)) || !Number.isSafeInteger(r.attempt_count)||r.attempt_count<0 ||
    (r.group_generation!==undefined && (!Number.isSafeInteger(r.group_generation)||r.group_generation<0)) || !['group_info_stale','group_info_invalid','external_join_deadline'].includes(r.reason))throw recoveryControlError('storage_corruption');
}
export function sameGroupInfoRequest(a:GroupInfoRefreshRequest,b:GroupInfoRefreshRequest):boolean {
  return (a.group_generation??0)===(b.group_generation??0) && a.request_id===b.request_id && a.minimum_epoch===b.minimum_epoch && a.deadline_at===b.deadline_at && a.expires_at===b.expires_at && a.reason===b.reason;
}
export function validateGroupInfoWork(r:GroupInfoWork):void {
  validateGroupInfoRequest(r?.request);
  if(r.version!==1 || !r.user_id || !r.device_id || !r.cid || r.cid.length>512 || r.cid.indexOf(':')<=0 || !r.job_id ||
    !/^[a-f0-9]{64}$/.test(r.signing_identity_sha256) || !/^[a-f0-9]{64}$/.test(r.artifact_sha256) ||
    !Number.isSafeInteger(r.retry_at)||r.retry_at<=0 || !Number.isSafeInteger(r.generation)||r.generation<0 ||
    (r.group_id!==null && !(r.group_id instanceof Uint8Array)) || (r.control_revision!==null && !/^[0-9]+$/.test(r.control_revision)) ||
    (r.lease_id!==null && (typeof r.lease_id!=='string'||!r.lease_id)) || !['observe','claim','prepare','upload','reconcile'].includes(r.stage) ||
    !['pending','deferred','settled'].includes(r.disposition) || !['requested','transport','manual','upgrade','budget','scope','binding','request_changed','lease_expired','local_state'].includes(r.reason) ||
    [r.observations,r.claims,r.uploads].some(n=>!Number.isSafeInteger(n)||n<0||n>3) ||
    (r.claimed_lease && (typeof r.claimed_lease.lease_token!=='string'||!r.claimed_lease.lease_token||r.claimed_lease.lease_token.length>4096 || !Number.isFinite(Date.parse(r.claimed_lease.lease_expires_at)))) ||
    (r.stage==='prepare'&&!r.claimed_lease) ||
    (r.material && (!(r.material.bytes instanceof Uint8Array)||!r.material.bytes.length||r.material.bytes.length>1048576 ||
      !Number.isSafeInteger(r.material.epoch)||r.material.epoch<r.request.minimum_epoch || typeof r.material.lease_token!=='string'||!r.material.lease_token||r.material.lease_token.length>4096 || !Number.isFinite(Date.parse(r.material.lease_expires_at)))) ||
    ((r.stage==='upload'||r.uploads>0)&&!r.material))throw recoveryControlError('storage_corruption');
  const metadata={...r,material:r.material?{...r.material,bytes:null}:null};
  if(new TextEncoder().encode(JSON.stringify(metadata)).length>16384)throw recoveryControlError('storage_corruption');
}
export function newGroupInfoWork(scope:GroupInfoWorkScope,request:StoredGroupInfoRefreshRequest,owner:GroupInfoWorkOwner,now:number):GroupInfoWork {
  const {cid,...r}=request,marker=owner.markers[cid],control=owner.controls[cid];
  const row:GroupInfoWork={user_id:scope.user_id,device_id:scope.device_id,signing_identity_sha256:scope.signing_identity_sha256,artifact_sha256:scope.artifact_sha256,version:1,cid,request:r,job_id:crypto.randomUUID(),retry_at:now,lease_id:null,stage:'observe',disposition:'pending',reason:'requested',
    observations:0,claims:0,uploads:0,generation:marker?.group_generation??0,group_id:marker?.group_id??null,control_revision:control?.recovery_revision??null,claimed_lease:null,material:null};
  validateGroupInfoWork(row);return row;
}
export interface DurableGroupInfoContext extends GroupInfoWorkScope {
  assertScope():void;
  captureOwner(cids:string[]):{owner:GroupInfoWorkOwner;assertOwner():void;onCheckpointFailure?(error:unknown):Promise<void>};
  automaticAllowed(cid:string):boolean;
  exportMaterial(cid:string,minimum:number):Promise<{bytes:Uint8Array;epoch:number}>;
  discover(cids:string[]):Promise<unknown>;
  maintain(lane: 'gi' | 'legacy_gi'):Promise<void>;
}
export interface ReservedGroupInfoApi {
  observeGroupInfoRefresh(channelType:string,channelId:string):Promise<{request:GroupInfoRefreshRequest|null}>;
  reserveGroupInfoRefreshClaim(channelType:string,channelId:string,requestId:string):Promise<GroupInfoRefreshRequest>;
  submitReservedGroupInfo(channelType:string,channelId:string,body:UploadGroupInfoRequest):Promise<unknown>;
}
/** Production per-request journal. HTTP responses are workflow observations, never MLS Ready/rejection authority. */
export class DurableGroupInfoRepairCoordinator extends GroupInfoRepairCoordinator {
  private timer:ReturnType<typeof setTimeout>|null=null;
  private stopped=false;
  private work:Promise<void>|null=null;
  private sharingGuard:(()=>void)|null=null;
  constructor(private readonly adapter:EncryptionStorageAdapter,private readonly transport:GroupInfoRepairApi&ReservedGroupInfoApi,
    private readonly hooks:GroupInfoRepairCallbacks,readonly context:DurableGroupInfoContext,private readonly now:()=>number=()=>Date.now()) {super(adapter,transport,hooks);}
  private current():void {this.context.assertScope();if(this.stopped)throw recoveryControlError('recovery_scope_changed');}
  get supported():boolean {return this.adapter.groupInfoRepairWorkVersion===1 && !!this.adapter.loadGroupInfoWork && !!this.adapter.listDueGroupInfoWork && !!this.adapter.loadGroupInfoWorkPage && !!this.adapter.loadGroupInfoWorkObligations && !!this.adapter.saveGroupInfoWork;}
  private capabilities():void {if(!this.supported || !this.transport.observeGroupInfoRefresh || !this.transport.reserveGroupInfoRefreshClaim || !this.transport.submitReservedGroupInfo)throw recoveryControlError('client_upgrade_required');}
  private clock():number {const n=this.now();if(!Number.isSafeInteger(n)||n<=0||!Number.isSafeInteger(n+30000))throw recoveryControlError('invalid_clock');return n;}
  private arm(delay=30000):void {if(this.stopped||this.timer)return;this.timer=setTimeout(()=>{this.timer=null;void this.run().catch(()=>{try{this.current();this.arm();}catch(_){this.stop();}});},delay);(this.timer as ReturnType<typeof setTimeout>&{unref?:()=>void}).unref?.();}
  async start(_cids:string[],cached:import('./types').GroupInfoRefreshRequestedEvent[]=[]):Promise<void> {
    this.current();this.capabilities();for(const event of cached)await this.handleRequested(event);
    await this.backfill();this.current();await this.restore();
  }
  private async owned(cids:string[]):Promise<ReturnType<DurableGroupInfoContext['captureOwner']>> {
    const guard=this.context.captureOwner(cids);
    guard.owner.obligations=await this.adapter.loadGroupInfoWorkObligations!(cids);this.current();guard.assertOwner();return guard;
  }
  private async backfill():Promise<void> {
    await this.context.maintain('legacy_gi');this.current();
    const before=this.context.captureOwner([]);const page=await this.adapter.loadGroupInfoWorkPage!(this.context.device_id);this.current();before.assertOwner();
    // Maintenance is bounded too. Another corrupt row may enter this page after de-indexing.
    try{for(const row of page.requests){validateGroupInfoRequest(row);if(!row.cid || row.cid.indexOf(':')<=0)throw recoveryControlError('storage_corruption');}}
    catch{this.arm(250);return;}
    const guard=await this.owned([...new Set(page.requests.map(r=>r.cid))]);
    const old=await this.adapter.loadGroupInfoWork!(this.context.device_id,page.requests);this.current();guard.assertOwner();
    const changes=page.requests.map((r,i)=>({cid:r.cid,request_id:r.request_id,expected:old[i],next:old[i]||newGroupInfoWork(this.context,r,guard.owner,this.clock())}));
    await this.adapter.saveGroupInfoWork!(this.context.user_id,this.context.device_id,changes,guard.owner,guard.assertOwner,{page});this.current();guard.assertOwner();
    if(page.more)this.arm(250);
  }
  async restore():Promise<void> {this.current();this.capabilities();await this.context.maintain('gi');this.current();const guard=this.context.captureOwner([]);
    try{const due=await this.adapter.listDueGroupInfoWork!(this.context.device_id,Number.MAX_SAFE_INTEGER,1);this.current();guard.assertOwner();if(due.length)this.arm(Math.min(30000,Math.max(250,due[0].retry_at-this.clock())));}
    catch(error){this.current();guard.assertOwner();if((error as {code?:string})?.code!=='storage_corruption')throw error;this.arm(250);}}
  async applyAuthoritativeSnapshot(snapshot:Record<string,GroupInfoRefreshRequest|null>,observed?:Record<string,StoredGroupInfoRefreshRequest[]>):Promise<void> {
    this.current();this.capabilities();for(const [cid,r]of Object.entries(snapshot)){
      const guard=this.context.captureOwner([cid]);const checkpoint=await this.hooks.captureCheckpoint!(cid,observed?.[cid]);this.current();guard.assertOwner();
      await checkpoint(rows=>r?[...rows.filter(row=>row.request_id!==r.request_id),{...r,cid}]:[]);this.current();guard.assertOwner();
    }this.arm(250);
  }
  async handleRequested(event:import('./types').GroupInfoRefreshRequestedEvent):Promise<void> {if(event.version!==1)return;await this.applyAuthoritativeSnapshot({[event.cid]:event});}
  async reportExternalJoinFailure(cid:string,body:import('./types').ReportGroupInfoFailureRequest):Promise<GroupInfoRefreshRequest|null> {
    this.current();this.capabilities();const result=await super.reportExternalJoinFailure(cid,body);this.current();this.arm(250);return result;
  }
  async handleUploaded(event:import('./types').GroupInfoUploadedEvent):Promise<void> {this.current();this.capabilities();if(event.version===1)this.arm(250);}
  async handleRemoved(cid:string):Promise<void> {this.current();this.notifyRemoved(cid);}
  async reconcile(cid:string):Promise<void> {this.current();await this.context.discover([cid]);this.current();this.arm(250);}
  async run():Promise<void> {
    this.current();this.capabilities();if(this.work){this.sharingGuard?.();return this.work;}
    this.sharingGuard=this.context.captureOwner([]).assertOwner;
    const work=(async()=>{
      await this.context.maintain('gi');this.current();await this.backfill();const before=this.context.captureOwner([]),due=await this.adapter.listDueGroupInfoWork!(this.context.device_id,this.clock(),50);this.current();before.assertOwner();
      let calls=0;
      for(const row of due){
        validateGroupInfoWork(row);const guard=await this.owned([row.cid]),now=this.clock();
        let reason:GroupInfoWork['reason']|null=null;
        if(row.user_id!==this.context.user_id||row.signing_identity_sha256!==this.context.signing_identity_sha256||row.artifact_sha256!==this.context.artifact_sha256)reason='upgrade';
        else if(row.generation!==(guard.owner.markers[row.cid]?.group_generation??0) || !sameBytes(row.group_id,guard.owner.markers[row.cid]?.group_id??null))reason='scope';
        else if((row.request.group_generation??0)!==row.generation ||
          (row.generation>0 && (!guard.owner.markers[row.cid] || !recoveryControlGroupMatches(guard.owner.controls[row.cid],guard.owner.markers[row.cid]!))))reason='binding';
        else if(!this.context.automaticAllowed(row.cid))reason='manual';
        else if(!this.hooks.isEligible(row.cid) || Object.values(guard.owner.obligations![row.cid]).some(value=>value!==null))reason='local_state';
        const counter=row.stage==='claim'?'claims':row.stage==='upload'?'uploads':'observations';
        if(!reason && row.stage!=='prepare' && row[counter]>=3)reason='budget';
        if(reason){await this.change(row,{...row,retry_at:now+30000,lease_id:null,disposition:reason==='local_state'?'pending':'deferred',reason},guard);continue;}
        if(calls>=6 && row.stage!=='prepare')break;
        let reserved:GroupInfoWork={...row,retry_at:now+30000,lease_id:crypto.randomUUID(),[counter]:row[counter]+(row.stage==='prepare'?0:1),
          stage:row.stage==='upload'?'reconcile':row.stage};
        if(!await this.change(row,reserved,guard))continue;if(row.stage!=='prepare')calls++;
        let next=reserved;const split=row.cid.indexOf(':'),type=row.cid.slice(0,split),id=row.cid.slice(split+1);
        try {
          if(row.stage==='observe'||row.stage==='reconcile'){
            const response=await this.transport.observeGroupInfoRefresh(type,id);this.current();guard.assertOwner();
            if(!response || !Object.prototype.hasOwnProperty.call(response,'request'))throw recoveryControlError('storage_corruption');
            if(!response.request)next={...reserved,disposition:'settled'};
            else {
              validateGroupInfoRequest(response.request);
              if(!sameGroupInfoRequest(response.request,row.request))next={...reserved,disposition:'deferred',reason:'request_changed'};
              else if(row.material){
                const valid=Date.parse(row.material.lease_expires_at)>this.clock();
                next={...reserved,stage:'upload',disposition:valid?'pending':'deferred',reason:valid?'requested':'lease_expired'};
              }else next={...reserved,stage:'claim'};
            }
          }else if(row.stage==='prepare'){
            if(!row.claimed_lease)throw recoveryControlError('storage_corruption');
            if(Date.parse(row.claimed_lease.lease_expires_at)<=now)next={...reserved,disposition:'deferred',reason:'lease_expired'};
            else {const material=await this.context.exportMaterial(row.cid,row.request.minimum_epoch);this.current();guard.assertOwner();next={...reserved,stage:'upload',material:{...material,...row.claimed_lease}};}
          }else if(row.stage==='claim'){
            if(Date.parse(row.request.expires_at)<=now){next={...reserved,disposition:'deferred',reason:'lease_expired'};calls--;}
            else {
              const lease=await this.transport.reserveGroupInfoRefreshClaim(type,id,row.request.request_id);this.current();guard.assertOwner();validateGroupInfoRequest(lease);
              if(!sameGroupInfoRequest(lease,row.request) || !lease.lease_token || !lease.lease_expires_at || Date.parse(lease.lease_expires_at)<=this.clock())throw recoveryControlError('recovery_checkpoint_conflict');
              const claimed:GroupInfoWork={...reserved,stage:'prepare',claimed_lease:{lease_token:lease.lease_token,lease_expires_at:lease.lease_expires_at}};
              if(!await this.change(reserved,claimed,guard))continue;reserved=claimed;
              const material=await this.context.exportMaterial(row.cid,row.request.minimum_epoch);this.current();guard.assertOwner();
              next={...claimed,stage:'upload',material:{...material,...claimed.claimed_lease!}};
            }
          }else {
            if(!row.material)throw recoveryControlError('storage_corruption');
            if(Date.parse(row.material.lease_expires_at)<=now){next={...reserved,disposition:'deferred',reason:'lease_expired'};calls--;}
            else {await this.transport.submitReservedGroupInfo(type,id,{group_info:row.material.bytes,epoch:row.material.epoch,expected:{group_generation:row.generation,group_id:row.group_id},request_id:row.request.request_id,lease_token:row.material.lease_token});this.current();guard.assertOwner();}
          }
        }catch(error){this.current();guard.assertOwner();if((error as {gi_checkpoint_failed?:boolean}).gi_checkpoint_failed)throw error;next={...reserved,reason:(error as {code?:string})?.code==='provider_mutation_busy'?'local_state':'transport'};}
        await this.change(reserved,{...next,lease_id:null},guard);
      }
      await this.restore();
    })();this.work=work;try{await work;}finally{if(this.work===work)this.work=null;}
  }
  private async change(expected:GroupInfoWork,next:GroupInfoWork,guard:ReturnType<DurableGroupInfoContext['captureOwner']>):Promise<boolean> {
    this.current();guard.assertOwner();let result:boolean[];try{result=await this.adapter.saveGroupInfoWork!(this.context.user_id,this.context.device_id,[{cid:expected.cid,request_id:expected.request.request_id,expected,next}],guard.owner,guard.assertOwner);}catch(error){await guard.onCheckpointFailure?.(error);if(error && typeof error==='object')Object.assign(error,{gi_checkpoint_failed:true});throw error;}this.current();guard.assertOwner();return result[0];
  }
  stop():void {this.stopped=true;if(this.timer)clearTimeout(this.timer);this.timer=null;}
}
function sameBytes(a:Uint8Array|null,b:Uint8Array|null):boolean {return a===null?b===null:!!b&&a.length===b.length&&a.every((v,i)=>v===b[i]);}
