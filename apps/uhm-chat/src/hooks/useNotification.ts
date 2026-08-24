import { useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useChatCore, isDirectChannel, isPendingMember, isSkippedMember, getUserDisplayName } from '@ermis-network/ermis-chat-react';
import type { Channel as ChannelType } from '@ermis-network/ermis-chat-sdk';
import { NOTIFICATION_CONFIG } from '@/utils/constants';

const isEffectiveE2eeChannel = (channel: ChannelType | null | undefined, client: any) => {
  if (channel?.data?.mls_enabled === true) return true;
  const parentCid = channel?.data?.parent_cid as string | undefined;
  if (!parentCid) return false;
  return client?.activeChannels?.[parentCid]?.data?.mls_enabled === true;
};

/**
 * Plays a notification sound using the HTML5 Audio API.
 * Returns a function that plays the sound when called.
 */
function createBeepPlayer(): () => void {
  const audio = typeof Audio !== 'undefined' ? new Audio() : null;

  return () => {
    try {
      if (audio) {
        const customSound = localStorage.getItem('custom_notification_sound');
        const src = customSound || '/noti.mp3';
        
        // Only update src if it changed
        if (!audio.src || (audio.src !== src && audio.src !== window.location.origin + src)) {
          audio.src = src;
        }
        
        audio.currentTime = 0;
        audio.play().catch((err) => {
          console.error('Không thể tự động phát âm thanh do chính sách trình duyệt (Autoplay policy) hoặc file bị lỗi:', err);
        });
      }
    } catch (err) {
      console.error('Lỗi khi phát âm thanh:', err);
    }
  };
}

/**
 * Resolves a display name for a channel suitable for notifications.
 * For DM channels, returns the other user's name; otherwise returns the channel name.
 */
function getChannelDisplayName(channel: ChannelType, currentUserId?: string): string {
  if (isDirectChannel(channel) && currentUserId) {
    const otherMember = Object.values(channel.state?.members || {}).find(
      (m) => m.user_id !== currentUserId,
    );
    return getUserDisplayName(otherMember?.user, otherMember?.user?.id || otherMember?.user_id) || channel.cid || 'Unknown';
  }
  return (channel.data?.name as string) || channel.cid || 'Unknown';
}

/**
 * Hook that provides browser push notifications and sound alerts
 * for incoming messages when the user is not viewing the source channel.
 *
 * - Browser notifications: only shown when the tab is not focused (document.hidden)
 * - Sound alerts: played when a new message arrives in a channel other than the active one
 * - Both are throttled to avoid spamming
 */
export function useNotification(activeChannel: ChannelType | null | undefined) {
  const { client } = useChatCore();
  const { t } = useTranslation();
  const lastSoundTimeRef = useRef(0);
  const playBeepRef = useRef<(() => void) | null>(null);

  // Lazily initialize the beep player on first use
  const playSound = useCallback(() => {
    const now = Date.now();
    if (now - lastSoundTimeRef.current < NOTIFICATION_CONFIG.SOUND_THROTTLE_MS) return;
    lastSoundTimeRef.current = now;

    if (!playBeepRef.current) {
      playBeepRef.current = createBeepPlayer();
    }
    playBeepRef.current();
  }, []);

  // Request notification permission on mount
  useEffect(() => {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {
        // User denied or browser blocked — silently ignore
      });
    }
  }, []);

  // Listen for new messages and trigger notifications
  useEffect(() => {
    if (!client) return;

    const handleNewMessage = (event: any) => {
      // Ignore messages from the current user
      if (event.user?.id === client.userID) return;

      // Ignore if no channel info
      const channelCid = event.cid;
      if (!channelCid) return;

      // Look up the channel object
      const channel = client.activeChannels[channelCid];
      if (!channel) return;

      // Skip channels where user is banned/blocked/pending/skipped
      const membership = channel.state?.membership;
      if (
        Boolean(membership?.banned) ||
        Boolean(membership?.blocked) ||
        isPendingMember(membership?.channel_role) ||
        isSkippedMember(membership?.channel_role)
      ) {
        return;
      }

      // Check if this message is from the currently active channel
      const isActiveChannel = activeChannel?.cid === channelCid;

      // Determine sender name and channel name for notification
      const senderName = getUserDisplayName(event.user, event.user?.id) || t('system_messages.user_fallback');
      const channelName = getChannelDisplayName(channel, client.userID);
      const isDM = isDirectChannel(channel);

      // Build notification body
      const body = isDM
        ? t('notifications.message_new_direct', { name: senderName })
        : t('notifications.message_new_group', { name: senderName, channel: channelName });

      // Get message preview text
      let messageText = event.message?.text ? event.message.text.substring(0, 100) : '';

      // For E2EE channels, the text might be an encrypted payload.
      if (isEffectiveE2eeChannel(channel, client)) {
        const stateMsg = channel.state?.messages?.find((m: any) => m.id === event.message?.id);
        const isEncryptedPayload = (text: string) => text && (text.includes('0x') || text.match(/^\d+\n\d+\n/));
        
        if (stateMsg && stateMsg.text && !isEncryptedPayload(stateMsg.text)) {
          messageText = stateMsg.text.substring(0, 100);
        } else if (isEncryptedPayload(messageText)) {
          messageText = ''; // Fallback to 'New message' below
        }
      }

      // Replace mentioned user IDs with their display names
      if (messageText && event.message?.mentioned_users?.length) {
        const mentionedUsers = event.message.mentioned_users as any[];
        mentionedUsers.forEach((userItem) => {
          // Handle both cases where mentioned_users might be array of strings or array of user objects
          const userId = typeof userItem === 'string' ? userItem : userItem.id;
          if (userId) {
            const member = channel.state?.members?.[userId];
            const displayName = member?.user?.name || (typeof userItem === 'object' && userItem.name) || userId;
            messageText = messageText.replace(new RegExp(`@${userId}`, 'g'), `@${displayName}`);
          }
        });
      }

      if (!messageText && event.message?.attachments?.length > 0) {
        const firstAttachment = event.message.attachments[0];
        const type = firstAttachment.type;
        
        if (type === 'image') {
          messageText = `[${t('chat.preview_photo')}]`;
        } else if (type === 'video') {
          messageText = `[${t('chat.preview_video')}]`;
        } else if (type === 'voice' || type === 'audio') {
          messageText = `[${t('chat.preview_voice')}]`;
        } else if (type === 'sticker') {
          messageText = `[${t('chat.preview_sticker')}]`;
        } else {
          messageText = `[${t('chat.preview_file')}]`;
        }
      }

      if (!messageText) {
        messageText = t('notifications.new_message');
      }

      // --- Sound notification ---
      // Play sound if the message is NOT in the currently active channel,
      // OR if the tab is hidden (even if it's the active channel)
      if (!isActiveChannel || document.hidden) {
        playSound();
      }

      // --- Browser push notification ---
      // Only show browser notification when tab is not focused
      if (
        document.hidden &&
        typeof Notification !== 'undefined' &&
        Notification.permission === 'granted'
      ) {
        try {
          const notification = new Notification(body, {
            body: messageText,
            icon: '/favicon.svg',
            tag: `uhm-msg-${channelCid}`, // Collapse notifications from same channel
            silent: true, // We handle sound ourselves
          });

          // Click handler: focus the tab
          notification.onclick = () => {
            window.focus();
            notification.close();
          };

          // Auto-close after 5 seconds
          setTimeout(() => notification.close(), 5000);
        } catch {
          // Notification constructor may fail in some contexts (e.g. insecure origin)
        }
      }
    };

    const sub = client.on('message.new', handleNewMessage);
    return () => sub.unsubscribe();
  }, [client, activeChannel?.cid, playSound, t]);
}
