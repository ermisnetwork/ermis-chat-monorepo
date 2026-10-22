import {GroupInfoRepairCoordinator} from './group_info_repair';
import type {GroupInfoRepairApi, GroupInfoRepairCallbacks} from './group_info_repair';
import type {EncryptionStorageAdapter, GroupInfoRefreshRequest, GroupInfoRefreshRequestedEvent, GroupInfoUploadedEvent, ReportGroupInfoFailureRequest, StoredGroupInfoRefreshRequest} from './types';

/** Thin lifecycle adapter. The manager owns the single durable per-CID publication job. */
export class ClientDrivenGroupInfoRepair extends GroupInfoRepairCoordinator {
  constructor(storage: EncryptionStorageAdapter, private readonly transport: GroupInfoRepairApi,
    private readonly ownerCallbacks: GroupInfoRepairCallbacks, private readonly publish: (cid: string) => Promise<void>) {
    super(storage, transport, ownerCallbacks);
  }
  get supported(): boolean { return true; }
  async start(cids: string[], cached: GroupInfoRefreshRequestedEvent[] = []): Promise<void> {
    // Retained lease jobs remain dormant; a legacy hint is not a new capability.
    for (const cid of cids) await this.reconcile(cid);
    void cached;
  }
  async applyAuthoritativeSnapshot(_snapshot: Record<string, GroupInfoRefreshRequest | null>,
    _observed?: Record<string, StoredGroupInfoRefreshRequest[]>): Promise<void> {}
  async handleRequested(event: GroupInfoRefreshRequestedEvent): Promise<void> { await this.reconcile(event.cid); }
  async handleUploaded(event: GroupInfoUploadedEvent): Promise<void> { await this.reconcile(event.cid); }
  notifyRemoved(_cid: string): void {}
  async handleRemoved(_cid: string): Promise<void> {}
  async reconcile(cid: string): Promise<void> {
    const current = this.ownerCallbacks.captureScope?.(cid) || (() => {}); current();
    await this.publish(cid); current();
  }
  async reportExternalJoinFailure(cid: string, body: ReportGroupInfoFailureRequest): Promise<GroupInfoRefreshRequest | null> {
    const current=this.ownerCallbacks.captureScope?.(cid)||(()=>{});current();
    const split=cid.indexOf(':');if(split<1)return null;
    await this.transport.reportGroupInfoFailure(cid.slice(0,split),cid.slice(split+1),body);current();
    this.ownerCallbacks.emit({cid,status:'retryable',reason:body.reason});
    return null; // A marker is not a legacy claim capability or a Ready proof.
  }
}
