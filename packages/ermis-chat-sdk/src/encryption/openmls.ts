/**
 * Public, live-MLS-only view of the bundled OpenMLS module.
 *
 * The current binary temporarily contains additional internal exports. They are
 * intentionally not part of the external SDK contract and will be removed when
 * the replacement WASM artifact is available.
 */
export interface OpenMlsWasmModule {
  default(moduleOrPath?: string | URL | Request): Promise<unknown>;
  init(): void;
  Provider: unknown;
  Identity: unknown;
  Group: unknown;
  KeyPackage: unknown;
  RatchetTree: unknown;
  GroupInfo: unknown;
  MlsMessage: unknown;
  hash_channel_id(projectId: string, memberUserIds: string[]): string;
}

const wasmModuleCache = new Map<string, Promise<OpenMlsWasmModule>>();

export async function loadOpenMlsWasm(wasmPath = '/openmls_wasm_bg.wasm'): Promise<OpenMlsWasmModule> {
  const cacheKey = wasmPath;
  let promise = wasmModuleCache.get(cacheKey);

  if (!promise) {
    promise = (async () => {
      const wasmModule = (await import('./wasm/openmls_wasm.js')) as unknown as OpenMlsWasmModule;
      await wasmModule.default(wasmPath);
      wasmModule.init();
      return wasmModule;
    })();
    wasmModuleCache.set(cacheKey, promise);
  }

  return promise;
}
