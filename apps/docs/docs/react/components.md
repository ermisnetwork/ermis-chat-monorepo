---
sidebar_position: 2
---

# Core Components

Ermis Chat React provides a set of highly customizable Core Components. The props below are directly mapped from the SDK's `types.ts` file to give you exhaustive control over overrides and behavior.

---

## `<ChatProvider />`

The top-level provider for the chat application. It manages the global state context and passes it down.

### Core Props

| Prop | Type | Description |
| ---- | ---- | ----------- |
| `client` | `ErmisChat` | The initialized SDK client instance. |
| `children` | `React.ReactNode` | Child components requiring context. |
| `initialTheme` | `'dark' \| 'light'` | Initial layout theme (default: `'dark'`). |

### Example

```tsx
import React, { useEffect, useState } from 'react';
import { ChatProvider } from '@ermis-network/ermis-chat-react';
import { ErmisChat } from '@ermis-network/ermis-chat-sdk';

export const AppBuilder = ({ userToken }) => {
  const [chatClient, setChatClient] = useState<ErmisChat | null>(null);

  useEffect(() => {
    const initClient = async () => {
      const client = new ErmisChat('API_KEY');
      await client.connectUser({ id: 'user-1' }, userToken);
      setChatClient(client);
    };
    initClient();
  }, [userToken]);

  if (!chatClient) return <p>Starting Ermis...</p>;

  return (
    <ChatProvider client={chatClient} initialTheme="light">
      <YourAppLayout />
    </ChatProvider>
  );
};
```

---

## `<ChannelList />`

Renders a list of available channels to select. Connects to socket events for realtime unread tracking.

### Core Configs

| Prop | Type | Description |
| ---- | ---- | ----------- |
| `filters` | `ChannelFilters` | Query filters to fetch specific channels. |
| `sort` | `ChannelSort` | Array defining sort priority. |
| `options` | `ChannelQueryOptions` | Additional query options. |
| `className` | `string` | Custom CSS wrapper class name. |
| `onChannelSelect` | `(channel: Channel) => void` | Event when user clicks a row. |

### Component Overrides

| Prop | Type | Description |
| ---- | ---- | ----------- |
| `renderChannel` | `(channel: Channel, isActive: boolean) => React.ReactNode` | Custom render mapped function. |
| `ChannelItemComponent` | `React.ComponentType<ChannelItemProps>` | Overrides the wrapper for a single row. |
| `AvatarComponent` | `React.ComponentType<AvatarProps>` | Overrides the default avatar element. |
| `LoadingIndicator` | `React.ComponentType<{ text?: string }>` | Custom loading spinner element. |
| `EmptyStateIndicator` | `React.ComponentType<{ text?: string }>` | Shown when network returns zero channels. |

### Localization (I18n)

| Prop | Type | Description |
| ---- | ---- | ----------- |
| `pendingInvitesLabel` | `string \| ((count: number) => string)` | Header for pending invites list. |
| `channelsLabel` | `string` | Header for approved channel list. |
| `pendingBadgeLabel` | `string` | Hover text for pending badge limit. |
| `blockedBadgeLabel` | `string` | Hover text for blocked channel indicator. |
| `loadingLabel` | `string` | Text string during network sync. |
| `emptyStateLabel` | `string` | Text string for empty channel results. |

### Example

```tsx
import { ChannelList } from '@ermis-network/ermis-chat-react';

export const MessagesSidebar = () => (
  <ChannelList 
    filters={{ type: 'messaging' }}
    sort={[{ last_message_at: -1 }]}
    emptyStateLabel="Try starting a conversation."
    onChannelSelect={(c) => console.log('Viewing:', c.id)}
  />
);
```

---

## `<Channel />`

Establishes the active isolated context. Any message lists or info panels placed inside `Channel` hook into this specific data stream.

### Props

| Prop | Type | Description |
| ---- | ---- | ----------- |
| `children` | `React.ReactNode` | List or Composer components rendering data. |
| `className` | `string` | Styles for outer layout wrapper. |
| `EmptyStateIndicator` | `React.ComponentType` | UI activated when `ChatContext.activeChannel` is null. |
| `HeaderComponent` | `React.ComponentType<ChannelHeaderData>` | Replaces default top action bar natively. |
| `ForwardMessageModalComponent` | `React.ComponentType<ForwardMessageModalProps>` | Used to replace the standard forwarding view. |

### Example

```tsx
import { Channel } from '@ermis-network/ermis-chat-react';

const BlockedLayout = () => <div className="p-10">Select a channel first.</div>;

export const ChatArea = () => (
  <Channel 
    className="h-full border-l border-gray-200"
    EmptyStateIndicator={BlockedLayout}
  >
    <div className="flex flex-col h-full overflow-hidden">
      {/* Insert message views here */}
    </div>
  </Channel>
);
```

---

## `<VirtualMessageList />`

Advanced engine for rendering real-time message feeds via infinite cursor virtualization. 

### Core Configs

| Prop | Type | Description |
| ---- | ---- | ----------- |
| `className` | `string` | Custom CSS wrapper class name. |
| `loadMoreLimit` | `number` | Messages retrieved per batch (default: 25). |
| `showPinnedMessages` | `boolean` | Display float banner for pinned text. |
| `showReadReceipts` | `boolean` | Enables rendering receipts under sent logs. |
| `readReceiptsMaxAvatars` | `number` | Truncation limit before displaying a number. |
| `showTypingIndicator` | `boolean` | Allows rendering animated typing nodes. |

### Component Overrides

| Prop | Type | Description |
| ---- | ---- | ----------- |
| `renderMessage` | `Function` | Default list elements bypass. |
| `AvatarComponent` | `React.ComponentType<AvatarProps>` | Override chat profile display component. |
| `MessageBubble` | `React.ComponentType<MessageBubbleProps>` | Padding wrapper around text bodies. |
| `messageRenderers` | `Partial<Record<MessageLabel, React.ComponentType<MessageRendererProps>>>` | Map distinct render components to types. |
| `DateSeparatorComponent` | `React.ComponentType<DateSeparatorProps>` | Divider block between target dates. |
| `MessageItemComponent` | `React.ComponentType<MessageItemProps>` | Whole element layout replacement. |
| `SystemMessageItemComponent` | `React.ComponentType<SystemMessageItemProps>` | Structural override for SDK driven system actions. |
| `JumpToLatestButton` | `React.ComponentType<JumpToLatestProps>` | Trigger floating scroll return element. |
| `QuotedMessagePreviewComponent` | `React.ComponentType<QuotedMessagePreviewProps>` | Inline reply reference node module. |
| `MessageActionsBoxComponent` | `React.ComponentType<MessageActionsBoxProps>` | Element tracking interactions. |
| `PinnedMessagesComponent` | `React.ComponentType<any>` | Replaces sticky header entirely. |
| `ReplyPreviewComponent` | `React.ComponentType<ReplyPreviewProps>` | Element displayed over composer. |
| `ReadReceiptsComponent` | `React.ComponentType<ReadReceiptsProps>` | Block spanning active view status checks. |
| `ReadReceiptsTooltipComponent` | `React.ComponentType<ReadReceiptsTooltipProps>` | Visual float tracking read timelines. |
| `TypingIndicatorComponent` | `React.ComponentType` | Loader elements reflecting incoming keystrokes. |
| `MessageReactionsComponent` | `React.ComponentType<MessageReactionsProps>` | Interactive emoji tag list wrapper. |
| `EmptyStateIndicator` | `React.ComponentType` | Graphic displayed prior to starting discussion. |

### Localization (I18n)

| Prop | Type | Description |
| ---- | ---- | ----------- |
| `emptyTitle` | `string` | Label for header. |
| `emptySubtitle` | `string` | Label for helper text. |
| `jumpToLatestLabel` | `string` | Label triggering downward scroll. |
| `bannedOverlayTitle` | `string` | Label for sanction headline. |
| `bannedOverlaySubtitle` | `string` | Label for sanction explanation. |
| `blockedOverlayTitle` | `string` | Label for blocked element. |
| `blockedOverlaySubtitle` | `string` | Label for blocked details. |
| `pendingOverlayTitle` | `string` | Label for invite screen. |
| `pendingOverlaySubtitle` | `string` | Label for invite helper. |
| `pendingAcceptLabel` | `string` | Label for affirmative selection. |
| `pendingRejectLabel` | `string` | Label for negative selection. |

### Example

```tsx
import { VirtualMessageList, useChatContext } from '@ermis-network/ermis-chat-react';

const SpecialMessageBubble = ({ message, isOwnMessage, children }) => (
  <div className={`p-4 mt-2 max-w-[80%] rounded-[20px] ${isOwnMessage ? 'bg-green-500 text-white rounded-tr-none self-end' : 'bg-gray-100 rounded-tl-none self-start'}`}>
    {children}
    <p className="text-[10px] opacity-70 mt-1">{new Date(message.created_at).toLocaleTimeString()}</p>
  </div>
);

export const LiveFeed = () => (
  <VirtualMessageList 
    loadMoreLimit={50}
    showReadReceipts={true}
    emptyTitle="Crickets... 🦗"
    MessageBubble={SpecialMessageBubble}
  />
);
```

---

## `<MessageInput />`

The central textbox element orchestration supporting file drops, mentions, and editing logic.

### Core Configs

| Prop | Type | Description |
| ---- | ---- | ----------- |
| `placeholder` | `string` | Textbox default string hint. |
| `className` | `string` | Styles for module wrapper block. |
| `disableAttachments` | `boolean` | Deactivates UI and logic for adding objects. |
| `disableMentions` | `boolean` | Stops detection algorithms monitoring tags. |
| `onSend` | `(text: string) => void` | Event triggered after sending. |
| `onBeforeSend` | `(text: string, attachments: FilePreviewItem[]) => boolean \| Promise<boolean>` | Functional interceptor allowing cancellation validation routines safely. |
| `renderAbove` | `() => React.ReactNode` | Extends layout vertically over input. |

### UI Components

| Prop | Type | Description |
| ---- | ---- | ----------- |
| `SendButton` | `React.ComponentType<SendButtonProps>` | Replace standard send symbol. |
| `AttachButton` | `React.ComponentType<AttachButtonProps>` | Replace standard clip symbol. |
| `FilesPreviewComponent` | `React.ComponentType<FilesPreviewProps>` | Render queued elements prior to request submission. |
| `MentionSuggestionsComponent`| `React.ComponentType<MentionSuggestionsProps>` | Replace default floating array container. |
| `EmojiPickerComponent` | `React.ComponentType<EmojiPickerProps>` | Extensible block linking custom vendor keyboards. |
| `EmojiButtonComponent` | `React.ComponentType<EmojiButtonProps>` | Triggers expanding smileys widget externally. |
| `ReplyPreviewComponent`| `React.ComponentType<ReplyPreviewProps>` | Inline container displaying tracked message references. |
| `EditPreviewComponent` | `React.ComponentType<{ message: FormatMessageResponse, onDismiss: () => void, editingMessageLabel?: string }>` | Interface appearing during inline structural modification tasks. |

### Localization (I18n) & Errors

| Prop | Type | Description |
| ---- | ---- | ----------- |
| `bannedLabel` | `string` | Label alerting active lockouts. |
| `blockedLabel` | `string` | Label confirming severed connection. |
| `linksDisabledLabel`| `string` | Notification when regex disables URL strings. |
| `keywordBlockedLabel`| `(match: string) => string` | Return parameter evaluating forbidden values. |
| `sendDisabledLabel` | `string` | String output reflecting disabled status. |
| `slowModeLabel` | `(cooldown: number) => React.ReactNode` | String indicating active throttling measures globally. |

### Example

```tsx
import { MessageInput } from '@ermis-network/ermis-chat-react';

export const SmartComposer = () => (
  <MessageInput 
    placeholder="Write your message here..."
    onBeforeSend={async (text, attachments) => {
      if (text.toLowerCase().includes("spam")) {
        alert("This message looks like spam, you cannot send it.");
        return false;
      }
      return true; // OK to proceed
    }}
  />
);
```

---

## `<ChannelInfo />`

The orchestration component for Right-sidebar drawer configurations. Driving internal forms handling profile updates, grids, and roles.

### Core Configs & Listeners

| Prop | Type | Description |
| ---- | ---- | ----------- |
| `channel` | `Channel` | Overwrites inherited object node globally. |
| `className` | `string` | Style injections for module framework. |
| `title` | `string` | Static string overriding main navigation text. |
| `onClose` | `() => void` | Event mapping standard overlay disposal clicks. |
| `onSearchClick` | `() => void` | Event redirecting control toward custom panel. |
| `onLeaveChannel` | `() => void` | Fires executing logic. |
| `onDeleteChannel` | `() => void` | Functional removal executed. |
| `onAddMemberClick` | `() => void` | Method bypassing built-in array expansion nodes. |
| `onRemoveMember` | `(id: string) => void` | Validation trigger intercepting deletions. |
| `onBanMember` | `(id: string) => void` | Intercepts administration control elements. |
| `onUnbanMember` | `(id: string) => void` | Rescinds tracking flags programmatically. |
| `onPromoteMember` | `(id: string) => void` | Evaluates moderator flag additions. |
| `onDemoteMember` | `(id: string) => void` | Lowers metric parameters correctly. |
| `onBlockUser` | `() => void` | Rejects connection. |
| `onUnblockUser` | `() => void` | Resolves connection. |
| `onEditChannel` | `(data: EditChannelData) => Promise<void>` | Callback processing input text before patching server nodes. |

### Component Overrides

| Prop | Type | Description |
| ---- | ---- | ----------- |
| `AvatarComponent` | `React.ComponentType<AvatarProps>` | Override graphic map. |
| `HeaderComponent` | `React.ComponentType<ChannelInfoHeaderProps>` | Bypass navigation elements directly. |
| `CoverComponent` | `React.ComponentType<ChannelInfoCoverProps>` | Renders large graphic profile banners. |
| `ActionsComponent` | `React.ComponentType<ChannelInfoActionsProps>` | Replaces default functional trigger elements natively. |
| `TabsComponent` | `React.ComponentType<ChannelInfoTabsProps>` | Updates layout displaying media toggle logic intuitively. |
| `AddMemberModalComponent` | `React.ComponentType<AddMemberModalProps>` | Injects external popup architecture visually completely. |
| `EditChannelModalComponent` | `React.ComponentType<EditChannelModalProps>` | Allows specific control over update displays externally. |
| `MemberItemComponent` | `React.ComponentType<ChannelInfoMemberItemProps>` | Evaluates user rendering inside mapping objects dynamically. |
| `MediaItemComponent` | `React.ComponentType<ChannelInfoMediaItemProps>` | Structure formatting grid photos individually. |
| `LinkItemComponent` | `React.ComponentType<ChannelInfoLinkItemProps>` | Display layout extracting URLs intelligently. |
| `FileItemComponent` | `React.ComponentType<ChannelInfoFileItemProps>` | Maps download elements flawlessly. |
| `EmptyStateComponent` | `React.ComponentType<ChannelInfoEmptyStateProps>` | Fills grids holding empty definitions organically. |
| `LoadingComponent` | `React.ComponentType` | Overload standard graphic spinning loops manually. |
| `AddMemberButtonComponent`| `React.ComponentType<AddMemberButtonProps>` | Standard explicit interaction icon completely. |

### Add Member Localization

| Prop | Type | Description |
| ---- | ---- | ----------- |
| `addMemberModalTitle` | `string` | Header string. |
| `addMemberSearchPlaceholder` | `string` | Blank explicit text. |
| `addMemberLoadingText` | `string` | Status tag element. |
| `addMemberEmptyText` | `string` | Zero match prompt. |
| `addMemberAddLabel` | `string` | Standard action button. |
| `addMemberAddingLabel` | `string` | Dynamic toggle state. |
| `addMemberAddedLabel` | `string` | Static check graphic. |
| `addMemberButtonLabel` | `string` | List head parameter. |

### Edit Channel Localization

| Prop | Type | Description |
| ---- | ---- | ----------- |
| `editChannelModalTitle` | `string` | Header label object. |
| `editChannelNameLabel` | `string` | Label above channel name field. |
| `editChannelDescriptionLabel`| `string` | Label above channel description field. |
| `editChannelNamePlaceholder` | `string` | Visual blank string literal. |
| `editChannelDescriptionPlaceholder` | `string` | Target context neatly rendering element. |
| `editChannelPublicLabel` | `string` | Toggle tag identifier. |
| `editChannelSaveLabel` | `string` | Action confirm prompt. |
| `editChannelCancelLabel` | `string` | Abort sequence trigger. |
| `editChannelSavingLabel` | `string` | Loading state alert. |
| `editChannelChangeAvatarLabel`| `string` | Upload button identifier. |
| `editChannelImageAccept` | `string` | HTML accept attribute. |
| `editChannelMaxImageSize` | `number` | File truncation threshold. |
| `editChannelMaxImageSizeError`| `string` | Warning notification value. |

### General Context Localization

| Prop | Type | Description |
| ---- | ---- | ----------- |
| `actionsSearchLabel` | `string` | Menu action label. |
| `actionsSettingsLabel` | `string` | Configuration tag text. |
| `actionsDeleteLabel` | `string` | Warning action item. |
| `actionsLeaveLabel` | `string` | Logout list element. |
| `actionsBlockLabel` | `string` | Security constraint alert. |
| `actionsUnblockLabel` | `string` | Rescind security notification. |

### Example

```tsx
import { ChannelInfo } from '@ermis-network/ermis-chat-react';

export const SettingsSidebar = () => (
  <ChannelInfo 
    title="Overview"
    onClose={() => console.log('Close clicked')}
    actionsSearchLabel="Find Messages"
    onLeaveChannel={() => alert("Are you sure you want to exit?")}
  />
);
```
