import React, { useCallback, useState, useRef, useEffect } from 'react';
import { EmojiPicker } from 'frimousse';
import type { FormatMessageResponse } from '@ermis-network/ermis-chat-sdk';
import { useChatClient } from '../hooks/useChatClient';

const EmojiPickerRoot = EmojiPicker.Root as any;
const EmojiPickerSearch = EmojiPicker.Search as any;
const EmojiPickerViewport = EmojiPicker.Viewport as any;
const EmojiPickerLoading = EmojiPicker.Loading as any;
const EmojiPickerEmpty = EmojiPicker.Empty as any;
const EmojiPickerList = EmojiPicker.List as any;

const QUICK_REACTIONS = ['like', 'love', 'haha', 'sad', 'fire'];
const EMOJI_MAP: Record<string, string> = {
  like: '👍',
  love: '❤️',
  haha: '😂',
  sad: '😢',
  fire: '🔥',
};

export const MessageQuickReactions: React.FC<{
  message: FormatMessageResponse;
  isOwnMessage: boolean;
  disabled?: boolean;
  onAddReactionClick?: (e: React.MouseEvent, messageId: string) => void;
}> = React.memo(({ message, isOwnMessage, disabled, onAddReactionClick }) => {
  const { activeChannel, client } = useChatClient();
  const currentUserId = client?.userID;
  const [isExpanded, setIsExpanded] = useState(false);
  const [pickerPosition, setPickerPosition] = useState<'top' | 'bottom'>('top');
  const containerRef = useRef<HTMLDivElement>(null);

  // Close when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (isExpanded && containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsExpanded(false);
      }
    };
    if (isExpanded) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isExpanded]);

  const handleReactionToggle = useCallback(
    async (type: string) => {
      if (!activeChannel) return;
      const isOwn =
        (message as any).own_reactions?.some((r: any) => r.type === type) ||
        (message as any).latest_reactions?.some(
          (r: any) => r.type === type && (r.user?.id === currentUserId || (r as any).user_id === currentUserId)
        );

      try {
        if (isOwn) {
          await activeChannel.deleteReaction(message.id!, type);
        } else {
          await activeChannel.sendReaction(message.id!, type);
        }
      } catch (err) {
        console.error('Failed to toggle reaction', err);
      }
    },
    [activeChannel, message, currentUserId]
  );

  return (
    <div 
      ref={containerRef}
      className={`ermis-message-quick-reactions ${isOwnMessage ? 'ermis-message-quick-reactions--own' : ''} ${disabled ? 'ermis-message-quick-reactions--disabled' : ''} ${isExpanded ? 'ermis-message-quick-reactions--expanded' : ''}`}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
        {QUICK_REACTIONS.map((type) => {
          const isOwn =
            (message as any).own_reactions?.some((r: any) => r.type === type) ||
            (message as any).latest_reactions?.some(
              (r: any) => r.type === type && (r.user?.id === currentUserId || (r as any).user_id === currentUserId)
            );

          return (
            <button
              key={type}
              className={`ermis-message-quick-reactions__btn ${
                isOwn ? 'ermis-message-quick-reactions__btn--active' : ''
              }`}
              title={type}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleReactionToggle(type);
              }}
            >
              {EMOJI_MAP[type]}
            </button>
          );
        })}
        
        <button
          className="ermis-message-quick-reactions__btn ermis-message-quick-reactions__btn--more"
          title="More reactions"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (containerRef.current) {
              const rect = containerRef.current.getBoundingClientRect();
              const pickerHeight = 368;
              
              // If not enough space above, expand downwards
              if (rect.top < pickerHeight + 20) {
                 setPickerPosition('bottom');
              } else {
                 setPickerPosition('top');
              }
            }
            setIsExpanded(!isExpanded);
          }}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-500">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
        </button>
      </div>

      {isExpanded && (
        <div
          style={{ 
            position: 'absolute',
            ...(pickerPosition === 'top' ? { bottom: '100%', marginBottom: 8 } : { top: '100%', marginTop: 8 }),
            ...(isOwnMessage ? { right: 0 } : { left: 0 }),
            width: '350px', 
            height: '368px',
            borderRadius: 16,
            overflow: 'hidden',
            backgroundColor: 'var(--ermis-bg-primary)',
            border: '1px solid var(--ermis-border)',
            boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1)',
            zIndex: 102
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <EmojiPickerRoot 
            className="isolate flex h-full w-full flex-col bg-white dark:bg-[#1a1828]"
            locale="vi"
            onEmojiSelect={(emoji: any) => {
              handleReactionToggle(emoji.emoji);
              setIsExpanded(false);
            }}
          >
            <EmojiPickerSearch className="z-10 mx-3 mt-3 appearance-none rounded-xl bg-zinc-100 px-3 py-2 text-sm dark:bg-zinc-800 dark:text-zinc-100 outline-none focus:ring-2 focus:ring-primary/50" />
            <EmojiPickerViewport className="relative flex-1 outline-hidden mt-2">
              <EmojiPickerLoading className="absolute inset-0 flex items-center justify-center text-zinc-400 text-sm dark:text-zinc-500">
                Đang tải…
              </EmojiPickerLoading>
              <EmojiPickerEmpty className="absolute inset-0 flex items-center justify-center text-zinc-400 text-sm dark:text-zinc-500">
                Không tìm thấy emoji.
              </EmojiPickerEmpty>
              <EmojiPickerList
                className="select-none pb-1.5"
                components={{
                  CategoryHeader: ({ category, ...props }: any) => (
                    <div
                      className="bg-white/90 px-3 pt-3 pb-1.5 font-semibold text-zinc-500 text-xs dark:bg-[#1a1828]/90 dark:text-zinc-400 backdrop-blur-md"
                      {...props}
                    >
                      {category.label}
                    </div>
                  ),
                  Row: ({ children, ...props }: any) => (
                    <div className="scroll-my-1.5 px-2 flex justify-between" {...props}>
                      {children as React.ReactNode}
                    </div>
                  ),
                  Emoji: ({ emoji, ...props }: any) => {
                    const { formAction, ...safeProps } = props;
                    return (
                      <button
                        className="flex size-9 items-center justify-center rounded-lg text-xl hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors data-[active]:bg-zinc-100 dark:data-[active]:bg-zinc-800"
                        {...safeProps}
                      >
                        {emoji.emoji}
                      </button>
                    );
                  },
                }}
              />
            </EmojiPickerViewport>
          </EmojiPickerRoot>
        </div>
      )}
    </div>
  );
});

MessageQuickReactions.displayName = 'MessageQuickReactions';
