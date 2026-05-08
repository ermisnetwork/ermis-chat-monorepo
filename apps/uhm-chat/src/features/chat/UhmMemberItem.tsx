import React, { useState } from 'react';
import { Dropdown } from '@ermis-network/ermis-chat-react';
import type { ChannelInfoMemberItemProps } from '@ermis-network/ermis-chat-react';
import { CHANNEL_ROLES } from '@ermis-network/ermis-chat-react';
import { MoreVertical, Shield, UserMinus, Ban, UserCheck, ShieldAlert, ShieldPlus, ShieldMinus, UserX, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export const UhmMemberItem: React.FC<ChannelInfoMemberItemProps> = React.memo(({
  member, AvatarComponent,
  onRemove, canRemove,
  onBan, canBan,
  onUnban, canUnban,
  onPromote, canPromote,
  onDemote, canDemote,
  roleLabels
}) => {
  const { t } = useTranslation();
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const isOpen = anchorRect !== null;

  if (!member) return null;
  const role = (member.channel_role || CHANNEL_ROLES.MEMBER).toLowerCase();
  const hasActions = canRemove || canBan || canUnban || canPromote || canDemote;

  const isOwner = role === CHANNEL_ROLES.OWNER;
  const isModer = role === CHANNEL_ROLES.MODERATOR;
  const isPending = role === CHANNEL_ROLES.PENDING;

  const roleLabel = (roleLabels && roleLabels[role]) ||
    (isOwner ? t('roles.owner') :
      isModer ? t('roles.moder') :
        isPending ? t('roles.pending') :
          t('roles.member'));

  return (
    <div className={`flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-zinc-50 dark:hover:bg-zinc-800/40 transition-colors group ${isPending ? 'opacity-70' : ''}`}>
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
          {roleLabel}
        </span>
      </div>

      {hasActions && (
        <div className={isOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 transition-opacity'}>
          <button
            className={`w-8 h-8 flex items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-all active:scale-95 ${isOpen ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 shadow-sm' : ''}`}
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
            <div className="flex flex-col p-1 min-w-[200px] bg-white dark:bg-[#1a1828] rounded-xl shadow-2xl backdrop-blur-xl">
              {/* Group 1: Role Management */}
              {(canPromote || canDemote) && (
                <button
                  className={`flex items-center gap-2.5 px-3 py-2.5 text-[13px] font-medium rounded-lg transition-all group/item ${canPromote
                    ? 'text-zinc-700 dark:text-zinc-300 hover:bg-blue-50 dark:hover:bg-blue-500/10 hover:text-blue-600 dark:hover:text-blue-400'
                    : 'text-zinc-700 dark:text-zinc-300 hover:bg-amber-50 dark:hover:bg-amber-500/10 hover:text-amber-600 dark:hover:text-amber-400'
                    }`}
                  onClick={() => {
                    const id = member.user?.id || member.user_id;
                    if (canPromote && onPromote) onPromote(id);
                    else if (canDemote && onDemote) onDemote(id);
                    setAnchorRect(null);
                  }}
                >
                  {canPromote ? (
                    <ShieldPlus className="w-4 h-4 text-zinc-400 group-hover/item:text-blue-500 transition-colors" />
                  ) : (
                    <ShieldMinus className="w-4 h-4 text-zinc-400 group-hover/item:text-amber-500 transition-colors" />
                  )}
                  {canPromote ? t('actions_member.promote_moder') : t('actions_member.demote_member')}
                </button>
              )}

              {/* Group 2: Safety & Moderation */}
              {(canBan || canUnban) && (
                <button
                  className={`flex items-center gap-2.5 px-3 py-2.5 text-[13px] font-medium rounded-lg transition-all group/item ${!member.banned
                    ? 'text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10'
                    : 'text-zinc-700 dark:text-zinc-300 hover:bg-emerald-50 dark:hover:bg-emerald-500/10 hover:text-emerald-600 dark:hover:text-emerald-400'
                    }`}
                  onClick={() => {
                    const id = member.user?.id || member.user_id;
                    if (!member.banned && onBan) onBan(id);
                    else if (member.banned && onUnban) onUnban(id);
                    setAnchorRect(null);
                  }}
                >
                  {!member.banned ? (
                    <UserX className="w-4 h-4 text-red-400 group-hover/item:text-red-500 transition-colors" />
                  ) : (
                    <UserCheck className="w-4 h-4 text-zinc-400 group-hover/item:text-emerald-500 transition-colors" />
                  )}
                  {!member.banned ? t('actions_member.ban_member') : t('actions_member.unban_member')}
                </button>
              )}
              {canRemove && onRemove && (
                <button
                  className="flex items-center gap-2.5 px-3 py-2.5 text-[13px] font-medium rounded-lg text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-all group/item"
                  onClick={() => { onRemove(member.user?.id || member.user_id); setAnchorRect(null); }}
                >
                  <Trash2 className="w-4 h-4 text-red-400 group-hover/item:text-red-500 transition-colors" />
                  {t('actions_member.remove_member')}
                </button>
              )}
            </div>
          </Dropdown>
        </div>
      )}
    </div>
  );
}, (prev, next) => {
  return (
    prev.member?.banned === next.member?.banned &&
    prev.member?.user?.banned === next.member?.user?.banned &&
    prev.member?.channel_role === next.member?.channel_role &&
    prev.member?.user?.id === next.member?.user?.id &&
    prev.member?.user?.name === next.member?.user?.name &&
    prev.canRemove === next.canRemove &&
    prev.canBan === next.canBan &&
    prev.canUnban === next.canUnban &&
    prev.canPromote === next.canPromote &&
    prev.canDemote === next.canDemote &&
    prev.roleLabels === next.roleLabels &&
    prev.AvatarComponent === next.AvatarComponent
  );
});

UhmMemberItem.displayName = 'UhmMemberItem';
