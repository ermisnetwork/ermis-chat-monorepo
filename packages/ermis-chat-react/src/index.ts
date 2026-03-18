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

export { ChannelList } from './components/ChannelList';
export type { ChannelListProps } from './components/ChannelList';

export { Channel } from './components/Channel';
export type { ChannelProps } from './components/Channel';

export { ChannelHeader } from './components/ChannelHeader';
export type { ChannelHeaderProps } from './components/ChannelHeader';

export { MessageList } from './components/MessageList';
export type { MessageListProps, MessageBubbleProps } from './components/MessageList';

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
export type { MessageInputProps } from './components/MessageInput';
