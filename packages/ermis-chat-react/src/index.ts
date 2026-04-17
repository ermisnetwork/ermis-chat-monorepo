// Styles
import './styles/index.css';

// Context
export { ChatProvider } from './context/ChatProvider';
export type { ChatProviderProps, ChatContextValue, Theme } from './context/ChatProvider';

// Hooks
export { useChatClient } from './hooks/useChatClient';
export { useChannel } from './hooks/useChannel';
export type { UseChannelReturn } from './hooks/useChannel';
export { useChannelListUpdates } from './hooks/useChannelListUpdates';
export { useChannelRowUpdates } from './hooks/useChannelRowUpdates';
export { useBannedState } from './hooks/useBannedState';
export { useBlockedState } from './hooks/useBlockedState';
export { usePendingState } from './hooks/usePendingState';

// Components
export { Avatar } from './components/Avatar';
export type { AvatarProps } from './components/Avatar';

export { ChannelList, ChannelItem, ChannelTopicGroup } from './components/ChannelList';
export type { ChannelListProps, ChannelItemProps } from './components/ChannelList';

export { Channel } from './components/Channel';
export type { ChannelProps } from './components/Channel';

export { ChannelHeader } from './components/ChannelHeader';
export type { ChannelHeaderProps } from './components/ChannelHeader';
export type { ChannelHeaderData } from './types';

export type { MessageListProps, MessageBubbleProps, MessageItemProps, SystemMessageItemProps, DateSeparatorProps, JumpToLatestProps } from './types';

export { VirtualMessageList } from './components/VirtualMessageList';

export { PinnedMessages } from './components/PinnedMessages';
export type { PinnedMessagesProps, PinnedMessageItemProps } from './types';

export { MessageItem, SystemMessageItem } from './components/MessageItem';
export { MessageActionsBox } from './components/MessageActionsBox';
export type { MessageActionsBoxProps } from './types';

export { Dropdown, closeAllDropdowns } from './components/Dropdown';
export type { DropdownProps } from './components/Dropdown';

export { MessageReactions } from './components/MessageReactions';
export type { MessageReactionsProps, ReactionUser, LatestReaction } from './types';

export { MessageQuickReactions } from './components/MessageQuickReactions';

export { useMessageActions } from './hooks/useMessageActions';

export { formatTime, getDateKey, formatDateLabel, getMessageUserId, replaceMentionsForPreview } from './utils';

export {
  defaultMessageRenderers,
  RegularMessage,
  SystemMessage,
  SignalMessage,
  PollMessage,
  StickerMessage,
  ErrorMessage,
  AttachmentList,
  MessageAttachment,
} from './components/MessageRenderers';
export type { MessageRendererProps, AttachmentProps } from './components/MessageRenderers';

export { MessageInput } from './components/MessageInput';
export type { MessageInputProps, SendButtonProps, AttachButtonProps, EmojiPickerProps, EmojiButtonProps } from './components/MessageInput';

export { FilesPreview } from './components/FilesPreview';
export type { FilePreviewItem, FilesPreviewProps } from './components/FilesPreview';

export { MentionSuggestions } from './components/MentionSuggestions';
export type { MentionSuggestionsProps } from './components/MentionSuggestions';

export { useMentions } from './hooks/useMentions';
export type { MentionMember, MentionPayload, UseMentionsOptions, UseMentionsReturn } from './hooks/useMentions';

export { useScrollToMessage } from './hooks/useScrollToMessage';
export type { UseScrollToMessageOptions, UseScrollToMessageReturn } from './hooks/useScrollToMessage';

export { useLoadMessages, dedupMessages } from './hooks/useLoadMessages';
export type { UseLoadMessagesOptions, UseLoadMessagesReturn } from './hooks/useLoadMessages';

export { useChannelMessages } from './hooks/useChannelMessages';
export type { UseChannelMessagesOptions } from './hooks/useChannelMessages';

export { QuotedMessagePreview } from './components/QuotedMessagePreview';
export type { QuotedMessagePreviewProps } from './components/QuotedMessagePreview';
export { ReplyPreview } from './components/ReplyPreview';
export type { ReplyPreviewProps } from './types';

export { ForwardMessageModal } from './components/ForwardMessageModal';
export type { ForwardMessageModalProps, ForwardChannelItemProps } from './components/ForwardMessageModal';

export { TopicModal } from './components/TopicModal';

export { TypingIndicator } from './components/TypingIndicator';
export type { TypingIndicatorProps } from './components/TypingIndicator';
export { useTypingIndicator } from './hooks/useTypingIndicator';
export type { TypingUser } from './hooks/useTypingIndicator';

export {
  ChannelInfo,
  DefaultChannelInfoHeader,
  DefaultChannelInfoCover,
  DefaultChannelInfoActions,
  DefaultChannelInfoTabs
} from './components/ChannelInfo';

export { Modal } from './components/Modal';
export { Panel } from './components/Panel';
export type {
  ChannelInfoProps,
  ChannelInfoHeaderProps,
  ChannelInfoCoverProps,
  ChannelInfoActionsProps,
  ChannelInfoTabsProps,
  ChannelInfoMemberItemProps,
  ChannelInfoMediaItemProps,
  ChannelInfoLinkItemProps,
  ChannelInfoFileItemProps,
  ChannelInfoEmptyStateProps,
  AttachmentItem,
  MediaTab,
  ModalProps,
  AddMemberModalProps,
  AddMemberUserItemProps,
  AddMemberButtonProps,
} from './types';

export { UserPicker } from './components/UserPicker';
export type {
  UserPickerProps,
  UserPickerUser,
  UserPickerItemProps,
  UserPickerSelectedBoxProps,
} from './types';

export { CreateChannelModal } from './components/CreateChannelModal';
export type { CreateChannelModalProps } from './types';

// Call Components
export { ErmisCallContext } from './context/ErmisCallContext';
export type { CallContextValue } from './context/ErmisCallContext';
export { useCallContext } from './hooks/useCallContext';
export { ErmisCallProvider } from './components/ErmisCallProvider';
export type { ErmisCallProviderProps } from './components/ErmisCallProvider';
export { ErmisCallUI } from './components/ErmisCallUI';
export type {
  ErmisCallUIProps,
  ErmisCallRingingProps,
  ErmisCallConnectedAudioProps,
  ErmisCallConnectedVideoProps,
  ErmisCallErrorProps,
  ErmisCallControlsBarProps,
} from './types';
