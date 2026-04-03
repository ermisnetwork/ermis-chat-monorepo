---
sidebar_position: 6
---

# Custom Message Renderers

Ermis Chat provides native rendering support for various dynamic message layouts via the **MessageRenderers** mapping system. While the default UI handles text, attachments, and polls seamlessly, most production applications require heavily customized designs for system alerts, interactive poll cards, or custom signals.

## The `messageRenderers` Mapping

The `<VirtualMessageList />` component accepts a `messageRenderers` dictionary property that binds specific rendering components to an internal `MessageLabel`.

### Available `MessageLabel` Keys

When overriding, you are overriding the UI output for these specific types:

- **`regular`**: Standard text messages from users.
- **`system`**: Automated system alerts (e.g., "User A joined the channel").
- **`signal`**: Invisible or programmatic trigger messages (e.g., "Start video bridge").
- **`poll`**: Interactive message ballots.
- **`sticker`**: Large graphics sent dynamically without attachment wrappers.
- **`error`**: Client-side error messages or bounces.

You can also access the default fallback renderers if you need to wrap or extend them:
```tsx
import { defaultMessageRenderers } from '@ermis-network/ermis-chat-react';
```

---

## Overriding a Custom Type

To override how a message behaves, you simply need to define a React Component that takes `MessageRendererProps`, and supply it to the `messageRenderers` dictionary.

### Example: Custom System Messages

By default, system messages are displayed as discreet faded text chunks. You might want to style them as prominent banners. 

*Note: System messages often contain raw strings or locale-keys. The SDK provides a `parseSystemMessage` utility if you need to resolve "@userId" tags into actual names.*

```tsx
import { VirtualMessageList } from '@ermis-network/ermis-chat-react';
import type { MessageRendererProps } from '@ermis-network/ermis-chat-react';

// 1. Create your custom renderer
const MySystemBanner = ({ message }: MessageRendererProps) => {
  return (
    <div style={{ backgroundColor: '#fff3cd', padding: '10px', textAlign: 'center', borderRadius: '4px' }}>
      🚨 SYSTEM ALERT: {message.text}
    </div>
  );
};

// 2. Map it to the `system` key
export const ChannelMessages = () => {
  return (
    <VirtualMessageList 
      messageRenderers={{
        system: MySystemBanner
      }}
    />
  );
};
```

---

## Overriding Regular Messages

The `regular` MessageLabel represents the standard text chat bubble that accounts for 99% of user interactions within a channel.

> [!WARNING]
> When you override the `regular` renderer, you are completely dropping the default SDK bubble implementation. You will become explicitly responsible for parsing user text, formatting links, and rendering `message.attachments` using your own logic or by invoking the `<AttachmentList />` helper component manually.

```tsx
import { VirtualMessageList, AttachmentList } from '@ermis-network/ermis-chat-react';
import type { MessageRendererProps } from '@ermis-network/ermis-chat-react';

const MyRegularMessage = ({ message, isOwnMessage }: MessageRendererProps) => {
  return (
    <div className={`my-bubble ${isOwnMessage ? 'own' : 'other'}`}>
      <p>{message.text}</p>
      
      {/* Manually invoke AttachmentList to not lose image/video/file visuals! */}
      {message.attachments && message.attachments.length > 0 && (
         <AttachmentList attachments={message.attachments} />
      )}
    </div>
  );
};

// Map it to the `regular` key
export const ChannelMessages = () => (
  <VirtualMessageList messageRenderers={{ regular: MyRegularMessage }} />
);
```

---

## Attachment Renderers

If you are overriding `regular` messages, the SDK exposes convenient sub-components to help you handle files without rebuilding video players or image lightboxes from scratch.

### `<AttachmentList />`

Takes an array of attachments and visually groups them. Multiple images/videos will be rendered intelligently in a grid, while files and voice recordings will be stacked below.

**Props:**
- `attachments` (`Attachment[]`): The array of attachments from the message.

### `<MessageAttachment />`

If you want absolute control over the placement of individual attachments (e.g., interleaving them inside text), loop through `message.attachments` and use `MessageAttachment` to render each one individually. It will inspect the file's mime-type and render the appropriate internal module (e.g., `VideoAttachment`, `ImageAttachment`, `FileAttachment`).

```tsx
import { MessageAttachment } from '@ermis-network/ermis-chat-react';

// Inside your custom message renderer loop:
<MessageAttachment attachment={singleAttachmentObject} />
```

---

## Overriding Polls or Signals

Many advanced applications use conversational chat APIs to exchange realtime telemetry (`signal`), or complex user choice menus (`poll`). In these workflows, the message usually contains a JSON payload in its metadata, which you can extract and build an interface out of.

```tsx
const CustomPollRenderer = ({ message, isOwnMessage }: MessageRendererProps) => {
  const choices = message.poll_choices || [];
  
  return (
    <div className="custom-poll-card">
      <h4>{message.text}</h4>
      {choices.map((option) => (
        <button key={option} onClick={() => alert(`Voted: ${option}`)}>
          {option}
        </button>
      ))}
    </div>
  );
};

export const ChannelMessages = () => (
  <VirtualMessageList messageRenderers={{ poll: CustomPollRenderer }} />
);
```

By keeping rendering partitioned like this, you ensure that structural features like unread counting, scrolling, and memory virtualization remain completely functional, while you enjoy total freedom over pixel-perfect component injection inside the chat stream.
