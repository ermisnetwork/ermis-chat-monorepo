import { useState, useMemo, useCallback } from 'react';
import type { Channel, FormatMessageResponse } from '@ermis-network/ermis-chat-sdk';
import { createForwardMessagePayload } from '@ermis-network/ermis-chat-sdk';
import { useChatClient } from './useChatClient';
import { removeAccents } from '../utils';
import { isPendingMember, isSkippedMember } from '../channelRoleUtils';

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

    return channels.filter((ch) => {
      const name = (ch.data?.name || ch.cid) as string;
      const t = name.toLowerCase();
      const cleanT = removeAccents(t);

      const parentCid = ch.data?.parent_cid as string | undefined;
      const parent = parentCid ? client.activeChannels[parentCid] : null;
      const parentName = parent?.data?.name || '';
      const pt = parentName.toLowerCase();
      const cleanPT = removeAccents(pt);

      if (isStrict) {
        // Strict match when query has accents
        return t.includes(q) || pt.includes(q);
      } else {
        // Broad match when query is accent-less
        return cleanT.includes(cleanQ) || cleanPT.includes(cleanQ);
      }
    });
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

    for (const cid of selectedChannels) {
      const targetChannel = channels.find((c) => c.cid === cid);
      if (!targetChannel) continue;
      try {
        const forwardPayload = createForwardMessagePayload(
          message,
          targetChannel.cid as string,
          activeChannel.cid as string,
        );

        await activeChannel.forwardMessage(forwardPayload, {
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
  }, [activeChannel, selectedChannels, channels, message, sending, onDismiss]);

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
