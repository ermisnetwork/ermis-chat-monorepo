# Hướng dẫn Phát hành (Releasing Guide)

Ermis Chat Monorepo sử dụng [Changesets](https://github.com/changesets/changesets) kết hợp với GitHub Actions để tự động hóa toàn bộ quy trình đẩy code lên NPM và cập nhật số `version`. 

Bạn **KHÔNG BAO GIỜ** cần phải tự mở file `package.json` lên và đổi `version` bằng tay nữa. Hãy làm theo hướng dẫn dưới đây.

---

## Quy trình làm việc (Workflow)

### 1. Sau khi Code xong, chạy lệnh Changeset
Tại máy tính cá nhân của bạn, sau khi code xong tính năng hoặc sửa lỗi, trước khi tiến hành Commit và Push, hãy quyết định mức độ nâng cấp của phiên bản:

**Cách 1 (Nhanh nhất): Dành cho cập nhật Patch (Sửa lỗi nhỏ, Tối ưu, Thêm comment)**
Hầu hết các trường hợp, bạn chỉ cần một bản "Patch" (VD: `1.0.3` -> `1.0.4`). Hãy gõ lệnh tắt này ở thư mục gốc:
```bash
yarn patch "Nội dung tóm tắt cập nhật của bạn"
```
*(Lệnh này sẽ tự động sinh file cấu hình và bỏ qua mọi câu hỏi rườm rà. Hệ thống đã tự động gộp (link) chung package SDK và React lại với nhau).*

**Cách 2: Dành cho cập nhật Minor (Tính năng lớn) hoặc Major (Breaking Changes)**
Nếu bạn có sự thay đổi lớn, hãy khởi chạy CLI tương tác cơ bản:
```bash
yarn changeset
```
1. **Chọn Packages**: Dùng các phím `Mũi tên lên/xuống` và nhấn phím `Space` để tích chọn những thư viện có sự thay đổi. (Bởi vì SDK và React đã được config tự động link với nhau, bạn chọn 1 thì cái kia cũng tự nhảy). Nhấn `Enter` để chốt.
2. **Bỏ qua Major/Minor nếu không cần thiết**: Nếu đang ở dấu nhắc Major mà không muốn đập đi xây lại, đừng Space chọn gì cả, cứ gõ thẳng `Enter`.
3. **Mô tả thay đổi**: Nhập 1 câu tóm tắt (Ví dụ: *"Tính năng gọi Video 4K"*). Đây sẽ là nội dung được bê vào file Changelog trên NPM!

### 3. Commit và Push
Sau khi trả lời xong, Changesets sẽ sinh ra một file markdown nhỏ nhắn nằm bên trong thư mục `.changeset/`. 

Hãy dùng git để commit **cả tính năng code mới của bạn + file markdown này** lên nhánh của bạn (`main` hoặc nhánh tính năng).
```bash
git add .
git commit -m "feat: your new feature"
git push
```

---

## Vậy Bản Mới sẽ được "Tung Ra" trên NPM Khi Nào?

Lúc này **Github Actions** sẽ tự động tiếp quản 100%:

1. Action quét thấy bạn vừa Push một file Changeset sinh ra ở bước 3 vào nhánh `main`.
2. Action tự động tạo (hoặc cập nhật) một cái **Pull Request trên GitHub** có tên là `"Version Packages"`.
3. 🧘‍♂️ Cứ để mặc kệ cái Pull Request này chừng nào dự án vẫn chưa muốn ra mắt public. Bạn cứ code các tính năng khác tiếp, Action sẽ liên tục thu thập gom chung vào cái Pull Request kia.
4. **👉 LÚC BẠN MUỐN PHÁT HÀNH**: 
   - Lên Github, mở Pull Request *"Version Packages"* đó ra và nhấn nút **MERGE**.
   - Điều kì diệu sẽ xảy ra: Con Bot Github lập tức đi xóa hết các file changesets, viết tự động vào file `CHANGELOG.md`, sửa version ở tất cả `package.json`, và gọi thẳng lệnh **build và publish phiên bản mới cứng lên trang web NPM!!!** 🎇

---
## Lỗi Phổ Biến

- **Câu hỏi:** *Tôi lỡ update version `1.0.4` bằng tay vào `package.json` và code báo lỗi tung toé ở `yarn build` trên Github Actons?*
  **Trả lời:** Khả năng cao do bất đồng bộ ở trường `dependencies` (VD bạn bump SDK nhưng React UI lại đang link tới `1.0.3`). Bạn không phải làm việc này nữa. Chuyển lại version về ban đầu và xài `yarn changeset`!
