---
sidebar_position: 4
---

# User Management

Once a user is connected to `ErmisChat`, broad query methods for discovering other actors in the system, viewing contacts, and updating own profiles are available directly within the global client session.

## Querying and Searching

Retrieve users registered inside your Ermis Project using these methods.

### Paginated User Search
```typescript
// Query full paginated user list (by page size & page number)
const usersData = await chatClient.queryUsers('25', 1); // pageSize = 25, page = 1

// Search users by name
const searchResult = await chatClient.searchUsers(1, 25, 'Jane Doe'); 
```

### Targeted User Retrieval
```typescript
// Target a specific single user ID
const userDetail = await chatClient.queryUser('user-xyz');

// Retrieve batched users by an explicit list of IDs
const users = await chatClient.getBatchUsers(['user-1', 'user-2']);
```

## Contacts

Ermis maintains contact relationship structures. You can query contacts to fetch users interacting frequently or explicitly marked by blocklist rules:
```typescript
// Fetch user's contact list
const { contact_users, block_users } = await chatClient.queryContacts();

console.log("Allowed Users", contact_users);
console.log("Blocked Users", block_users);
```

## Updating Profiles

The client exposes two distinct methods to update the authenticated user's profile, separating media uploads from lightweight text changes to maximize UI responsiveness.

### 1. Updating Metadata (Text Only)
Use `updateProfile` for near-instant updates to the user's name or bio. This method does not support uploading image files.

```typescript
// Updates text fields asynchronously and hydrates the local user state
await chatClient.updateProfile({ 
  name: 'New User Name', 
  about_me: 'My updated about me...' 
});
```

### 2. Updating the Avatar (Image Upload)
Use `uploadFile` to send a media file to the server. The backend processes the file, updates the user's avatar URL in the database, and the SDK automatically syncs this new avatar URL down to the client state.

```typescript
// Usually derived from an <input type="file" /> in the browser
const newAvatarFile = new File([...], 'avatar.png');

// Uploads the file and updates the profile avatar automatically
const response = await chatClient.uploadAvatar(newAvatarFile);

console.log('Successfully uploaded and updated Avatar URL to:', response.avatar);
```

### 🎯 Orchestrating a Complete Profile Form
When building a 'Settings' form that updates both the Avatar and text metadata simultaneously, it's a best practice to orchestrate these two methods sequentially. This prevents UI blocking from heavy image uploads while keeping text changes fast.

> **Why not merge them?** 
> Keeping them separate ensures you can provide distinct loading states for image uploads vs text saves, and elegantly handle cases where an image upload fails but text properties are successfully persisted.

```javascript
const saveProfileChanges = async (newName, newAboutMe, newAvatarFile) => {
  setIsSaving(true);
  
  try {
    // Stage 1: Upload the avatar if the user selected a new image
    if (newAvatarFile) {
      // You can show a specific progress indicator here
      await chatClient.uploadAvatar(newAvatarFile); 
    }

    // Stage 2: Always update the text metadata
    await chatClient.updateProfile({ name: newName, about_me: newAboutMe });
    
    alert('Profile updated successfully!');
  } catch (error) {
    console.error('Failed to update profile:', error);
  } finally {
    setIsSaving(false);
  }
};
```

## Real-time Profile Sync (SSE)

After `connectUser` succeeds, the SDK automatically opens a **Server-Sent Events (SSE)** connection to receive real-time profile updates. When any user in the project changes their name, avatar, or about-me, the SDK:

1. Updates the user in `client.state.users`.
2. Propagates changes to every active channel's member list, watchers, and message references.
3. For **direct messaging** channels, automatically updates the channel name and image to reflect the other user's new profile.

### `connectToSSE`

Called internally by `connectUser`. You can also call it manually with an optional callback to react to profile update events:

```typescript
await chatClient.connectToSSE((data) => {
  // data.type === 'AccountUserChainProjects'
  console.log('User profile updated:', data.name, data.avatar);
});
```

### `disconnectFromSSE`

Closes the SSE connection. Useful when tearing down the client manually.

```typescript
await chatClient.disconnectFromSSE();
```
