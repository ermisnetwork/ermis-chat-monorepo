import { useCallback, useState } from 'react';
import type { Channel, E2eeAttachmentManifest } from '@ermis-network/ermis-chat-sdk';

export type E2eeFileUploadProgress = {
  fileIndex: number;
  phase: 'generating_preview' | 'encrypting' | 'uploading' | 'completing';
  loaded: number;
  total: number;
  percentage: number;
};

export function useE2eeFileUpload(channel: Channel | null) {
  const [progress, setProgress] = useState<E2eeFileUploadProgress | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const upload = useCallback(
    async (files: Blob[]): Promise<{ attachments: E2eeAttachmentManifest[]; e2ee_attachment_ids: string[] }> => {
      if (!channel) return { attachments: [], e2ee_attachment_ids: [] };
      const manager = (channel as any).getClient?.().encryptionManager;
      if (!manager?.initialized) throw new Error('E2EE attachments require an initialized encryption manager');
      setUploading(true);
      setError(undefined);
      try {
        return await manager.uploadE2eeAttachments(channel.type, channel.id, files, { onProgress: setProgress });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        throw err;
      } finally {
        setUploading(false);
      }
    },
    [channel],
  );

  return { upload, progress, uploading, error };
}
