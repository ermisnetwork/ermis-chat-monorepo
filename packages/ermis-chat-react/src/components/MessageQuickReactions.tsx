import React, { useCallback, useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
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
    <motion.div 
      ref={containerRef}
      layout
      transition={{ type: "spring", stiffness: 350, damping: 30 }}
      className={`ermis-message-quick-reactions ${isOwnMessage ? 'ermis-message-quick-reactions--own' : ''} ${disabled ? 'ermis-message-quick-reactions--disabled' : ''} ${isExpanded ? 'ermis-message-quick-reactions--expanded' : ''}`}
      style={{
        overflow: 'hidden',
        padding: isExpanded ? 0 : undefined,
        width: isExpanded ? 350 : undefined,
        height: isExpanded ? 368 : undefined,
        borderRadius: isExpanded ? 16 : 20,
        backgroundColor: isExpanded ? 'var(--ermis-bg-primary)' : undefined,
        border: isExpanded ? '1px solid var(--ermis-border)' : undefined,
        boxShadow: isExpanded ? '0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1)' : undefined,
        zIndex: isExpanded ? 101 : 20,
      }}
    >
      <AnimatePresence mode="popLayout">
        {!isExpanded ? (
          <motion.div
            key="quick-reactions"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.15 }}
            style={{ display: 'flex', alignItems: 'center', gap: '2px' }}
          >
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
                setIsExpanded(true);
              }}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-500">
                <line x1="12" y1="5" x2="12" y2="19"></line>
                <line x1="5" y1="12" x2="19" y2="12"></line>
              </svg>
            </button>
          </motion.div>
        ) : (
          <motion.div
            key="full-picker"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.2 }}
            style={{ width: '100%', height: '100%' }}
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
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
});

MessageQuickReactions.displayName = 'MessageQuickReactions';
