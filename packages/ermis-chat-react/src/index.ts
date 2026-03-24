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

// Components
export { Avatar } from './components/Avatar';
export type { AvatarProps } from './components/Avatar';

export { ChannelList, ChannelItem } from './components/ChannelList';
export type { ChannelListProps, ChannelItemProps } from './components/ChannelList';

export { Channel } from './components/Channel';
export type { ChannelProps } from './components/Channel';

export { ChannelHeader } from './components/ChannelHeader';
export type { ChannelHeaderProps } from './components/ChannelHeader';
export type { ChannelHeaderData } from './types';

export type { MessageListProps, MessageBubbleProps, MessageItemProps, SystemMessageItemProps } from './types';

export { VirtualMessageList } from './components/VirtualMessageList';

export { MessageItem, SystemMessageItem } from './components/MessageItem';

export { formatTime, getDateKey, formatDateLabel, getMessageUserId } from './utils';

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
export type { MessageInputProps, SendButtonProps, AttachButtonProps } from './components/MessageInput';

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
