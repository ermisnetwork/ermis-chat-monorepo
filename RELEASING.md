# Hướng dẫn Phát hành (Releasing Guide)

Dự án Ermis Chat sử dụng Github Actions để tự động publish (NPM) mỗi khi bạn đẩy code lên nhánh `main`.

> [!WARNING]
> Vì dự án không còn sử dụng Changesets, bạn **BẮT BUỘC** phải tự đổi số phiên bản (`version`) bằng tay trong file `package.json` của thư viện mà bạn sửa. Nếu quên, NPM sẽ văng lỗi vì trùng lặp version cũ!

## Package NPM chính thức

- Core SDK: `@ermis-network/ermis-chat-sdk`
- React SDK: `@ermis-network/ermis-chat-react`

Giữ nguyên scope `@ermis-network/*` khi publish. Nếu đã lỡ publish các tên unscoped hoặc tên trung gian, hãy deprecate bản đó trên NPM và hướng người dùng sang hai package chính thức ở trên.

---

## Quy trình làm việc (Workflow)

### 1. Code xong tính năng
Tại máy tính cá nhân của bạn, mở code lên sửa lỗi hoặc thêm tính năng.

### 2. Tự động nâng Version
Sau khi code xong, bạn không cần phải lục tung các file `package.json` lên để sửa bằng tay nữa. Hãy gõ lệnh này ở thư mục gốc:

**Khuyên dùng (Patch):** Thay đổi nhỏ (sửa bug, thêm comment).
```bash
yarn bump
```

**Thêm tính năng lớn (Minor):**
```bash
yarn bump minor
```

**Đập đi xây lại (Major):**
```bash
yarn bump major
```

*(Lệnh này tự động tính toán cộng dồn số phiên bản chính xác theo chuẩn SemVer, và lưu thẳng vào cả 2 package `sdk` & `react`. Đồng thời nó dạy React luôn xài đúng bản SDK vừa nhảy số).*

### 3. Commit và Push
Dùng git để commit code như bình thường:
```bash
git add .
git commit -m "feat: cập nhật siêu xịn"
git push
```

### 4. Publish thủ công cả 2 packages

Nếu cần publish từ máy local thay vì đợi Github Actions, dùng script:

```bash
yarn publish:packages --dry-run
yarn publish:packages --yes
```

Script này build SDK/React, chạy `npm pack --dry-run`, kiểm tra `@ermis-network/ermis-chat-react` đang phụ thuộc đúng version `@ermis-network/ermis-chat-sdk`, rồi publish tuần tự: SDK trước, đợi NPM registry nhìn thấy SDK cùng version, sau đó publish React. Script có thể resume: nếu SDK version đã tồn tại nhưng React chưa tồn tại, nó sẽ bỏ qua SDK và publish React. Có thể truyền tag:

```bash
yarn publish:packages --tag beta --yes
```

Nếu tài khoản NPM bật web-based 2FA, vẫn dùng lệnh trên và không cần truyền OTP. Ở mỗi bước `npm publish`, terminal sẽ yêu cầu bấm Enter để mở browser; xác thực xong ở browser thì tiến trình quay lại terminal và tiếp tục package kế tiếp.

Nếu tài khoản NPM dùng mã OTP 6 số thay vì browser verification, có thể truyền OTP riêng cho từng package:

```bash
yarn publish:packages --otp-sdk 111111 --otp-react 222222 --yes
```

Hoặc publish từng package riêng nếu muốn tự kiểm soát từng bước:

```bash
yarn publish:sdk --yes
yarn publish:react --yes
```

Luồng này publish SDK trước. Lệnh publish React sẽ kiểm tra SDK cùng version đã tồn tại trên NPM, để dependency `@ermis-network/ermis-chat-sdk` không trỏ tới version chưa publish.

### 5. Tự động hóa Github Actions
Sau khi code được đẩy thẳng lên `main` (hoặc sau khi được chốt Merge Pull Request vào `main`):
Con bot Github Actions tên là `"Publish SDKs to NPM"` sẽ lập tức chạy:
1. Yarn Install & Build.
2. Di chuyển vào SDK -> publish `@ermis-network/ermis-chat-sdk`.
3. Di chuyển vào React -> publish `@ermis-network/ermis-chat-react`.

Vậy là xong! Phiên bản mới đã xuất hiện trên NPM. Mọi thứ rất dễ theo dõi!

## Change log

- `2026-07-03`: Added `scripts/publish-packages.sh` and `yarn publish:packages` for local parallel publishing of `@ermis-network/ermis-chat-sdk` and `@ermis-network/ermis-chat-react`.
- `2026-07-06`: Added `scripts/publish-one-package.sh`, `yarn publish:sdk`, and `yarn publish:react` for sequential 2FA-friendly local publishing.
- `2026-07-06`: Changed `scripts/publish-packages.sh` to publish SDK then React sequentially, wait for SDK registry propagation, and resume when SDK already exists but React is still missing.
