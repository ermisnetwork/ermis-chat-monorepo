# Hướng dẫn Phát hành (Releasing Guide)

Dự án Ermis Chat sử dụng Github Actions để tự động publish (NPM) mỗi khi bạn đẩy code lên nhánh `main`. 

> [!WARNING]
> Vì dự án không còn sử dụng Changesets, bạn **BẮT BUỘC** phải tự đổi số phiên bản (`version`) bằng tay trong file `package.json` của thư viện mà bạn sửa. Nếu quên, NPM sẽ văng lỗi vì trùng lặp version cũ!

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

### 4. Tự động hóa Github Actions 🚀
Sau khi code được đẩy thẳng lên `main` (hoặc sau khi được chốt Merge Pull Request vào `main`):
Con bot Github Actions tên là `"Publish SDKs to NPM"` sẽ lập tức chạy:
1. Yarn Install & Build.
2. Di chuyển vào SDK -> Chạy lệnh `npm publish`.
3. Di chuyển vào React -> Chạy lệnh `npm publish`.

Vậy là xong! Phiên bản mới đã xuất hiện trên NPM. Mọi thứ rất dễ theo dõi!
