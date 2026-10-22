#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const openMlsDir = path.resolve(process.env.OPENMLS_DIR || path.join(repoRoot, '..', 'openmls'));
const outputDir = path.join(repoRoot, 'apps/uhm-chat/public');

const capture = (command, args, cwd = repoRoot, trim = true) => {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `${command} failed with exit ${result.status}`);
  }
  return trim ? result.stdout.trim() : result.stdout;
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
  'process_application_message',
  'owns_key_package_ref',
  'join_with_welcome_typed',
  'MlsErrorCode',
  'WelcomeCandidate',
  'join_with_welcome_with_policy',
  'join_external_with_policy',
  'process_message_with_context',
  'device_registration_signature',
  'lor_request_signature',
  'signature_public_key',
  'key_packages_typed',
  'rebase_candidate',
  'GroupInfoValidation',
  'validate_group_info_with_policy',
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
  copyFileSync(path.join(pkgDir, file), path.join(repoRoot, 'packages/ermis-chat-sdk/src/encryption/wasm', file));
  if (file === 'openmls_wasm_bg.wasm') copyFileSync(path.join(pkgDir, file), path.join(repoRoot, 'packages/ermis-chat-sdk/public', file));
}

// Target web emits one complete JS glue. Old bundler glue is not part of this
// generated set; retain its prior bytes in the restoration receipt/bundle.
for (const destination of [outputDir, path.join(repoRoot, 'packages/ermis-chat-sdk/src/encryption/wasm')]) {
  const obsolete = path.join(destination, 'openmls_wasm_bg.js');
  if (existsSync(obsolete)) unlinkSync(obsolete);
}

const wasmPath = path.join(pkgDir, 'openmls_wasm_bg.wasm');
const wasmBytes = readFileSync(wasmPath);
const cargoLockPath = path.join(openMlsDir, 'Cargo.lock');
// Include new/untracked producer files, not only tracked diff.
const sourceFiles = {};
const recordSources = (directory, relative = '') => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!['.git', 'target', 'pkg', 'node_modules', '.task-artifacts'].includes(entry.name)) recordSources(path.join(directory, entry.name), name);
    } else if (entry.isFile() && (/\.(rs|udl)$/.test(entry.name) || ['Cargo.toml', 'Cargo.lock'].includes(entry.name))) {
      sourceFiles[name] = sha256(readFileSync(path.join(directory, entry.name)));
    }
  }
};
recordSources(openMlsDir);
const provenance = {
  source_files: sourceFiles,
  local_only: dirty,
  generated_at: new Date().toISOString(),
  openmls_commit: capture('git', ['rev-parse', 'HEAD'], openMlsDir),
  openmls_dirty: dirty,
  openmls_status_sha256: sha256(sourceStatus),
  openmls_tracked_diff_sha256: sha256(capture('git', ['diff', '--binary'], openMlsDir, false)),
  cargo_lock_sha256: existsSync(cargoLockPath) ? sha256(readFileSync(cargoLockPath)) : null,
  wasm_pack: capture('wasm-pack', ['--version']),
  cargo: capture('cargo', ['--version']),
  rustc: capture('rustc', ['--version']),
  wasm_sha256: sha256(wasmBytes),
  wasm_size: statSync(wasmPath).size,
  contracts: ['recovery_pin', 'epoch_archive', 'epoch_archive_v2', 'explicit_group_id', 'group_generation', 'typed_welcome', 'trusted_historical_time', 'private_key_package_ownership', 'validated_application_ratchet', 'fallible_key_package_generation_serialization', 'isolated_welcome_candidate', 'checked_allow_expired_tree_policy', 'canonical_acceptance_context', 'device_registration_proof', 'mls_control_request_proof_v1', 'three_way_candidate_rebase', 'readonly_group_info_validation'],
};
const sdkDir = path.join(repoRoot, 'packages/ermis-chat-sdk');
for (const destination of [outputDir, path.join(sdkDir, 'src/encryption/wasm')]) {
  writeFileSync(path.join(destination, 'openmls_wasm_build.json'), `${JSON.stringify(provenance, null, 2)}\n`);
}
const packagePath = path.join(sdkDir, 'package.json');
const sdkPackage = JSON.parse(readFileSync(packagePath, 'utf8'));
sdkPackage.openmlsBuild = {
  ...sdkPackage.openmlsBuild,
  commit: provenance.openmls_commit,
  sourceDiffSha256: provenance.openmls_tracked_diff_sha256,
  patches: [],
  cargoLockSha256: provenance.cargo_lock_sha256,
  wasmPack: provenance.wasm_pack,
  cargo: provenance.cargo,
  rustc: provenance.rustc,
  wasmSha256: provenance.wasm_sha256,
  wasmSize: provenance.wasm_size,
  contracts: provenance.contracts,
  sourceFilesSha256: sha256(JSON.stringify(sourceFiles)),
  localOnly: provenance.local_only,
};
writeFileSync(packagePath, `${JSON.stringify(sdkPackage, null, 2)}\n`);

console.log(`UHM OpenMLS ${provenance.openmls_commit} -> ${provenance.wasm_sha256} (${provenance.wasm_size} bytes)`);
