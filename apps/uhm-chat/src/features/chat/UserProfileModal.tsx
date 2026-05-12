import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageSquare } from 'lucide-react';
import { useChatClient, Avatar, isDirectChannel } from '@ermis-network/ermis-chat-react';
import { UhmModal } from '@/components/custom/UhmModal';
import { Button } from '@/components/ui/button';

interface UserProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
  userId: string | null;
  /** Optional: navigate to DM with this user */
  onSendMessage?: (userId: string) => void;
}

export const UserProfileModal: React.FC<UserProfileModalProps> = ({
  isOpen,
  onClose,
  userId,
  onSendMessage,
}) => {
  const { t } = useTranslation();
  const { client, activeChannel } = useChatClient();

  // Look up user info from current channel members, or from all known channels
  const userInfo = useMemo(() => {
    if (!userId || !client) return null;

    // 1. Try current channel members
    if (activeChannel?.state?.members) {
      const member = activeChannel.state.members[userId];
      if (member?.user) {
        return {
          id: userId,
          name: member.user.name || userId,
          avatar: member.user.avatar,
          role: member.channel_role,
          online: member.user.online,
          lastActive: member.user.last_active,
        };
      }
    }

    // 2. Try to find in any active channel
    for (const cid of Object.keys(client.activeChannels || {})) {
      const ch = client.activeChannels[cid];
      const member = ch?.state?.members?.[userId];
      if (member?.user) {
        return {
          id: userId,
          name: member.user.name || userId,
          avatar: member.user.avatar,
          role: member.channel_role,
          online: member.user.online,
          lastActive: member.user.last_active,
        };
      }
    }

    // 3. Fallback
    return { id: userId, name: userId, avatar: undefined, role: undefined, online: undefined, lastActive: undefined };
  }, [userId, client, activeChannel]);

  const isSelf = userId === client?.userID;

  // Check if a DM already exists with this user
  const existingDm = useMemo(() => {
    if (!userId || !client || isSelf) return null;
    for (const cid of Object.keys(client.activeChannels || {})) {
      const ch = client.activeChannels[cid];
      if (!isDirectChannel(ch)) continue;
      const memberIds = Object.keys(ch.state?.members || {});
      if (memberIds.length === 2 && memberIds.includes(userId) && memberIds.includes(client.userID || '')) {
        return ch;
      }
    }
    return null;
  }, [userId, client, isSelf]);

  if (!userInfo) return null;

  return (
    <UhmModal
      isOpen={isOpen}
      onClose={onClose}
      maxWidth="360px"
    >
      <div className="flex flex-col items-center gap-4 py-4">
        {/* Avatar */}
        <Avatar
          image={userInfo.avatar}
          name={userInfo.name}
          size={80}
          className="ring-4 ring-background shadow-lg"
        />

        {/* Name */}
        <div className="flex flex-col items-center gap-1">
          <h3 className="text-lg font-bold text-zinc-900 dark:text-zinc-100">
            {userInfo.name}
          </h3>
          <span className="text-xs text-zinc-400 dark:text-zinc-500 font-mono">
            @{userInfo.id}
          </span>
        </div>

        {/* Online status */}
        {userInfo.online !== undefined && (
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${userInfo.online ? 'bg-emerald-500' : 'bg-zinc-400'}`} />
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              {userInfo.online ? t('profile.online', 'Online') : t('profile.offline', 'Offline')}
            </span>
          </div>
        )}

        {/* Role badge */}
        {userInfo.role && userInfo.role !== 'member' && (
          <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-[11px] font-semibold uppercase tracking-wider bg-primary/10 text-primary">
            {userInfo.role}
          </span>
        )}

        {/* Actions */}
        {!isSelf && onSendMessage && (
          <Button
            variant="default"
            className="rounded-full px-6 h-10 gap-2 mt-2"
            onClick={() => {
              onSendMessage(userId!);
              onClose();
            }}
          >
            <MessageSquare className="w-4 h-4" />
            {existingDm
              ? t('profile.open_chat', 'Open Chat')
              : t('profile.send_message', 'Send Message')}
          </Button>
        )}
      </div>
    </UhmModal>
  );
};
