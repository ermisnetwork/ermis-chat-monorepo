import React, { useEffect, useRef } from 'react';
import { EmojiPicker } from 'frimousse';
import { motion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '@/store/useUIStore';

export const GlobalPickers: React.FC = () => {
  const { pickerAction, closePickers } = useUIStore();
  const { i18n } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const stickerIframeUrl = 'https://sticker.ermis.network';

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (pickerAction.type && containerRef.current && !containerRef.current.contains(event.target as Node)) {
        // Check if the click was on the trigger button to avoid double-toggle
        const target = event.target as HTMLElement;
        if (target.closest('.picker-trigger')) return;
        
        closePickers();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [pickerAction.type, closePickers]);

  // Handle sticker selection from iframe
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // Only handle if sticker picker is conceptually active
      if (pickerAction.type !== 'sticker') return;
      
      const stickerUrl = event.data?.data?.content?.url;
      if (!stickerUrl || typeof stickerUrl !== 'string') return;
      
      const fullUrl = `${stickerIframeUrl}/${stickerUrl}`;
      if (pickerAction.onSelect) {
        pickerAction.onSelect(fullUrl);
      }
      closePickers();
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [pickerAction, closePickers]);

  // Handle Escape key
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePickers();
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [closePickers]);

  const [savedRect, setSavedRect] = React.useState<DOMRect | null>(null);
  const lastType = useRef<'emoji' | 'sticker'>('emoji');

  useEffect(() => {
    if (pickerAction.anchorRect) {
      setSavedRect(pickerAction.anchorRect);
    }
    if (pickerAction.type) {
      lastType.current = pickerAction.type;
    }
  }, [pickerAction.anchorRect, pickerAction.type]);

  const isOpen = !!pickerAction.type;
  const activeRect = pickerAction.anchorRect || savedRect;
  const currentType = pickerAction.type || lastType.current;
  const pickerHeight = currentType === 'sticker' ? 400 : 368;

  const style: React.CSSProperties = {
    position: 'fixed',
    zIndex: 1000,
    top: activeRect ? Math.max(20, activeRect.top - pickerHeight - 16) : -1000,
    left: activeRect ? Math.min(window.innerWidth - 370, Math.max(20, activeRect.left - 20)) : -1000,
    pointerEvents: isOpen ? 'auto' : 'none',
    transformOrigin: 'bottom left',
    willChange: 'transform, opacity'
  };

  return (
    <>
        <motion.div 
          ref={containerRef} 
          style={style} 
          initial={{ opacity: 0, scale: 0.95, y: 10 }}
          animate={{ 
            opacity: isOpen ? 1 : 0, 
            scale: isOpen ? 1 : 0.95,
            y: isOpen ? 0 : 10
          }}
          transition={{ duration: 0.15, ease: "easeOut" }}
          className="shadow-2xl rounded-2xl overflow-hidden border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#1a1828]"
        >
          {/* Emoji Picker */}
          <div style={{ display: currentType === 'emoji' ? 'block' : 'none' }}>
            <EmojiPicker.Root 
              className="isolate flex h-[368px] w-[350px] flex-col bg-white dark:bg-[#1a1828]"
              locale={i18n.language === 'vi' ? 'vi' : 'en'}
              onEmojiSelect={(emoji) => {
                if (pickerAction.onSelect) {
                  pickerAction.onSelect(emoji.emoji);
                }
              }}
            >
              <EmojiPicker.Search className="z-10 mx-3 mt-3 appearance-none rounded-xl bg-zinc-100 px-3 py-2 text-sm dark:bg-zinc-800 dark:text-zinc-100 outline-none focus:ring-2 focus:ring-primary/50" />
              <EmojiPicker.Viewport className="relative flex-1 outline-hidden mt-2">
                <EmojiPicker.Loading className="absolute inset-0 flex items-center justify-center text-zinc-400 text-sm dark:text-zinc-500">
                  {i18n.language === 'vi' ? 'Đang tải…' : 'Loading…'}
                </EmojiPicker.Loading>
                <EmojiPicker.Empty className="absolute inset-0 flex items-center justify-center text-zinc-400 text-sm dark:text-zinc-500">
                  {i18n.language === 'vi' ? 'Không tìm thấy emoji.' : 'No emoji found.'}
                </EmojiPicker.Empty>
                <EmojiPicker.List
                  className="select-none pb-1.5"
                  components={{
                    CategoryHeader: ({ category, ...props }) => (
                      <div
                        className="bg-white/90 px-3 pt-3 pb-1.5 font-semibold text-zinc-500 text-xs dark:bg-[#1a1828]/90 dark:text-zinc-400 backdrop-blur-md"
                        {...props}
                      >
                        {category.label}
                      </div>
                    ),
                    Row: ({ children, ...props }) => (
                      <div className="scroll-my-1.5 px-2 flex justify-between" {...props}>
                        {children}
                      </div>
                    ),
                    Emoji: ({ emoji, ...props }) => (
                      <button
                        className="flex size-9 items-center justify-center rounded-lg text-xl hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors data-[active]:bg-zinc-100 dark:data-[active]:bg-zinc-800"
                        {...props}
                      >
                        {emoji.emoji}
                      </button>
                    ),
                  }}
                />
              </EmojiPicker.Viewport>
            </EmojiPicker.Root>
          </div>

          {/* Sticker Picker */}
          <div style={{ display: currentType === 'sticker' ? 'block' : 'none', width: '350px', height: '400px' }}>
            <iframe
              src={stickerIframeUrl}
              className="w-full h-full border-none bg-white dark:bg-[#1a1828]"
              title="Global Sticker Picker"
              sandbox="allow-scripts allow-same-origin"
            />
          </div>
        </motion.div>
    </>
  );
};
