---
sidebar_position: 4
---

# User Management

The SDK delegates user operations to the configured `endUserApiMode: 'legacy' | 'v1'` adapter. Legacy keeps the USS listing, SSE, and profile contract; v1 uses targeted user APIs and intentionally does not expose unrestricted full-user listing.

## Targeted User Retrieval

```typescript
const user = await chatClient.queryUser('user-xyz');
const users = await chatClient.getBatchUsers(['user-1', 'user-2']);
```

- In v1, `queryUser(id)` calls `GET /users/:id`; `getBatchUsers(ids)` calls `POST /users/batch` with `{ user_ids }`, de-dupes IDs, and chunks at 100 IDs per request.
- V1 requests use Bearer auth without `project_id`, and normalize `display_name -> name` and `avatar_url -> avatar` while preserving raw fields.
- Legacy maps the same SDK methods to its existing project-scoped endpoints and response shapes.

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

## Listing APIs

```typescript
await chatClient.queryUsers();
await chatClient.syncUserCache();
```

These methods work in legacy mode. In v1 they throw `UnsupportedEndUserFeatureError` with `feature = 'unrestricted_listing'` before making a request.

## Browser User Cache

In browser runtimes, the SDK keeps a local IndexedDB user cache. On `connectUser()`, the SDK hydrates from local cache only, then asynchronously refreshes the connected user's full profile with `queryUser(me)`.

The cache is updated by:

- `queryUser`
- `getBatchUsers`
- `searchUsers`
- message/member enrichment
- `updateProfile`
- `uploadAvatar`

The cache namespace includes the selected `endUserApiMode`, so legacy and v1 never read each other's records. When `projectId` is unavailable in self-host mode, the SDK also scopes the cache by the normalized user/chat base URL plus the current user ID.

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

In v1, `updateProfile()` maps `name -> display_name` and `avatar -> avatar_url`; `about_me` throws a typed unsupported error. Legacy keeps `/users/update`, including its existing profile fields.

V1 `uploadAvatar()` posts multipart data to `/users/me/avatar` and returns the normalized full user profile. Legacy uses `/users/upload`.

## Real-time Profile Sync

Profile SSE is available in legacy mode. In v1, `connectToSSE()` throws `UnsupportedEndUserFeatureError`; refresh user state through targeted reads/search, batch lookup, profile update calls, and message/member payload enrichment.

## User Picker Guidance

User discovery UI should be search-driven:

- Seed the initial list from `client.state.users` and already loaded channel members.
- Do not call `queryUsers()` on mount.
- Only perform remote search when the search input is non-empty.
- Call `client.searchUsers(search.trim(), limit)` for remote search.
