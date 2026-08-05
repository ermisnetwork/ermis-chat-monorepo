# Tài liệu Kỹ thuật: API Muted & Đồng bộ WebSocket cho Frontend Web

Tài liệu này hướng dẫn đội ngũ **Frontend (Web/Mobile)** cách tích hợp API **Tắt/Bật thông báo (Mute / Unmute)** cuộc trò chuyện và cách xử lý event đồng bộ thời gian thực qua **WebSocket**.

---

## 1. Tổng quan cơ chế Mute / Unmute

- **Cấp độ hỗ trợ**: Per-channel / Per-conversation (Tắt/bật thông báo theo từng cuộc trò chuyện).
- **Cơ chế lưu trữ**: Trường `muted` dạng `ISO 8601 Timestamp` (`DateTime<Utc>` hoặc `null`).
  - `null`: Không mute (nhận thông báo bình thường).
  - `Timestamp` (VD: `2026-08-04T18:30:00Z`): Đang mute cho tới thời điểm này.
  - `Timestamp` tối đa tương lai (VD: `9999-12-31T23:59:59Z`): Mute vĩnh viễn (cho tới khi người dùng chủ động Unmute).
- **Đồng bộ đa thiết bị**: Khi một thiết bị gửi request Mute/Unmute qua HTTP API, backend sẽ cập nhật Database và tự động broadcast một event WebSocket `member.updated` tới tất cả các thiết bị/tab đang online của người dùng đó để đồng bộ trạng thái UI.

---

## 2. HTTP API: Tắt / Bật thông báo

### Endpoint
```http
POST /channels/{channel_type}/{channel_id}/muted
```

- **Headers**:
  - `Authorization: Bearer <access_token>`
  - `Content-Type: application/json`

- **Path Parameters**:
  - `channel_type`: Loại channel (VD: `messaging`, `team`, v.v.). *Lưu ý: Endpoint này không hỗ trợ `topic`.*
  - `channel_id`: ID của channel.

### Request Body Schema
```json
{
  "mute": boolean,
  "duration": number // (Optional) Thời gian mute tính bằng milliseconds
}
```

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `mute` | `boolean` | **Có** | `true` để tắt thông báo, `false` để bật lại thông báo. |
| `duration` | `number` | Không | Thời gian tắt thông báo (ms). Ví dụ: `3600000` (1 giờ), `28800000` (8 giờ). Nếu `mute: true` mà bỏ trống `duration`, hệ thống hiểu là **Mute vĩnh viễn**. |

---

### Ví dụ Request & Response

#### a. Mute 1 giờ (`3600000` ms)
```http
POST /channels/messaging/channel_123/muted
Content-Type: application/json

{
  "mute": true,
  "duration": 3600000
}
```

#### b. Mute vĩnh viễn (Không thời hạn)
```http
POST /channels/messaging/channel_123/muted
Content-Type: application/json

{
  "mute": true
}
```

#### c. Unmute (Bật lại thông báo)
```http
POST /channels/messaging/channel_123/muted
Content-Type: application/json

{
  "mute": false
}
```

#### Response Thành công
- **Status Code**: `200 OK`
- **Body**: (Rỗng hoặc `Ok`)

---

## 3. WebSocket Event Đồng bộ (`member.updated`)

Sau khi gọi API Muted thành công, Backend sẽ broadcast sự kiện WebSocket tới tất cả kết nối WebSocket của user với cấu trúc dữ liệu như sau:

### Event Tag: `member.updated`

#### Payload Cấu trúc JSON từ WebSocket:
```json
{
  "cid": "messaging:channel_123",
  "created_at": "2026-08-04T10:35:00.123Z",
  "event_seq": 1045,
  "type": "member.updated",
  "channel_id": "channel_123",
  "channel_type": "messaging",
  "member": {
    "user_id": "user_456",
    "user": {
      "id": "user_456"
    },
    "created_at": "2026-01-01T00:00:00Z",
    "updated_at": "2026-08-04T10:35:00Z",
    "channel_role": "member",
    "banned": false,
    "blocked": false,
    "muted": "2026-08-04T11:35:00.123Z" // ISODate string nếu Muted, hoặc null nếu Unmuted
  },
  "user": {
    "id": "user_456"
  }
}
```

> [!IMPORTANT]
> Giá trị trường `member.muted`:
> - Nếu đang Muted: là chuỗi mốc thời gian hết hạn dạng ISO Date (VD: `"2026-08-04T11:35:00.123Z"`).
> - Nếu đã Unmuted: là `null` (hoặc không tồn tại trường này).

---

## 4. Hướng dẫn xử lý phía Frontend (Client Web)

### Step 1: Utility helper kiểm tra trạng thái Muted

Viết hàm tiện ích helper để kiểm tra xem một channel có đang bị Mute hay không:

```typescript
/**
 * Kiểm tra xem cuộc trò chuyện có đang trong trạng thái Mute hay không.
 * @param mutedTimestamp Chuỗi ISO Date (VD: member.muted) hoặc null/undefined
 */
export function isChannelMuted(mutedTimestamp?: string | null): boolean {
  if (!mutedTimestamp) {
    return false;
  }
  const mutedUntil = new Date(mutedTimestamp).getTime();
  const now = Date.now();
  return mutedUntil > now;
}
```

---

### Step 2: Xử lý gọi HTTP API từ UI

Khi người dùng thao tác bấm menu "Tắt thông báo" hoặc "Bật lại thông báo":

```typescript
// Hàm Mute channel
async function muteChannel(channelType: string, channelId: string, durationMs?: number) {
  try {
    await api.post(`/channels/${channelType}/${channelId}/muted`, {
      mute: true,
      ...(durationMs ? { duration: durationMs } : {})
    });
    // Lưu ý: Không cần tự tay update state local nếu đã nghe WebSocket event 'member.updated'.
    // Tuy nhiên có thể optimistic update UI nếu muốn UX phản hồi tức thì.
  } catch (error) {
    console.error('Lỗi khi mute channel:', error);
  }
}

// Hàm Unmute channel
async function unmuteChannel(channelType: string, channelId: string) {
  try {
    await api.post(`/channels/${channelType}/${channelId}/muted`, {
      mute: false
    });
  } catch (error) {
    console.error('Lỗi khi unmute channel:', error);
  }
}
```

---

### Step 3: Lắng nghe và xử lý WebSocket Event

Trong bộ quản lý kết nối WebSocket của Web App:

```typescript
webSocket.on('message', (eventData: any) => {
  if (eventData.type === 'member.updated') {
    const { cid, member, user } = eventData;

    // Chỉ xử lý nếu event này liên quan đến chính user hiện tại
    if (user?.id === currentUserId) {
      const isMuted = isChannelMuted(member.muted);

      // 1. Cập nhật State Store (Redux / Zustand / React Context)
      store.dispatch(updateChannelMuteState({
        cid,
        muted: member.muted,
        isMuted
      }));

      // 2. Cập nhật UI (Hiển thị icon Chuông gạch chéo 🔕 trên danh sách chat)
      updateChannelUI(cid, { isMuted });
    }
  }
});
```

---

### Step 4: Logic phát âm thanh / thông báo (Sound & Notification) trên Web

Khi có tin nhắn mới xẩy ra (`message.new` qua WebSocket):

```typescript
webSocket.on('message', (eventData: any) => {
  if (eventData.type === 'message.new') {
    const { cid, message } = eventData;
    const channel = store.getChannelByCid(cid);

    const isMuted = isChannelMuted(channel?.member?.muted);
    const isMentioned = message?.mentioned_users?.includes(currentUserId);

    // QUY TẮC PHÁT CHUÔNG / POPUP:
    // - Nếu KHÔNG MUTE: Phát tiếng notification & Bật Browser Popup.
    // - Nếu ĐANG MUTE nhưng ĐƯỢC MENTION: Vẫn có thể phát tiếng (tùy cài đặt UX).
    // - Nếu ĐANG MUTE & KHÔNG MENTION: Im lặng hoàn toàn (Suppress sound/popup).
    
    if (!isMuted || isMentioned) {
      playNotificationSound();
      showBrowserNotification(message);
    }
  }
});
```
