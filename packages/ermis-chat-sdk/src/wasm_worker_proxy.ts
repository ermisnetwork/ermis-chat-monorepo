/**
 * WasmWorkerProxy — Proxy class chạy trên Main Thread.
 *
 * Implement interface INodeCall, nhưng mọi method call đều được forward
 * tới Web Worker qua postMessage. Main Thread KHÔNG BAO GIỜ gọi WASM trực tiếp.
 *
 * Data transfer dùng Transferable buffers (zero-copy).
 */

import { INodeCall } from './types';

/** Response types từ Worker */
type WorkerResponse =
  | { id: number; type: 'result'; data?: any }
  | { id: number; type: 'error'; error: string }
  | { type: 'recv_data'; data: Uint8Array }
  | { type: 'recv_error'; error: string };

export class WasmWorkerProxy implements INodeCall {
  private worker: Worker;
  private nextId = 0;
  private pendingCalls = new Map<number, { resolve: (data?: any) => void; reject: (error: Error) => void }>();

  /** Queue cho asyncRecv — Worker gửi data về, Main Thread consume từng cái */
  private recvResolveQueue: Array<(data: Uint8Array) => void> = [];
  private recvDataQueue: Uint8Array[] = [];
  private recvErrorQueue: Array<(error: Error) => void> = [];

  /** Static cache — persist across Worker instances */
  private static cachedBlobUrl: string | null = null;
  private static cachedWasmBytes: ArrayBuffer | null = null;

  constructor(workerUrl: string | URL) {
    // Cache Blob URL — chỉ fetch worker script 1 lần
    if (!WasmWorkerProxy.cachedBlobUrl) {
      const url = workerUrl.toString();
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, false); // synchronous
      xhr.send();

      if (xhr.status === 200) {
        const blob = new Blob([xhr.responseText], { type: 'application/javascript' });
        WasmWorkerProxy.cachedBlobUrl = URL.createObjectURL(blob);
      }
    }

    if (WasmWorkerProxy.cachedBlobUrl) {
      this.worker = new Worker(WasmWorkerProxy.cachedBlobUrl, { type: 'module' });
    } else {
      // Fallback: try direct URL (works when server has correct MIME config)
      this.worker = new Worker(workerUrl, { type: 'module' });
    }

    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => this.handleMessage(e.data);
    this.worker.onerror = (e) => {
      console.error('🔴 WASM Worker error:', e.message);
      // Reject all pending calls
      this.pendingCalls.forEach(({ reject }) => reject(new Error(`Worker error: ${e.message}`)));
      this.pendingCalls.clear();
    };
  }

  // === LIFECYCLE ===

  /** Initialize WASM trong Worker — fetch bytes 1 lần, gửi cached bytes cho Worker */
  async init(wasmPath?: string): Promise<void> {
    // Fetch WASM bytes 1 lần duy nhất trên Main Thread
    if (!WasmWorkerProxy.cachedWasmBytes) {
      const absoluteWasmPath = new URL(
        wasmPath || '/ermis_call_node_wasm_bg.wasm',
        window.location.origin,
      ).href;
      const response = await fetch(absoluteWasmPath);
      WasmWorkerProxy.cachedWasmBytes = await response.arrayBuffer();
    }
    // Gửi copy bytes cho Worker (transfer → zero-copy, original stays cached)
    const bytesCopy = WasmWorkerProxy.cachedWasmBytes.slice(0);
    await this.call('init', { wasmBytes: bytesCopy }, [bytesCopy]);
  }

  /** Spawn WASM node */
  async spawn(relayUrls: string[]): Promise<void> {
    await this.call('spawn', { relayUrls });
  }

  /** Lấy local endpoint address */
  async getLocalEndpointAddr(): Promise<string> {
    return await this.call('getLocalEndpointAddr');
  }

  // === INodeCall IMPLEMENTATION ===

  async connect(address: string): Promise<void> {
    await this.call('connect', { address });
  }

  async acceptConnection(): Promise<void> {
    await this.call('acceptConnection');
  }

  async sendFrame(data: Uint8Array): Promise<void> {
    // Transfer buffer ownership → zero-copy Main→Worker
    await this.call('sendFrame', { data }, [data.buffer]);
  }

  async beginWithGop(data: Uint8Array): Promise<void> {
    await this.call('beginWithGop', { data }, [data.buffer]);
  }

  async sendAudioFrame(data: Uint8Array): Promise<void> {
    await this.call('sendAudioFrame', { data }, [data.buffer]);
  }

  async sendControlFrame(data: Uint8Array): Promise<void> {
    // Control frames nhỏ — clone OK, không cần transfer
    await this.call('sendControlFrame', { data });
  }

  /**
   * asyncRecv — nhận data từ Worker recv loop.
   *
   * Worker chạy recv loop nội bộ, gửi data về qua postMessage.
   * Method này trả về Promise resolve khi có data mới.
   * KHÔNG BAO GIỜ block Main Thread — chỉ chờ postMessage event.
   */
  async asyncRecv(): Promise<Uint8Array> {
    // Nếu đã có data trong queue (Worker gửi trước khi Main gọi asyncRecv)
    if (this.recvDataQueue.length > 0) {
      return this.recvDataQueue.shift()!;
    }

    // Chờ data từ Worker
    return new Promise<Uint8Array>((resolve, reject) => {
      this.recvResolveQueue.push(resolve);
      this.recvErrorQueue.push(reject);
    });
  }

  // === CONTROL ===

  /** Bắt đầu recv loop trong Worker */
  async startRecvLoop(): Promise<void> {
    await this.call('startRecvLoop');
  }

  /** Dừng recv loop trong Worker */
  async stopRecvLoop(): Promise<void> {
    await this.call('stopRecvLoop');
  }

  async closeEndpoint(): Promise<void> {
    await this.call('closeEndpoint');
  }

  closeConnection(): void {
    // Fire-and-forget — không cần chờ response
    const id = this.nextId++;
    this.worker.postMessage({ id, type: 'closeConnection' });
  }

  networkChange(): void {
    const id = this.nextId++;
    this.worker.postMessage({ id, type: 'networkChange' });
  }

  async getStats(): Promise<any> {
    return await this.call('getStats');
  }

  /** Terminate Worker — gọi khi call kết thúc */
  async terminate(): Promise<void> {
    try {
      await this.call('terminate');
    } catch {
      /* ignore — worker may already be dead */
    }
    this.worker.terminate();

    // KHÔNG revoke Blob URL và KHÔNG clear cached Module
    // — chúng được reuse cho call tiếp theo

    // Reject remaining recv waiters
    this.recvResolveQueue = [];
    this.recvErrorQueue.forEach((reject) => reject(new Error('Worker terminated')));
    this.recvErrorQueue = [];
    this.recvDataQueue = [];
  }

  // === INTERNAL ===

  private handleMessage(msg: WorkerResponse) {
    // Stream data từ recv loop (không có id)
    if (msg.type === 'recv_data') {
      const data = (msg as any).data as Uint8Array;
      if (this.recvResolveQueue.length > 0) {
        // Có consumer đang chờ → resolve ngay
        const resolve = this.recvResolveQueue.shift()!;
        this.recvErrorQueue.shift(); // Remove paired reject
        resolve(data);
      } else {
        // Chưa có consumer → queue data
        this.recvDataQueue.push(data);
      }
      return;
    }

    if (msg.type === 'recv_error') {
      const error = new Error((msg as any).error);
      if (this.recvErrorQueue.length > 0) {
        const reject = this.recvErrorQueue.shift()!;
        this.recvResolveQueue.shift(); // Remove paired resolve
        reject(error);
      }
      return;
    }

    // RPC response (có id)
    const { id } = msg;
    const pending = this.pendingCalls.get(id);
    if (!pending) return;

    this.pendingCalls.delete(id);

    if (msg.type === 'error') {
      pending.reject(new Error(msg.error));
    } else {
      pending.resolve(msg.data);
    }
  }

  /** Send RPC call to Worker and wait for response */
  private call(type: string, payload?: Record<string, any>, transfer?: Transferable[]): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pendingCalls.set(id, { resolve, reject });
      const message = { id, type, ...payload };
      if (transfer && transfer.length > 0) {
        this.worker.postMessage(message, transfer);
      } else {
        this.worker.postMessage(message);
      }
    });
  }
}
