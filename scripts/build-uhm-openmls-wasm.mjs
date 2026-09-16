#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const openMlsDir = path.resolve(process.env.OPENMLS_DIR || path.join(repoRoot, '..', 'openmls'));
const outputDir = path.join(repoRoot, 'apps/uhm-chat/public');

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
const requireText = (contents, expected, label) => {
  for (const value of expected) {
    if (!contents.includes(value)) throw new Error(`${label} is missing required OpenMLS export: ${value}`);
  }
};

if (!existsSync(path.join(openMlsDir, '.git'))) {
  throw new Error(`OpenMLS repository not found at ${openMlsDir}; set OPENMLS_DIR to its absolute path`);
}

const sourceStatus = capture('git', ['status', '--porcelain'], openMlsDir);
const dirty = sourceStatus.length > 0;
if (dirty && process.env.ALLOW_DIRTY_OPENMLS !== '1') {
  throw new Error('OpenMLS working tree is dirty; set ALLOW_DIRTY_OPENMLS=1 only for a local development artifact');
}

run('wasm-pack', ['build', '--target', 'web'], path.join(openMlsDir, 'openmls-wasm'));

const pkgDir = path.join(openMlsDir, 'openmls-wasm/pkg');
const glue = readFileSync(path.join(pkgDir, 'openmls_wasm.js'), 'utf8');
const declarations = readFileSync(path.join(pkgDir, 'openmls_wasm.d.ts'), 'utf8');
const wasmDeclarations = readFileSync(path.join(pkgDir, 'openmls_wasm_bg.wasm.d.ts'), 'utf8');

const publicExports = [
  'WrappedRecoveryKey',
  'generate_recovery_keypair',
  'wrap_recovery_private_key',
  'process_message_at',
  'join_with_welcome_typed',
  'MlsErrorCode',
];
requireText(glue, publicExports, 'generated glue');
requireText(declarations, publicExports, 'generated declarations');
requireText(
  wasmDeclarations,
  ['wrappedrecoverykey_from_bytes', 'group_process_message_at', 'group_join_with_welcome_typed'],
  'generated WASM declarations',
);

for (const file of ['openmls_wasm.js', 'openmls_wasm.d.ts', 'openmls_wasm_bg.wasm', 'openmls_wasm_bg.wasm.d.ts']) {
  copyFileSync(path.join(pkgDir, file), path.join(outputDir, file));
}

const wasmPath = path.join(pkgDir, 'openmls_wasm_bg.wasm');
const wasmBytes = readFileSync(wasmPath);
const cargoLockPath = path.join(openMlsDir, 'Cargo.lock');
const provenance = {
  generated_at: new Date().toISOString(),
  openmls_commit: capture('git', ['rev-parse', 'HEAD'], openMlsDir),
  openmls_dirty: dirty,
  openmls_status_sha256: sha256(sourceStatus),
  openmls_tracked_diff_sha256: sha256(capture('git', ['diff', '--binary'], openMlsDir)),
  cargo_lock_sha256: existsSync(cargoLockPath) ? sha256(readFileSync(cargoLockPath)) : null,
  wasm_pack: capture('wasm-pack', ['--version']),
  cargo: capture('cargo', ['--version']),
  rustc: capture('rustc', ['--version']),
  wasm_sha256: sha256(wasmBytes),
  wasm_size: statSync(wasmPath).size,
  contracts: ['recovery_pin', 'epoch_archive', 'typed_welcome', 'trusted_historical_time'],
};
writeFileSync(path.join(outputDir, 'openmls_wasm_build.json'), `${JSON.stringify(provenance, null, 2)}\n`);

console.log(`UHM OpenMLS ${provenance.openmls_commit} -> ${provenance.wasm_sha256} (${provenance.wasm_size} bytes)`);
