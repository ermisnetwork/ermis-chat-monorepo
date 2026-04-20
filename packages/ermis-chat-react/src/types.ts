import type {
  FormatMessageResponse,
  MessageLabel,
  Attachment,
  Channel,
  ChannelFilters,
  ChannelSort,
  ChannelQueryOptions,
  UserCallInfo,
} from '@ermis-network/ermis-chat-sdk';
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
  /** Message ID to jump/scroll to (set by search, cleared after scroll) */
  jumpToMessageId: string | null;
  setJumpToMessageId: (id: string | null) => void;
  /** Indicates whether the direct call feature is enabled */
  enableCall?: boolean;
};

export type ChatProviderProps = {
  client: ErmisChat;
  children: React.ReactNode;
  /** Initial theme, defaults to 'dark' */
  initialTheme?: Theme;
  /** Enable direct call feature (Audio/Video). If enabled, configures internal CallProvider */
  enableCall?: boolean;
  /** Provide session ID to be used for call nodes */
  callSessionId?: string;
  /** Override the WebAssembly module path for Call Nodes */
  callWasmPath?: string;
  /** Override the relay URL for Call Nodes */
  callRelayUrl?: string;
  /** Custom Component to completely replace the default Call UI */
  CallUIComponent?: React.ComponentType;
  /** Path to the mp3 file for incoming call ringing */
  incomingCallAudioPath?: string;
  /** Path to the mp3 file for outgoing call ringing */
  outgoingCallAudioPath?: string;
  /** Called when a call is initiated by the local user */
  onCallStart?: (callType: 'audio' | 'video', cid: string) => void;
  /** Called when a call ends (includes duration in seconds) */
  onCallEnd?: (duration: number) => void;
  /** Called when a call error occurs */
  onCallError?: (error: string) => void;
  /** Called when an incoming call is received */
  onIncomingCall?: (callerInfo: UserCallInfo) => void;
  /** Called when the local user accepts an incoming call */
  onCallAccepted?: () => void;
  /** Called when the local user rejects an incoming call */
  onCallRejected?: () => void;
};

/* ----------------------------------------------------------
   Call Provider types
   ---------------------------------------------------------- */
export interface ErmisCallProviderProps {
  children: React.ReactNode;
  client: ErmisChat;
  sessionId: string;
  wasmPath?: string;
  relayUrl?: string;
  /** Called when a call is initiated by the local user */
  onCallStart?: (callType: 'audio' | 'video', cid: string) => void;
  /** Called when a call ends (includes duration in seconds) */
  onCallEnd?: (duration: number) => void;
  /** Called when a call error occurs */
  onCallError?: (error: string) => void;
  /** Called when an incoming call is received */
  onIncomingCall?: (callerInfo: UserCallInfo) => void;
  /** Called when the local user accepts an incoming call */
  onCallAccepted?: () => void;
  /** Called when the local user rejects an incoming call */
  onCallRejected?: () => void;
}

/* ----------------------------------------------------------
   Call UI types
   ---------------------------------------------------------- */
export type ErmisCallUIProps = {
  /** Additional CSS class name */
  className?: string;
  incomingCallTitle?: (callType: string) => string;
  outgoingCallTitle?: (callType: string) => string;
  ongoingCallTitle?: (callType: string) => string;
  isCallingYouLabel?: string;
  ringingLabel?: string;
  rejectCallLabel?: string;
  acceptCallLabel?: string;
  endCallLabel?: string;
  cancelLabel?: string;
  toggleMicTitle?: string;
  toggleVideoTitle?: string;
  shareScreenTitle?: string;
  stopScreenShareTitle?: string;
  /** Label shown during an active call (default: "Connected") */
  connectedLabel?: string;
  /** Label for the audio call type badge (default: "Audio Call") */
  audioCallBadgeLabel?: string;
  /** Label for the video call type badge (default: "Video Call") */
  videoCallBadgeLabel?: string;
  /** Tooltip for the fullscreen button (default: "Fullscreen") */
  fullscreenTitle?: string;
  /** Tooltip for the exit fullscreen button (default: "Exit Fullscreen") */
  exitFullscreenTitle?: string;
  /** Tooltip for the upgrade call button (default: "Request Video Upgrade") */
  upgradeCallTitle?: string;
  /** If true, suppress incoming call UI — useful for "Do Not Disturb" mode */
  suppressIncomingCalls?: boolean;
  /** Called on each second tick of the call duration timer */
  onCallDurationChange?: (seconds: number) => void;
  AvatarComponent?: React.ComponentType<AvatarProps>;
  MicIcon?: React.ComponentType;
  MicOffIcon?: React.ComponentType;
  VideoIcon?: React.ComponentType;
  VideoOffIcon?: React.ComponentType;
  PhoneIcon?: React.ComponentType;
  ScreenShareIcon?: React.ComponentType;
  ScreenShareOffIcon?: React.ComponentType;
  FullscreenIcon?: React.ComponentType;
  ExitFullscreenIcon?: React.ComponentType;
  /** Custom icon for the upgrade call button (audio → video) */
  UpgradeCallIcon?: React.ComponentType;
  incomingCallAudioPath?: string;
  outgoingCallAudioPath?: string;
  /** Replace the entire Ringing state view */
  RingingComponent?: React.ComponentType<ErmisCallRingingProps>;
  /** Replace the entire Connected Audio state view */
  ConnectedAudioComponent?: React.ComponentType<ErmisCallConnectedAudioProps>;
  /** Replace the entire Connected Video state view */
  ConnectedVideoComponent?: React.ComponentType<ErmisCallConnectedVideoProps>;
  /** Replace the entire Error state view */
  ErrorComponent?: React.ComponentType<ErmisCallErrorProps>;
  /** Replace the controls bar */
  ControlsBarComponent?: React.ComponentType<ErmisCallControlsBarProps>;
};

/* ----------------------------------------------------------
   Call sub-component prop types (for component slots)
   ---------------------------------------------------------- */

/** Props for the Ringing state view */
export type ErmisCallRingingProps = {
  peerInfo?: UserCallInfo;
  callType: string;
  isIncoming: boolean;
  acceptCall: () => Promise<void>;
  rejectCall: () => Promise<void>;
  endCall: () => Promise<void>;
  AvatarComponent: React.ComponentType<AvatarProps>;
  isCallingYouLabel: string;
  ringingLabel: string;
  rejectCallLabel: string;
  acceptCallLabel: string;
  endCallLabel: string;
  audioCallBadgeLabel: string;
  videoCallBadgeLabel: string;
};

/** Props for the Connected Audio state view */
export type ErmisCallConnectedAudioProps = {
  peerInfo?: UserCallInfo;
  callDuration: number;
  isRemoteMicMuted: boolean;
  AvatarComponent: React.ComponentType<AvatarProps>;
  connectedLabel: string;
  renderControls: () => React.ReactNode;
};

/** Props for the Connected Video state view */
export type ErmisCallConnectedVideoProps = {
  localVideoRef: React.RefObject<HTMLVideoElement | null>;
  remoteVideoRef: React.RefObject<HTMLVideoElement | null>;
  isRemoteMicMuted: boolean;
  renderControls: () => React.ReactNode;
};

/** Props for the Error state view */
export type ErmisCallErrorProps = {
  errorMessage: string;
  clearError: () => void;
  cancelLabel: string;
  PhoneIcon: React.ComponentType;
};

/** Props for the Controls bar */
export type ErmisCallControlsBarProps = {
  callType: string;
  toggleMic: () => void;
  toggleVideo: () => void;
  toggleScreenShare: () => Promise<void>;
  toggleFullscreen: () => void;
  upgradeCall: () => Promise<void>;
  endCall: () => Promise<void>;
  isMicMuted: boolean;
  isVideoMuted: boolean;
  isScreenSharing: boolean;
  isFullscreen: boolean;
  audioDevices: MediaDeviceInfo[];
  videoDevices: MediaDeviceInfo[];
  selectedAudioDeviceId: string;
  selectedVideoDeviceId: string;
  switchAudioDevice: (id: string) => Promise<void>;
  switchVideoDevice: (id: string) => Promise<void>;
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
  renderRight?: (channel: Channel, actionDisabled?: boolean) => React.ReactNode;
  /** Override default title rendering */
  renderTitle?: (channel: Channel) => React.ReactNode;
  /** Custom renderer for Audio Call button */
  renderAudioCallButton?: (onClick: () => void, disabled: boolean) => React.ReactNode;
  /** Custom renderer for Video Call button */
  renderVideoCallButton?: (onClick: () => void, disabled: boolean) => React.ReactNode;
  /** I18n label for the audio call button tooltip (default: "Audio Call") */
  audioCallTitle?: string;
  /** I18n label for the video call button tooltip (default: "Video Call") */
  videoCallTitle?: string;
  /** Custom component to show when a call is active (e.g. "Call in progress" badge) */
  CallBadgeComponent?: React.ComponentType<{ callType: string }>;
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
export type ChannelAction = {
  id: string;
  label: string;
  icon?: React.ReactNode;
  onClick: (channel: Channel, e: React.MouseEvent) => void;
  isDanger?: boolean;
};

export type ChannelActionsProps = {
  channel: Channel;
  actions: ChannelAction[];
  onClose: () => void;
};

export type ChannelItemProps = {
  channel: Channel;
  isActive: boolean;
  hasUnread: boolean;
  unreadCount: number;
  lastMessageText: string;
  lastMessageUser: string;
  lastMessageTimestamp?: Date | string | null;
  onSelect: (channel: Channel) => void;
  AvatarComponent: React.ComponentType<AvatarProps>;
  /** Whether the current user has blocked this channel (messaging only) */
  isBlocked?: boolean;
  /** Whether the current user is pending an invitation for this channel */
  isPending?: boolean;
  /** Label for the pending channel badge indicator */
  pendingBadgeLabel?: string;
  /** Label for the blocked channel badge indicator */
  blockedBadgeLabel?: string;
  isClosedTopic?: boolean;
  closedTopicIcon?: React.ReactNode;
  PinnedIconComponent?: React.ComponentType;
  ChannelActionsComponent?: React.ComponentType<ChannelActionsProps>;
  /** Handler when Create Topic action is triggered */
  onAddTopic?: (channel: Channel) => void;
  /** Handler when Edit Topic action is triggered */
  onEditTopic?: (channel: Channel) => void;
  /** Handler when Close/Reopen Topic action is triggered */
  onToggleCloseTopic?: (channel: Channel, isClosed: boolean) => void;
  /** Array of action IDs to hide from the actions dropdown */
  hiddenActions?: string[];
};

export type ChannelListProps = {
  filters?: ChannelFilters;
  sort?: ChannelSort;
  options?: ChannelQueryOptions;
  renderChannel?: (channel: Channel, isActive: boolean) => React.ReactNode;
  onChannelSelect?: (channel: Channel) => void;
  className?: string;
  /** Array of action IDs to hide from the actions dropdown */
  hiddenActions?: string[];
  LoadingIndicator?: React.ComponentType<{ text?: string }>;
  EmptyStateIndicator?: React.ComponentType<{ text?: string }>;
  AvatarComponent?: React.ComponentType<AvatarProps>;
  /** Replace the default channel list item component */
  ChannelItemComponent?: React.ComponentType<ChannelItemProps>;
  /** Label for the pending invites accordion header */
  pendingInvitesLabel?: string | ((count: number) => string);
  /** Label for the regular channels section header */
  channelsLabel?: string;
  /** Label for the pending channel badge indicator */
  pendingBadgeLabel?: string;
  /** Label for the loading indicator */
  loadingLabel?: string;
  /** Label for the empty state indicator */
  emptyStateLabel?: string;
  /** Label for the blocked channel badge hover */
  blockedBadgeLabel?: string;
  /** Custom component for rendering topic group */
  ChannelTopicGroupComponent?: React.ComponentType<any>;
  /** Custom avatar component for general topic */
  GeneralTopicAvatarComponent?: React.ComponentType<any>;
  /** Custom avatar component for other topics */
  TopicAvatarComponent?: React.ComponentType<any>;
  /** Name for the general topic (default: "general") */
  generalTopicLabel?: string;
  /** Handler when Add Topic button is clicked on a team channel */
  onAddTopic?: (channel: Channel) => void;
  /** Optional custom emoji picker for TopicModal */
  TopicEmojiPickerComponent?: React.ComponentType<any>;
  closedTopicIcon?: React.ReactNode;
  PinnedIconComponent?: React.ComponentType;
  /** Custom component for channel actions dropdown */
  ChannelActionsComponent?: React.ComponentType<ChannelActionsProps>;
  /** Handler when Edit Topic action is triggered */
  onEditTopic?: (channel: Channel) => void;
  /** Handler when Close/Reopen Topic action is triggered */
  onToggleCloseTopic?: (channel: Channel, isClosed: boolean) => void;
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

  /** I18n Labels */
  emptyTitle?: string;
  emptySubtitle?: string;
  jumpToLatestLabel?: string;
  bannedOverlayTitle?: string;
  bannedOverlaySubtitle?: string;
  blockedOverlayTitle?: string;
  blockedOverlaySubtitle?: string;
  pendingOverlayTitle?: string;
  pendingOverlaySubtitle?: string;
  pendingAcceptLabel?: string;
  pendingRejectLabel?: string;
  closedTopicOverlayTitle?: string;
  closedTopicOverlaySubtitle?: string;
  closedTopicReopenLabel?: string;
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
  /** Whether interactions are disabled */
  disabled?: boolean;
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
  /** I18n Label for forwarded message */
  forwardedLabel?: string;
  /** I18n Label for edited state */
  editedLabel?: string;
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
  EditPreviewComponent?: React.ComponentType<{
    message: FormatMessageResponse;
    onDismiss: () => void;
    editingMessageLabel?: string;
  }>;
  /** I18n Label for banned state */
  bannedLabel?: string;
  /** I18n Label for blocked state (messaging channels) */
  blockedLabel?: string;
  /** I18n Label for links disabled error */
  linksDisabledLabel?: string;
  /** I18n Label for keyword blocked error */
  keywordBlockedLabel?: (match: string) => string;
  /** I18n Label for sending capability disabled */
  sendDisabledLabel?: string;
  /** I18n Label for slow mode active */
  slowModeLabel?: (cooldown: number) => React.ReactNode;
  /** I18n Label for closed topic */
  closedTopicLabel?: string;
};

/* ----------------------------------------------------------
   ReplyPreview types
   ---------------------------------------------------------- */
export type ReplyPreviewProps = {
  message: FormatMessageResponse;
  onDismiss: () => void;
  replyingToLabel?: string;
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

  /** I18n Labels */
  pinLabel?: string;
  unpinLabel?: string;
  editLabel?: string;
  copyLabel?: string;
  deleteForMeLabel?: string;
  deleteForEveryoneLabel?: string;
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

/* --------------------------------------------------------------------------
 * Modal Components
 * -------------------------------------------------------------------------- */

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  maxWidth?: string;
  hideCloseButton?: boolean;
  closeOnOutsideClick?: boolean;
}

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
  onBan?: (id: string) => void;
  canBan?: boolean;
  onUnban?: (id: string) => void;
  canUnban?: boolean;
  onPromote?: (id: string) => void;
  canPromote?: boolean;
  onDemote?: (id: string) => void;
  canDemote?: boolean;
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
  /** Whether the current user can edit channel info */
  canEdit?: boolean;
  /** Callback when the edit button is clicked */
  onEditClick?: () => void;
  /** Whether the channel is public */
  isPublic?: boolean;
  /** Name of the parent channel (if this is a topic) */
  parentChannelName?: string;
  /** Whether the channel is a topic */
  isTopic?: boolean;
  /** Whether the channel is a team channel */
  isTeamChannel?: boolean;
};

export type ChannelInfoActionsProps = {
  onSearchClick?: () => void;
  onSettingsClick?: () => void;
  onLeaveChannel?: () => void;
  onDeleteChannel?: () => void;
  onBlockUser?: () => void;
  onUnblockUser?: () => void;
  isTeamChannel?: boolean;
  isTopic?: boolean;
  isClosedTopic?: boolean;
  isBlocked?: boolean;
  currentUserRole?: string;
  searchLabel?: string;
  settingsLabel?: string;
  deleteLabel?: string;
  leaveLabel?: string;
  blockLabel?: string;
  unblockLabel?: string;
  onCloseTopic?: () => void;
  onReopenTopic?: () => void;
  closeTopicLabel?: string;
  reopenTopicLabel?: string;
};

export type ChannelInfoMember = {
  id: string;
  name?: string;
  avatar?: string;
  [key: string]: any;
};

/** Payload for updating channel profile */
export type EditChannelData = {
  name?: string;
  image?: string;
  description?: string;
  public?: boolean;
};

/** Props for the EditChannelModal */
export type EditChannelModalProps = {
  channel: Channel;
  onClose: () => void;
  /** Override the default save logic entirely */
  onSave?: (data: EditChannelData) => Promise<void>;
  /** Custom avatar component */
  AvatarComponent: React.ComponentType<AvatarProps>;
  /** Modal title (default: 'Edit Channel') */
  title?: string;
  /** Label for the name input (default: 'Channel Name') */
  nameLabel?: string;
  /** Label for the description input (default: 'Description') */
  descriptionLabel?: string;
  /** Placeholder for name input */
  namePlaceholder?: string;
  /** Placeholder for description input */
  descriptionPlaceholder?: string;
  /** Label for the public toggle (default: 'Public Channel') */
  publicLabel?: string;
  /** Label for the save button (default: 'Save') */
  saveLabel?: string;
  /** Label for the cancel button (default: 'Cancel') */
  cancelLabel?: string;
  /** Label shown while saving (default: 'Saving...') */
  savingLabel?: string;
  /** Label for the change avatar button (default: 'Change Avatar') */
  changeAvatarLabel?: string;
  /** Accept attribute for the file input (default: 'image/*') */
  imageAccept?: string;
  /** Max file size in bytes (default: 5MB = 5242880) */
  maxImageSize?: number;
  /** Error text for exceeding max size (default: 'Image must be less than 5MB') */
  maxImageSizeError?: string;
};

/** Props for the Add Member button rendered at the top of the Members tab */
export type AddMemberButtonProps = {
  onClick: () => void;
  /** Label text for the button (default: 'Add Member') */
  label?: string;
};

/** Props for individual user items inside the AddMemberModal */
export type AddMemberUserItemProps = {
  user: any;
  /** Whether the user already belongs to the channel */
  isExisting: boolean;
  /** Whether the user is currently being added */
  isAdding: boolean;
  /** Callback to add the user */
  onAdd: (userId: string) => void;
  AvatarComponent: React.ComponentType<AvatarProps>;
  /** Label shown when the user is already in the channel (default: 'Added') */
  addedLabel?: string;
  /** Label shown while adding (default: 'Adding...') */
  addingLabel?: string;
  /** Label for the add button (default: 'Add') */
  addLabel?: string;
};

/** Props for the AddMemberModal */
export type AddMemberModalProps = {
  channel: Channel;
  currentMembers: any[];
  onClose: () => void;
  AvatarComponent: React.ComponentType<AvatarProps>;
  /** Modal title (default: 'Add Member') */
  title?: string;
  /** Search input placeholder (default: 'Search by name, email or phone...') */
  searchPlaceholder?: string;
  /** Text shown while loading users (default: 'Loading users...') */
  loadingText?: string;
  /** Text shown when no users match the search (default: 'No users found.') */
  emptyText?: string;
  /** Label for the add button on each user row (default: 'Add') */
  addLabel?: string;
  /** Label shown while a user is being added (default: 'Adding...') */
  addingLabel?: string;
  /** Label shown when a user already belongs to the channel (default: 'Added') */
  addedLabel?: string;
  /** Custom user item component (replaces the default row) */
  UserItemComponent?: React.ComponentType<AddMemberUserItemProps>;
  /** Custom search input component */
  SearchInputComponent?: React.ComponentType<{
    value: string;
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    placeholder: string;
  }>;
};

export type ChannelInfoTabsProps = {
  channel: Channel;
  members: ChannelInfoMember[];
  AvatarComponent: React.ComponentType<AvatarProps>;
  currentUserId?: string;
  currentUserRole?: string;
  onAddMemberClick?: () => void;
  onRemoveMember?: (id: string) => void;
  onBanMember?: (id: string) => void;
  onUnbanMember?: (id: string) => void;
  onPromoteMember?: (id: string) => void;
  onDemoteMember?: (id: string) => void;

  /** Label for the 'Add Member' button in the Members tab (default: 'Add Member') */
  addMemberButtonLabel?: string;
  /** Custom component for the 'Add Member' button */
  AddMemberButtonComponent?: React.ComponentType<AddMemberButtonProps>;

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
  /** Custom component replacing the entire AddMemberModal */
  AddMemberModalComponent?: React.ComponentType<AddMemberModalProps>;
  /** Custom component replacing the entire EditChannelModal */
  EditChannelModalComponent?: React.ComponentType<EditChannelModalProps>;

  /** Custom sub-component overrides (passed through to TabsComponent) */
  MemberItemComponent?: React.ComponentType<ChannelInfoMemberItemProps>;
  MediaItemComponent?: React.ComponentType<ChannelInfoMediaItemProps>;
  LinkItemComponent?: React.ComponentType<ChannelInfoLinkItemProps>;
  FileItemComponent?: React.ComponentType<ChannelInfoFileItemProps>;
  EmptyStateComponent?: React.ComponentType<ChannelInfoEmptyStateProps>;
  LoadingComponent?: React.ComponentType;

  /** Add Member customization (passed through to AddMemberModal) */
  addMemberModalTitle?: string;
  addMemberSearchPlaceholder?: string;
  addMemberLoadingText?: string;
  addMemberEmptyText?: string;
  addMemberAddLabel?: string;
  addMemberAddingLabel?: string;
  addMemberAddedLabel?: string;
  /** Label for the 'Add Member' button in Members tab */
  addMemberButtonLabel?: string;
  /** Custom component for the 'Add Member' button */
  AddMemberButtonComponent?: React.ComponentType<AddMemberButtonProps>;

  /** Edit Channel customization (passed through to EditChannelModal) */
  /** Override edit channel save logic */
  onEditChannel?: (data: EditChannelData) => Promise<void>;
  editChannelModalTitle?: string;
  editChannelNameLabel?: string;
  editChannelDescriptionLabel?: string;
  editChannelNamePlaceholder?: string;
  editChannelDescriptionPlaceholder?: string;
  editChannelPublicLabel?: string;
  editChannelSaveLabel?: string;
  editChannelCancelLabel?: string;
  editChannelSavingLabel?: string;
  editChannelChangeAvatarLabel?: string;
  editChannelImageAccept?: string;
  editChannelMaxImageSize?: number;
  editChannelMaxImageSizeError?: string;

  /** Action Labels */
  actionsSearchLabel?: string;
  actionsSettingsLabel?: string;
  actionsDeleteLabel?: string;
  actionsLeaveLabel?: string;

  /** Action callbacks */
  onSearchClick?: () => void;
  onLeaveChannel?: () => void;
  onDeleteChannel?: () => void;
  onAddMemberClick?: () => void;
  onRemoveMember?: (id: string) => void;
  onBanMember?: (id: string) => void;
  onUnbanMember?: (id: string) => void;
  onPromoteMember?: (id: string) => void;
  onDemoteMember?: (id: string) => void;

  /** Block/Unblock callbacks (messaging channels only) */
  onBlockUser?: () => void;
  onUnblockUser?: () => void;
  /** I18n labels for block/unblock actions */
  actionsBlockLabel?: string;
  actionsUnblockLabel?: string;
  actionsCloseTopicLabel?: string;
  actionsReopenTopicLabel?: string;

  /** Settings Panel Topics Labels */
  settingsWorkspaceTopicsTitle?: string;
  settingsTopicsFeatureName?: string;
  settingsTopicsFeatureDescription?: string;
};

/* ----------------------------------------------------------
   Message Search Panel types
   ---------------------------------------------------------- */
export type SearchResultMessage = {
  id: string;
  text?: string;
  user_id?: string;
  user?: { id?: string; name?: string; avatar?: string; image?: string; avatar_url?: string };
  created_at?: string;
  [key: string]: any;
};

export type MessageSearchPanelProps = {
  isOpen: boolean;
  onClose: () => void;
  channel: Channel;
  /** Custom avatar component */
  AvatarComponent?: React.ComponentType<AvatarProps>;
  /** Title for the panel */
  title?: string;
  /** Search input placeholder */
  placeholder?: string;
  /** Text shown when loading */
  loadingText?: string;
  /** Text shown when no more messages or no results */
  emptyText?: string;
  /** Debounce wait time in ms (default: 500) */
  debounceMs?: number;
};

/* ----------------------------------------------------------
   Channel Settings Panel types
   ---------------------------------------------------------- */
export type ChannelSettingsPanelProps = {
  isOpen: boolean;
  onClose: () => void;
  channel: Channel;
  /** Title for the settings panel */
  title?: string;
  /** Custom slow mode options */
  slowModeOptions?: { label: string; value: number }[];
  /** I18n labels for Topics settings */
  workspaceTopicsTitle?: string;
  topicsFeatureName?: string;
  topicsFeatureDescription?: string;
};

/* ----------------------------------------------------------
   UserPicker types
   ---------------------------------------------------------- */

/** Individual user item in UserPicker */
export type UserPickerUser = {
  id: string;
  name?: string;
  email?: string;
  phone?: string;
  avatar?: string;
  [key: string]: any;
};

/** Props for each user row in UserPicker */
export type UserPickerItemProps = {
  user: UserPickerUser;
  selected: boolean;
  disabled: boolean;
  mode: 'radio' | 'checkbox';
  onToggle: (user: UserPickerUser) => void;
  AvatarComponent: React.ComponentType<AvatarProps>;
};

/** Props for the selected users chip box */
export type UserPickerSelectedBoxProps = {
  users: UserPickerUser[];
  onRemove: (userId: string) => void;
  AvatarComponent: React.ComponentType<AvatarProps>;
  /** Label when no users selected */
  emptyLabel?: string;
};

/** Main UserPicker props */
export type UserPickerProps = {
  /** Selection mode: 'radio' for single, 'checkbox' for multi */
  mode: 'radio' | 'checkbox';
  /** Called whenever selection changes */
  onSelectionChange?: (users: UserPickerUser[]) => void;
  /** User IDs to exclude from the list (e.g. existing members) */
  excludeUserIds?: string[];
  /** Users that are pre-selected on mount */
  initialSelectedUsers?: UserPickerUser[];
  /** Page size for queryUsers (default: 30) */
  pageSize?: number;
  /** Custom avatar component */
  AvatarComponent?: React.ComponentType<AvatarProps>;
  /** Custom user item component (replaces the default row) */
  UserItemComponent?: React.ComponentType<UserPickerItemProps>;
  /** Custom selected box component (checkbox mode only) */
  SelectedBoxComponent?: React.ComponentType<UserPickerSelectedBoxProps>;
  /** Custom search input component */
  SearchInputComponent?: React.ComponentType<{
    value: string;
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    placeholder: string;
  }>;

  /** I18n labels */
  searchPlaceholder?: string;
  loadingText?: string;
  emptyText?: string;
  loadingMoreText?: string;
  selectedEmptyLabel?: string;
};

/* ----------------------------------------------------------
   Create Channel Modal Props
   ---------------------------------------------------------- */

export type CreateChannelModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: (channel: any) => void; // Uses 'any' or 'Channel' based on context

  /** Override visual components */
  AvatarComponent?: React.ComponentType<AvatarProps>;
  UserItemComponent?: React.ComponentType<UserPickerItemProps>;

  /** i18n labels */
  title?: string;
  directTabLabel?: string;
  groupTabLabel?: string;
  groupNameLabel?: string;
  groupNamePlaceholder?: string;
  groupDescriptionLabel?: string;
  groupDescriptionPlaceholder?: string;
  groupPublicLabel?: string;
  groupAvatarLabel?: string;
  userSearchPlaceholder?: string;
  cancelButtonLabel?: string;
  createButtonLabel?: string;
  creatingButtonLabel?: string;

  /** File upload configuration for group channel images */
  imageAccept?: string;
  maxImageSize?: number; // bytes
  maxImageSizeError?: string;
};

export type TopicModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: (channel: Channel) => void;
  /** Inject external emoji picker component */
  EmojiPickerComponent?: React.ComponentType<{ onSelect: (emoji: any) => void; [key: string]: any }>;
  /** Parent team channel to create topic under, will use activeChannel if not provided */
  parentChannel?: Channel;

  /** If provided, operates in edit mode for this topic */
  topic?: Channel;

  /** i18n labels */
  title?: string;
  nameLabel?: string;
  namePlaceholder?: string;
  emojiLabel?: string;
  descriptionLabel?: string;
  descriptionPlaceholder?: string;
  cancelButtonLabel?: string;
  saveButtonLabel?: string;
  savingButtonLabel?: string;
};
