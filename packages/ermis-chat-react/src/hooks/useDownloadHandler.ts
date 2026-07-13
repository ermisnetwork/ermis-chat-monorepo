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
      console.warn('Download via blob failed, falling back to direct link:', err);
      // Fallback: use an <a> tag with download attribute instead of window.open
      // This triggers a file download rather than navigating to a new tab
      const a = document.createElement('a');
      a.style.display = 'none';
      a.href = url;
      a.download = filename || 'file';
      a.rel = 'noopener noreferrer';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        if (document.body.contains(a)) {
          document.body.removeChild(a);
        }
      }, 1000);
    }
  }, [client]);

  return { downloadFile };
};
