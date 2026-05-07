import React, { useState } from 'react';
import { Dropdown } from '@ermis-network/ermis-chat-react';
import type { ChannelInfoMemberItemProps } from '@ermis-network/ermis-chat-react';
import { CHANNEL_ROLES } from '@ermis-network/ermis-chat-react';
import { MoreVertical, Shield, UserMinus, Ban, UserCheck, ShieldAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export const UhmMemberItem: React.FC<ChannelInfoMemberItemProps> = React.memo(({
  member, AvatarComponent,
  onRemove, canRemove,
  onBan, canBan,
  onUnban, canUnban,
  onPromote, canPromote,
  onDemote, canDemote
}) => {
  const { t } = useTranslation();
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const isOpen = anchorRect !== null;

  if (!member) return null;
  const role = member.channel_role || CHANNEL_ROLES.MEMBER;
  const hasActions = canRemove || canBan || canUnban || canPromote || canDemote;

  const isOwner = role === CHANNEL_ROLES.OWNER;
  const isModer = role === CHANNEL_ROLES.MODERATOR;

  return (
    <div className="flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-zinc-50 dark:hover:bg-zinc-800/40 transition-colors group">
      <AvatarComponent
        image={member.user?.avatar}
        name={member.user?.name || member.user?.id}
        size={36}
      />

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate">
            {member.user?.name || member.user?.id}
          </span>
          {isOwner && (
            <ShieldAlert className="w-3.5 h-3.5 text-amber-500 shrink-0" />
          )}
          {isModer && (
            <Shield className="w-3.5 h-3.5 text-blue-500 shrink-0" />
          )}
        </div>
        <span className="text-[10px] uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
          {isOwner ? t('roles.owner', 'Chủ sở hữu') : isModer ? t('roles.moder', 'Quản trị viên') : t('roles.member', 'Thành viên')}
        </span>
      </div>

      {hasActions && (
        <div className="opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            className="w-8 h-8 flex items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-all"
            onClick={(e) => {
              e.stopPropagation();
              setAnchorRect(e.currentTarget.getBoundingClientRect());
            }}
          >
            <MoreVertical className="w-4 h-4" />
          </button>

          <Dropdown
            isOpen={isOpen}
            anchorRect={anchorRect}
            onClose={() => setAnchorRect(null)}
            align="right"
          >
            <div className="flex flex-col p-1 min-w-[160px]">
              {canPromote && onPromote && (
                <button
                  className="flex items-center gap-2 px-3 py-2 text-xs font-medium rounded-lg text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                  onClick={() => { onPromote(member.user?.id || member.user_id); setAnchorRect(null); }}
                >
                  <Shield className="w-3.5 h-3.5" />
                  {t('actions_member.promote_moder', 'Thăng cấp Quản trị')}
                </button>
              )}
              {canDemote && onDemote && (
                <button
                  className="flex items-center gap-2 px-3 py-2 text-xs font-medium rounded-lg text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                  onClick={() => { onDemote(member.user?.id || member.user_id); setAnchorRect(null); }}
                >
                  <UserCheck className="w-3.5 h-3.5" />
                  {t('actions_member.demote_member', 'Gỡ tư cách Quản trị')}
                </button>
              )}
              {canUnban && onUnban && (
                <button
                  className="flex items-center gap-2 px-3 py-2 text-xs font-medium rounded-lg text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                  onClick={() => { onUnban(member.user?.id || member.user_id); setAnchorRect(null); }}
                >
                  <UserCheck className="w-3.5 h-3.5" />
                  {t('actions_member.unban_member', 'Gỡ chặn thành viên')}
                </button>
              )}

              <div className="h-px bg-zinc-100 dark:bg-zinc-800 my-1" />

              {canBan && onBan && (
                <button
                  className="flex items-center gap-2 px-3 py-2 text-xs font-medium rounded-lg text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors"
                  onClick={() => { onBan(member.user?.id || member.user_id); setAnchorRect(null); }}
                >
                  <Ban className="w-3.5 h-3.5" />
                  {t('actions_member.ban_member', 'Chặn vĩnh viễn')}
                </button>
              )}
              {canRemove && onRemove && (
                <button
                  className="flex items-center gap-2 px-3 py-2 text-xs font-medium rounded-lg text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors"
                  onClick={() => { onRemove(member.user?.id || member.user_id); setAnchorRect(null); }}
                >
                  <UserMinus className="w-3.5 h-3.5" />
                  {t('actions_member.remove_member', 'Mời ra khỏi nhóm')}
                </button>
              )}
            </div>
          </Dropdown>
        </div>
      )}
    </div>
  );
});

UhmMemberItem.displayName = 'UhmMemberItem';
