#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

// Absolute path to the files inside the installed package
const sourceWasm = path.join(__dirname, '../public/ermis_call_node_wasm_bg.wasm');
const sourceIncomingMp3 = path.join(__dirname, '../public/call_incoming.mp3');
const sourceOutgoingMp3 = path.join(__dirname, '../public/call_outgoing.mp3');

// Execution directory (always the root of the consumer's project)
const targetDir = path.join(process.cwd(), 'public');
const targetWasm = path.join(targetDir, 'ermis_call_node_wasm_bg.wasm');
const targetIncomingMp3 = path.join(targetDir, 'call_incoming.mp3');
const targetOutgoingMp3 = path.join(targetDir, 'call_outgoing.mp3');

console.log('🔄 Configuring WebAssembly & Audio files for Ermis Direct Call feature...');

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

  if (fs.existsSync(sourceIncomingMp3)) {
    fs.copyFileSync(sourceIncomingMp3, targetIncomingMp3);
    console.log('✅ Successfully copied call_incoming.mp3 to your public/ directory!');
  } else {
    console.warn('⚠️ Warning: call_incoming.mp3 not found in SDK, skipping copy.');
  }

  if (fs.existsSync(sourceOutgoingMp3)) {
    fs.copyFileSync(sourceOutgoingMp3, targetOutgoingMp3);
    console.log('✅ Successfully copied call_outgoing.mp3 to your public/ directory!');
  } else {
    console.warn('⚠️ Warning: call_outgoing.mp3 not found in SDK, skipping copy.');
  }

  console.log('You can now enable the Direct Call feature in your application.');
} catch (error) {
  console.error('❌ An error occurred while copying the file:', error.message);
  process.exit(1);
}
