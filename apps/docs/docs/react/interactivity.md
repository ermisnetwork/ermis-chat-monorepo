---
sidebar_position: 7
---

# Message Interactivity

Ermis Chat React comes pre-packaged with a complete suite of messaging features including reactions, message actions (Edit, Copy, Delete), replies/quotes, and forwarding. 

This document explains how these interactivity modules behave natively and how you can override them.

## Message Actions

Every message rendered in `<VirtualMessageList />` features a **Message Actions Box**, typically visible on hover or mobile long-press contexts.

### Actions Supported:
By default, the UI Kit authorizes the following interactions based on the user's role mapping via the internal hook `useMessageActions`:
- **Copy**: Raw text copy to clipboard.
- **Reply**: Triggers a quote into the `MessageInput` buffer.
- **Pin/Unpin**: Promotes the targeted message globally.
- **Edit**: Transitions the `MessageInput` into edit-mode.
- **Forward**: Opens the popup modal to distribute the message.
- **Delete for Everyone & Delete for Me**: Irreversibly deletes the targeted message based on the user's channel permissions.

### Overriding the Actions Box

You can completely replace the UI or alter which buttons appear by feeding a custom `MessageActionsBoxComponent` to the message list:

```tsx
import { VirtualMessageList } from '@ermis-network/ermis-chat-react';
import type { MessageActionsBoxProps } from '@ermis-network/ermis-chat-react';

const BaseCustomActions = (props: MessageActionsBoxProps) => {
   return (
      <div className="my-actions-menu">
         <button onClick={() => props.onReply?.(props.message)}>Reply</button>
         {(props.isOwnMessage || props.message.type === 'regular') && (
            <button onClick={() => props.onDelete?.(props.message)}>Delete</button>
         )}
      </div>
   );
};

// Injection into UI Kit
<VirtualMessageList MessageActionsBoxComponent={BaseCustomActions} />
```

---

## Message Reactions

Reactions allow users to drop emojis instantly on any message entity.

The SDK manages reactions via the `<MessageReactions />` and `<MessageQuickReactions />` components, computing real-time `reaction_counts` dictionaries seamlessly.

If you want to render reactions differently, pass a `MessageReactionsComponent` into `<VirtualMessageList />`. You get access to `reactionCounts`, `ownReactions`, and `latestReactions` to map out the UI accurately:

```tsx
import { VirtualMessageList } from '@ermis-network/ermis-chat-react';
import type { MessageReactionsProps } from '@ermis-network/ermis-chat-react';

const CustomReactions = ({ reactionCounts, ownReactions, onClickReaction }: MessageReactionsProps) => {
  if (!reactionCounts || Object.keys(reactionCounts).length === 0) return null;

  return (
    <div className="reaction-row">
       {Object.entries(reactionCounts).map(([type, count]) => {
          const isOwn = ownReactions?.some((r) => r.type === type);
          return (
            <span 
              key={type} 
              onClick={() => onClickReaction?.(type)}
              style={{ fontWeight: isOwn ? 'bold' : 'normal', cursor: 'pointer' }}
            >
               {type} {count}
            </span>
          );
       })}
    </div>
  );
};

export const MessagingView = () => (
   <VirtualMessageList MessageReactionsComponent={CustomReactions} />
);
```

---

## Quoted Replies 

When a user executes the **Reply** action, the target message cascades down into the `<MessageInput />` module, visually rendering as a `<ReplyPreview />`.

Upon sending, the sent message utilizes the `<QuotedMessagePreview />` inline component directly within the bounds of its message bubble body. Both layers accept overrides if your bespoke chat requires a drastically different structural layout for quoted replies.

```tsx
import { VirtualMessageList } from '@ermis-network/ermis-chat-react';
import type { QuotedMessagePreviewProps } from '@ermis-network/ermis-chat-react';

const CustomQuoteBlock = ({ quotedMessage, isOwnMessage, onClick }: QuotedMessagePreviewProps) => (
  <div 
    onClick={() => onClick(quotedMessage.id)} 
    className={`my-quote-block ${isOwnMessage ? 'own' : 'stranger'}`}
  >
     Replying to: {quotedMessage.text}
  </div>
);

export const MessagingView = () => (
   <VirtualMessageList QuotedMessagePreviewComponent={CustomQuoteBlock} />
);
```

---

## Forwarding Messages

Ermis Chat UI Kit ships with a highly integrated `<ForwardMessageModal />` that renders across the top navigation topology when a user attempts to forward media/messages to separate channels.

To override its physical form factor (e.g. implementing completely independent routing instead of a popup modal), pass `ForwardMessageModalComponent` directly onto the `<Channel />` context boundary.

```tsx
import { Channel } from '@ermis-network/ermis-chat-react';
import type { ForwardMessageModalProps } from '@ermis-network/ermis-chat-react';

const MyForwardModal = ({ message, onDismiss }: ForwardMessageModalProps) => (
  <div className="custom-forward-overlay">
     <h3>Forward Message Node: {message.id}</h3>
     {/* Your custom routing / search list */}
     <button onClick={onDismiss}>Cancel</button>
  </div>
);

// Inject at the Channel boundary
export const ChatArea = () => (
  <Channel ForwardMessageModalComponent={MyForwardModal}>
     {/* ... children ... */}
  </Channel>
);
```
