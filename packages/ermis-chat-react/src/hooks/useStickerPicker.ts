import { useState, useEffect, useCallback } from 'react';
import type { Channel } from '@ermis-network/ermis-chat-sdk';

export type UseStickerPickerOptions = {
  activeChannel?: Channel | null;
  stickerIframeUrl?: string;
};

export function useStickerPicker({
  activeChannel,
  stickerIframeUrl = 'https://sticker.ermis.network',
}: UseStickerPickerOptions) {
  const [stickerPickerOpen, setStickerPickerOpen] = useState(false);

  const toggleStickerPicker = useCallback(() => {
    setStickerPickerOpen((prev) => !prev);
  }, []);

  const closeStickerPicker = useCallback(() => {
    setStickerPickerOpen(false);
  }, []);

  const handleStickerSend = useCallback(
    async (stickerUrl: string) => {
      if (!activeChannel) return;
      try {
        await activeChannel.sendMessage({
          text: '',
          attachments: [],
          sticker_url: stickerUrl,
        });
        setStickerPickerOpen(false);
      } catch (error) {
        console.error('Failed to send sticker', error);
      }
    },
    [activeChannel],
  );

  useEffect(() => {
    if (!stickerPickerOpen) return;

    const handleMessage = (event: MessageEvent) => {
      const stickerUrl = event.data?.data?.content?.url;
      if (!stickerUrl || typeof stickerUrl !== 'string') return;
      const fullUrl = `${stickerIframeUrl}/${stickerUrl}`;
      handleStickerSend(fullUrl);
    };

    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, [stickerPickerOpen, stickerIframeUrl, handleStickerSend]);

  return {
    stickerPickerOpen,
    toggleStickerPicker,
    closeStickerPicker,
    handleStickerSend,
  };
}
