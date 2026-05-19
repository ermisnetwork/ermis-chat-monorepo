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

const REACTIONS = ['like', 'love', 'haha', 'sad', 'fire'];

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
}> = React.memo(({ message, isOwnMessage, disabled }) => {
  const { activeChannel, client } = useChatClient();
  const currentUserId = client?.userID;
  const [isExpanded, setIsExpanded] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [pickerPosition, setPickerPosition] = useState<'top' | 'bottom'>('top');
  const containerRef = useRef<HTMLDivElement>(null);

  // Close when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsExpanded(false);
        setShowPicker(false);
      }
    };
    if (isExpanded || showPicker) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isExpanded, showPicker]);

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

  const isOwnReaction = useCallback(
    (type: string) => {
      return (
        (message as any).own_reactions?.some((r: any) => r.type === type) ||
        (message as any).latest_reactions?.some(
          (r: any) => r.type === type && (r.user?.id === currentUserId || (r as any).user_id === currentUserId)
        )
      );
    },
    [message, currentUserId]
  );

  const handleMoreClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        setPickerPosition(rect.top < 388 ? 'bottom' : 'top');
      }
      setShowPicker((prev) => !prev);
      setIsExpanded(false);
    },
    []
  );

  return (
    <div 
      ref={containerRef} 
      className="ermis-qr-wrapper" 
      style={{ position: 'relative', display: 'inline-flex' }}
      onMouseLeave={() => {
        if (!showPicker) {
          setIsExpanded(false);
        }
      }}
    >
      {/* Trigger button (looks like other action buttons) */}
      <button 
        className={`ermis-message-list__actions-trigger ${isExpanded || showPicker ? 'ermis-message-list__actions-trigger--active' : ''}`}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (!disabled) { setIsExpanded(!isExpanded); setShowPicker(false); } }}
        title="Add reaction"
        disabled={disabled}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <path d="M8 14s1.5 2 4 2 4-2 4-2" />
          <line x1="9" y1="9" x2="9.01" y2="9" />
          <line x1="15" y1="9" x2="15.01" y2="9" />
        </svg>
      </button>

      {/* Horizontal Strip */}
      {isExpanded && (
        <div className="ermis-qr__strip ermis-qr__strip--horizontal" onClick={(e) => e.stopPropagation()}>
          {REACTIONS.map((type) => (
            <button
              key={type}
              className={`ermis-qr__emoji ${isOwnReaction(type) ? 'ermis-qr__emoji--active' : ''}`}
              title={type}
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleReactionToggle(type); setIsExpanded(false); }}
            >
              {EMOJI_MAP[type]}
            </button>
          ))}
          <button
            className="ermis-qr__emoji ermis-qr__emoji--more"
            title="More reactions"
            onClick={handleMoreClick}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="5" r="1.5" fill="currentColor" />
              <circle cx="12" cy="12" r="1.5" fill="currentColor" />
              <circle cx="12" cy="19" r="1.5" fill="currentColor" />
            </svg>
          </button>
        </div>
      )}

      {/* Full emoji picker */}
      {showPicker && (
        <div
          className={`ermis-qr__picker ermis-qr__picker--${pickerPosition} ${isOwnMessage ? 'ermis-qr__picker--own' : ''}`}
          onClick={(e) => e.stopPropagation()}
        >
          <EmojiPickerRoot
            className="isolate flex h-full w-full flex-col bg-white dark:bg-[#1a1828]"
            locale="vi"
            onEmojiSelect={(emoji: any) => {
              handleReactionToggle(emoji.emoji);
              setShowPicker(false);
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
                    <div className="bg-white/90 px-3 pt-3 pb-1.5 font-semibold text-zinc-500 text-xs dark:bg-[#1a1828]/90 dark:text-zinc-400 backdrop-blur-md" {...props}>
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
                      <button className="flex size-9 items-center justify-center rounded-lg text-xl hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors data-[active]:bg-zinc-100 dark:data-[active]:bg-zinc-800" {...safeProps}>
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
