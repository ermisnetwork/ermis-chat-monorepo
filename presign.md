# API Upload Presigned v2

Upload file trực tiếp từ client lên storage qua presigned URL, hỗ trợ **multipart upload** cho file lớn.

**Base URL:** `/channels/{channel_type}/{channel_id}/file`
**Auth:** Yêu cầu JWT Bearer token.

---

## Tổng quan

### So sánh các flow

**Flow cũ (vẫn hoạt động):**
```
Client  ──POST multipart──▶  Bellboy  ──stream──▶  Storage
        ◀──── file URL ────
```

**Presigned flow (file nhỏ, < 16 MB):**
```
Client  ──1. POST /presign──▶  Bellboy           (lấy presigned URL)
        ◀── upload_url + id ──

Client  ──2. PUT file ──────▶  Storage            (upload trực tiếp)

Client  ──3. POST /confirm──▶  Bellboy            (tạo record DB)
        ◀──── file URL ────
```

**Presigned multipart flow (file lớn, ≥ 16 MB):**
```
Client  ──1. POST /presign──▶  Bellboy            (lấy danh sách URL)
        ◀── parts[] + id ────

Client  ──2. PUT chunk 1 ──▶  Storage             (upload từng phần)
        ──   PUT chunk 2 ──▶  Storage
        ──   PUT chunk N ──▶  Storage

Client  ──3. POST /confirm──▶  Bellboy            (hoàn tất & lưu DB)
        ◀──── file URL ────
```

### Ưu điểm

- **Không tắc nghẽn băng thông server**: file đi thẳng lên storage
- **Độ trễ thấp hơn**: 1 hop thay vì 2 cho file payload
- **Hỗ trợ file lớn**: multipart upload chia file thành chunks 10 MB
- **Giữ nguyên Content-Type**: trình duyệt có thể phát video ngay (không bị tải xuống)
- **Tương thích ngược**: endpoint cũ `POST /file` không thay đổi

### Giới hạn

| Tham số | Giá trị |
|---|---|
| Ngưỡng multipart | 16 MB (`MULTIPART_THRESHOLD`) |
| Kích thước chunk | 10 MB (`CHUNK_SIZE`) |
| Số part tối đa | 10,000 (`MAX_PART_COUNT`) |
| File tối đa (multipart) | ~100 GB (10,000 × 10 MB) |
| Thời hạn presigned URL | 15 phút (`PRESIGN_EXPIRY_SECS = 900`) |

---

## Endpoints

### POST `/file/presign` — Lấy Presigned Upload URL

Yêu cầu URL có thời hạn để upload trực tiếp lên storage. Server tự động chọn chế độ single-put hoặc multipart dựa vào `file_size`.

**Quyền:** Thành viên channel + capability `upload-file`.

**Request:**
```json
{
  "file_name": "video.mp4",
  "content_type": "video/mp4",
  "file_size": 52428800
}
```

| Trường | Kiểu | Bắt buộc | Mô tả |
|---|---|---|---|
| `file_name` | `string` | ✅ | Tên file gốc |
| `content_type` | `string` | ✅ | MIME type (vd: `image/png`, `video/mp4`) |
| `file_size` | `int64` | ❌ | Kích thước file (bytes). Nếu > 16 MB → multipart. Nếu không truyền → single-put. |

#### Response: Chế độ Single-Put

Khi `file_size` không truyền hoặc ≤ 16 MB:

```json
{
  "attachment_id": "550e8400-e29b-41d4-a716-446655440000",
  "upload_mode": "single",
  "upload_url": "https://storage.example.com/bucket/path/cid/550e8400...?X-Amz-Algorithm=...",
  "multipart": null
}
```

#### Response: Chế độ Multipart

Khi `file_size` > 16 MB:

```json
{
  "attachment_id": "550e8400-e29b-41d4-a716-446655440000",
  "upload_mode": "multipart",
  "upload_url": null,
  "multipart": {
    "upload_id": "2~abc123def456",
    "part_size": 10485760,
    "part_count": 5,
    "parts": [
      { "part_number": 1, "upload_url": "https://storage.example.com/...?partNumber=1&uploadId=...&X-Amz-Signature=..." },
      { "part_number": 2, "upload_url": "https://storage.example.com/...?partNumber=2&uploadId=...&X-Amz-Signature=..." },
      { "part_number": 3, "upload_url": "https://storage.example.com/...?partNumber=3&uploadId=...&X-Amz-Signature=..." },
      { "part_number": 4, "upload_url": "https://storage.example.com/...?partNumber=4&uploadId=...&X-Amz-Signature=..." },
      { "part_number": 5, "upload_url": "https://storage.example.com/...?partNumber=5&uploadId=...&X-Amz-Signature=..." }
    ]
  }
}
```

| Trường | Kiểu | Mô tả |
|---|---|---|
| `attachment_id` | `UUID` | ID attachment do server tạo |
| `upload_mode` | `string` | `"single"` hoặc `"multipart"` |
| `upload_url` | `string?` | Presigned PUT URL (chỉ có ở chế độ single) |
| `multipart` | `object?` | Thông tin multipart (chỉ có ở chế độ multipart) |
| `multipart.upload_id` | `string` | ID multipart upload của S3 (cần truyền lại lúc confirm) |
| `multipart.part_size` | `int` | Kích thước mỗi phần (10 MB) |
| `multipart.part_count` | `int` | Tổng số phần |
| `multipart.parts` | `array` | Danh sách presigned URL, mỗi phần một URL |
| `multipart.parts[].part_number` | `int` | Số thứ tự phần (bắt đầu từ 1) |
| `multipart.parts[].upload_url` | `string` | Presigned PUT URL cho phần này |

**Lỗi:**

| ermis_code | Nguyên nhân |
|---|---|
| 4 | Input không hợp lệ, `file_size` ≤ 0, hoặc file quá lớn (> 100 GB) |
| 7 | Không phải thành viên channel |
| 8 | Bị ban khỏi channel |
| 9 | Phải chấp nhận lời mời trước |
| 17 | Capability `upload-file` bị tắt |

---

### PUT `{upload_url}` — Upload File lên Storage (phía client)

#### Chế độ Single-Put

Upload toàn bộ file trong 1 request:

```
PUT {upload_url}
Content-Type: video/mp4

<dữ liệu nhị phân>
```

**Response:** `200 OK` từ storage khi thành công.

#### Chế độ Multipart

Upload từng chunk lên URL tương ứng. Các phần có thể upload **song song**.

```
PUT {parts[0].upload_url}
Content-Type: application/octet-stream

<bytes 0 đến 10485759>
```

**Quan trọng:** Mỗi response của part đều có header `ETag` — bạn **phải** lưu lại và gửi trong bước confirm.

```
HTTP/1.1 200 OK
ETag: "d41d8cd98f00b204e9800998ecf8427e"
```

**Quy tắc chia chunk:**
- Tất cả các phần trừ phần cuối phải đúng `part_size` bytes (10 MB)
- Phần cuối có thể nhỏ hơn (phần dư của file)
- Các phần có thể upload đồng thời để tăng tốc

**Lỗi:**
- `403 Forbidden` — URL hết hạn hoặc chữ ký không khớp
- `400 Bad Request` — request không hợp lệ

---

### POST `/file/confirm` — Xác nhận Upload & Tạo Record

Sau khi upload xong lên storage, gọi endpoint này để hoàn tất upload và tạo record trong database.

**Quyền:** Thành viên channel + capability `upload-file`.

#### Request: Chế độ Single-Put

```json
{
  "attachment_id": "550e8400-e29b-41d4-a716-446655440000",
  "file_name": "photo.png",
  "content_type": "image/png"
}
```

#### Request: Chế độ Multipart

```json
{
  "attachment_id": "550e8400-e29b-41d4-a716-446655440000",
  "file_name": "video.mp4",
  "content_type": "video/mp4",
  "multipart_upload_id": "2~abc123def456",
  "parts": [
    { "part_number": 1, "etag": "\"d41d8cd98f00b204e9800998ecf8427e\"" },
    { "part_number": 2, "etag": "\"a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6\"" },
    { "part_number": 3, "etag": "\"1234567890abcdef1234567890abcdef\"" },
    { "part_number": 4, "etag": "\"fedcba0987654321fedcba0987654321\"" },
    { "part_number": 5, "etag": "\"abcdef1234567890abcdef1234567890\"" }
  ]
}
```

| Trường | Kiểu | Bắt buộc | Mô tả |
|---|---|---|---|
| `attachment_id` | `UUID` | ✅ | ID từ response `/file/presign` |
| `file_name` | `string` | ✅ | Tên file gốc |
| `content_type` | `string` | ✅ | MIME type |
| `multipart_upload_id` | `string` | Chỉ multipart | `upload_id` từ response presign |
| `parts` | `array` | Chỉ multipart | ETag của từng phần đã upload |
| `parts[].part_number` | `int` | Chỉ multipart | Số thứ tự phần (bắt đầu từ 1) |
| `parts[].etag` | `string` | Chỉ multipart | ETag từ header response khi upload phần đó |

**Response:**
```json
{
  "file": "https://bucket.ermis.network/bellboy/test/messaging%3Achannel123/550e8400-e29b-41d4-a716-446655440000"
}
```

**Lỗi:**

| ermis_code | Nguyên nhân |
|---|---|
| 4 | Thiếu trường, thiếu parts cho multipart, hoặc file không tìm thấy trên storage |
| 7 | Không phải thành viên channel |
| 8 | Bị ban khỏi channel |
| 9 | Phải chấp nhận lời mời trước |
| 17 | Capability `upload-file` bị tắt |

---

## Ví dụ đầy đủ

### Upload Single-Put (curl)

```bash
# Bước 1: Lấy presigned URL
curl -X POST "http://localhost:8888/channels/messaging/channel123/file/presign" \
  -H "Authorization: Bearer <jwt_token>" \
  -H "Content-Type: application/json" \
  -d '{"file_name": "photo.png", "content_type": "image/png"}'

# Bước 2: Upload file trực tiếp lên storage
curl -X PUT "<upload_url>" \
  -H "Content-Type: image/png" \
  --data-binary @photo.png

# Bước 3: Xác nhận upload
curl -X POST "http://localhost:8888/channels/messaging/channel123/file/confirm" \
  -H "Authorization: Bearer <jwt_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "attachment_id": "<attachment_id>",
    "file_name": "photo.png",
    "content_type": "image/png"
  }'
```

### Upload Multipart (curl)

```bash
# Bước 1: Lấy presigned URLs cho multipart
curl -X POST "http://localhost:8888/channels/messaging/channel123/file/presign" \
  -H "Authorization: Bearer <jwt_token>" \
  -H "Content-Type: application/json" \
  -d '{"file_name": "video.mp4", "content_type": "video/mp4", "file_size": 52428800}'

# Bước 2: Chia file và upload từng phần, lưu lại ETag
# Phần 1 (bytes 0-10485759)
dd if=video.mp4 bs=10485760 count=1 skip=0 | \
  curl -X PUT "<parts[0].upload_url>" \
    -H "Content-Type: application/octet-stream" \
    --data-binary @- -v 2>&1 | grep -i etag

# Phần 2 (bytes 10485760-20971519)
dd if=video.mp4 bs=10485760 count=1 skip=1 | \
  curl -X PUT "<parts[1].upload_url>" \
    -H "Content-Type: application/octet-stream" \
    --data-binary @- -v 2>&1 | grep -i etag

# ... lặp lại cho tất cả các phần

# Bước 3: Xác nhận với ETags
curl -X POST "http://localhost:8888/channels/messaging/channel123/file/confirm" \
  -H "Authorization: Bearer <jwt_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "attachment_id": "<attachment_id>",
    "file_name": "video.mp4",
    "content_type": "video/mp4",
    "multipart_upload_id": "<upload_id>",
    "parts": [
      {"part_number": 1, "etag": "<etag1>"},
      {"part_number": 2, "etag": "<etag2>"},
      {"part_number": 3, "etag": "<etag3>"},
      {"part_number": 4, "etag": "<etag4>"},
      {"part_number": 5, "etag": "<etag5>"}
    ]
  }'
```

---

## Hướng dẫn tích hợp SDK

### JavaScript/TypeScript

```typescript
const MULTIPART_THRESHOLD = 16 * 1024 * 1024; // 16 MB

type UploadProgress = {
  loaded: number;
  total: number;
  percentage: number;
};

async function uploadFilePresigned(
  channel,
  file: File,
  onProgress?: (progress: UploadProgress) => void,
): Promise<string> {
  const client = channel.getClient();
  const channelURL = `/channels/${channel.type}/${channel.id}`;
  const contentType = file.type || 'application/octet-stream';

  // 1. Lấy presigned URL(s)
  const presignResp = await client.post(`${channelURL}/file/presign`, {
    file_name: file.name,
    content_type: contentType,
    file_size: file.size,
  });

  if (presignResp.upload_mode === 'multipart') {
    // 2a. Upload multipart
    const parts = await uploadMultipart(
      file,
      presignResp.multipart,
      onProgress,
    );

    // 3a. Xác nhận multipart
    const confirmResp = await client.post(`${channelURL}/file/confirm`, {
      attachment_id: presignResp.attachment_id,
      file_name: file.name,
      content_type: contentType,
      multipart_upload_id: presignResp.multipart.upload_id,
      parts,
    });
    return confirmResp.file;
  }

  // 2b. Upload single-put
  await uploadToPresignedUrl(
    presignResp.upload_url,
    file,
    contentType,
    onProgress,
  );

  // 3b. Xác nhận single-put
  const confirmResp = await client.post(`${channelURL}/file/confirm`, {
    attachment_id: presignResp.attachment_id,
    file_name: file.name,
    content_type: contentType,
  });
  return confirmResp.file;
}

async function uploadMultipart(
  file: File,
  multipart: {
    upload_id: string;
    part_size: number;
    part_count: number;
    parts: { part_number: number; upload_url: string }[];
  },
  onProgress?: (progress: UploadProgress) => void,
): Promise<{ part_number: number; etag: string }[]> {
  const completedParts: { part_number: number; etag: string }[] = [];
  let totalUploaded = 0;
  const concurrency = 4; // Upload tối đa 4 phần cùng lúc

  const uploadPart = async (part: { part_number: number; upload_url: string }) => {
    const start = (part.part_number - 1) * multipart.part_size;
    const end = Math.min(start + multipart.part_size, file.size);
    const chunk = file.slice(start, end);

    const resp = await fetch(part.upload_url, {
      method: 'PUT',
      body: chunk,
      headers: { 'Content-Type': 'application/octet-stream' },
    });

    if (!resp.ok) throw new Error(`Phần ${part.part_number} thất bại: HTTP ${resp.status}`);

    const etag = resp.headers.get('ETag');
    if (!etag) throw new Error(`Phần ${part.part_number}: thiếu header ETag`);

    completedParts.push({ part_number: part.part_number, etag });
    totalUploaded += (end - start);
    onProgress?.({
      loaded: totalUploaded,
      total: file.size,
      percentage: Math.round((totalUploaded / file.size) * 100),
    });
  };

  // Upload các phần với giới hạn concurrency
  for (let i = 0; i < multipart.parts.length; i += concurrency) {
    const batch = multipart.parts.slice(i, i + concurrency);
    await Promise.all(batch.map(uploadPart));
  }

  return completedParts.sort((a, b) => a.part_number - b.part_number);
}

/**
 * PUT file lên presigned URL với theo dõi tiến trình qua XMLHttpRequest.
 *
 * Dùng XHR thay vì fetch vì Cloudflare R2 dùng HTTP/2 mặc định,
 * Chrome block streaming request body qua HTTP/2 khi không biết
 * Content-Length — gây lỗi ERR_ALPN_NEGOTIATION_FAILED.
 */
function uploadToPresignedUrl(
  url: string,
  file: File,
  contentType: string,
  onProgress?: (progress: UploadProgress) => void,
): { promise: Promise<void>; abort: () => void } {
  let xhr: XMLHttpRequest;

  const promise = new Promise<void>((resolve, reject) => {
    xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', contentType);

    xhr.upload.onprogress = ({ loaded, total }) =>
      onProgress?.({ loaded, total, percentage: Math.round(loaded / total * 100) });

    xhr.onload = () =>
      xhr.status < 300 ? resolve() : reject(new Error(`Upload thất bại: HTTP ${xhr.status}`));

    xhr.onerror = () => reject(new Error('Lỗi mạng'));
    xhr.send(file);
  });

  return { promise, abort: () => xhr?.abort() };
}
```

---

## Cấu hình

| Config Key | Kiểu | Mặc định | Mô tả |
|---|---|---|---|
| `storage_allow_http` | `bool` | `true` | Cho phép kết nối HTTP (không TLS) tới storage. Set `false` cho production chỉ dùng HTTPS. |
| `storage_region` | `string` | `"auto"` | Region S3 cho SigV4 signing. Dùng `"auto"` cho Cloudflare R2, `"us-east-1"` cho MinIO/AWS. |

---

## Lưu ý

- **Tương thích ngược:** Endpoint cũ `POST /channels/{type}/{id}/file` vẫn hoạt động bình thường. Client không gửi `file_size` sẽ luôn nhận chế độ single-put.
- **Content-Type & Content-Disposition:** Với multipart upload, các header này được set ngay từ lúc khởi tạo multipart, nên trình duyệt có thể phát video và hiển thị ảnh trực tiếp mà không bị tải xuống.
- **Dọn dẹp:** Nếu presigned URL được tạo nhưng upload không hoàn tất, hãy cấu hình Object Lifecycle Rule trên storage bucket để tự động abort multipart upload chưa hoàn thành (vd: sau 24 giờ).
- **Quyền hạn:** Tất cả các endpoint dùng chung mô hình quyền — thành viên channel + capability `upload-file`.
- **Sanitize tên file:** Các ký tự `"`, `\`, `\r`, `\n` trong tên file được thay bằng `_` để chống header injection.