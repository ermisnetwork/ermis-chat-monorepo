/**
 * WASM Worker — chạy ErmisCall WASM instance trên Worker thread.
 *
 * Mọi WASM sync calls (sendFrame, sendAudioFrame, sendControlFrame) chạy ở đây,
 * KHÔNG BAO GIỜ block Main Thread. Khi P2P connection congested (peer mạng yếu),
 * Worker thread bị block nhưng UI vẫn responsive.
 *
 * Communication: postMessage với Transferable buffers (zero-copy).
 */

// @ts-ignore — WASM module import sẽ được resolve bởi bundler
import init, { ErmisCall } from './wasm/ermis_call_node_wasm';

let ermisCall: ErmisCall | null = null;
let isRecvActive = false;

/** Request types từ Main Thread */
type WorkerRequest =
  | { id: number; type: 'init'; wasmPath: string }
  | { id: number; type: 'spawn'; relayUrls: string[] }
  | { id: number; type: 'getLocalEndpointAddr' }
  | { id: number; type: 'connect'; address: string }
  | { id: number; type: 'acceptConnection' }
  | { id: number; type: 'sendFrame'; data: Uint8Array }
  | { id: number; type: 'beginWithGop'; data: Uint8Array }
  | { id: number; type: 'sendAudioFrame'; data: Uint8Array }
  | { id: number; type: 'sendControlFrame'; data: Uint8Array }
  | { id: number; type: 'closeEndpoint' }
  | { id: number; type: 'closeConnection' }
  | { id: number; type: 'networkChange' }
  | { id: number; type: 'startRecvLoop' }
  | { id: number; type: 'stopRecvLoop' }
  | { id: number; type: 'getStats' }
  | { id: number; type: 'terminate' };

/** Helper: gửi success response */
function sendResult(id: number, data?: any) {
  self.postMessage({ id, type: 'result', data });
}

/** Helper: gửi error response */
function sendError(id: number, error: string) {
  self.postMessage({ id, type: 'error', error });
}

/** Helper: sleep */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Receive loop — chạy liên tục trong Worker.
 * asyncRecv() block Worker thread khi chờ data — KHÔNG ảnh hưởng Main Thread.
 * Data nhận được gửi về Main Thread qua postMessage với Transferable.
 */
async function recvLoop() {
  while (isRecvActive && ermisCall) {
    try {
      const data = await ermisCall.asyncRecv();
      // Transfer buffer ownership → zero-copy
      (self as unknown as { postMessage: (msg: any, transfer?: Transferable[]) => void }).postMessage(
        { type: 'recv_data', data },
        [data.buffer],
      );
    } catch (error) {
      if (!isRecvActive) break; // Đã dừng — không cần log
      (self as unknown as { postMessage: (msg: any, transfer?: Transferable[]) => void }).postMessage({
        type: 'recv_error',
        error: String(error),
      });
      await sleep(200); // Backoff trước khi thử lại
    }
  }
}

/** Main message handler */
self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;

  try {
    switch (msg.type) {
      // === LIFECYCLE ===
      case 'init': {
        await init(msg.wasmPath);
        ermisCall = new ErmisCall();
        sendResult(msg.id);
        break;
      }

      case 'spawn': {
        if (!ermisCall) throw new Error('WASM not initialized');
        await ermisCall.spawn(msg.relayUrls);
        sendResult(msg.id);
        break;
      }

      case 'getLocalEndpointAddr': {
        if (!ermisCall) throw new Error('WASM not initialized');
        const addr = await ermisCall.getLocalEndpointAddr();
        sendResult(msg.id, addr);
        break;
      }

      case 'connect': {
        if (!ermisCall) throw new Error('WASM not initialized');
        await ermisCall.connect(msg.address);
        sendResult(msg.id);
        break;
      }

      case 'acceptConnection': {
        if (!ermisCall) throw new Error('WASM not initialized');
        await ermisCall.acceptConnection();
        sendResult(msg.id);
        break;
      }

      // === DATA SEND (blocking calls — now safe in Worker) ===
      case 'sendFrame': {
        if (!ermisCall) throw new Error('WASM not initialized');
        ermisCall.sendFrame(msg.data);
        sendResult(msg.id);
        break;
      }

      case 'beginWithGop': {
        if (!ermisCall) throw new Error('WASM not initialized');
        ermisCall.beginWithGop(msg.data);
        sendResult(msg.id);
        break;
      }

      case 'sendAudioFrame': {
        if (!ermisCall) throw new Error('WASM not initialized');
        ermisCall.sendAudioFrame(msg.data);
        sendResult(msg.id);
        break;
      }

      case 'sendControlFrame': {
        if (!ermisCall) throw new Error('WASM not initialized');
        ermisCall.sendControlFrame(msg.data);
        sendResult(msg.id);
        break;
      }

      // === RECEIVE LOOP ===
      case 'startRecvLoop': {
        isRecvActive = true;
        sendResult(msg.id);
        // Start loop (fire-and-forget — runs until stopRecvLoop)
        recvLoop();
        break;
      }

      case 'stopRecvLoop': {
        isRecvActive = false;
        sendResult(msg.id);
        break;
      }

      // === CONTROL ===
      case 'closeEndpoint': {
        if (!ermisCall) throw new Error('WASM not initialized');
        await ermisCall.closeEndpoint();
        sendResult(msg.id);
        break;
      }

      case 'closeConnection': {
        if (!ermisCall) throw new Error('WASM not initialized');
        ermisCall.closeConnection();
        sendResult(msg.id);
        break;
      }

      case 'networkChange': {
        if (!ermisCall) throw new Error('WASM not initialized');
        ermisCall.networkChange();
        sendResult(msg.id);
        break;
      }

      case 'getStats': {
        if (!ermisCall) throw new Error('WASM not initialized');
        const stats = ermisCall.getStats();
        sendResult(msg.id, stats);
        break;
      }

      case 'terminate': {
        isRecvActive = false;
        if (ermisCall) {
          try {
            ermisCall.closeConnection();
          } catch {
            /* ignore */
          }
          try {
            ermisCall.free();
          } catch {
            /* ignore */
          }
          ermisCall = null;
        }
        sendResult(msg.id);
        // Worker sẽ bị terminate bởi Main Thread sau khi nhận result
        break;
      }

      default:
        sendError((msg as any).id, `Unknown message type: ${(msg as any).type}`);
    }
  } catch (error) {
    sendError(msg.id, String(error));
  }
};
