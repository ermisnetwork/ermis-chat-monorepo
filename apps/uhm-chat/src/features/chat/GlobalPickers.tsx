import React, { useEffect, useRef } from 'react';
import data from '@emoji-mart/data';
import Picker from '@emoji-mart/react';
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

  const style: React.CSSProperties = {
    position: 'fixed',
    zIndex: 1000,
    display: pickerAction.type ? 'block' : 'none',
    // Calculate position based on anchorRect
    top: pickerAction.anchorRect ? Math.min(window.innerHeight - 450, Math.max(20, pickerAction.anchorRect.top - 420)) : 0,
    left: pickerAction.anchorRect ? Math.min(window.innerWidth - 370, Math.max(20, pickerAction.anchorRect.left - 20)) : 0,
  };

  return (
    <div 
      ref={containerRef} 
      style={style} 
      className="shadow-2xl rounded-2xl overflow-hidden border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#1a1828] animate-in fade-in zoom-in-95 duration-200"
    >
      {/* Emoji Picker - Always mounted but hidden if not type === 'emoji' */}
      <div style={{ display: pickerAction.type === 'emoji' ? 'block' : 'none' }}>
        <Picker
          data={data}
          onEmojiSelect={(emoji: any) => {
            if (pickerAction.onSelect) {
              pickerAction.onSelect(emoji.native);
            }
            closePickers();
          }}
          locale={i18n.language === 'vi' ? 'vi' : 'en'}
          theme={document.documentElement.classList.contains('dark') ? 'dark' : 'light'}
        />
      </div>

      {/* Sticker Picker - Always mounted in iframe to preload */}
      <div style={{ display: pickerAction.type === 'sticker' ? 'block' : 'none', width: '350px', height: '400px' }}>
        <iframe
          src={stickerIframeUrl}
          className="w-full h-full border-none bg-white dark:bg-[#1a1828]"
          title="Global Sticker Picker"
          sandbox="allow-scripts allow-same-origin"
        />
      </div>
    </div>
  );
};
