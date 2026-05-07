import React from 'react';
import { Play } from 'lucide-react';
import type { AttachmentItem } from '@ermis-network/ermis-chat-react';

export const UhmMediaItem: React.FC<{
  item: AttachmentItem;
  onClick: (url: string) => void;
}> = React.memo(({ item, onClick }) => {
  const isVideo = item.attachment_type === 'video';

  return (
    <div 
      className="relative aspect-square cursor-pointer overflow-hidden rounded-xl bg-zinc-100 dark:bg-zinc-800 group"
      onClick={() => onClick(item.url)}
    >
      <img
        src={item.thumb_url || item.url}
        alt={item.file_name}
        className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-110"
      />
      {isVideo && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/20 group-hover:bg-black/30 transition-colors">
          <div className="w-8 h-8 flex items-center justify-center rounded-full bg-white/20 backdrop-blur-md border border-white/30">
            <Play className="w-4 h-4 text-white fill-current" />
          </div>
        </div>
      )}
      <div className="absolute inset-0 ring-1 ring-inset ring-black/5 rounded-xl pointer-events-none" />
    </div>
  );
});

UhmMediaItem.displayName = 'UhmMediaItem';
