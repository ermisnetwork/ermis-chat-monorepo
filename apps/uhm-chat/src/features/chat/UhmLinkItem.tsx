import React from 'react';
import { ExternalLink, Link as LinkIcon } from 'lucide-react';
import type { AttachmentItem } from '@ermis-network/ermis-chat-react';

export const UhmLinkItem: React.FC<{
  item: AttachmentItem;
}> = React.memo(({ item }) => {
  const handleClick = () => {
    if (item.url) {
      window.open(item.url, '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <div 
      className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-zinc-50 dark:hover:bg-zinc-800/40 transition-colors group cursor-pointer"
      onClick={handleClick}
    >
      <div className="w-10 h-10 rounded-xl bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center text-zinc-500 dark:text-zinc-400 overflow-hidden shrink-0">
        {item.thumb_url ? (
          <img src={item.thumb_url} alt="" className="w-full h-full object-cover" />
        ) : (
          <LinkIcon className="w-5 h-5" />
        )}
      </div>
      
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate">
          {item.title || item.file_name || item.url}
        </div>
        <div className="text-[10px] text-zinc-400 dark:text-zinc-500 truncate">
          {item.url}
        </div>
      </div>
      
      <div className="opacity-0 group-hover:opacity-100 transition-opacity">
        <div className="w-8 h-8 flex items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-all">
          <ExternalLink className="w-4 h-4" />
        </div>
      </div>
    </div>
  );
});

UhmLinkItem.displayName = 'UhmLinkItem';
