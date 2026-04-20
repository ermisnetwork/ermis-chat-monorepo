import React, { useState, useCallback, useMemo } from 'react';
import type { Channel } from '@ermis-network/ermis-chat-sdk';
import type { ChannelAction, ChannelActionsProps } from '../types';
import { Dropdown } from './Dropdown';

/* ----------------------------------------------------------
   SVG Icons for default actions
   ---------------------------------------------------------- */
const PinIcon = () => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="17" x2="12" y2="22" /><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 11.24V6a3 3 0 0 0-6 0v5.24a2 2 0 0 1-1.11 1.31l-1.78.9A2 2 0 0 0 5 15.24Z" /></svg>);
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
  },
): ChannelAction[] {
  const actions: ChannelAction[] = [];
  if (!currentUserId) return actions;

  const isDirect = channel.type === 'messaging';
  const isTeam = channel.type === 'team';
  const isTopic = channel.type === 'topic' || Boolean(channel.data?.parent_cid);
  const isClosed = channel.data?.is_closed_topic === true;

  const ms = channel.state?.members?.[currentUserId] || channel.state?.membership;
  const role = ms?.channel_role || (ms as any)?.role;
  const isBlocked = options?.isBlocked !== undefined ? options.isBlocked : (ms as any)?.blocked;
  const isPinned = false;

  // Pin / Unpin — available for all channel types
  actions.push({
    id: isPinned ? 'unpin' : 'pin',
    label: isPinned ? (isTopic ? 'Unpin topic' : 'Unpin channel') : (isTopic ? 'Pin topic' : 'Pin channel'),
    icon: <PinIcon />,
    onClick: async (ch) => {
      // TODO: Implement pin/unpin logic
    },
  });

  if (isDirect) {
    // Direct channel: Block / Unblock
    actions.push({
      id: isBlocked ? 'unblock' : 'block',
      label: isBlocked ? 'Unblock user' : 'Block user',
      icon: <BlockIcon />,
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
    if (role === 'owner' || role === 'moder') {
      actions.push({
        id: 'edit_topic',
        label: 'Edit topic',
        icon: <EditIcon />,
        onClick: (ch) => {
          options?.onEditTopic?.(ch);
        },
      });
    }
    // Topic: Close / Reopen (owner & moder only)
    if (role === 'owner' || role === 'moder') {
      actions.push({
        id: isClosed ? 'reopen' : 'close',
        label: isClosed ? 'Reopen topic' : 'Close topic',
        icon: isClosed ? <UnlockIcon /> : <LockIcon />,
        isDanger: !isClosed,
        onClick: (ch) => {
          options?.onToggleCloseTopic?.(ch, isClosed);
        },
      });
    }
  } else if (isTeam) {
    // Team channel: Create Topic (owner & moder, only if topics enabled)
    const hasTopicsEnabled = Boolean(channel.data?.topics_enabled);
    if (hasTopicsEnabled && (role === 'owner' || role === 'moder') && options?.onAddTopic) {
      actions.push({
        id: 'create_topic',
        label: 'Create topic',
        icon: <CreateTopicIcon />,
        onClick: (ch) => { options.onAddTopic!(ch); },
      });
    }
    if (role === 'owner') {
      actions.push({
        id: 'delete',
        label: 'Delete channel',
        icon: <TrashIcon />,
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
    if (role === 'moder' || role === 'member') {
      actions.push({
        id: 'leave',
        label: 'Leave channel',
        icon: <LeaveIcon />,
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
