import React from 'react';
import { FileText, FileCode, FileArchive, Music, File as FileIcon, Download } from 'lucide-react';
import type { AttachmentItem } from '@ermis-network/ermis-chat-react';

const getUhmFileIcon = (fileName: string) => {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  if (['pdf', 'doc', 'docx', 'txt'].includes(ext)) return FileText;
  if (['zip', 'rar', '7z'].includes(ext)) return FileArchive;
  if (['js', 'ts', 'tsx', 'html', 'css', 'json', 'py'].includes(ext)) return FileCode;
  if (['mp3', 'wav', 'm4a', 'ogg'].includes(ext)) return Music;
  return FileIcon;
};

const formatSize = (bytes?: number) => {
  if (!bytes) return '';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

export const UhmFileItem: React.FC<{
  item: AttachmentItem;
  onClick: (url: string) => void;
}> = React.memo(({ item, onClick }) => {
  const Icon = getUhmFileIcon(item.file_name || '');

  return (
    <div 
      className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-zinc-50 dark:hover:bg-zinc-800/40 transition-colors group cursor-pointer"
      onClick={() => onClick(item.url)}
    >
      <div className="w-10 h-10 rounded-xl bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center text-zinc-500 dark:text-zinc-400">
        <Icon className="w-5 h-5" />
      </div>
      
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate">
          {item.file_name}
        </div>
        <div className="text-[10px] text-zinc-400 dark:text-zinc-500 flex items-center gap-2">
          {formatSize(item.content_length)}
          {item.created_at && (
            <>
              <span className="w-0.5 h-0.5 rounded-full bg-zinc-300 dark:bg-zinc-700" />
              <span>{new Date(item.created_at).toLocaleDateString()}</span>
            </>
          )}
        </div>
      </div>
      
      <div className="opacity-0 group-hover:opacity-100 transition-opacity">
        <div className="w-8 h-8 flex items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-all">
          <Download className="w-4 h-4" />
        </div>
      </div>
    </div>
  );
});

UhmFileItem.displayName = 'UhmFileItem';
