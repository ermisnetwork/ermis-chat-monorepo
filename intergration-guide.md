# Hướng dẫn tích hợp Frontend — Event Sourcing Message Sync

> **Phiên bản**: 1.0
> **Ngày**: 09/07/2026
> **Đối tượng**: Frontend / Mobile developers tích hợp tính năng sync message dựa trên sequence number

---

## Mục lục

1. [Tổng quan](#1-tổng-quan)
   * [1.1. Lưu ý đặc biệt đối với các kênh mã hoá đầu cuối (E2EE)](#11-lưu-ý-đặc-biệt-đối-với-các-kênh-mã-hoá-đầu-cuối-e2ee)
2. [Cấu trúc lưu trữ Client (Local DB)](#2-cấu-trúc-lưu-trữ-client-local-db)
   * [2.1. Cấu trúc đối tượng `Channel`](#21-cấu-trúc-đối-tượng-channel)
   * [2.2. Cấu trúc đối tượng `Message`](#22-cấu-trúc-đối-tượng-message)
3. [API Reference](#3-api-reference)
   * [3.1. Channel Sync — `GET /channels/{channel_type}/{channel_id}/sync`](#31-channel-sync--get-channelschannel_typechannel_idsync)
   * [3.2. Global Sync — `POST /sync`](#32-global-sync--post-sync)
   * [3.3. Query Messages — `POST /channels/{channel_type}/{channel_id}/query`](#33-query-messages--post-channelschannel_typechannel_idquery)
4. [Luồng Sync chính](#4-luồng-sync-chính)
   * [4.1. Khi app khởi động (Cold Start)](#41-khi-app-khởi-động-cold-start)
   * [4.2. Khi đang online (WebSocket events)](#42-khi-đang-online-websocket-events)
   * [4.3. Khi app từ background → foreground](#43-khi-app-từ-background--foreground)
5. [Xử lý các trường hợp xóa đặc biệt (Edge Cases)](#5-xử-lý-các-trường-hợp-xóa-đặc-biệt-edge-cases)
   * [5.1. Dữ liệu Server trả về khi truy vấn tin nhắn (`POST /channels/.../query`)](#51-dữ-liệu-server-trả-về-khi-truy-vấn-tin-nhắn-post-channelsquery)
   * [5.2. Sự kiện Server trả về khi Sync (`GET /sync` hoặc `POST /sync`)](#52-sự-kiện-server-trả-về-khi-sync-get-sync-hoặc-post-sync)
   * [5.3. Kịch bản 1: Xóa tin nhắn một phía (Ẩn tin nhắn)](#53-kịch-bản-1-xóa-tin-nhắn-một-phía-ẩn-tin-nhắn)
   * [5.4. Kịch bản 2: Xóa tin nhắn hoàn toàn (Xóa cho mọi người)](#54-kịch-bản-2-xóa-tin-nhắn-hoàn-toàn-xóa-cho-mọi-người)
   * [5.5. Quy tắc xử lý Local DB cho các trường hợp xóa](#55-quy-tắc-xử-lý-local-db-cho-các-trường-hợp-xóa)
   * [5.6. Quy tắc áp dụng Event vào Local DB](#56-quy-tắc-áp-dụng-event-vào-local-db)
6. [Logic phát hiện và sửa lỗi Gap (Gap Detection & Reconciliation)](#6-logic-phát-hiện-và-sửa-lỗi-gap-gap-detection--reconciliation)
   * [6.1. Logic lưu trữ Hidden Sequences từ Sync API](#61-logic-lưu-trữ-hidden-sequences-từ-sync-api)
   * [6.2. Logic phát hiện Gap trên đường truyền Real-time (WebSocket)](#62-logic-phát-hiện-gap-trên-đường-truyền-real-time-websocket)
   * [6.3. Logic tránh Gap giả trên UI khi phân trang (msg_seq)](#63-logic-tránh-gap-giả-trên-ui-khi-phân-trang-msg_seq)
7. [Sơ đồ tổng hợp](#7-sơ-đồ-tổng-hợp)

---

## 1. Tổng quan

Hệ thống sử dụng **hai loại sequence number** để đồng bộ messages:

| Sequence | Mục đích | Tăng khi |
|----------|---------|----------|
| `msg_seq` | Đánh số vị trí tin nhắn trong channel | Chỉ khi có **tin nhắn mới** (bao gồm system messages) |
| `event_seq` | Đánh số thứ tự cho mọi thay đổi liên quan đến message | message new, update, delete, reaction add/delete, poll choice add/delete |

**`event_seq` KHÔNG tăng khi**: member added/removed, channel created/deleted, channel topic events, invite events, user online/offline.

### Ví dụ timeline

```
Thời gian →

msg_seq:     1          2          -    -     3
event_seq:   1          2          3    4     5
Event:    msg_new    msg_new    react  edit  msg_new
                               to #1  #2

Message #1: msg_seq=1, last_event_seq=3 (cập nhật khi có reaction)
Message #2: msg_seq=2, last_event_seq=4 (cập nhật khi edit)
Message #3: msg_seq=3, last_event_seq=5
```

### 1.1. Lưu ý đặc biệt đối với các kênh mã hoá đầu cuối (E2EE)

Đối với các kênh trò chuyện có bật mã hoá đầu cuối (E2EE):
* **Cơ chế hoạt động:** Hệ thống đồng bộ ở tầng nền (Sync Layer) chỉ đóng vai trò giao nhận và chuyển tiếp (Delivery Envelope) các gói tin đã mã hóa.
* **Ủy quyền xử lý (Delegation):** Khi nhận được các sự kiện đồng bộ từ các Endpoint E2EE chuyên biệt (như `/v1/e2ee/sync` hoặc `/v1/e2ee/channels/.../sync`), Sync Layer của Client sẽ **chuyển giao trực tiếp (delegate)** payload của sự kiện đó sang cho mô-đun E2EE / MLS Engine của Client tự giải mã, xác thực chữ ký và cập nhật trạng thái nhóm (Group Membership, Key Exchange).
* **Nhiệm vụ của Client:** Sync Layer không tự ý giải mã nội dung tin nhắn dạng ciphertext hay xử lý logic cấu trúc giao thức MLS. Nó chỉ đảm bảo các gói tin/event được tải về đầy đủ, đúng thứ tự dựa theo sequence (`event_seq`), sau đó chuyển giao cho module E2EE chuyên trách xử lý.

---

## 2. Cấu trúc lưu trữ Client (Local DB)

> [!IMPORTANT]
> **Không lưu trữ các sự kiện (Events) vào Local DB:**
> Danh sách các event (`events[]`) nhận được từ API Sync chỉ đóng vai trò là log thay đổi (delta log) dùng để đồng bộ. Client **không được lưu trực tiếp các event này** vào cơ sở dữ liệu. Thay vào đó, Client sẽ duyệt qua các event để cập nhật/ghi đè trạng thái cuối cùng của tin nhắn vào bảng `messages` (chỉ lưu một bản ghi duy nhất cho mỗi tin nhắn).

Dưới đây là danh sách các trường thông tin **quan trọng và cần thiết** liên quan đến cơ chế đồng bộ tin nhắn mà Client cần tích hợp vào cấu trúc cơ sở dữ liệu local (không bắt buộc Client phải thiết kế DB hoặc đặt tên thuộc tính giống hệt như thế này, miễn là đảm bảo lưu trữ và theo dõi đầy đủ các thông tin này).

### 2.1. Cấu trúc đối tượng `Channel`

```ts
interface Channel {
    cid: string;                             // ID channel (ví dụ: "messaging:abc123")
    channel_type: string;                    // "messaging", "team", "topic"
    channel_id: string;
    
    // Sync cursors
    last_synced_event_seq: number;          // event_seq lớn nhất đã sync thành công (mặc định: 0)
    last_synced_at: string | null;           // RFC3339 timestamp cursor (dùng cho lần sync đầu tiên)
    has_more: boolean;                       // Trạng thái cho biết channel còn sự kiện chưa đồng bộ hết hay không
    
    // Truncate / Clear marker
    last_msg_seq_before_chat_deleted: number | null; // Lưu seq chặn dưới của channel để xóa tin nhắn cũ

    // Tập hợp Sequence bị ẩn/xóa (Bắt buộc để tránh Gap giả)
    // Có thể lưu dưới dạng JSON String (ví dụ: "[10,11]") hoặc kiểu Array/Set tùy Database
    hidden_event_seqs: number[];             // Tập hợp event_seq bị ẩn (để check WS Gap giả)
    hidden_message_seqs: number[];           // Tập hợp msg_seq bị xóa/ẩn (để check UI Gap giả)
}
```

### 2.2. Cấu trúc đối tượng `Message`

```ts
interface Message {
    id: string;                              // ID tin nhắn (UUID)
    cid: string;                             // ID channel chứa tin nhắn
    
    // Các trường Event Sourcing (Quan trọng!)
    msg_seq: number | null;                  // Vị trí tin nhắn trong channel (chỉ tăng khi có tin nhắn mới)
    last_event_seq: number | null;           // Chỉ số event sequence cuối cùng tác động/thay đổi tin nhắn này.
                                             // Dùng để đảm bảo tính Idempotency khi nhận nhiều event trùng lặp hoặc out-of-order.
    
    // Content & State
    text: string;
    created_at: string;                      // Thời gian tạo tin nhắn (RFC3339)
    deleted_at: string | null;               // Lưu thời gian xóa (nếu dùng soft-delete)
}
```

> ⚠️ **QUY TẮC CỐT LÕI (Idempotency):**
> Khi nhận được bất kỳ event nào tác động đến một tin nhắn đã lưu (ví dụ: `message_updated`, `message_deleted`, `reaction`), Client **chỉ xử lý và cập nhật database** nếu `event.event_seq > message.last_event_seq` hiện tại của tin nhắn đó trong Local DB. Nếu nhỏ hơn hoặc bằng, Client phải bỏ qua (skip) event đó để tránh ghi đè dữ liệu mới bằng dữ liệu cũ hơn.

---

## 3. API Reference

### 3.1. Channel Sync — `GET /channels/{channel_type}/{channel_id}/sync`

Sync events cho **một channel** cụ thể.

**Query Parameters:**

| Param | Type | Bắt buộc | Mô tả |
|-------|------|----------|-------|
| `since_seq` | `u64` | Một trong hai | Event sequence cursor. Phải > 0. Server trả events có `event_seq > since_seq` |
| `since` | `RFC3339` | Một trong hai | Timestamp cursor. Server trả events sau timestamp này |
| `limit` | `u32` | Không | Số events tối đa (default: 100, max: 200) |

> ⚠️ **Chỉ được truyền MỘT** trong `since_seq` hoặc `since`. Truyền cả hai → lỗi 400.

**Response: `ChannelSyncResult`**

```json
{
    "events": [
        {
            "type": "message_new",
            "data": {
                "event_seq": 5,
                "message": { "id": "...", "msg_seq": 3, "last_event_seq": 5, "text": "Hello", ... },
                "sender": { "id": "user1", "name": "Trung" },
                "created_at": "2026-07-09T10:00:00Z"
            }
        },
        {
            "type": "message_updated",
            "data": {
                "event_seq": 6,
                "message": { "id": "...", "msg_seq": 2, "last_event_seq": 6, "text": "Edited text", ... },
                "message_update": { "old_text": "Original text" },
                "sender": { "id": "user1" },
                "created_at": "2026-07-09T10:01:00Z"
            }
        },
        {
            "type": "message_deleted",
            "data": {
                "event_seq": 7,
                "message_id": "uuid-of-deleted-msg",
                "sender": { "id": "user1" },
                "created_at": "2026-07-09T10:02:00Z"
            }
        },
        {
            "type": "reaction",
            "data": {
                "event_seq": 8,
                "action": "reaction.new",
                "message_id": "uuid-of-reacted-msg",
                "latest_reactions": [...],
                "reaction_counts": {"like": 1},
                "reaction": { "type": "like", "user_id": "user2" },
                "created_at": "2026-07-09T10:03:00Z"
            }
        }
    ],
    "has_more": false,
    "next_cursor": "2026-07-09T10:03:00Z",
    "hidden_message_seqs": [4, 7],
    "hidden_event_seqs": [9, 15],
    "last_msg_seq_before_chat_deleted": 10
}
```

**Các loại event trong `events`:**

| `type` | Mô tả | Action trên client |
|--------|-------|-------------------|
| `message_new` | Tin nhắn mới | INSERT vào bảng `messages` |
| `message_updated` | Tin nhắn được sửa | UPDATE message trong DB |
| `message_deleted` | Tin nhắn bị xoá | Soft delete (set `deleted_at`) hoặc hard delete |
| `reaction` | Thêm/xoá reaction | Update `latest_reactions` + `reaction_counts` của message |

**Response fields quan trọng:**

| Field | Mô tả | Client xử lý |
|-------|-------|--------------|
| `has_more` | `true` = còn events chưa fetch. Client phải gọi tiếp | Nếu `true`, gọi lại API với cursor phù hợp. |
| `next_cursor` | RFC3339 timestamp để dùng cho lần sync tiếp theo (chỉ có khi dùng timestamp cursor). | **Khi dùng `since` (timestamp):** Lưu vào `channels.last_synced_at`. <br>**Khi dùng `since_seq` (seq-based):** Client lấy `event_seq` lớn nhất trong `events[]` lưu vào `last_synced_event_seq` của bảng channel làm cursor tiếp theo. |
| `hidden_message_seqs` | Danh sách `msg_seq` bị user ẩn (xóa 1 phía) | Xem [Mục 6.1](#61-logic-lưu-trữ-hidden-sequences-từ-sync-api) để xử lý. |
| `hidden_event_seqs` | Danh sách `event_seq` tương ứng của các events bị ẩn | Xem [Mục 6.1](#61-logic-lưu-trữ-hidden-sequences-từ-sync-api) để xử lý. |
| `last_msg_seq_before_chat_deleted` | Seq chặn dưới của lịch sử trò chuyện | Xem [Mục 5.5](#1-xử-lý-truncate--clear-history-last_msg_seq_before_chat_deleted) để xóa tin nhắn cũ. |

---

### 3.2. Global Sync — `POST /sync`

Sync events cho **nhiều channels cùng lúc**. Đây là API chính cho offline catch-up.

**Request Body: `UnifiedSyncRequest`**

```json
{
    "project_id": "uuid-optional",
    "cursors": {
        "messaging:abc123": 42,
        "team:xyz789": "2026-07-09T08:00:00Z",
        "messaging:new_channel": "2026-07-01T00:00:00Z"
    },
    "removed_cursor": {
        "removed_at": "2026-07-08T00:00:00Z",
        "event_id": "uuid-of-last-removed-event"
    },
    "limit": 100
}
```

**Giải thích `cursors`:**

- Key: `cid` của channel
- Value: **MỘT trong hai loại** (tự động phân biệt):
  - `u64` (số nguyên) → `event_seq` cursor. Server trả events có `event_seq > value`
  - `string` (RFC3339) → timestamp cursor. Server trả events sau timestamp

> 💡 **Lần đầu sync**: dùng timestamp cursor (ví dụ `"1970-01-01T00:00:00Z"` để lấy từ đầu)
> **Lần sync tiếp theo**: dùng `event_seq` cursor (chính xác hơn)

**Response: `UnifiedSyncResponse`**

```json
{
    "messaging:abc123": {
        "events": [...],
        "has_more": false,
        "next_cursor": "2026-07-09T10:05:00Z",
        "hidden_message_seqs": [],
        "hidden_event_seqs": [],
        "last_msg_seq_before_chat_deleted": null
    },
    "team:xyz789": {
        "events": [...],
        "has_more": true,
        "next_cursor": "2026-07-09T09:30:00Z",
        "hidden_message_seqs": [5],
        "hidden_event_seqs": [12],
        "last_msg_seq_before_chat_deleted": null
    },
    "removed_channels": {
        "events": [
            {
                "event_id": "uuid",
                "cid": "messaging:deleted_one",
                "channel_id": "deleted_one",
                "channel_type": "messaging",
                "parent_cid": null,
                "removed_at": "2026-07-09T05:00:00Z",
                "removed_by": "admin_user_id",
                "removal_type": "removed",
                "reason": null,
                "self_remove": false
            }
        ],
        "has_more": false,
        "next_cursor": {
            "removed_at": "2026-07-09T05:00:00Z",
            "event_id": "uuid"
        }
    }
}
```

**`removed_channels` xử lý:**
- Server trả danh sách channels mà user bị kick/leave/remove
- **Client PHẢI xoá channel khỏi local DB** khi thấy nó trong `removed_channels.events`
- Nếu channel không có trong response (không nằm trong `cursors` keys nào → server skip) thì **không cần xoá** — đó là channel user không join
- Lưu `removed_channels.next_cursor` để dùng cho request tiếp

> ⚠️ **QUAN TRỌNG**: Nếu một `cid` có trong `cursors` nhưng KHÔNG xuất hiện trong response, nghĩa là user **không còn là member** hoặc channel **không tồn tại**. Client nên check lại membership hoặc xoá channel.

---

### 3.3. Channel Query — `POST /channels/{channel_type}/{channel_id}/query`

Query messages hoặc thông tin channel dựa theo `msg_seq` cursor (Event Sourcing) hoặc ID (Tương thích ngược).

**Request Body:**

```ts
interface ChannelQueryRequestBody {
    messages_seq?: {
        seq?: number;           // Query duy nhất 1 tin nhắn cụ thể theo msg_seq
        anchor_seq?: number;    // Điểm neo msg_seq (bắt buộc nếu dùng before hoặc after)
        before?: number;        // Số lượng tin nhắn trước anchor_seq cần lấy
        after?: number;         // Số lượng tin nhắn sau anchor_seq cần lấy
        limit?: number;         // Số lượng tin nhắn tối đa (mặc định: 25)
    };
    // parent_cid?: string;     // Dành cho topic channel (nếu cần)
}
```

**Nguyên lý phân trang/query của Server:**
1. **Query theo một message cụ thể:** Truyền `seq`. Server chỉ trả về đúng 1 tin nhắn có `msg_seq = seq`.
2. **Query phân trang (Scroll up / Scroll down / Jump to):** Truyền `anchor_seq` kèm theo `before` và/hoặc `after`. Range tìm kiếm sẽ là `[anchor_seq - before, anchor_seq + after]`.
3. **Query tin nhắn mới nhất:** Không truyền `seq` và `anchor_seq`. Server sẽ tự động trả về các tin nhắn mới nhất dựa trên `limit` (mặc định 25 tin nhắn cuối cùng).

**Ví dụ sử dụng (Request payload):**

*   **Lấy 25 tin nhắn mới nhất:**
    ```json
    {}
    ```

*   **Scroll up (Lấy 25 tin nhắn trước tin nhắn có msg_seq = 50):**
    ```json
    {
        "messages_seq": {
            "anchor_seq": 50,
            "before": 25
        }
    }
    ```

*   **Jump to message (Lấy tin nhắn có msg_seq = 100, kèm theo 12 tin nhắn trước và 12 tin nhắn sau):**
    ```json
    {
        "messages_seq": {
            "anchor_seq": 100,
            "before": 12,
            "after": 12
        }
    }
    ```

---

## 4. Luồng Sync chính

### 4.1. Khi app khởi động (Cold Start)

```
┌─────────────────────────────────────────────────┐
│ 1. Đọc tất cả channels từ local DB             │
│    → Lấy last_synced_event_seq cho mỗi channel │
│                                                  │
│ 2. Build cursors map:                            │
│    {                                             │
│      "messaging:abc": 42,    ← có event_seq     │
│      "team:xyz": "2026-...", ← chưa có, dùng ts │
│    }                                             │
│                                                  │
│ 3. POST /sync với cursors map                    │
│                                                  │
│ 4. Xử lý response:                              │
│    - Apply events vào local DB                   │
│    - Xử lý hidden_message_seqs                   │
│    - Xử lý last_msg_seq_before_chat_deleted      │
│    - Xử lý removed_channels                      │
│    - Cập nhật sync cursors                        │
│                                                  │
│ 5. Nếu has_more=true cho channel nào → gọi lại  │
│    GET /channels/.../sync?since_seq=X            │
└─────────────────────────────────────────────────┘
```

### 4.2. Khi đang online (WebSocket events)

```
┌─────────────────────────────────────────────────────────────┐
│ WebSocket event đến                                         │
│                                                             │
│ 1. Parse event, lấy event_seq                               │
│                                                             │
│ 2. So sánh với last_synced_event_seq:                       │
│    - Nếu event_seq == last + 1 → OK, apply                  │
│    - Nếu event_seq > last + 1 → GAP DETECTED                │
│      → Đối chiếu tập hợp hidden_event_seqs của channel      │
│      → Nếu là GAP thực tế: Gọi Sync API để fill gap         │
│      → Nếu là GAP giả (tất cả chỉ là event ẩn): Skip Sync   │
│    - Nếu event_seq <= last → duplicate, skip                │
│                                                             │
│ 3. Cập nhật last_synced_event_seq                           │
└─────────────────────────────────────────────────────────────┘
```

### 4.3. Khi app từ background → foreground

```
Giống Cold Start flow, nhưng cursors đã có event_seq
→ POST /sync với event_seq cursors
→ Nhanh hơn vì chỉ fetch events mới
```

---

## 5. Xử lý các trường hợp xóa đặc biệt (Edge Cases)

Để tích hợp chính xác, Client cần hiểu rõ cấu trúc dữ liệu JSON mà Server sẽ trả về đối với từng kịch bản xóa (ẩn 1 phía, xóa hẳn, clear history, hay admin truncate).

---

### 5.1. Dữ liệu Server trả về khi truy vấn tin nhắn (`POST /channels/.../query`)

Khi Client tải lịch sử chat (phân trang hoặc nhảy tới một tin nhắn cụ thể), Server trả về mảng `messages` chứa các đối tượng có thuộc tính `display_type` dùng để phân loại trạng thái tin nhắn:

#### Case 1: Tin nhắn bình thường (`display_type: "normal"`)
Chứa đầy đủ nội dung tin nhắn.
```json
{
  "display_type": "normal",
  "id": "8c6cf7ee-5bc8-4395-8e7c-e09210c4fa61",
  "cid": "messaging:abc123",
  "sender": { "id": "user1", "name": "Trung" },
  "message_type": "regular",
  "text": "Hello World",
  "created_at": "2026-07-09T05:00:00.000Z",
  "msg_seq": 10,
  "last_event_seq": 15
}
```

#### Case 2: Tin nhắn bị ẩn/xóa 1 phía (`display_type: "deleted"`)
Xảy ra khi người dùng hiện tại đã chọn "Xóa tin nhắn này ở phía tôi". Server sẽ trả về thông tin tối giản (`DeletedMessage`) **hoàn toàn không có nội dung text/content** để bảo mật, chỉ giữ lại các trường meta:
```json
{
  "display_type": "deleted",
  "id": "8c6cf7ee-5bc8-4395-8e7c-e09210c4fa61",
  "cid": "messaging:abc123",
  "sender": { "id": "user1", "name": "Trung" },
  "created_at": "2026-07-09T05:00:00.000Z",
  "deleted_at": "2026-07-09T05:05:00.000Z",
  "msg_seq": 10
}
```
*   **Xử lý:** Client lưu trạng thái tin nhắn này dưới Local DB bằng cách xóa bản ghi cũ hoặc đánh dấu ẩn đi để không hiển thị lên màn hình.

#### Case 3: Tin nhắn bị xóa hẳn/thu hồi cho tất cả (`display_type: "unavailable"`)
Xảy ra khi tin nhắn đã bị xóa vật lý ở Datastore phía Server (thu hồi cho tất cả). Để lấp đầy khoảng hở sequence khi client query range, Server trả về `UnavailableMessage` **chỉ gồm `cid` và `msg_seq`**:
```json
{
  "display_type": "unavailable",
  "cid": "messaging:abc123",
  "msg_seq": 10
}
```
*   **Xử lý:** Client ghi nhận tin nhắn này đã bị thu hồi hoàn toàn tại vị trí `msg_seq = 10`.

---

### 5.2. Dữ liệu Server trả về khi đồng bộ (`POST /sync` hoặc `GET /channels/.../sync`)

Khi đồng bộ các sự kiện thay đổi (Sync API), dữ liệu trả về cho các case xóa sẽ khác nhau:

#### Case 1: Tin nhắn bị thu hồi cho mọi người (Message Deleted Event)
Server trả về sự kiện có `type: "message_deleted"` trong mảng `events[]`:
```json
{
  "type": "message_deleted",
  "data": {
    "event_seq": 18,
    "message_id": "8c6cf7ee-5bc8-4395-8e7c-e09210c4fa61",
    "sender": { "id": "user1", "name": "Trung" },
    "created_at": "2026-07-09T05:10:00.000Z"
  }
}
```
*   **Xử lý:** Client tìm tin nhắn theo `message_id` trong DB và đánh dấu đã thu hồi (cập nhật `deleted_at = created_at` và `last_event_seq = event_seq`).

#### Case 2: Tin nhắn bị xóa 1 phía (Ẩn tin nhắn)
Khi người dùng chọn ẩn tin nhắn, Server **loại bỏ (skip) toàn bộ** các sự kiện của tin nhắn này (như `message_new`, `message_updated`) ra khỏi danh sách `events[]`. Thay vào đó, Server trả về thông tin sequence bị ẩn tại phần gốc của JSON response:
```json
{
  "events": [
    // Hoàn toàn không có bất kỳ sự kiện nào liên quan đến tin nhắn bị ẩn ở đây
  ],
  "has_more": false,
  "hidden_message_seqs": [10],      // Danh sách msg_seq của tin nhắn đã bị ẩn
  "hidden_event_seqs": [15, 16]     // Danh sách event_seq tương ứng đã bị ẩn
}
```
*   **Xử lý:** Client lấy mảng `hidden_message_seqs` và `hidden_event_seqs` lưu vào bảng `hidden_sequences` ở local DB, đồng thời xóa/ẩn tin nhắn có `msg_seq` tương ứng ra khỏi bảng tin nhắn local.

---

### 5.3. Dữ liệu Server trả về khi xóa đoạn chat (Clear History / Truncate)

Khi toàn bộ hoặc một phần lịch sử chat bị xóa (do người dùng tự xóa lịch sử hoặc admin cắt giảm tin nhắn cũ), Server sẽ trả về trường `last_msg_seq_before_chat_deleted` trong Sync response:

```json
{
  "events": [...],
  "has_more": false,
  "last_msg_seq_before_chat_deleted": 42
}
```

*   **Giá trị này đại diện cho:** Chỉ số `msg_seq` cao nhất bị xóa. Nó được tổng hợp từ:
    *   `user_clear_seq` (Nếu người dùng hiện tại tự Clear History - chỉ ảnh hưởng tới user này).
    *   `last_msg_seq_before_truncate` (Nếu Admin Truncate channel - ảnh hưởng tới tất cả mọi người).
*   **Xử lý:** Client nhận được giá trị này thì lập tức chạy câu lệnh xóa mọi tin nhắn local có `msg_seq <= last_msg_seq_before_chat_deleted` và cập nhật trường này vào thông tin channel.

---

### 5.4. Dữ liệu Server trả về khi user bị Kick / Rời nhóm

Trong kết quả của **Global Sync**, nếu user không còn quyền trong channel nữa, thông tin sẽ được trả về trong mảng `removed_channels`:

```json
{
  "removed_channels": {
    "events": [
      {
        "event_id": "673f4e24-9b2f-410a-8c9f-3e8dfc7a1029",
        "cid": "messaging:abc123",
        "channel_id": "abc123",
        "channel_type": "messaging",
        "removed_at": "2026-07-09T05:20:00.000Z",
        "removed_by": "admin_user_id",
        "removal_type": "removed",
        "self_remove": false
      }
    ],
    "has_more": false
  }
}
```
*   **Xử lý:** Client xóa sạch thông tin của channel `messaging:abc123` và toàn bộ tin nhắn liên quan ra khỏi local DB.

---

### 5.5. Quy tắc xử lý Local DB cho các trường hợp xóa

#### 1. Xử lý Truncate / Clear History (`last_msg_seq_before_chat_deleted`)
Khi nhận được giá trị `last_msg_seq_before_chat_deleted` lớn hơn `0`:
*   **Bước 1:** Client thực hiện xóa tất cả các bản ghi tin nhắn cục bộ thuộc channel đó có `msg_seq <= last_msg_seq_before_chat_deleted`.
*   **Bước 2:** Cập nhật giá trị chặn dưới này vào thuộc tính `last_msg_seq_before_chat_deleted` trên dòng thông tin của channel cục bộ để chặn việc phân trang ngược về quá khứ quá mốc đã bị xóa.

#### 2. Xử lý ẩn tin nhắn cá nhân (`hidden_message_seqs`)
Khi nhận được mảng `hidden_message_seqs` từ phản hồi Sync:
*   **Bước 1:** Client duyệt qua danh sách các `msg_seq` bị ẩn.
*   **Bước 2:** Thực hiện xóa vật lý các tin nhắn có `msg_seq` tương ứng ra khỏi bảng `messages` local.

#### 3. Xử lý bị kick / rời nhóm / xóa channel (`removed_channels`)
Khi có danh sách channel nằm trong `removed_channels` của Global Sync:
*   **Bước 1:** Client thực hiện xóa sạch mọi bản ghi tin nhắn liên kết với channel đó khỏi bảng `messages`.
*   **Bước 2:** Xóa dòng thông tin channel tương ứng khỏi bảng `channels`.
*   **Bước 3:** Dọn dẹp các trạng thái đồng bộ liên quan của channel đó.

---

### 5.6. Quy tắc áp dụng Event vào Local DB

Khi nhận được danh sách `events[]` từ API đồng bộ hoặc WebSocket, Client duyệt tuần tự từng event và áp dụng quy tắc cập nhật trạng thái tin nhắn dựa trên trường `last_event_seq` để đảm bảo tính **Idempotency (không trùng lặp/ghi đè ngược)**:

1.  **Tra cứu tin nhắn cục bộ:** Dựa vào `message_id` hoặc thuộc tính định danh trong event để tìm bản ghi tin nhắn hiện tại dưới Local DB.
2.  **So sánh Sequence (`event_seq`):**
    *   Nếu tin nhắn chưa tồn tại: Thực hiện thêm mới tin nhắn.
    *   Nếu tin nhắn đã tồn tại: Chỉ áp dụng thay đổi (nội dung, reaction, trạng thái xóa) nếu `event.event_seq > message.last_event_seq` trong database. Nếu `event_seq <= last_event_seq`, lập tức bỏ qua (skip) sự kiện này.
3.  **Cập nhật mốc Cursor:** Sau khi áp dụng thành công toàn bộ danh sách, cập nhật `last_synced_event_seq` của channel bằng giá trị `event_seq` lớn nhất đã xử lý.

---

## 6. Logic phát hiện và sửa lỗi Gap (Gap Detection & Reconciliation)

Khi xảy ra các hành động xóa một phía hoặc dọn dẹp lịch sử, Server vẫn tăng sequence nhưng không gửi tin nhắn/event về. Để Client không bị hiểu lầm là bị mất dữ liệu và gọi API Sync không cần thiết, Client cần đối chiếu với các trường mảng `hidden_event_seqs`, `hidden_message_seqs` và mốc chặn dưới `last_msg_seq_before_chat_deleted` trên Channel để phân biệt Gap thực tế và Gap giả.

---

### 6.1. Logic lưu trữ Hidden Sequences từ Sync API
Mỗi khi nhận kết quả từ `POST /sync` hoặc `GET /channels/.../sync`, ngoài việc áp dụng sự kiện, Client cần thực hiện:
1.  Đọc thuộc tính mảng `hidden_event_seqs` và `hidden_message_seqs` hiện tại của channel từ Local DB.
2.  Hợp nhất (merge) các giá trị mới nhận được từ Server vào mảng tương ứng (loại bỏ các số sequence trùng lặp).
3.  Lưu mảng đã được cập nhật trở lại vào dòng ghi nhận thông tin channel tương ứng.

---

### 6.2. Logic phát hiện Gap trên đường truyền Real-time (WebSocket)
Khi nhận một event qua WebSocket, Client thực hiện quy trình sau:
1.  **So sánh sequence:** So sánh `event_seq` của event nhận được với chỉ số kế tiếp dự kiến (`expected_seq = last_synced_event_seq + 1`).
2.  **Nếu event_seq > expected_seq (Phát hiện lệch sequence):**
    *   Xác định danh sách các sequence bị thiếu ở giữa: `[expected_seq, expected_seq + 1, ..., event_seq - 1]`.
    *   Đọc tập hợp `hidden_event_seqs` của channel đó từ DB.
    *   Kiểm tra xem có bất kỳ sequence bị thiếu nào **KHÔNG** nằm trong tập hợp `hidden_event_seqs` hay không.
    *   **Kết quả:**
        *   *Nếu có ít nhất 1 sequence bị thiếu không nằm trong tập ẩn:* Đây là **Gap thực tế** (bị mất dữ liệu). Client bắt buộc phải dừng nhận WebSocket tạm thời và gọi API `/channels/.../sync?since_seq={expected_seq - 1}` để đồng bộ bù dữ liệu (Reconciliation).
        *   *Nếu tất cả sequence bị thiếu đều nằm trong tập ẩn:* Đây là **Gap giả** (do tin nhắn bị ẩn). Client bỏ qua cảnh báo Gap, cập nhật `expected_seq = event_seq + 1` và tiếp tục xử lý bình thường mà không cần gọi API.

---

### 6.3. Logic tránh Gap giả trên UI khi phân trang (msg_seq)
Khi người dùng cuộn xem lịch sử trò chuyện và Client hiển thị tin nhắn từ Local DB:
1.  Nếu có khoảng hở giữa chỉ số `msg_seq` của hai tin nhắn liền kề (ví dụ: tin nhắn A có `msg_seq = 10`, tin nhắn tiếp theo B có `msg_seq = 12`), Client xác định các số sequence bị khuyết ở giữa (ở đây là `11`).
2.  Đọc tập hợp `hidden_message_seqs` và giá trị `last_msg_seq_before_chat_deleted` của channel từ DB.
3.  **Kết quả:**
    *   *Nếu toàn bộ sequence bị khuyết đáp ứng một trong hai điều kiện sau:*
        *   Nằm trong danh sách `hidden_message_seqs` (Tin nhắn bị ẩn 1 phía).
        *   Nhỏ hơn hoặc bằng `last_msg_seq_before_chat_deleted` (Tin nhắn nằm trong lịch sử cũ đã bị xóa/clear/truncate).
        
        → Đây không phải là lỗi thiếu tin nhắn. Client hiển thị danh sách liền mạch và **không hiển thị** loader hay nút cảnh báo "Tải bổ sung tin nhắn".
    *   *Nếu có ít nhất một sequence bị khuyết không đáp ứng hai điều kiện trên:* Đây là tin nhắn bị thiếu thực tế (chưa tải về). Client cần hiển thị loader hoặc kích hoạt cơ chế tải bổ sung (backfill) qua API `POST /query`.

---

## 7. Sơ đồ tổng hợp

### Complete Sync Flow

```
┌──────────┐     ┌──────────────────────────────────────────────┐
│          │     │              BELLBOY SERVER                   │
│  CLIENT  │     │                                              │
│          │     │  ┌─────────────┐  ┌──────────────────────┐   │
│          │     │  │ Message     │  │ Event Log            │   │
│          │     │  │ Table       │  │ room: event:{cid}    │   │
│          │     │  │ room: {cid} │  │ (append-only)        │   │
│          │     │  └──────┬──────┘  └──────────┬───────────┘   │
│          │     │         │                    │               │
│          │     │  ┌──────▼────────────────────▼──────────┐    │
│          │     │  │  Sequence Counters (Datastore)       │    │
│          │     │  │  channel_latest_message_seqs         │    │
│          │     │  │  channel_latest_event_seqs           │    │
│          │     │  └─────────────────────────────────────┘    │
│          │     └──────────────────────────────────────────────┘
│          │
│  ┌───────▼──────────────────────────────────────────────┐
│  │  Sync Algorithm                                       │
│  │                                                       │
│  │  1. App start → POST /sync                            │
│  │     Body: { cursors: { "cid": event_seq_or_ts } }     │
│  │                                                       │
│  │  2. For each channel in response:                     │
│  │     a. Apply events sequentially                      │
│  │     b. Handle hidden_message_seqs → delete locally    │
│  │     c. Handle last_msg_seq_before_chat_deleted        │
│  │        → DELETE FROM messages WHERE msg_seq <= X      │
│  │     d. Update last_synced_event_seq                   │
│  │     e. If has_more → call channel sync individually   │
│  │                                                       │
│  │  3. Handle removed_channels:                          │
│  │     → DELETE channel + messages from local DB         │
│  │                                                       │
│  │  4. Connect WebSocket                                 │
│  │     → Monitor event_seq for gap detection             │
│  │     → On gap: call channel sync to fill               │
│  │                                                       │
│  │  5. App background → foreground:                      │
│  │     → Repeat step 1 with updated cursors              │
│  └───────────────────────────────────────────────────────┘
```

### Bảng tóm tắt — Khi nào gọi API nào?

| Tình huống | API | Cursor |
|-----------|-----|--------|
| App khởi động lần đầu | thì call channel query |
| App khởi động (đã có data) | `POST /sync` | `event_seq` cho mỗi channel |
| Background → Foreground | `POST /sync` | `event_seq` cho mỗi channel |
| WebSocket phát hiện gap | `GET /channels/.../sync` | `since_seq` = last known seq |
| Scroll up load more | `POST /channels/.../query` | Body: `messages_seq: { anchor_seq: min_local_seq, before: limit }` |
| Jump to message | `POST /channels/.../query` | Body: `messages_seq: { anchor_seq: target_seq, before: X, after: Y }` |
| Channel sync có `has_more` | `GET /channels/.../sync` | `since` = `next_cursor` từ response |

### Bảng tóm tắt — Server response → Client action

| Server field | Điều kiện | Client action |
|-------------|-----------|--------------|
| `events[]` | Luôn xử lý | Duyệt từng event, áp dụng trạng thái tin nhắn mới nhất vào bảng messages |
| `has_more = true` | | Gọi tiếp API với cursor mới |
| `next_cursor` | `has_more = true` | Dùng làm `since` cho request tiếp |
| `hidden_message_seqs` | Array không rỗng | Xoá messages có `msg_seq` trong list |
| `hidden_event_seqs` | Array không rỗng | Không coi là gap khi detect |
| `last_msg_seq_before_chat_deleted` | Giá trị > 0 | **Xoá TẤT CẢ messages có `msg_seq ≤ giá trị`** |
| `removed_channels.events[]` | Array không rỗng | **Xoá channel + messages khỏi local DB** |

---

> **Lưu ý cho developer:**
> - Luôn dùng `event_seq` cursor khi có thể (chính xác hơn timestamp)
> - `msg_seq` dùng cho **query/pagination messages**, `event_seq` dùng cho **sync events**
> - Server giới hạn `limit` tối đa 200 per request
> - Khi channel bị truncate, `last_msg_seq_before_chat_deleted` sẽ được trả về trong MỌI lần sync cho đến khi không còn messages nào có seq ≤ giá trị đó