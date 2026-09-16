// UHM needs the internal OpenMLS contract (PIN/archive plus rollout APIs).
// The publishable SDK artifact intentionally carries the smaller external contract.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let openMlsPromise: Promise<any> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function loadUhmOpenMlsWasm(wasmPath = '/openmls_wasm_bg.wasm'): Promise<any> {
  if (!openMlsPromise) {
    openMlsPromise = (async () => {
      const moduleUrl = new URL('/openmls_wasm.js', window.location.origin).href;
      const module = await import(/* @vite-ignore */ moduleUrl);
      await module.default({ module_or_path: wasmPath });
      module.init();
      return module;
    })().catch((error) => {
      openMlsPromise = null;
      throw error;
    });
  }
  return openMlsPromise;
}
