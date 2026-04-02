---
sidebar_position: 3
---

# Hooks

Instead of using the UI components, you can use our built-in hooks to create a fully customized headless UI.

## Context Hooks

These hooks let you access the data from the upper Providers.

* `useChatContext()`: Retrieves the initialized `chatClient` and global app state.
* `useChannelStateContext()`: Retrieves all state for the currently active channel (messages, members, watchers).
* `useChannelActionContext()`: Retrieves functions like `sendMessage`, `editMessage`, `loadMore`.

## Example: Custom Message List

```tsx
import { useChannelStateContext } from '@ermis-network/ermis-chat-react';

export const MyCustomList = () => {
    const { messages } = useChannelStateContext();

    return (
        <div className="my-list">
            {messages.map(m => (
                <div key={m.id}>{m.text}</div>
            ))}
        </div>
    )
}
```
