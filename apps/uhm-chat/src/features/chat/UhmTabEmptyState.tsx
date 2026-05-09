import React from 'react';
import { useTranslation } from 'react-i18next';
import { Image, Link, FileText, Users } from 'lucide-react';

export const UhmTabEmptyState: React.FC<{ label: string }> = React.memo(({ label }) => {
  const { t } = useTranslation();

  const renderIcon = () => {
    const iconProps = { className: "w-8 h-8 text-zinc-300 dark:text-zinc-600", strokeWidth: 1.5 };
    switch (label) {
      case 'media':
        return <Image {...iconProps} />;
      case 'links':
        return <Link {...iconProps} />;
      case 'files':
        return <FileText {...iconProps} />;
      case 'members':
        return <Users {...iconProps} />;
      default:
        return null;
    }
  };

  return (
    <div className="flex flex-col items-center justify-center p-8 text-center h-full min-h-[200px]">
      <div className="mb-4 p-4 rounded-full bg-zinc-50 dark:bg-zinc-800/50">
        {renderIcon()}
      </div>
      <span className="text-sm text-zinc-500 dark:text-zinc-400 font-medium">
        {t(`chat.info_empty_${label}`)}
      </span>
    </div>
  );
});

UhmTabEmptyState.displayName = 'UhmTabEmptyState';
