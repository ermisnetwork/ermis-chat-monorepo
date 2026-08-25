const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const sdkDir = path.join(rootDir, 'packages/ermis-chat-sdk');
const reactDir = path.join(rootDir, 'packages/ermis-chat-react');

const target = process.argv[2] || 'all'; // 'all', 'sdk', 'react'
const dryRun = process.argv.includes('--dry-run');

function run(cmd, cwd = rootDir) {
  console.log(`\n\x1b[36m==> [${cwd}] ${cmd}\x1b[0m`);
  execSync(cmd, { cwd, stdio: 'inherit' });
}

function getPkg(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
}

function checkVersionExists(pkgName, version) {
  try {
    const res = execSync(`npm view ${pkgName}@${version} version --json`, { stdio: ['pipe', 'pipe', 'ignore'] })
      .toString()
      .trim();
    return res.includes(version);
  } catch {
    return false;
  }
}

try {
  console.log('\x1b[32m🚀 Starting Ermis Chat Packages Publish Process...\x1b[0m');

  // 1. Build packages
  if (!process.argv.includes('--skip-build')) {
    console.log('\n📦 Building packages...');
    run('yarn build');
  }

  const sdkPkg = getPkg(sdkDir);
  const reactPkg = getPkg(reactDir);

  const publishFlags = dryRun ? '--dry-run --access public' : '--access public';

  // 2. Publish SDK
  if (target === 'all' || target === 'sdk') {
    const sdkExists = checkVersionExists(sdkPkg.name, sdkPkg.version);
    if (sdkExists) {
      console.log(`\x1b[33m⚠️  ${sdkPkg.name}@${sdkPkg.version} is already published on npm. Skipping.\x1b[0m`);
    } else {
      console.log(`\n🚀 Publishing ${sdkPkg.name}@${sdkPkg.version}...`);
      run(`npm publish ${publishFlags}`, sdkDir);
      console.log(`\x1b[32m✅ Successfully published ${sdkPkg.name}@${sdkPkg.version}\x1b[0m`);
    }
  }

  // 3. Publish React UI
  if (target === 'all' || target === 'react') {
    const reactExists = checkVersionExists(reactPkg.name, reactPkg.version);
    if (reactExists) {
      console.log(`\x1b[33m⚠️  ${reactPkg.name}@${reactPkg.version} is already published on npm. Skipping.\x1b[0m`);
    } else {
      console.log(`\n🚀 Publishing ${reactPkg.name}@${reactPkg.version}...`);
      run(`npm publish ${publishFlags}`, reactDir);
      console.log(`\x1b[32m✅ Successfully published ${reactPkg.name}@${reactPkg.version}\x1b[0m`);
    }
  }

  console.log('\n\x1b[32m🎉 Publish workflow completed!\x1b[0m\n');
} catch (error) {
  console.error('\n\x1b[31m❌ Publish failed:\x1b[0m', error.message);
  process.exit(1);
}
