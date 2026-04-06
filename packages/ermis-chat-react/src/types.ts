import type { FormatMessageResponse, MessageLabel, Attachment, Channel, ChannelFilters, ChannelSort, ChannelQueryOptions } from '@ermis-network/ermis-chat-sdk';
import type { ErmisChat } from '@ermis-network/ermis-chat-sdk';

/* ----------------------------------------------------------
   Context types
   ---------------------------------------------------------- */
export type Theme = 'dark' | 'light';

export type ReadStateEntry = {
  last_read: Date | string;
  last_read_message_id?: string;
  unread_messages: number;
  user: {
    id: string;
    name?: string;
    avatar?: string;
  };
  last_send?: string;
};

export type ChatContextValue = {
  client: ErmisChat;
  activeChannel: Channel | null;
  setActiveChannel: (channel: Channel | null) => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  messages: FormatMessageResponse[];
  setMessages: React.Dispatch<React.SetStateAction<FormatMessageResponse[]>>;
  /** Re-read messages from SDK state into React state */
  syncMessages: () => void;
  /** Message being replied to (shown as preview in MessageInput) */
  quotedMessage: FormatMessageResponse | null;
  setQuotedMessage: (message: FormatMessageResponse | null) => void;
  /** Message being edited (shown as preview in MessageInput and alters send behavior) */
  editingMessage: FormatMessageResponse | null;
  setEditingMessage: (message: FormatMessageResponse | null) => void;
  /** Read state per user — maps userId to their read status */
  readState: Record<string, ReadStateEntry>;
  setReadState: React.Dispatch<React.SetStateAction<Record<string, ReadStateEntry>>>;
  /** Message being forwarded (triggers ForwardMessageModal) */
  forwardingMessage: FormatMessageResponse | null;
  setForwardingMessage: (message: FormatMessageResponse | null) => void;
};

export type ChatProviderProps = {
  client: ErmisChat;
  children: React.ReactNode;
  /** Initial theme, defaults to 'dark' */
  initialTheme?: Theme;
};

/* ----------------------------------------------------------
   Avatar types
   ---------------------------------------------------------- */
export type AvatarProps = {
  /** Image URL */
  image?: string | null;
  /** Name used for fallback initials */
  name?: string;
  /** Size in pixels (default: 36) */
  size?: number;
  /** Additional CSS class name */
  className?: string;
};

/* ----------------------------------------------------------
   Channel types
   ---------------------------------------------------------- */
export type ChannelProps = {
  children: React.ReactNode;
  /** Additional CSS class name */
  className?: string;
  /** Custom component shown when no channel is selected */
  EmptyStateIndicator?: React.ComponentType;
  /** Replace the default ChannelHeader entirely */
  HeaderComponent?: React.ComponentType<ChannelHeaderData>;
  /** Replace the default ForwardMessageModal entirely */
  ForwardMessageModalComponent?: React.ComponentType<ForwardMessageModalProps>;
};

export type ChannelHeaderProps = {
  /** Additional CSS class name */
  className?: string;
  /** Custom avatar component */
  AvatarComponent?: React.ComponentType<AvatarProps>;
  /** Override channel name */
  title?: string;
  /** Override channel image */
  image?: string;
  /** Subtitle text (e.g. member count, online status) */
  subtitle?: string;
  /** Render custom content on the right side */
  renderRight?: (channel: Channel) => React.ReactNode;
  /** Override default title rendering */
  renderTitle?: (channel: Channel) => React.ReactNode;
};

/** Data passed to a fully custom HeaderComponent */
export type ChannelHeaderData = {
  channel: Channel;
  name: string;
  image?: string;
};

/* ----------------------------------------------------------
   ChannelList types
   ---------------------------------------------------------- */
export type ChannelItemProps = {
  channel: Channel;
  isActive: boolean;
  hasUnread: boolean;
  unreadCount: number;
  lastMessageText: string;
  lastMessageUser: string;
  onSelect: (channel: Channel) => void;
  AvatarComponent: React.ComponentType<AvatarProps>;
};

export type ChannelListProps = {
  filters?: ChannelFilters;
  sort?: ChannelSort;
  options?: ChannelQueryOptions;
  renderChannel?: (channel: Channel, isActive: boolean) => React.ReactNode;
  onChannelSelect?: (channel: Channel) => void;
  className?: string;
  LoadingIndicator?: React.ComponentType;
  EmptyStateIndicator?: React.ComponentType;
  AvatarComponent?: React.ComponentType<AvatarProps>;
  /** Replace the default channel list item component */
  ChannelItemComponent?: React.ComponentType<ChannelItemProps>;
};

/* ----------------------------------------------------------
   MessageRenderers types
   ---------------------------------------------------------- */
export type AttachmentProps = {
  attachment: Attachment;
};

export type MessageRendererProps = {
  message: FormatMessageResponse;
  isOwnMessage: boolean;
};

export type MessageBubbleProps = {
  message: FormatMessageResponse;
  isOwnMessage: boolean;
  children: React.ReactNode;
};

export type DateSeparatorProps = {
  label: string;
};

export type JumpToLatestProps = {
  onClick: () => void;
};

/* ----------------------------------------------------------
   MessageList types
   ---------------------------------------------------------- */
export type MessageListProps = {
  /** Fully custom render for each message */
  renderMessage?: (message: FormatMessageResponse, isOwnMessage: boolean) => React.ReactNode;
  /** Additional CSS class name */
  className?: string;
  /** Custom empty state component */
  EmptyStateIndicator?: React.ComponentType;
  /** Custom avatar component */
  AvatarComponent?: React.ComponentType<AvatarProps>;
  /** Custom message bubble wrapper */
  MessageBubble?: React.ComponentType<MessageBubbleProps>;
  /** Custom renderers per message type */
  messageRenderers?: Partial<Record<MessageLabel, React.ComponentType<MessageRendererProps>>>;
  /** Number of older messages to load per page (default: 25) */
  loadMoreLimit?: number;
  /** Custom date separator component */
  DateSeparatorComponent?: React.ComponentType<DateSeparatorProps>;
  /** Custom message item component (replaces the entire row) */
  MessageItemComponent?: React.ComponentType<MessageItemProps>;
  /** Custom system message item component */
  SystemMessageItemComponent?: React.ComponentType<SystemMessageItemProps>;
  /** Custom "Jump to latest" button */
  JumpToLatestButton?: React.ComponentType<JumpToLatestProps>;
  /** Custom quoted message preview inside message items */
  QuotedMessagePreviewComponent?: React.ComponentType<QuotedMessagePreviewProps>;
  /** Custom message actions component (hover buttons + dropdown) */
  MessageActionsBoxComponent?: React.ComponentType<MessageActionsBoxProps>;
  /** Show pinned messages bar (default: true) */
  showPinnedMessages?: boolean;
  /** Custom pinned messages component */
  PinnedMessagesComponent?: React.ComponentType<any>;
  /** Custom reply preview component in MessageInput */
  ReplyPreviewComponent?: React.ComponentType<ReplyPreviewProps>;
  /** Show read receipts (default: true) */
  showReadReceipts?: boolean;
  /** Custom read receipts component (replaces the entire read-receipts row) */
  ReadReceiptsComponent?: React.ComponentType<ReadReceiptsProps>;
  /** Custom read receipts tooltip component */
  ReadReceiptsTooltipComponent?: React.ComponentType<ReadReceiptsTooltipProps>;
  /** Max visible avatars in read receipts before showing +N (default: 5) */
  readReceiptsMaxAvatars?: number;
  /** Show typing indicator (default: true) */
  showTypingIndicator?: boolean;
  /** Custom typing indicator component */
  TypingIndicatorComponent?: React.ComponentType;
  /** Custom component for message reactions */
  MessageReactionsComponent?: React.ComponentType<MessageReactionsProps>;
};

/* ----------------------------------------------------------
   Message Reactions types
   ---------------------------------------------------------- */
export type ReactionUser = {
  id: string;
  name?: string;
  avatar?: string;
};

export type LatestReaction = {
  user: ReactionUser;
  type: string;
};

export type MessageReactionsProps = {
  /** Map of reaction type to count */
  reactionCounts?: Record<string, number>;
  /** Array of current user's reactions */
  ownReactions?: LatestReaction[];
  /** Array of latest reactions to show in tooltip/hover */
  latestReactions?: LatestReaction[];
  /** Avatar Component if consumer wants to use it in tooltips */
  AvatarComponent?: React.ComponentType<AvatarProps>;
  /** Callback when clicking a reaction */
  onClickReaction?: (type: string) => void;
};

/* ----------------------------------------------------------
   ReadReceipts types
   ---------------------------------------------------------- */
export type ReadReceiptUser = {
  id: string;
  name?: string;
  avatar?: string;
  last_read?: Date | string;
};

export type ReadReceiptsTooltipProps = {
  /** All users who have read this message */
  readers: ReadReceiptUser[];
  /** Avatar component for rendering user avatars */
  AvatarComponent: React.ComponentType<AvatarProps>;
};

export type ReadReceiptsProps = {
  /** Users who have read the message */
  readers: ReadReceiptUser[];
  /** Max number of visible avatars before showing +N overflow (default: 5) */
  maxAvatars?: number;
  /** Avatar component for rendering user avatars */
  AvatarComponent: React.ComponentType<AvatarProps>;
  /** Custom tooltip component */
  TooltipComponent?: React.ComponentType<ReadReceiptsTooltipProps>;
  /** Whether to show the tooltip on hover (default: true) */
  showTooltip?: boolean;
  /** Whether the message belongs to the current user (used to show 'Sent/Delivered' status when nobody has read it) */
  isOwnMessage?: boolean;
  /** Whether the message is the last in a group of consecutive messages by the same user */
  isLastInGroup?: boolean;
  /** The message status (e.g., 'sending', 'failed', 'sent') */
  status?: string;
};

/* ----------------------------------------------------------
   MessageItem types
   ---------------------------------------------------------- */
export type MessageItemProps = {
  message: FormatMessageResponse;
  isOwnMessage: boolean;
  isFirstInGroup: boolean;
  isLastInGroup: boolean;
  isHighlighted: boolean;
  AvatarComponent: React.ComponentType<AvatarProps>;
  MessageBubble: React.ComponentType<MessageBubbleProps>;
  MessageRenderer: React.ComponentType<MessageRendererProps>;
  onClickQuote?: (messageId: string) => void;
  /** Custom quoted message preview component */
  QuotedMessagePreviewComponent?: React.ComponentType<QuotedMessagePreviewProps>;
  /** Custom message actions component (hover buttons + dropdown) */
  MessageActionsBoxComponent?: React.ComponentType<MessageActionsBoxProps>;
  /** Users who have read up to this message */
  readBy?: Array<{ id: string; name?: string; avatar?: string }>;
  /** Custom component for message reactions */
  MessageReactionsComponent?: React.ComponentType<MessageReactionsProps>;
};

export type SystemMessageItemProps = {
  message: FormatMessageResponse;
  isOwnMessage: boolean;
  SystemRenderer: React.ComponentType<MessageRendererProps>;
};

export type SendButtonProps = { disabled: boolean; onClick: () => void };
export type AttachButtonProps = { disabled: boolean; onClick: () => void };

/** Props passed to a consumer-provided emoji picker component */
export type EmojiPickerProps = {
  /** Called when user selects an emoji — insert the emoji string into the input */
  onSelect: (emoji: string) => void;
  /** Called when the picker should close (e.g. click outside) */
  onClose: () => void;
};

/** Props passed to the emoji button component */
export type EmojiButtonProps = {
  /** Whether the picker is currently open */
  active: boolean;
  /** Toggle the picker */
  onClick: () => void;
};

export type MessageInputProps = {
  /** Placeholder text */
  placeholder?: string;
  /** Callback after message is sent */
  onSend?: (text: string) => void;
  /** Additional CSS class name */
  className?: string;
  /** Custom send button component */
  SendButton?: React.ComponentType<SendButtonProps>;
  /** Custom attach button component */
  AttachButton?: React.ComponentType<AttachButtonProps>;
  /** Custom file preview component */
  FilesPreviewComponent?: React.ComponentType<FilesPreviewProps>;
  /** Custom mention suggestions component */
  MentionSuggestionsComponent?: React.ComponentType<MentionSuggestionsProps>;
  /** Disable file attachments entirely */
  disableAttachments?: boolean;
  /** Disable @mention suggestions (overrides auto-detection) */
  disableMentions?: boolean;
  /** Render custom content above the input row (e.g. reply preview) */
  renderAbove?: () => React.ReactNode;
  /** Hook called before sending — return false to cancel */
  onBeforeSend?: (text: string, attachments: FilePreviewItem[]) => boolean | Promise<boolean>;
  /** Consumer-provided emoji picker component (not bundled — bring your own) */
  EmojiPickerComponent?: React.ComponentType<EmojiPickerProps>;
  /** Custom emoji button component (defaults to 😀 toggle button) */
  EmojiButtonComponent?: React.ComponentType<EmojiButtonProps>;
  /** Custom reply preview component */
  ReplyPreviewComponent?: React.ComponentType<ReplyPreviewProps>;
  /** Custom edit preview component */
  EditPreviewComponent?: React.ComponentType<{ message: FormatMessageResponse; onDismiss: () => void }>;
};

/* ----------------------------------------------------------
   ReplyPreview types
   ---------------------------------------------------------- */
export type ReplyPreviewProps = {
  message: FormatMessageResponse;
  onDismiss: () => void;
};

/* ----------------------------------------------------------
   Message Actions Box types
   ---------------------------------------------------------- */
export type MessageActionsBoxProps = {
  message: FormatMessageResponse;
  isOwnMessage: boolean;
  onReply?: (message: FormatMessageResponse) => void;
  onForward?: (message: FormatMessageResponse) => void;
  onPinToggle?: (message: FormatMessageResponse, isPinned: boolean) => void;
  onEdit?: (message: FormatMessageResponse) => void;
  onCopy?: (message: FormatMessageResponse) => void;
  onDelete?: (message: FormatMessageResponse) => void;
  onDeleteForMe?: (message: FormatMessageResponse) => void;
};

/* ----------------------------------------------------------
   Forward Message Modal types
   ---------------------------------------------------------- */
export type ForwardChannelItemProps = {
  channel: Channel;
  selected: boolean;
  onToggle: (channel: Channel) => void;
  AvatarComponent: React.ComponentType<AvatarProps>;
};

export type ForwardMessageModalProps = {
  message: FormatMessageResponse;
  onDismiss: () => void;
  /** Custom channel list item for the picker */
  ChannelItemComponent?: React.ComponentType<ForwardChannelItemProps>;
  /** Custom search input component */
  SearchInputComponent?: React.ComponentType<{ value: string; onChange: (v: string) => void }>;
};

/* ----------------------------------------------------------
   Pinned Messages types
   ---------------------------------------------------------- */
export type PinnedMessageItemProps = {
  message: FormatMessageResponse;
  isOwnMessage: boolean;
  onClickMessage?: (messageId: string) => void;
  onUnpin?: (messageId: string) => void;
  AvatarComponent: React.ComponentType<AvatarProps>;
};

export type PinnedMessagesProps = {
  /** Additional CSS class name */
  className?: string;
  /** Custom avatar component */
  AvatarComponent?: React.ComponentType<AvatarProps>;
  /** Custom pinned message item component */
  PinnedMessageItemComponent?: React.ComponentType<PinnedMessageItemProps>;
  /** Callback when a pinned message is clicked (e.g. scroll to it) */
  onClickMessage?: (messageId: string) => void;
  /** Max messages to show in collapsed state (default: 1) */
  maxCollapsed?: number;
};

/* ----------------------------------------------------------
   QuotedMessagePreview types
   ---------------------------------------------------------- */
export type QuotedMessagePreviewProps = {
  /** The quoted (replied-to) message object */
  quotedMessage: {
    id: string;
    text?: string;
    user?: { id?: string; name?: string };
  };
  /** Whether the parent message is from the current user */
  isOwnMessage: boolean;
  /** Callback when the quote box is clicked */
  onClick: (messageId: string) => void;
};

/* ----------------------------------------------------------
   MentionSuggestions types
   ---------------------------------------------------------- */
export type MentionSuggestionsProps = {
  members: MentionMember[];
  highlightIndex: number;
  onSelect: (member: MentionMember) => void;
};

/* ----------------------------------------------------------
   useChannel types
   ---------------------------------------------------------- */
export type UseChannelReturn = {
  channel: Channel | null;
  loading: boolean;
  error: Error | null;
};

/* ----------------------------------------------------------
   Mention types
   ---------------------------------------------------------- */
export type MentionMember = {
  id: string;
  name: string;
  avatar?: string;
};

export type MentionPayload = {
  text: string;
  mentioned_all: boolean;
  mentioned_users: string[];
};

export type UseMentionsOptions = {
  members: MentionMember[];
  currentUserId?: string;
  editableRef: React.RefObject<HTMLDivElement | null>;
};

export type UseMentionsReturn = {
  showSuggestions: boolean;
  filteredMembers: MentionMember[];
  highlightIndex: number;
  /** Call on each input event of the contenteditable */
  handleInput: () => void;
  /** Call on keydown. Returns true if the event was consumed (e.g. Enter for selection). */
  handleKeyDown: (e: React.KeyboardEvent) => boolean;
  /** Select a member from the suggestion list */
  selectMention: (member: MentionMember) => void;
  /** Build the payload from the contenteditable DOM */
  buildPayload: () => MentionPayload;
  /** Reset mention state (call after send) */
  reset: () => void;
};

/* ----------------------------------------------------------
   File preview types (upload attachments)
   ---------------------------------------------------------- */
export type FilePreviewItem = {
  /** Unique ID for keying */
  id: string;
  /** Original File object (optional for existing server attachments) */
  file?: File;
  /** Blob URL for image/video preview */
  previewUrl?: string;
  /** Upload status */
  status: 'pending' | 'uploading' | 'done' | 'error';
  /** Error message if upload failed */
  error?: string;
  /** URL returned after successful upload */
  uploadedUrl?: string;
  /** Thumbnail URL (video only) */
  thumbUrl?: string;
  /** File with normalized name */
  normalizedFile?: File;
  /** Track original attachments during edits */
  originalAttachment?: Attachment;
};

export type FilesPreviewProps = {
  files: FilePreviewItem[];
  onRemove: (id: string) => void;
};

/* ----------------------------------------------------------
   Channel Info types
   ---------------------------------------------------------- */

/** Attachment item from the channel attachment query API */
export type AttachmentItem = {
  id: string;
  attachment_type: string;
  user_id: string;
  cid: string;
  url: string;
  thumb_url: string;
  file_name: string;
  content_type: string;
  content_length: number;
  content_disposition: string;
  message_id: string;
  created_at: string;
  updated_at: string;
  // for link previews
  title?: string;
  title_link?: string;
  og_scrape_url?: string;
  image_url?: string;
  text?: string;
};

export type MediaTab = 'members' | 'media' | 'links' | 'files';

/* Sub-component prop types for consumer customization */

export type ChannelInfoMemberItemProps = {
  member: ChannelInfoMember;
  AvatarComponent: React.ComponentType<AvatarProps>;
  onRemove?: (id: string) => void;
  canRemove?: boolean;
};

export type ChannelInfoMediaItemProps = {
  item: AttachmentItem;
  onClick: (url: string) => void;
};

export type ChannelInfoLinkItemProps = {
  item: AttachmentItem;
};

export type ChannelInfoFileItemProps = {
  item: AttachmentItem;
  onClick: (url: string) => void;
};

export type ChannelInfoEmptyStateProps = {
  label: string;
};

/* Section component prop types */

export type ChannelInfoHeaderProps = {
  title: string;
  onClose?: () => void;
};

export type ChannelInfoCoverProps = {
  channelName: string;
  channelImage?: string;
  channelDescription?: string;
  AvatarComponent: React.ComponentType<AvatarProps>;
};

export type ChannelInfoActionsProps = {
  onMuteToggle?: () => void;
  onSearchClick?: () => void;
  onLeaveChannel?: () => void;
  onDeleteChannel?: () => void;
  isTeamChannel?: boolean;
  currentUserRole?: string;
};

export type ChannelInfoMember = {
  id: string;
  name?: string;
  avatar?: string;
  [key: string]: any;
};

export type ChannelInfoTabsProps = {
  channel: Channel;
  members: ChannelInfoMember[];
  AvatarComponent: React.ComponentType<AvatarProps>;
  currentUserId?: string;
  currentUserRole?: string;
  onAddMemberClick?: () => void;
  onRemoveMember?: (id: string) => void;

  /** Custom sub-component overrides */
  MemberItemComponent?: React.ComponentType<ChannelInfoMemberItemProps>;
  MediaItemComponent?: React.ComponentType<ChannelInfoMediaItemProps>;
  LinkItemComponent?: React.ComponentType<ChannelInfoLinkItemProps>;
  FileItemComponent?: React.ComponentType<ChannelInfoFileItemProps>;
  EmptyStateComponent?: React.ComponentType<ChannelInfoEmptyStateProps>;
  LoadingComponent?: React.ComponentType;
};

export type ChannelInfoProps = {
  /** Optional channel override. Defaults to activeChannel from context */
  channel?: Channel;
  /** Additional CSS class */
  className?: string;
  /** Custom avatar component */
  AvatarComponent?: React.ComponentType<AvatarProps>;
  /** Optional callback when the user clicks a close button */
  onClose?: () => void;
  /** Custom Title String for the banner */
  title?: string;

  /** Custom components to replace internal sections */
  HeaderComponent?: React.ComponentType<ChannelInfoHeaderProps>;
  CoverComponent?: React.ComponentType<ChannelInfoCoverProps>;
  ActionsComponent?: React.ComponentType<ChannelInfoActionsProps>;
  TabsComponent?: React.ComponentType<ChannelInfoTabsProps>;

  /** Custom sub-component overrides (passed through to TabsComponent) */
  MemberItemComponent?: React.ComponentType<ChannelInfoMemberItemProps>;
  MediaItemComponent?: React.ComponentType<ChannelInfoMediaItemProps>;
  LinkItemComponent?: React.ComponentType<ChannelInfoLinkItemProps>;
  FileItemComponent?: React.ComponentType<ChannelInfoFileItemProps>;
  EmptyStateComponent?: React.ComponentType<ChannelInfoEmptyStateProps>;
  LoadingComponent?: React.ComponentType;

  /** Action callbacks */
  onMuteToggle?: () => void;
  onSearchClick?: () => void;
  onLeaveChannel?: () => void;
  onDeleteChannel?: () => void;
  onAddMemberClick?: () => void;
  onRemoveMember?: (id: string) => void;
};

