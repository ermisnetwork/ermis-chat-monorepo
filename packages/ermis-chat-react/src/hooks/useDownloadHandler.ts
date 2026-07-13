import { useCallback } from 'react';
import { useChatClient } from './useChatClient';

export const useDownloadHandler = () => {
  const { client } = useChatClient();

  const downloadFile = useCallback(async (url: string | undefined, filename?: string) => {
    if (!url) return;

    try {
      const blob = await client.downloadMedia(url);
      const urlBlob = window.URL.createObjectURL(blob);
      
      const a = document.createElement('a');
      a.style.display = 'none';
      a.href = urlBlob;
      a.download = filename || 'file';
      document.body.appendChild(a);
      
      a.click();
      
      // Cleanup after a delay to ensure the browser has started the download
      setTimeout(() => {
        if (document.body.contains(a)) {
          document.body.removeChild(a);
        }
        window.URL.revokeObjectURL(urlBlob);
      }, 1000);
    } catch (err) {
      // Fallback: trigger a direct download via <a> tag without opening a new tab.
      // This keeps the user on the same page even when fetch-based download fails.
      console.warn('Blob download failed, falling back to direct anchor download:', err);
      try {
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = filename || 'file';
        // Force download attribute — prevents navigation for same-origin URLs
        a.target = '_self';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          if (document.body.contains(a)) {
            document.body.removeChild(a);
          }
        }, 500);
      } catch {
        // Last resort: nothing we can do, just log
        console.error('All download methods failed for:', url);
      }
    }
  }, [client]);

  return { downloadFile };
};
