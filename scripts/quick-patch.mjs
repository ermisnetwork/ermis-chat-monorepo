import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// Lấy tham số người dùng nhập từ Terminal (Bỏ qua 2 phần tử đầu là lệnh node)
const messageArgs = process.argv.slice(2);
const message = messageArgs.length > 0 ? messageArgs.join(' ') : 'Cập nhật và tối ưu nội bộ SDK';

// Tạo tên file ngẫu nhiên đúng chuẩn
const id = crypto.randomBytes(3).toString('hex');
const fileName = `patch-${id}.md`;

// Nội dung file luôn ép cứng cập nhật Patch cho cả 2 package
const content = `---
"@ermis-network/ermis-chat-react": patch
"@ermis-network/ermis-chat-sdk": patch
---

${message}
`;

const destPath = path.join(process.cwd(), '.changeset', fileName);

// Ghi file
fs.writeFileSync(destPath, content);
console.log(`\x1b[32m✅ Đã tự động tạo file cấu hình Patch:\x1b[0m .changeset/${fileName}`);
console.log(`\x1b[36m📝 Nội dung:\x1b[0m ${message}`);
console.log(`Bây giờ bạn chỉ cần commit file này và push lên github!`);
