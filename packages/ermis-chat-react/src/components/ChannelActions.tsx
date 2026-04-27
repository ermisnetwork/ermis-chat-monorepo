import React, { useState, useCallback, useMemo } from 'react';
import type { Channel } from '@ermis-network/ermis-chat-sdk';
import type { ChannelAction, ChannelActionLabels, ChannelActionIcons, ChannelActionsProps } from '../types';
import { Dropdown } from './Dropdown';
import { isDirectChannel, isGroupChannel, isTopicChannel } from '../channelTypeUtils';
import { canManageChannel, CHANNEL_ROLES } from '../channelRoleUtils';

/* ----------------------------------------------------------
   SVG Icons for default actions
   ---------------------------------------------------------- */
const PinIcon = () => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 4.5l-4 4l-4 1.5l-1.5 1.5l7 7l1.5 -1.5l1.5 -4l4 -4" /><path d="M9 15l-4.5 4.5" /><path d="M14.5 4l5.5 5.5" /></svg>);
const UnpinIcon = () => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 4.5l-4 4l-4 1.5l-1.5 1.5l7 7l1.5 -1.5l1.5 -4l4 -4" /><path d="M9 15l-4.5 4.5" /><path d="M14.5 4l5.5 5.5" /><line x1="3" y1="3" x2="21" y2="21" /></svg>);
const BlockIcon = () => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="4.93" y1="4.93" x2="19.07" y2="19.07" /></svg>);
const LeaveIcon = () => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></svg>);
const TrashIcon = () => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>);
const LockIcon = () => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>);
const UnlockIcon = () => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 9.9-1" /></svg>);
const CreateTopicIcon = () => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>);
const EditIcon = () => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>);
const MoreIcon = () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" /></svg>);

/* ----------------------------------------------------------
   computeDefaultActions
   Derives a list of ChannelAction[] based on channel type
   and the current user's role. Currently actions only log
   to console — real API calls will be wired later.
   ---------------------------------------------------------- */
export function computeDefaultActions(
  channel: Channel,
  currentUserId?: string,
  options?: {
    onAddTopic?: (channel: Channel) => void;
    onEditTopic?: (channel: Channel) => void;
    onToggleCloseTopic?: (channel: Channel, isClosed: boolean) => void;
    isBlocked?: boolean;
    actionLabels?: ChannelActionLabels;
    actionIcons?: ChannelActionIcons;
  },
): ChannelAction[] {
  const actions: ChannelAction[] = [];
  if (!currentUserId) return actions;

  const isDirect = isDirectChannel(channel);
  const isTeamOrMeeting = isGroupChannel(channel);
  const isTopic = isTopicChannel(channel);
  const isClosed = channel.data?.is_closed_topic === true;

  const ms = channel.state?.members?.[currentUserId] || channel.state?.membership;
  const role = ms?.channel_role;
  const isBlocked = options?.isBlocked !== undefined ? options.isBlocked : (ms as any)?.blocked;
  const isPinned = channel.data?.is_pinned === true;

  // Pin / Unpin — available for all channel types
  const actionLabels = options?.actionLabels;

  const pinLabel = isPinned
    ? (isTopic ? (actionLabels?.unpinTopic || 'Unpin topic') : (actionLabels?.unpinChannel || 'Unpin channel'))
    : (isTopic ? (actionLabels?.pinTopic || 'Pin topic') : (actionLabels?.pinChannel || 'Pin channel'));

  const actionIcons = options?.actionIcons;

  const pinIcon = isPinned
    ? (actionIcons?.UnpinIcon || <UnpinIcon />)
    : (actionIcons?.PinIcon || <PinIcon />);

  actions.push({
    id: isPinned ? 'unpin' : 'pin',
    label: pinLabel,
    icon: pinIcon,
    onClick: async (ch) => {
      try {
        if (isPinned) {
          await ch.unpin();
        } else {
          await ch.pin();
        }
      } catch (e) {
        console.error('Error toggling pin state', e);
      }
    },
  });

  if (isDirect) {
    // Direct channel: Block / Unblock
    actions.push({
      id: isBlocked ? 'unblock' : 'block',
      label: isBlocked ? (actionLabels?.unblockUser || 'Unblock user') : (actionLabels?.blockUser || 'Block user'),
      icon: isBlocked ? (actionIcons?.UnblockIcon || <BlockIcon />) : (actionIcons?.BlockIcon || <BlockIcon />),
      isDanger: !isBlocked,
      onClick: async (ch) => {
        try {
          if (isBlocked) {
            await ch.unblockUser();
          } else {
            await ch.blockUser();
          }
        } catch (e) {
          console.error('Error toggling block state', e);
        }
      },
    });
  } else if (isTopic) {
    // Topic: Edit topic (owner & moder only)
    if (canManageChannel(role)) {
      actions.push({
        id: 'edit_topic',
        label: actionLabels?.editTopic || 'Edit topic',
        icon: actionIcons?.EditTopicIcon || <EditIcon />,
        onClick: (ch) => {
          options?.onEditTopic?.(ch);
        },
      });
    }
    // Topic: Close / Reopen (owner & moder only)
    if (canManageChannel(role)) {
      actions.push({
        id: isClosed ? 'reopen' : 'close',
        label: isClosed ? (actionLabels?.reopenTopic || 'Reopen topic') : (actionLabels?.closeTopic || 'Close topic'),
        icon: isClosed ? (actionIcons?.ReopenTopicIcon || <UnlockIcon />) : (actionIcons?.CloseTopicIcon || <LockIcon />),
        isDanger: !isClosed,
        onClick: async (ch) => {
          if (options?.onToggleCloseTopic) {
            options.onToggleCloseTopic(ch, isClosed);
            return;
          }
          // Default behavior: call SDK API directly
          const parentCid = ch.data?.parent_cid as string | undefined;
          if (!parentCid) return;
          try {
            const client = ch.getClient();
            const parentChannel = client.activeChannels[parentCid];
            if (!parentChannel) return;
            if (isClosed) {
              await parentChannel.reopenTopic(ch.cid);
            } else {
              await parentChannel.closeTopic(ch.cid);
            }
          } catch (err) {
            console.error('Failed to toggle topic close state', err);
          }
        },
      });
    }
  } else if (isTeamOrMeeting) {
    // Team channel: Create Topic (owner & moder, only if topics enabled)
    const hasTopicsEnabled = Boolean(channel.data?.topics_enabled);
    if (hasTopicsEnabled && canManageChannel(role) && options?.onAddTopic) {
      actions.push({
        id: 'create_topic',
        label: actionLabels?.createTopic || 'Create topic',
        icon: actionIcons?.CreateTopicIcon || <CreateTopicIcon />,
        onClick: (ch) => { options.onAddTopic!(ch); },
      });
    }
    if (role === CHANNEL_ROLES.OWNER) {
      actions.push({
        id: 'delete',
        label: actionLabels?.deleteChannel || 'Delete channel',
        icon: actionIcons?.DeleteChannelIcon || <TrashIcon />,
        isDanger: true,
        onClick: async (ch) => {
          try {
            await ch.delete();
          } catch (e) {
            console.error('Error deleting channel', e);
          }
        },
      });
    }
    if (role === CHANNEL_ROLES.MODERATOR || role === CHANNEL_ROLES.MEMBER) {
      actions.push({
        id: 'leave',
        label: actionLabels?.leaveChannel || 'Leave channel',
        icon: actionIcons?.LeaveChannelIcon || <LeaveIcon />,
        isDanger: true,
        onClick: async (ch) => {
          try {
            await ch.removeMembers([currentUserId]);
          } catch (e) {
            console.error('Error leaving channel', e);
          }
        },
      });
    }
  }

  return actions;
}

/* ----------------------------------------------------------
   DefaultChannelActions
   The default UI component that renders the "more" trigger
   button and the dropdown menu. Consumer can fully replace
   this via ChannelActionsComponent prop.
   ---------------------------------------------------------- */
export const DefaultChannelActions: React.FC<ChannelActionsProps> = React.memo(({ channel, actions, onClose }) => {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);

  const handleActionsClick = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    setAnchorRect(e.currentTarget.getBoundingClientRect());
    setDropdownOpen(true);
  }, []);

  const handleClose = useCallback(() => {
    setDropdownOpen(false);
    setAnchorRect(null);
    onClose();
  }, [onClose]);

  if (!actions || actions.length === 0) return null;

  return (
    <>
      <button
        type="button"
        className={`ermis-channel-list__actions-trigger ${dropdownOpen ? 'ermis-channel-list__actions-trigger--active' : ''}`}
        onClick={handleActionsClick}
        title="More actions"
      >
        <MoreIcon />
      </button>
      <Dropdown
        isOpen={dropdownOpen}
        anchorRect={anchorRect}
        onClose={handleClose}
        align="right"
      >
        <div className="ermis-dropdown__menu">
          {actions.map((action) => (
            <button
              key={action.id}
              className={`ermis-dropdown__item ${action.isDanger ? 'ermis-dropdown__item--danger' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                handleClose();
                action.onClick(channel, e);
              }}
            >
              {action.icon}
              <span>{action.label}</span>
            </button>
          ))}
        </div>
      </Dropdown>
    </>
  );
});

DefaultChannelActions.displayName = 'DefaultChannelActions';
