import type { FormatMessageResponse, MessageLabel, Attachment, Channel } from '@ermis-network/ermis-chat-sdk';
import type { ErmisChat } from '@ermis-network/ermis-chat-sdk';

/* ----------------------------------------------------------
   Context types
   ---------------------------------------------------------- */
export type Theme = 'dark' | 'light';

export type ChatContextValue = {
  client: ErmisChat;
  activeChannel: Channel | null;
  setActiveChannel: (channel: Channel | null) => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
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
};

export type ChannelHeaderProps = {
  /** Additional CSS class name */
  className?: string;
  /** Custom avatar component */
  AvatarComponent?: React.ComponentType<AvatarProps>;
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
  filters?: any;
  sort?: any[];
  options?: { message_limit?: number };
  renderChannel?: (channel: Channel, isActive: boolean) => React.ReactNode;
  onChannelSelect?: (channel: Channel) => void;
  className?: string;
  LoadingIndicator?: React.ComponentType;
  EmptyStateIndicator?: React.ComponentType;
  AvatarComponent?: React.ComponentType<AvatarProps>;
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

/* ----------------------------------------------------------
   MessageList types
   ---------------------------------------------------------- */
export type MessageListProps = {
  renderMessage?: (message: FormatMessageResponse, isOwnMessage: boolean) => React.ReactNode;
  className?: string;
  EmptyStateIndicator?: React.ComponentType;
  AvatarComponent?: React.ComponentType<AvatarProps>;
  MessageBubble?: React.ComponentType<MessageBubbleProps>;
  messageRenderers?: Partial<Record<MessageLabel, React.ComponentType<MessageRendererProps>>>;
  /** Number of older messages to load per page (default: 25) */
  loadMoreLimit?: number;
};

/* ----------------------------------------------------------
   MessageItem types
   ---------------------------------------------------------- */
export type MessageItemProps = {
  message: FormatMessageResponse;
  isOwnMessage: boolean;
  isFirstInGroup: boolean;
  isHighlighted: boolean;
  AvatarComponent: React.ComponentType<AvatarProps>;
  MessageBubble: React.ComponentType<MessageBubbleProps>;
  MessageRenderer: React.ComponentType<MessageRendererProps>;
  onClickQuote?: (messageId: string) => void;
};

export type SystemMessageItemProps = {
  message: FormatMessageResponse;
  isOwnMessage: boolean;
  SystemRenderer: React.ComponentType<MessageRendererProps>;
};

/* ----------------------------------------------------------
   MessageInput types
   ---------------------------------------------------------- */
export type MessageInputProps = {
  placeholder?: string;
  onSend?: (text: string) => void;
  className?: string;
  SendButton?: React.ComponentType<{ disabled: boolean; onClick: () => void }>;
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
   useScrollToMessage types
   ---------------------------------------------------------- */
export type ScrollToMessageFn = (messageId: string) => void;

export type UseScrollToMessageOptions = {
  /** Reference to the scroll container */
  listRef: React.RefObject<HTMLDivElement | null>;
  /** Current active channel from SDK */
  activeChannel: any;
  /** Setter to replace message state when fetching around a message */
  setMessages: React.Dispatch<React.SetStateAction<FormatMessageResponse[]>>;
  /** Reset hasMore flag when message state is replaced */
  setHasMore: React.Dispatch<React.SetStateAction<boolean>>;
  /** Set hasNewer flag when jumping to an older message */
  setHasNewer: React.Dispatch<React.SetStateAction<boolean>>;
};

export type UseScrollToMessageReturn = {
  /** Currently highlighted message ID (null if none) */
  highlightedId: string | null;
  /** Scroll to a message by ID, fetching if not in DOM */
  scrollToMessage: ScrollToMessageFn;
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
  /** Original File object */
  file: File;
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
};

export type FilesPreviewProps = {
  files: FilePreviewItem[];
  onRemove: (id: string) => void;
};
