# E2EE Frontend Guide

**Search tags:** e2ee, mls, bellboy, frontend, web, TypeScript, IndexedDB, localStorage, wasm, sync, message_updated, reaction

## Mục Đích

Hướng dẫn này dành cho web developer tích hợp E2EE bằng Ermis Chat SDK. Nội dung tập trung vào TypeScript/web runtime: load OpenMLS WASM, init SDK MLS manager, IndexedDB storage, create/enable/send/edit/sync, và UI hydrate từ local plaintext cache.

API contract chi tiết nằm ở [e2ee_api_reference.md](./e2ee_api_reference.md). Event payload chi tiết nằm ở [e2ee_events.md](./e2ee_events.md).

## Tra Cứu Nhanh

| Keyword | Việc cần làm | Link |
|---|---|---|
| `wasm` | Publish/load `openmls_wasm_bg.wasm` | Init E2EE |
| `IndexedDB` | Default `IndexedDBMlsStorage` per user | Storage |
| `X-Device-ID` | SDK tự lấy từ storage/localStorage | Init E2EE |
| `createE2eeChannel` | Tạo DM/team E2EE từ đầu | Create channel |
| `enableE2ee` | Upgrade channel standard -> E2EE | Enable channel |
| `sendMessage` | SDK route sang `/v1/e2ee/.../message` | Messaging |
| `editMessage` | Latest encrypted snapshot | Edit message |
| `sync` | Login/reconnect/offline catch-up | Sync |
| `reaction` | Patch local cache từ WS/sync | Metadata |

## Nội Dung Chính

### Init E2EE

Web cần load WASM trước khi `MlsManager.initialize()`.

```ts
import { ErmisChat, MlsManager, IndexedDBMlsStorage, loadOpenMlsWasm } from '@ermis-network/ermis-chat-sdk';

const client = ErmisChat.getInstance(apiKey, {
  baseURL,
  timeout: 15000,
});

await client.connectUser({ id: userId, name: displayName }, token);

const wasmModule = await loadOpenMlsWasm('/openmls_wasm_bg.wasm');
const mlsManager = new MlsManager();

await mlsManager.initialize(client, userId, {
  wasmModule,
  storage: new IndexedDBMlsStorage(userId),
});

client.mlsManager = mlsManager;
```

Frontend app phải đảm bảo file WASM được serve public path đúng. Nếu WASM load fail, E2EE UI nên disable toggle và vẫn cho standard chat hoạt động.

### Storage web

SDK default storage:

| Data | Web storage | Notes |
|---|---|---|
| `device_id` | `localStorage` key `ermis_device_id` | Global per browser; SDK injects `X-Device-ID`. |
| identity bytes | IndexedDB `identity` store | Keyed by `userId:deviceId`. |
| provider state | IndexedDB `meta` store | Web provider is in-memory; persist after commits/decrypt. |
| group marker | IndexedDB `groups` store | `cid -> marker`. |
| decrypted messages | IndexedDB `messages` store | UI hydration/search source. |
| sync cursors | IndexedDB `meta` store | Per cid RFC3339 timestamp cursor. |
| pending snapshots/evictions | IndexedDB `meta` store | Retry after reconnect. |

Không xóa IndexedDB khi logout cùng user nếu muốn restore E2EE state nhanh. Khi switch user, SDK dùng DB scoped theo user id để tránh contaminate state.

### Create E2EE channel

#### Team channel

```ts
async function createTeamE2ee(client: ErmisChat, memberIds: string[], name: string) {
  const channelId = crypto.randomUUID();
  const cid = `team:${channelId}`;

  const bundle = await client.mlsManager.createE2eeChannel('team', channelId, cid, memberIds);

  const channel = client.channel('team', channelId, {
    name,
    members: memberIds,
    mls_enabled: true,
    welcome: bundle.welcome,
    ratchet_tree: bundle.ratchet_tree,
    group_info: bundle.group_info,
    epoch: bundle.epoch,
  });

  await channel.create();
  return channel;
}
```

#### Messaging DM

```ts
async function createDmE2ee(client: ErmisChat, memberIds: string[]) {
  const bundle = await client.mlsManager.createE2eeChannel('messaging', null, null, memberIds);

  const channel = client.channel('messaging', undefined, {
    channel_id: bundle.channel_id,
    members: memberIds,
    public: false,
    mls_enabled: true,
    welcome: bundle.welcome,
    ratchet_tree: bundle.ratchet_tree,
    group_info: bundle.group_info,
    epoch: bundle.epoch,
  });

  await channel.create();
  return channel;
}
```

DM E2EE cần `client.projectId` để SDK gọi WASM `hash_channel_id(projectId, memberIds)`. Nếu create race xảy ra, SDK/client phải discard local group loser và query/sync channel winner.

### Enable E2EE cho channel có sẵn

```ts
async function enableChannelE2ee(channel: any) {
  const client = channel.getClient();
  if (!client.mlsManager?.initialized) {
    throw new Error('E2EE is unavailable on this device');
  }

  const memberIds = Object.keys(channel.state.members || {});
  const result = await client.mlsManager.enableE2ee(channel.type, channel.id, channel.cid, memberIds);

  channel.data = {
    ...channel.data,
    mls_enabled: true,
    mls_enabled_at: result?.channel?.mls_enabled_at ?? new Date().toISOString(),
    mls_epoch: result?.channel?.mls_epoch ?? result?.epoch,
  };

  return result;
}
```

UI nên disable enable button nếu channel đã E2EE, topic child đang inherited E2EE, user không có quyền, hoặc MLS manager chưa initialized.

### Send message

SDK `channel.sendMessage()` nên tự route sang E2EE path nếu `channel.data.mls_enabled` và `client.mlsManager.initialized`.

```ts
async function sendE2eeText(channel: any, text: string) {
  if (channel.data?.mls_enabled) {
    return channel.sendMessage({
      text,
      attachments: [],
      mentioned_users: [],
    });
  }

  return channel.sendMessage({ text });
}
```

Expected behavior:

- SDK encrypts payload with OpenMLS.
- SDK sends `mls_ciphertext` + `mls_epoch` to `/v1/e2ee/.../message`.
- SDK stores own plaintext snapshot locally because own ciphertext may not be decrypted again.
- UI renders local plaintext immediately, then reconciles WS envelope by message id.

### Receive and hydrate messages

UI message list should render encrypted placeholder only while decrypt/cache lookup is pending.

```ts
client.on('message.new', async (event) => {
  const message = event.message;
  const channel = client.activeChannels[event.cid];
  const isE2ee = channel?.data?.mls_enabled;
  const isMls = message?.content_type === 'mls' && message?.mls_ciphertext;

  if (!isE2ee || !isMls || !client.mlsManager?.initialized) return;

  const decrypted = await client.mlsManager.processE2eeMessage(event.cid, message).catch(() => null);
  if (decrypted) {
    channel.state.addMessageSorted(decrypted, false);
    client.dispatchEvent({ type: 'e2ee.message_decrypted', cid: event.cid, message: decrypted });
  }
});
```

Rendering rule:

```tsx
function MessageText({ message }: { message: any }) {
  if (message.content_type === 'mls' && !message.text) {
    if (message.e2ee_status === 'failed') return <span>Encrypted message could not be decrypted</span>;
    if (message.e2ee_status === 'decrypting') return <span>Decrypting encrypted message...</span>;
    return <span>Encrypted message</span>;
  }

  return <span>{message.text}</span>;
}
```

### Edit message

```ts
async function editE2eeMessage(channel: any, messageId: string, text: string) {
  if (channel.data?.mls_enabled && channel.getClient().mlsManager?.initialized) {
    const response = await channel.editMessage(messageId, { text });

    const stored = await channel.getClient().mlsManager.storage.loadE2eeMessage(messageId);
    if (stored) {
      channel.state.addMessageSorted({ ...stored, content_type: 'standard' }, false);
    }

    return response;
  }

  return channel.editMessage(messageId, { text });
}
```

E2EE edit payload phải là full latest snapshot, bao gồm `old_texts` đã tích lũy. UI không append bubble mới; update same message id.

### Add/remove members

```ts
async function addMembers(channel: any, userIds: string[]) {
  const mlsManager = channel.getClient().mlsManager;

  if (channel.data?.mls_enabled && mlsManager?.initialized) {
    return mlsManager.addMembers(channel.type, channel.id, channel.cid, userIds);
  }

  return channel.addMembers(userIds);
}

async function removeMember(channel: any, userId: string) {
  const mlsManager = channel.getClient().mlsManager;

  if (channel.data?.mls_enabled && mlsManager?.initialized) {
    return mlsManager.evictMember(channel.type, channel.id, channel.cid, userId);
  }

  return channel.removeMembers([userId]);
}
```

For self-leave, current user leaves via `self_remove=true`; remaining active clients store the leaver as a pending ghost. The monorepo SDK bundles pending ghosts into the next `addMembers`, `removeMembers`, or `keyRotation` composite commit. If no main action is available, the remaining designated evictor can still send a remove-only `commit_eviction`.

```ts
client.on('member.removed', async (event: any) => {
  const channel = client.activeChannels[event.cid];
  const mlsManager = client.mlsManager;
  if (!channel?.data?.mls_enabled || !mlsManager?.initialized) return;

  const targetUserId = event.member?.user_id;
  const actorUserId = event.user?.id;
  const isSelfLeave =
    event.self_remove === true ||
    (event.self_remove === undefined && Boolean(targetUserId && actorUserId && targetUserId === actorUserId));

  if (targetUserId === client.userID) {
    mlsManager.leaveGroup(event.cid);
    for (const topicCid of event.topic_cids ?? []) mlsManager.leaveGroup(topicCid);
    return;
  }

  if (!isSelfLeave) {
    // Admin kick path: the remover already sent the MLS commit through edit_channel.
    return;
  }

  if (!mlsManager.isDesignatedEvictor(channel)) return;

  try {
    await mlsManager.evictMember(channel.type, channel.id, event.cid, targetUserId, true);
    for (const topicCid of event.topic_cids ?? []) {
      const [topicType, topicId] = topicCid.split(':');
      await mlsManager.evictMember(topicType, topicId, topicCid, targetUserId, true);
    }
  } catch (err) {
    client.logger('error', 'commit_eviction after self-leave failed; will retry from pending queue', {
      err,
      cid: event.cid,
      target_user_ids: [targetUserId],
    });
  }
});
```

Important guard: use `event.member.user_id` as the removed target. `event.user.id` is the actor. `event.self_remove` is the source of truth; only `self_remove=true` should create pending ghost cleanup for remaining members. Actor/target equality is only fallback for old cached events. Cleanup must be confirmed only after the server accepts the composite commit and local `mergePendingCommit()` succeeds.

### Removed channel sync cleanup

Web SDK stores a user-scoped composite `removed_cursor` in IndexedDB:

```ts
type RemovedSyncCursor = { removed_at: string; event_id: string };
```

It sends this object with `/v1/e2ee/sync`. `removed_channels` is separate from per-cid events: it tells this user/device to delete local MLS group state and decrypted cache for channels where membership was hard-deleted and recorded in `member_removal_history`. `removal_type="channel_deleted"` means the channel no longer exists for any member; `parent_cid` may be `null`, so cleanup by `cid`. Do not read `event:{cid}` for removed-user cleanup; that stream is only for active members.

When the current user self-leaves or receives a removed-channel history event, also move the per-cid sync cursor to the removal timestamp. Otherwise a later re-add can replay an old, already-consumed Welcome and OpenMLS will fail with `No matching key package was found in the key store`.

Invite reject should perform the same local MLS cleanup for the rejecting user. If the client ever created a local group before accepting, delete that local group and move the per-cid cursor to the server event timestamp from `notification.invite_rejected`; this cleanup is a no-op when no group exists. On later re-invite, initial per-cid sync must use a membership-bounded cursor: the latest of saved cursor, current `membership.created_at` with a small lookback, and `mls_enabled_at` with a small lookback. Bellboy also clamps E2EE sync to the current membership boundary so stale Welcome events from an older rejected membership are not returned.

### External join on channel open

```ts
async function ensureE2eeReady(channel: any) {
  const client = channel.getClient();
  const mlsManager = client.mlsManager;

  if (!channel.data?.mls_enabled || !mlsManager?.initialized) return true;
  if (mlsManager.getGroup?.(channel.cid)) return true;

  await mlsManager.syncChannel?.(channel.type, channel.id, channel.cid).catch(() => null);
  if (mlsManager.getGroup?.(channel.cid)) return true;

  await mlsManager.joinExternal(channel.type, channel.id, channel.cid);
  await mlsManager.syncAfterExternalJoin?.(channel.cid).catch(() => null);
  return true;
}
```

Trigger points nên có: sau login/reconnect, khi mở channel E2EE, và sau accept invite/channel.created mà local group chưa tồn tại.

### Sync on login/reconnect

```ts
async function syncE2ee(client: ErmisChat) {
  const mlsManager = client.mlsManager;
  if (!mlsManager?.initialized) return;

  mlsManager.markSyncStart?.();
  try {
    await mlsManager.sync();
  } finally {
    mlsManager.markSyncEnd?.();
  }
}

client.on('connection.recovered', () => {
  syncE2ee(client).catch((err) => client.logger('error', 'E2EE sync failed', { err }));
});
```

Sync handler must process events per cid sequentially, persist decrypted messages/provider state, then save `next_cursor`.

### Reaction/delete/pin metadata

```ts
client.on('reaction.new', async (event) => {
  const message = event.message;
  const storage = client.mlsManager?.storage;
  if (!message?.id || !storage) return;

  const local = await storage.loadE2eeMessage(message.id);
  if (!local) return;

  await storage.saveE2eeMessage({
    ...local,
    latest_reactions: message.latest_reactions,
    reaction_counts: message.reaction_counts,
  });
});

client.on('message.deleted', async (event) => {
  const messageId = event.message?.id;
  if (messageId) await client.mlsManager?.storage?.deleteE2eeMessage(messageId);
});
```

Sync metadata events must apply the same patches offline.

### Search and pagination

For E2EE channels, server search cannot inspect plaintext after encryption. Search should use local decrypted message index.

```ts
async function searchE2ee(channel: any, term: string) {
  const storage = channel.getClient().mlsManager?.storage;
  if (!channel.data?.mls_enabled || !storage) return [];
  return storage.searchE2eeMessagesByCid(channel.cid, term, 100);
}
```

Pagination/query response should be reconciled with local plaintext cache by message id before rendering.

## Lưu Ý Tích Hợp

- Do not show E2EE toggle unless WASM and MLS manager initialized.
- Do not send standard message to an E2EE channel; server rejects it.
- Keep encrypted attachments metadata inside plaintext payload before encrypting.
- Persist provider after any operation that advances ratchet state.
- Treat local decrypted cache as private data; clear only on explicit user/device reset.
- Handle `epoch_stale` by clearing pending commit, running sync, and retrying once.

## Checklist

- [ ] WASM assets are served and loaded before E2EE UI is enabled.
- [ ] `client.deviceId` is initialized and SDK injects `X-Device-ID`.
- [ ] `MlsManager.initialize()` receives user-scoped `IndexedDBMlsStorage`.
- [ ] Create DM uses SDK `createE2eeChannel('messaging', null, null, members)`.
- [ ] Enable/add/remove/key rotation paths merge commit only after server OK.
- [ ] Message list hydrates encrypted envelopes from IndexedDB plaintext cache.
- [ ] WS and sync metadata update reaction/delete/pin/edit local state.
- [ ] Login/reconnect triggers unified E2EE sync.
- [ ] Search in E2EE channels uses local decrypted index.

## Liên Kết Liên Quan

- [e2ee_api_reference.md](./e2ee_api_reference.md) — endpoint detail.
- [e2ee_client_flows.md](./e2ee_client_flows.md) — sequence diagrams.
- [e2ee_events.md](./e2ee_events.md) — realtime and sync payloads.
- [e2ee_mobile_guide.md](./e2ee_mobile_guide.md) — mobile differences.
