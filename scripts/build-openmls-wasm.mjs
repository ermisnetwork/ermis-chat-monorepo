#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sdkRoot = path.join(repoRoot, 'packages/ermis-chat-sdk');
const openMlsDir = path.resolve(process.env.OPENMLS_DIR || path.join(repoRoot, '..', 'openmls'));
const manifest = JSON.parse(readFileSync(path.join(sdkRoot, 'package.json'), 'utf8'));
const build = manifest.openmlsBuild;

const capture = (command, args, cwd = repoRoot) => {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `${command} failed with exit ${result.status}`);
  }
  return result.stdout.trim();
};

const run = (command, args, cwd = repoRoot) => {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} failed with exit ${result.status}`);
};

const sha256 = (contents) => createHash('sha256').update(contents).digest('hex');
const assertEqual = (actual, expected, label) => {
  if (actual !== expected) throw new Error(`${label} mismatch: expected ${expected}, received ${actual}`);
};

if (!existsSync(path.join(openMlsDir, '.git'))) {
  throw new Error(`OpenMLS repository not found at ${openMlsDir}; set OPENMLS_DIR to its absolute path`);
}

assertEqual(capture('git', ['rev-parse', 'HEAD'], openMlsDir), build.commit, 'OpenMLS commit');
assertEqual(
  capture('git', ['status', '--porcelain', '--untracked-files=no'], openMlsDir),
  '',
  'OpenMLS tracked working tree',
);
assertEqual(capture('wasm-pack', ['--version']), build.wasmPack, 'wasm-pack version');
assertEqual(capture('cargo', ['--version']), build.cargo, 'cargo version');
assertEqual(capture('rustc', ['--version']), build.rustc, 'rustc version');

const pinnedLock = path.join(sdkRoot, 'wasm-build/Cargo.lock');
const openMlsLock = path.join(openMlsDir, 'Cargo.lock');
const lockBytes = readFileSync(pinnedLock);
assertEqual(sha256(lockBytes), build.cargoLockSha256, 'Pinned Cargo.lock SHA-256');
copyFileSync(pinnedLock, openMlsLock);

const wasmPackageDir = path.join(openMlsDir, 'openmls-wasm/pkg');
run('wasm-pack', ['build', '--target', 'web'], path.join(openMlsDir, 'openmls-wasm'));
assertEqual(sha256(readFileSync(openMlsLock)), build.cargoLockSha256, 'Post-build Cargo.lock SHA-256');

const generatedGluePath = path.join(wasmPackageDir, 'openmls_wasm.js');
let generatedGlue = readFileSync(generatedGluePath, 'utf8');
const loggerReplacements = [
  [
    'console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\\n", e);',
    'globalThis.__ermisSdkLog?.(\'warn\', "`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\\n", e);',
  ],
  [
    'console.error(getStringFromWasm0(arg0, arg1));',
    "globalThis.__ermisSdkLog?.('error', getStringFromWasm0(arg0, arg1));",
  ],
  [
    "console.warn('using deprecated parameters for `initSync()`; pass a single object instead')",
    "globalThis.__ermisSdkLog?.('warn', 'using deprecated parameters for `initSync()`; pass a single object instead')",
  ],
  [
    "console.warn('using deprecated parameters for the initialization function; pass a single object instead')",
    "globalThis.__ermisSdkLog?.('warn', 'using deprecated parameters for the initialization function; pass a single object instead')",
  ],
];

for (const [original, replacement] of loggerReplacements) {
  if (!generatedGlue.includes(original)) {
    throw new Error(`Generated OpenMLS glue changed; missing logger integration target: ${original}`);
  }
  generatedGlue = generatedGlue.replace(original, replacement);
}

const declarations = readFileSync(path.join(wasmPackageDir, 'openmls_wasm.d.ts'), 'utf8');
const wasmDeclarations = readFileSync(path.join(wasmPackageDir, 'openmls_wasm_bg.wasm.d.ts'), 'utf8');
const forbiddenHistoryContract = /epoch[-_ ]?archive|\b(?:recovery|vault|pin)\b/i;
for (const [label, contents] of [
  ['generated glue', generatedGlue],
  ['generated declarations', declarations],
  ['generated WASM declarations', wasmDeclarations],
]) {
  if (forbiddenHistoryContract.test(contents)) {
    throw new Error(`${label} contains a forbidden encrypted-history contract`);
  }
}

const wasmPath = path.join(wasmPackageDir, 'openmls_wasm_bg.wasm');
const wasmBytes = readFileSync(wasmPath);
assertEqual(sha256(wasmBytes), build.wasmSha256, 'OpenMLS WASM SHA-256');
assertEqual(statSync(wasmPath).size, build.wasmSize, 'OpenMLS WASM size');

const generatedDir = path.join(sdkRoot, 'src/encryption/wasm');
writeFileSync(path.join(generatedDir, 'openmls_wasm.js'), generatedGlue);
copyFileSync(path.join(wasmPackageDir, 'openmls_wasm.d.ts'), path.join(generatedDir, 'openmls_wasm.d.ts'));
copyFileSync(wasmPath, path.join(generatedDir, 'openmls_wasm_bg.wasm'));
copyFileSync(
  path.join(wasmPackageDir, 'openmls_wasm_bg.wasm.d.ts'),
  path.join(generatedDir, 'openmls_wasm_bg.wasm.d.ts'),
);
copyFileSync(wasmPath, path.join(sdkRoot, 'public/openmls_wasm_bg.wasm'));
copyFileSync(wasmPath, path.join(repoRoot, 'apps/uhm-chat/public/openmls_wasm_bg.wasm'));
rmSync(path.join(generatedDir, 'openmls_wasm_bg.js'), { force: true });

console.log(`OpenMLS ${build.commit} -> ${build.wasmSha256} (${build.wasmSize} bytes)`);
