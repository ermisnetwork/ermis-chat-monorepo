import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageSquare, Mail, Phone, Hash, Copy } from 'lucide-react';
import { useChatClient, Avatar, isDirectChannel, useContactChannels } from '@ermis-network/ermis-chat-react';
import { UhmModal } from '@/components/custom/UhmModal';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';

interface UserProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
  userId: string | null;
  /** Optional: navigate to DM with this user */
  onSendMessage?: (userId: string, existingChannel?: any) => void;
}

export const UserProfileModal: React.FC<UserProfileModalProps> = ({
  isOpen,
  onClose,
  userId,
  onSendMessage,
}) => {
  const { t } = useTranslation();
  const { client, activeChannel } = useChatClient();
  const contacts = useContactChannels();

  const handleCopy = (text: string) => {
    if (text) {
      navigator.clipboard.writeText(text);
      toast.success(t('message_actions.copy_success', 'Copied to clipboard'));
    }
  };

  // Look up user info from current channel members, or from all known channels
  const userInfo = useMemo(() => {
    if (!userId || !client) return null;

    const globalUser = client.state?.users?.[userId];

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
          email: globalUser?.email,
          phone: globalUser?.phone,
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
          email: globalUser?.email,
          phone: globalUser?.phone,
        };
      }
    }

    // 3. Fallback
    return {
      id: userId,
      name: globalUser?.name || userId,
      avatar: globalUser?.avatar,
      role: undefined,
      online: globalUser?.online,
      lastActive: globalUser?.last_active,
      email: globalUser?.email,
      phone: globalUser?.phone
    };
  }, [userId, client, activeChannel]);

  const isSelf = userId === client?.userID;

  // Check if a DM already exists with this user by checking contacts
  const existingDm = useMemo(() => {
    if (!userId || !client || isSelf) return null;
    return contacts.find(ch => {
      if (!isDirectChannel(ch)) return false;
      const memberIds = Object.keys(ch.state?.members || {});
      return memberIds.length === 2 && memberIds.includes(userId) && memberIds.includes(client.userID || '');
    }) || null;
  }, [userId, client, isSelf, contacts]);

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
        </div>

        {/* Contact Info Section */}
        {(userInfo.email || userInfo.phone || userInfo.id) && (
          <div className="w-full space-y-2 mt-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
              {t('profile.contact_info_label', 'Contact Info')}
            </span>
            {userInfo.id && (
              <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-zinc-50 dark:bg-[#1a1828] border border-zinc-200/60 dark:border-zinc-800/60 group">
                <Hash className="w-4 h-4 text-zinc-400 dark:text-zinc-500 shrink-0" />
                <div className="flex flex-col min-w-0 flex-1">
                  <span className="text-[10px] text-zinc-400 dark:text-zinc-500 leading-tight">
                    {t('profile.user_id_label', 'User ID')}
                  </span>
                  <span className="text-xs text-zinc-700 dark:text-zinc-200 break-all font-mono leading-relaxed mt-0.5">
                    {userInfo.id}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => handleCopy(userInfo.id)}
                  className="p-1.5 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-zinc-200 dark:hover:bg-zinc-800 rounded-md text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
                  title={t('message_actions.copy', 'Copy')}
                >
                  <Copy className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
            {userInfo.email && (
              <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-zinc-50 dark:bg-[#1a1828] border border-zinc-200/60 dark:border-zinc-800/60 group">
                <Mail className="w-4 h-4 text-zinc-400 dark:text-zinc-500 shrink-0" />
                <div className="flex flex-col min-w-0 flex-1">
                  <span className="text-[10px] text-zinc-400 dark:text-zinc-500 leading-tight">
                    {t('profile.email_label', 'Email')}
                  </span>
                  <span className="text-sm text-zinc-700 dark:text-zinc-200 truncate">
                    {userInfo.email}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => handleCopy(userInfo.email!)}
                  className="p-1.5 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-zinc-200 dark:hover:bg-zinc-800 rounded-md text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
                  title={t('message_actions.copy', 'Copy')}
                >
                  <Copy className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
            {userInfo.phone && (
              <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-zinc-50 dark:bg-[#1a1828] border border-zinc-200/60 dark:border-zinc-800/60 group">
                <Phone className="w-4 h-4 text-zinc-400 dark:text-zinc-500 shrink-0" />
                <div className="flex flex-col min-w-0 flex-1">
                  <span className="text-[10px] text-zinc-400 dark:text-zinc-500 leading-tight">
                    {t('profile.phone_label', 'Phone')}
                  </span>
                  <span className="text-sm text-zinc-700 dark:text-zinc-200 truncate">
                    {userInfo.phone}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => handleCopy(userInfo.phone!)}
                  className="p-1.5 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-zinc-200 dark:hover:bg-zinc-800 rounded-md text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
                  title={t('message_actions.copy', 'Copy')}
                >
                  <Copy className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>
        )}

        {/* Actions */}
        {!isSelf && onSendMessage && (
          <Button
            variant="default"
            className="rounded-full px-6 h-10 gap-2 mt-2"
            onClick={() => {
              onSendMessage(userId!, existingDm || undefined);
              onClose();
            }}
          >
            <MessageSquare className="w-4 h-4" />
            {existingDm
              ? t('profile.open_chat', 'Open Chat')
              : t('chat.create_channel_message', 'Message')}
          </Button>
        )}
      </div>
    </UhmModal>
  );
};
