#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

// Absolute path to the wasm file inside the installed package
const sourceWasm = path.join(__dirname, '../public/ermis_call_node_wasm_bg.wasm');

// Execution directory (always the root of the consumer's project)
const targetDir = path.join(process.cwd(), 'public');
const targetWasm = path.join(targetDir, 'ermis_call_node_wasm_bg.wasm');

console.log('🔄 Configuring WebAssembly file for Ermis Direct Call feature...');

if (!fs.existsSync(sourceWasm)) {
  console.error('❌ Error: Could not find the original Wasm file in the SDK package.');
  console.error('Search path:', sourceWasm);
  process.exit(1);
}

// Create the public directory if it doesn't exist in the consumer project
if (!fs.existsSync(targetDir)) {
  console.log('Creating public directory...');
  fs.mkdirSync(targetDir, { recursive: true });
}

try {
  fs.copyFileSync(sourceWasm, targetWasm);
  console.log('✅ Successfully copied ermis_call_node_wasm_bg.wasm to your public/ directory!');
  console.log('You can now enable the Direct Call feature in your application.');
} catch (error) {
  console.error('❌ An error occurred while copying the file:', error.message);
  process.exit(1);
}
