export type OpenMlsWasmModule = typeof import('./wasm/openmls_wasm');

const wasmModuleCache = new Map<string, Promise<OpenMlsWasmModule>>();

export async function loadOpenMlsWasm(wasmPath = '/openmls_wasm_bg.wasm'): Promise<OpenMlsWasmModule> {
  const cacheKey = wasmPath;
  let promise = wasmModuleCache.get(cacheKey);

  if (!promise) {
    promise = (async () => {
      const wasmModule = await import('./wasm/openmls_wasm.js');
      await wasmModule.default(wasmPath);
      wasmModule.init();
      return wasmModule;
    })();
    wasmModuleCache.set(cacheKey, promise);
  }

  return promise;
}
