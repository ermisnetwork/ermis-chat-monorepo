const fs = require('fs');
const path = require('path');

const sdkPath = path.join(__dirname, '../packages/ermis-chat-sdk/package.json');
const reactPath = path.join(__dirname, '../packages/ermis-chat-react/package.json');

function bumpVersion(versionStr, type) {
  const parts = versionStr.split('.').map(Number);
  
  if (type === 'major') {
    parts[0] += 1;
    parts[1] = 0;
    parts[2] = 0;
  } else if (type === 'minor') {
    parts[1] += 1;
    parts[2] = 0;
  } else {
    parts[2] += 1; // Mặc định là patch
  }
  
  return parts.join('.');
}

// Bắt tham số từ dòng lệnh (VD: minor, major, patch), nếu không gõ thì mặc định là patch
const bumpType = process.argv[2] || 'patch';

try {
  // 1. Đọc và parse package.json của SDK
  const sdkPkg = JSON.parse(fs.readFileSync(sdkPath, 'utf8'));
  const oldVersion = sdkPkg.version;
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

  console.log(`\x1b[32m🚀 Thành công!\x1b[0m Hệ thống nâng cấp mức độ [\x1b[35m${bumpType.toUpperCase()}\x1b[0m]`);
  console.log(`Version nhảy từ \x1b[33m${oldVersion}\x1b[0m ➡️ \x1b[36m${newVersion}\x1b[0m`);
  console.log(`Áp dụng nội bộ thành công cho cả 2 packages: SDK và React UI.`);
} catch (error) {
  console.error('\x1b[31m❌ Lỗi khi tự động nâng version:\x1b[0m', error.message);
}
