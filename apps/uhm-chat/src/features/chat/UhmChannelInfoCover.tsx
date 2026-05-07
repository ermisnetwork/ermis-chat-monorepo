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
    <div className="relative p-4 flex flex-col items-center bg-white dark:bg-[#1a1828] border-b border-zinc-100 dark:border-zinc-800/50 overflow-hidden">
      {/* Background Subtle Gradient/Pattern */}
      <div className="absolute inset-0 bg-gradient-to-b from-zinc-50/50 to-transparent dark:from-white/[0.02] dark:to-transparent pointer-events-none" />

      {/* Action Area (Top Right) */}
      {canEdit && (
        <button
          onClick={onEditClick}
          className="absolute top-4 right-4 p-2 rounded-full text-zinc-400 hover:text-primary hover:bg-primary/5 transition-all active:scale-95 z-10"
          title={t('edit.edit_btn')}
        >
          <Pencil className="w-4 h-4" />
        </button>
      )}

      {/* Avatar with Status Badge */}
      <div className="relative shrink-0 z-10">
        <div
          onClick={() => isActualImage && setIsLightboxOpen(true)}
          className={`relative p-1 bg-white dark:bg-zinc-900 rounded-full shadow-sm border border-zinc-200/60 dark:border-zinc-700/50 group/avatar ${isActualImage ? 'cursor-pointer' : ''}`}
        >
          {isEmojiTopic ? (
            <div className="w-20 h-20 flex items-center justify-center text-4xl select-none bg-zinc-50 dark:bg-zinc-800/50 rounded-full shadow-inner">
              {emoji}
            </div>
          ) : (
            <AvatarComponent
              image={channelImage}
              name={channelName}
              size={80}
              className="rounded-full !w-20 !h-20 object-cover transition-all group-hover/avatar:brightness-90"
              disableLightbox
            />
          )}

          {/* Zoom Indicator Overlay (Only for real images) */}
          {isActualImage && (
            <div className="absolute inset-1 rounded-full bg-black/20 opacity-0 group-hover/avatar:opacity-100 transition-opacity flex items-center justify-center pointer-events-none">
              <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v3m0 0v3m0-3h3m-3 0H7" />
              </svg>
            </div>
          )}
        </div>

        {/* Status Badge (Bottom-Right) */}
        {isTeamChannel && !isTopic && (
          <div className={`absolute bottom-0.5 right-0.5 p-1.5 rounded-full border-2 border-white dark:border-[#1a1828] shadow-md z-10 ${isPublic
              ? 'bg-blue-500 text-white'
              : 'bg-zinc-500 text-white'
            }`}>
            {isPublic ? <Globe className="w-2.5 h-2.5" /> : <Lock className="w-2.5 h-2.5" />}
          </div>
        )}
      </div>

      {/* Main Info Area */}
      <div className="mt-4 flex flex-col items-center text-center z-10 w-full px-4">
        <h2 className="text-base font-bold text-zinc-900 dark:text-white leading-snug line-clamp-2">
          {channelName}
        </h2>

        <div className="flex flex-col items-center gap-1 mt-1.5">
          {/* Topic Parent Info */}
          {isTopic && parentChannelName && (
            <div className="flex items-center gap-1 px-2 py-0.5 bg-zinc-100 dark:bg-zinc-800 rounded-full text-[10px] font-bold text-zinc-500 dark:text-zinc-400 uppercase tracking-tight">
              <Hash className="w-2.5 h-2.5" />
              <span>{parentChannelName}</span>
            </div>
          )}

          {channelDescription ? (
            <p className="text-xs text-zinc-500 dark:text-zinc-400 leading-normal italic line-clamp-3">
              {channelDescription}
            </p>
          ) : isTeamChannel && !isTopic && (
            <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 px-2 py-0.5 rounded border border-zinc-100 dark:border-zinc-800">
              {isPublic ? t('system_messages.public') : t('system_messages.private')}
            </span>
          )}
        </div>
      </div>

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
