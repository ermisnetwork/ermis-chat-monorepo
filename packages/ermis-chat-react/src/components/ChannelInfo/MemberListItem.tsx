import React, { useState } from 'react';
import { Dropdown } from '../Dropdown';
import type { ChannelInfoMemberItemProps } from '../../types';
import { CHANNEL_ROLES } from '../../channelRoleUtils';

export const MemberListItem = React.memo(({
  member, AvatarComponent, 
  onRemove, canRemove, 
  onBan, canBan, 
  onUnban, canUnban, 
  onPromote, canPromote, 
  onDemote, canDemote 
}: ChannelInfoMemberItemProps) => {
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const isOpen = anchorRect !== null;

  if (!member) return null;
  const role = member.channel_role || CHANNEL_ROLES.MEMBER;
  const hasActions = canRemove || canBan || canUnban || canPromote || canDemote;

  return (
    <div className="ermis-channel-info__member-item">
      <AvatarComponent image={member.user?.avatar} name={member.user?.name || member.user?.id} size={36} />
      <div className="ermis-channel-info__member-info">
        <span className="ermis-channel-info__member-name">{member.user?.name || member.user?.id}</span>
        <span className={`ermis-channel-info__member-role ermis-channel-info__member-role--${role.toLowerCase()}`}>
          {role.charAt(0).toUpperCase() + role.slice(1)}
        </span>
      </div>
      
      {hasActions && (
        <>
          <button
            className="ermis-channel-info__member-actions-btn"
            onClick={(e) => {
              e.stopPropagation();
              setAnchorRect(e.currentTarget.getBoundingClientRect());
            }}
            aria-label="Member actions"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="1" />
              <circle cx="12" cy="5" r="1" />
              <circle cx="12" cy="19" r="1" />
            </svg>
          </button>
          
          <Dropdown
            isOpen={isOpen}
            anchorRect={anchorRect}
            onClose={() => setAnchorRect(null)}
            align="right"
          >
            <div className="ermis-dropdown__menu">
              {canPromote && onPromote && (
                <button className="ermis-dropdown__item" onClick={() => { onPromote(member.user?.id || member.user_id); setAnchorRect(null); }}>Promote to Moder</button>
              )}
              {canDemote && onDemote && (
                <button className="ermis-dropdown__item" onClick={() => { onDemote(member.user?.id || member.user_id); setAnchorRect(null); }}>Demote to Member</button>
              )}
              {canBan && onBan && (
                <button className="ermis-dropdown__item ermis-dropdown__item--danger" onClick={() => { onBan(member.user?.id || member.user_id); setAnchorRect(null); }}>Ban Member</button>
              )}
              {canUnban && onUnban && (
                <button className="ermis-dropdown__item" onClick={() => { onUnban(member.user?.id || member.user_id); setAnchorRect(null); }}>Unban Member</button>
              )}
              {canRemove && onRemove && (
                <button className="ermis-dropdown__item ermis-dropdown__item--danger" onClick={() => { onRemove(member.user?.id || member.user_id); setAnchorRect(null); }}>Remove from Channel</button>
              )}
            </div>
          </Dropdown>
        </>
      )}
    </div>
  );
}, (prev, next) => {
  return prev.member?.user_id === next.member?.user_id &&
         prev.member?.channel_role === next.member?.channel_role &&
         prev.member?.banned === next.member?.banned &&
         prev.canRemove === next.canRemove &&
         prev.canBan === next.canBan &&
         prev.canUnban === next.canUnban &&
         prev.canPromote === next.canPromote &&
         prev.canDemote === next.canDemote;
});
(MemberListItem as any).displayName = 'MemberListItem';
