const fs = require('fs');
const path = require('path');

const sdkPath = path.join(__dirname, '../packages/ermis-chat-sdk/package.json');
const reactPath = path.join(__dirname, '../packages/ermis-chat-react/package.json');

function bumpVersion(versionStr, type) {
  // If user passes an explicit version (e.g. 2.1.1 or 2.1.0-external.3)
  if (/^\d+\.\d+\.\d+(-[a-zA-Z0-9_.-]+)?$/.test(type)) {
    return type;
  }

  // Parse semver with optional prerelease tag
  // Matches: 2.1.0, 2.1.0-external.2, 2.1.0-alpha, etc.
  const match = versionStr.match(/^(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9_.-]+?)(?:\.(\d+))?)?$/);
  if (!match) {
    // Fallback: if string has NaN from previous bad bump, recover
    if (versionStr.includes('NaN')) {
      return '2.1.0-external.3';
    }
    throw new Error(`Invalid semver format: "${versionStr}"`);
  }

  let major = parseInt(match[1], 10);
  let minor = parseInt(match[2], 10);
  let patch = parseInt(match[3], 10);
  const tag = match[4]; // e.g. "external"
  const preNum = match[5] !== undefined ? parseInt(match[5], 10) : undefined;

  switch (type.toLowerCase()) {
    case 'major':
      return `${major + 1}.0.0`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'release':
      return `${major}.${minor}.${patch}`;
    case 'prerelease':
    case 'external':
      if (tag) {
        const nextPre = preNum !== undefined ? preNum + 1 : 1;
        return `${major}.${minor}.${patch}-${tag}.${nextPre}`;
      }
      return `${major}.${minor}.${patch + 1}-external.1`;
    case 'patch':
    default:
      if (tag && preNum !== undefined) {
        return `${major}.${minor}.${patch}-${tag}.${preNum + 1}`;
      }
      return `${major}.${minor}.${patch + 1}`;
  }
}

// Bắt tham số từ dòng lệnh (VD: minor, major, patch, external, hoặc phiên bản cụ thể)
const bumpType = process.argv[2] || 'patch';

try {
  // 1. Đọc và parse package.json của SDK
  const sdkPkg = JSON.parse(fs.readFileSync(sdkPath, 'utf8'));
  const oldVersion = sdkPkg.version.includes('NaN') ? '2.1.0-external.2' : sdkPkg.version;
  const newVersion = bumpVersion(oldVersion, bumpType);

  // 2. Cập nhật cho SDK
  sdkPkg.version = newVersion;
  fs.writeFileSync(sdkPath, JSON.stringify(sdkPkg, null, 2) + '\n');

  // 3. Đọc và cập nhật cho React UI
  const reactPkg = JSON.parse(fs.readFileSync(reactPath, 'utf8'));
  reactPkg.version = newVersion;

  // Đồng thời cập nhật cả dòng dependencies để React luôn đòi hỏi SDK bản mới nhất
  if (reactPkg.dependencies && reactPkg.dependencies['@ermis-network/ermis-chat-sdk']) {
    reactPkg.dependencies['@ermis-network/ermis-chat-sdk'] = newVersion;
  }

  fs.writeFileSync(reactPath, JSON.stringify(reactPkg, null, 2) + '\n');

  // 4. Update apps/uhm-chat if present
  const uhmPath = path.join(__dirname, '../apps/uhm-chat/package.json');
  if (fs.existsSync(uhmPath)) {
    const uhmPkg = JSON.parse(fs.readFileSync(uhmPath, 'utf8'));
    if (uhmPkg.dependencies) {
      if (uhmPkg.dependencies['@ermis-network/ermis-chat-sdk']) {
        uhmPkg.dependencies['@ermis-network/ermis-chat-sdk'] = newVersion;
      }
      if (uhmPkg.dependencies['@ermis-network/ermis-chat-react']) {
        uhmPkg.dependencies['@ermis-network/ermis-chat-react'] = newVersion;
      }
    }
    fs.writeFileSync(uhmPath, JSON.stringify(uhmPkg, null, 2) + '\n');
  }

  console.log(`\x1b[32m🚀 Thành công!\x1b[0m Nâng cấp mức độ [\x1b[35m${bumpType.toUpperCase()}\x1b[0m]`);
  console.log(`Version: \x1b[33m${oldVersion}\x1b[0m ➡️ \x1b[36m${newVersion}\x1b[0m`);
  console.log(`Áp dụng thành công cho SDK, React UI và UHM Chat.`);
} catch (error) {
  console.error('\x1b[31m❌ Lỗi khi tự động nâng version:\x1b[0m', error.message);
}
