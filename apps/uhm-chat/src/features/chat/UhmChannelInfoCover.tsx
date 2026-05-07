import React from 'react';
import { Pencil, Globe, Lock, Hash } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Avatar, MediaLightbox } from '@ermis-network/ermis-chat-react';
import type { ChannelInfoCoverProps } from '@ermis-network/ermis-chat-react';

export const UhmChannelInfoCover: React.FC<ChannelInfoCoverProps> = React.memo(({
  channelName,
  channelImage,
  channelDescription,
  AvatarComponent = Avatar,
  canEdit,
  onEditClick,
  isPublic,
  parentChannelName,
  isTopic,
  isTeamChannel,
}) => {
  const { t } = useTranslation();
  const [isLightboxOpen, setIsLightboxOpen] = React.useState(false);

  // Logic to handle Emoji topics
  const isEmojiTopic = channelImage?.startsWith('emoji://');
  const emoji = isEmojiTopic ? channelImage?.replace('emoji://', '') : null;
  const isActualImage = channelImage && !isEmojiTopic;

  return (
    <div className="relative py-3.5 px-4 flex items-center gap-3 bg-white dark:bg-[#1a1828] border-b border-zinc-100 dark:border-zinc-800/50">
      {/* Avatar with Status Badge Only */}
      <div className="relative shrink-0">
        <div 
          onClick={() => isActualImage && setIsLightboxOpen(true)}
          className={`relative p-0.5 bg-zinc-50 dark:bg-zinc-800/50 rounded-full border border-zinc-100 dark:border-zinc-700/50 group/avatar ${isActualImage ? 'cursor-pointer' : ''}`}
        >
          {isEmojiTopic ? (
            <div className="w-12 h-12 flex items-center justify-center text-2xl select-none bg-white dark:bg-[#1a1828] rounded-full shadow-inner">
              {emoji}
            </div>
          ) : (
            <AvatarComponent 
              image={channelImage} 
              name={channelName} 
              size={48} 
              className="rounded-full !w-12 !h-12 object-cover transition-all group-hover/avatar:brightness-75" 
              disableLightbox 
            />
          )}
          
          {/* Zoom Indicator Overlay (Only for real images) */}
          {isActualImage && (
            <div className="absolute inset-0.5 rounded-full bg-black/20 opacity-0 group-hover/avatar:opacity-100 transition-opacity flex items-center justify-center pointer-events-none">
              <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v3m0 0v3m0-3h3m-3 0H7" />
              </svg>
            </div>
          )}
        </div>

        {/* Status Badge (Bottom-Right) */}
        {isTeamChannel && !isTopic && (
          <div className={`absolute -bottom-0.5 -right-0.5 p-1 rounded-full border-2 border-white dark:border-[#1a1828] shadow-sm z-10 ${
            isPublic 
            ? 'bg-blue-500 text-white' 
            : 'bg-zinc-500 text-white'
          }`}>
            {isPublic ? <Globe className="w-2 h-2" /> : <Lock className="w-2 h-2" />}
          </div>
        )}
      </div>

      {/* Main Info Column */}
      <div className="flex-1 min-w-0 flex flex-col justify-center">
        <h2 className="text-sm font-bold text-zinc-900 dark:text-white truncate leading-tight">
          {channelName}
        </h2>

        <div className="flex flex-col gap-0.5 mt-0.5">
          {/* Topic Parent Info */}
          {isTopic && parentChannelName && (
            <div className="flex items-center gap-1 text-[10px] font-bold text-zinc-400 truncate uppercase tracking-tight">
              <Hash className="w-2.5 h-2.5 shrink-0" />
              <span>{parentChannelName}</span>
            </div>
          )}

          {channelDescription ? (
            <p className="text-[10px] text-zinc-500 dark:text-zinc-400 truncate leading-tight italic">
              {channelDescription}
            </p>
          ) : isTeamChannel && !isTopic && (
            <span className="text-[9px] font-bold uppercase tracking-widest text-zinc-400/80">
              {isPublic ? t('system_messages.public') : t('system_messages.private')}
            </span>
          )}
        </div>
      </div>

      {/* Action Area (Right Side) */}
      {canEdit && (
        <button
          onClick={onEditClick}
          className="p-2 rounded-full text-zinc-400 hover:text-primary hover:bg-primary/5 transition-all active:scale-95 shrink-0"
          title={t('edit.edit_btn')}
        >
          <Pencil className="w-3.5 h-3.5" />
        </button>
      )}

      {/* Media Lightbox */}
      {isActualImage && (
        <MediaLightbox 
          isOpen={isLightboxOpen}
          onClose={() => setIsLightboxOpen(false)}
          items={[{ type: 'image', src: channelImage, alt: channelName }]}
        />
      )}
    </div>
  );
});

UhmChannelInfoCover.displayName = 'UhmChannelInfoCover';
