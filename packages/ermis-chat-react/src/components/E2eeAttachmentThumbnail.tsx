import React, { useEffect } from 'react';
import type { E2eeAttachmentManifest } from '@ermis-network/ermis-chat-sdk';
import { useChatCore } from '../hooks/useChatCore';
import {
  scheduleE2eePreviewLoad,
  useE2eeAttachmentRenderer,
} from '../hooks/useE2eeAttachmentRenderer';

type E2eeAttachmentThumbnailProps = {
  className: string;
  manifest: E2eeAttachmentManifest;
};

export const E2eeAttachmentThumbnail: React.FC<E2eeAttachmentThumbnailProps> = React.memo(
  ({ className, manifest }) => {
    const { activeChannel } = useChatCore();
    const previewAsset = manifest.assets.find((asset) => asset.kind === 'preview');
    const preview = useE2eeAttachmentRenderer(activeChannel, manifest, 'preview');

    useEffect(() => {
      if (!previewAsset || preview.url || preview.loading || preview.error) return;
      scheduleE2eePreviewLoad(preview.load);
    }, [preview.error, preview.load, preview.loading, preview.url, previewAsset]);

    if (!previewAsset || preview.error) return null;
    if (!preview.url) {
      return (
        <span className={`${className} ${className}--loading`} aria-hidden>
          <span className="ermis-e2ee-attachment-spinner" />
        </span>
      );
    }

    return (
      <img
        className={className}
        src={preview.url}
        alt=""
        loading="lazy"
        draggable={false}
      />
    );
  },
);

E2eeAttachmentThumbnail.displayName = 'E2eeAttachmentThumbnail';
