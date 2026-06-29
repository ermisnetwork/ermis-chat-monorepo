import { useState, useMemo, useCallback } from 'react';
import type { Channel, E2eeAttachmentManifest, FormatMessageResponse } from '@ermis-network/ermis-chat-sdk';
import { createForwardMessagePayload } from '@ermis-network/ermis-chat-sdk';
import { useChatClient } from './useChatClient';
import { removeAccents, buildUserMap } from '../utils';
import { isPendingMember, isSkippedMember } from '../channelRoleUtils';

function isE2eeAttachmentManifest(attachment: unknown): attachment is E2eeAttachmentManifest {
  return Boolean(
    attachment &&
      typeof attachment === 'object' &&
      (attachment as E2eeAttachmentManifest).version === 1 &&
      typeof (attachment as E2eeAttachmentManifest).attachment_id === 'string',
  );
}

function isEffectiveE2ee(channel: Channel | null | undefined): boolean {
  if (!channel) return false;
  return typeof (channel as any)._isEffectiveE2ee === 'function'
    ? (channel as any)._isEffectiveE2ee()
    : channel.data?.mls_enabled === true;
}

function attachmentUrl(attachment: any): string | undefined {
  return attachment?.asset_url || attachment?.image_url || attachment?.url || attachment?.thumb_url;
}

export function useForwardMessage(message: FormatMessageResponse, onDismiss: () => void) {
  const { client, activeChannel } = useChatClient();
  const [selectedChannels, setSelectedChannels] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [sending, setSending] = useState(false);
  const [results, setResults] = useState<{ success: string[]; failed: string[] } | null>(null);

  /* ---------- Get channels from client state (include topics) ---------- */
  const channels = useMemo(() => {
    return (Object.values(client.activeChannels) as Channel[]).filter((ch) => {
      const role = ch.state?.membership?.channel_role as string;
      return !isPendingMember(role) && !isSkippedMember(role);
    });
  }, [client.activeChannels]);

  /* ---------- Filter by search ---------- */
  const filteredChannels = useMemo(() => {
    if (!search.trim()) return channels;
    const q = search.toLowerCase();
    const cleanQ = removeAccents(q);
    const isStrict = q !== cleanQ;

    const result: Channel[] = [];
    for (const ch of channels) {
      const name = (ch.data?.name || ch.cid) as string;
      const t = name.toLowerCase();
      const cleanT = removeAccents(t);

      const parentCid = ch.data?.parent_cid as string | undefined;
      const parent = parentCid ? client.activeChannels[parentCid] : null;
      const parentName = parent?.data?.name || '';
      const pt = parentName.toLowerCase();
      const cleanPT = removeAccents(pt);

      let matched = false;
      if (isStrict) {
        // Strict match when query has accents
        matched = t.startsWith(q) || pt.startsWith(q);
      } else {
        // Broad match when query is accent-less
        matched = cleanT.startsWith(cleanQ) || cleanPT.startsWith(cleanQ);
      }

      if (matched) {
        result.push(ch);
        if (result.length >= 50) break;
      }
    }
    return result;
  }, [channels, search, client.activeChannels]);

  /* ---------- Toggle selection ---------- */
  const toggleChannel = useCallback((channel: Channel) => {
    setSelectedChannels((prev) => {
      const next = new Set(prev);
      if (next.has(channel.cid)) {
        next.delete(channel.cid);
      } else {
        next.add(channel.cid);
      }
      return next;
    });
  }, []);

  /* ---------- Send forward ---------- */
  const handleSend = useCallback(async () => {
    if (!activeChannel || selectedChannels.size === 0 || sending) return;
    setSending(true);
    const success: string[] = [];
    const failed: string[] = [];

    // Format message text to replace mention IDs with names
    let formattedMessage = { ...message };
    if (formattedMessage.text && formattedMessage.mentioned_users && formattedMessage.mentioned_users.length > 0) {
      let newText = formattedMessage.text;
      const userMap = buildUserMap(activeChannel.state);
      
      formattedMessage.mentioned_users.forEach((userId) => {
        const name = userMap[userId] || client.state.users[userId]?.name || userId;
        newText = newText.replace(new RegExp(`@${userId}`, 'g'), `@${name}`);
      });
      formattedMessage.text = newText;
    }

    for (const cid of selectedChannels) {
      const targetChannel = channels.find((c) => c.cid === cid);
      if (!targetChannel) continue;
      try {
        if (!['messaging', 'team', 'topic'].includes(activeChannel.type)) {
          throw new Error('Forward source channel type is not allowed');
        }
        if (formattedMessage.quoted_message_id || formattedMessage.parent_id) {
          throw new Error('Reply/thread messages cannot be forwarded');
        }
        if (formattedMessage.mentioned_all || (formattedMessage.mentioned_users?.length || 0) > 0) {
          throw new Error('Mention messages cannot be forwarded');
        }
        const targetIsE2ee = isEffectiveE2ee(targetChannel);
        const sourceIsE2ee = isEffectiveE2ee(activeChannel);
        if (sourceIsE2ee && !targetIsE2ee) {
          const accepted =
            typeof window === 'undefined' ||
            window.confirm('Forwarding this encrypted message to a standard channel will remove E2EE protection.');
          if (!accepted) throw new Error('Privacy downgrade canceled');
        }
        const forwardPayload = createForwardMessagePayload(
          formattedMessage,
          targetChannel.cid as string,
          activeChannel.cid as string,
        );

        if (targetIsE2ee && formattedMessage.attachments && formattedMessage.attachments.length > 0) {
          const manager = client.encryptionManager;
          if (!manager?.initialized) throw new Error('E2EE forward requires an initialized encryption manager');
          const blobs: Blob[] = [];
          for (const attachment of formattedMessage.attachments as any[]) {
            if (isE2eeAttachmentManifest(attachment)) {
              blobs.push(await manager.downloadE2eeAttachmentAsset(activeChannel.type, activeChannel.id!, attachment, 'original'));
              continue;
            }
            const url = attachmentUrl(attachment);
            if (!url) throw new Error('Forward source attachment has no downloadable URL');
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Forward source attachment download failed: HTTP ${response.status}`);
            blobs.push(await response.blob());
          }
          const prepared = await manager.uploadE2eeAttachments(targetChannel.type, targetChannel.id!, blobs);
          forwardPayload.attachments = prepared.attachments as any;
          forwardPayload.e2ee_attachment_ids = prepared.e2ee_attachment_ids;
        }

        await targetChannel.forwardMessage(forwardPayload, {
          type: targetChannel.type,
          channelID: targetChannel.id!,
        });
        success.push((targetChannel.data?.name || targetChannel.cid) as string);
      } catch (err) {
        console.error(`Failed to forward to ${cid}`, err);
        failed.push((targetChannel.data?.name || targetChannel.cid) as string);
      }
    }

    setResults({ success, failed });
    setSending(false);

    // Auto-close after success (short delay)
    if (failed.length === 0) {
      setTimeout(() => onDismiss(), 1200);
    }
  }, [client, activeChannel, selectedChannels, channels, message, sending, onDismiss]);

  return {
    search,
    setSearch,
    selectedChannels,
    toggleChannel,
    sending,
    results,
    setResults,
    filteredChannels,
    handleSend,
  };
}
