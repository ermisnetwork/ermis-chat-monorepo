// UHM loads the paired internal OpenMLS artifact and hashes its actual bytes.
import { instrumentMlsExternalJoin } from '@/utils/mlsRepairDiagnostics';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let openMlsPromise: Promise<any> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function loadUhmOpenMlsWasm(wasmPath = '/openmls_wasm_bg.wasm'): Promise<any> {
  if (!openMlsPromise) {
    openMlsPromise = (async () => {
      const moduleUrl = new URL('/openmls_wasm.js', window.location.origin).href;
      const [metadataResponse,wasmResponse]=await Promise.all([
        fetch('/openmls_wasm_build.json',{cache:'no-store'}),fetch(wasmPath,{cache:'no-store'}),
      ]);
      if(!metadataResponse.ok || !wasmResponse.ok)throw new Error('mls_artifact_unavailable');
      const metadata=await metadataResponse.json(),bytes=await wasmResponse.arrayBuffer();
      if(bytes.byteLength<1 || bytes.byteLength>8_388_608 || metadata.wasm_size!==bytes.byteLength ||
          typeof metadata.wasm_sha256!=='string' || !/^[0-9a-f]{64}$/.test(metadata.wasm_sha256))throw new Error('mls_artifact_mismatch');
      const actual=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
      if(actual!==metadata.wasm_sha256)throw new Error('mls_artifact_mismatch');
      const module = await import(/* @vite-ignore */ moduleUrl);
      await module.default({ module_or_path: bytes });
      module.init();
      instrumentMlsExternalJoin(module.Group);
      return {...module,__ermisWasmSha256:actual};
    })().catch((error) => {
      openMlsPromise = null;
      throw error;
    });
  }
  return openMlsPromise;
}
