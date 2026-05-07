import React from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ChannelInfoHeaderProps } from '@ermis-network/ermis-chat-react';

export const UhmChannelInfoHeader: React.FC<ChannelInfoHeaderProps> = React.memo(({ title, onClose }) => {
  const { t } = useTranslation();

  return (
    <div className="flex items-center justify-between h-[60px] px-4 border-b border-zinc-200/50 dark:border-zinc-800/50 bg-white dark:bg-[#1a1828]">
      <h3 className="text-base font-bold text-zinc-900 dark:text-zinc-100 truncate pr-4">
        {title}
      </h3>
      {onClose && (
        <button
          onClick={onClose}
          aria-label={t('actions.close')}
          className="flex items-center justify-center w-8 h-8 rounded-full text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-700 dark:hover:text-zinc-200 transition-all active:scale-95"
        >
          <X className="w-[20px] h-[20px]" />
        </button>
      )}
    </div>
  );
});

UhmChannelInfoHeader.displayName = 'UhmChannelInfoHeader';
