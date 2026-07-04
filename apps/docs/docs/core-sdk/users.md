---
sidebar_position: 4
---

# User Management

The SDK uses `ermis_end_user` v1 for user profile reads, search, and current-user profile updates. v1 intentionally does not expose unrestricted full-user listing.

## Targeted User Retrieval

```typescript
const user = await chatClient.queryUser('user-xyz');
const users = await chatClient.getBatchUsers(['user-1', 'user-2']);
```

- `queryUser(id)` calls `GET /users/:id`.
- `getBatchUsers(ids)` calls `POST /users/batch` with `{ user_ids }`, de-dupes IDs, and chunks at 100 IDs per request.
- Both methods use Bearer auth and do not send `project_id`.
- Responses normalize `display_name -> name` and `avatar_url -> avatar` while preserving raw `display_name`, `avatar_url`, `status`, and `services`.

## Search

```typescript
const response = await chatClient.searchUsers('Jane Doe', 25);
```

`searchUsers(query, limit)` calls `GET /users/search?q=<query>&limit=<limit>`. `limit` is capped at 100.

The legacy overload remains callable:

```typescript
await chatClient.searchUsers(1, 25, 'Jane Doe');
```

For v1 this maps to `q=Jane Doe&limit=25` and ignores `page`.

## Unsupported Listing APIs

```typescript
await chatClient.queryUsers(); // throws
await chatClient.syncUserCache(); // throws
```

`queryUsers()` and `syncUserCache()` are unsupported because v1 has no full-user-list endpoint. The SDK also does not run background 10k-user cache sync after `connectUser()`.

## Browser User Cache

In browser runtimes, the SDK keeps a local IndexedDB user cache. On `connectUser()`, the SDK hydrates from local cache only, then asynchronously refreshes the connected user's full profile with `queryUser(me)`.

The cache is updated by:

- `queryUser`
- `getBatchUsers`
- `searchUsers`
- message/member enrichment
- `updateProfile`
- `uploadAvatar`

When `projectId` is unavailable in self-host mode, the SDK scopes the cache by the normalized user/chat base URL plus the current user ID.

## Updating Profiles

Use `updateProfile` for lightweight metadata and `uploadAvatar` for image upload.

```typescript
await chatClient.updateProfile({
  name: 'New User Name',
  avatar: 'https://cdn.example.com/avatar.png',
});

const response = await chatClient.uploadAvatar(newAvatarFile);
console.log(response.avatar);
```

`updateProfile()` maps `name -> display_name` and `avatar -> avatar_url`. `about_me` is not supported by v1 and throws an explicit error.

`uploadAvatar()` posts multipart data to `/users/me/avatar` and returns the normalized full user profile.

## Real-time Profile Sync

Profile SSE is unsupported in v1. `connectToSSE()` throws an explicit unsupported error. Refresh user state through targeted reads/search, batch lookup, profile update calls, and message/member payload enrichment.

## User Picker Guidance

User discovery UI should be search-driven:

- Seed the initial list from `client.state.users` and already loaded channel members.
- Do not call `queryUsers()` on mount.
- Only perform remote search when the search input is non-empty.
- Call `client.searchUsers(search.trim(), limit)` for remote search.
