import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Users, Image, Link as LinkIcon, FileText } from 'lucide-react';
import type { ChannelInfoTabHeaderProps, MediaTab } from '@ermis-network/ermis-chat-react';

export const UhmChannelInfoTabHeader: React.FC<ChannelInfoTabHeaderProps> = ({
  activeTab,
  onTabChange,
  availableTabs,
  tabCounts,
}) => {
  const { t } = useTranslation();
  const [indicatorStyle, setIndicatorStyle] = useState({ left: 0, width: 0 });
  const tabsContainerRef = useRef<HTMLDivElement>(null);

  const TabIcon = ({ type }: { type: MediaTab }) => {
    switch (type) {
      case 'members': return <Users className="w-4 h-4" />;
      case 'media': return <Image className="w-4 h-4" />;
      case 'links': return <LinkIcon className="w-4 h-4" />;
      case 'files': return <FileText className="w-4 h-4" />;
      default: return null;
    }
  };

  const getTabLabel = (tab: MediaTab) => {
    switch (tab) {
      case 'members': return t('chat.tabs.members', 'Thành viên');
      case 'media': return t('chat.tabs.media', 'Ảnh & Video');
      case 'links': return t('chat.tabs.links', 'Liên kết');
      case 'files': return t('chat.tabs.files', 'Tệp tin');
      default: return tab;
    }
  };

  // Update sliding indicator position
  useEffect(() => {
    const timer = setTimeout(() => {
      const container = tabsContainerRef.current;
      if (!container) return;
      const activeEl = container.querySelector(`[data-active="true"]`) as HTMLElement;
      if (activeEl) {
        setIndicatorStyle({
          left: activeEl.offsetLeft,
          width: activeEl.offsetWidth,
        });
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [activeTab, availableTabs]);

  return (
    <div 
      ref={tabsContainerRef}
      className="sticky top-0 z-20 bg-white/80 dark:bg-[#1a1828]/80 backdrop-blur-md px-2 py-1.5 border-b border-zinc-100 dark:border-zinc-800/50 flex w-full gap-0.5 overflow-x-auto no-scrollbar relative"
    >
      {/* Sliding Indicator Background */}
      <div 
        className="absolute h-[28px] bg-zinc-100 dark:bg-zinc-800 rounded-lg shadow-sm transition-all duration-300 ease-out pointer-events-none"
        style={{ 
          left: indicatorStyle.left, 
          width: indicatorStyle.width,
          top: '50%',
          transform: 'translateY(-50%)',
          opacity: indicatorStyle.width > 0 ? 1 : 0
        }}
      />

      {availableTabs.map(tab => (
        <button
          key={tab}
          onClick={() => onTabChange(tab)}
          data-active={activeTab === tab}
          className={`
            relative z-10 flex flex-1 justify-center items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold transition-colors duration-200 shrink-0
            ${activeTab === tab 
              ? 'text-zinc-900 dark:text-zinc-100' 
              : 'text-zinc-500 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
            }
          `}
        >
          <TabIcon type={tab} />
          <span>{getTabLabel(tab)}</span>
          {tabCounts[tab] > 0 && (
            <span className={`
              ml-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-bold transition-colors duration-200
              ${activeTab === tab 
                ? 'bg-white dark:bg-zinc-700 text-zinc-500 dark:text-zinc-400' 
                : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-400 dark:text-zinc-500'
              }
            `}>
              {tabCounts[tab]}
            </span>
          )}
        </button>
      ))}
    </div>
  );
};
