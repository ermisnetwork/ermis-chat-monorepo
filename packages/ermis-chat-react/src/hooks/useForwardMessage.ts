import { useState, useMemo, useCallback } from 'react';
import type {
  Channel,
  E2eeAttachmentManifest,
  E2eeAttachmentManifestAsset,
  FormatMessageResponse,
} from '@ermis-network/ermis-chat-sdk';
import { createForwardMessagePayload } from '@ermis-network/ermis-chat-sdk';
import { useChatCore } from './useChatCore';
import { removeAccents, buildUserMap, getUserDisplayName } from '../utils';
import { isPendingMember, isSkippedMember } from '../channelRoleUtils';

function isE2eeAttachmentManifest(attachment: unknown): attachment is E2eeAttachmentManifest {
  return Boolean(
    attachment &&
      typeof attachment === 'object' &&
      (attachment as E2eeAttachmentManifest).version === 1 &&
      typeof (attachment as E2eeAttachmentManifest).attachment_id === 'string' &&
      Array.isArray((attachment as E2eeAttachmentManifest).assets),
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

function originalAsset(attachment: E2eeAttachmentManifest): E2eeAttachmentManifestAsset | undefined {
  return attachment.assets.find((asset) => asset.kind === 'original') || attachment.assets[0];
}

function displayString(display: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = display?.[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function displayNumber(display: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = display?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function extensionForMimeType(mimeType?: string): string {
  if (!mimeType) return '';
  if (mimeType === 'image/jpeg') return '.jpg';
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'image/webp') return '.webp';
  if (mimeType === 'image/gif') return '.gif';
  if (mimeType === 'video/mp4') return '.mp4';
  if (mimeType === 'video/quicktime') return '.mov';
  if (mimeType === 'video/webm') return '.webm';
  if (mimeType === 'audio/mpeg') return '.mp3';
  if (mimeType === 'audio/webm') return '.webm';
  return '';
}

function inferAttachmentType(attachment: any, mimeType?: string): string | undefined {
  const explicitType = attachment?.attachment_type || attachment?.type;
  if (explicitType === 'voiceRecording') return 'voiceRecording';
  if (explicitType === 'image' || explicitType === 'video' || explicitType === 'file') return explicitType;
  if (mimeType?.startsWith('image/')) return 'image';
  if (mimeType?.startsWith('video/')) return 'video';
  if (mimeType?.startsWith('audio/')) return 'file';
  return undefined;
}

function sourceAttachmentMetadata(
  attachment: any,
  blob: Blob,
  index: number,
): { file: File; displayOverride: Record<string, unknown> } {
  const manifestDisplay = isE2eeAttachmentManifest(attachment) ? originalAsset(attachment)?.display : undefined;
  const sourceName =
    displayString(manifestDisplay, 'name') ||
    attachment?.file_name ||
    attachment?.title ||
    attachment?.name ||
    `forwarded-attachment-${index + 1}`;
  const sourceMime =
    displayString(manifestDisplay, 'mime_type') ||
    attachment?.mime_type ||
    attachment?.content_type ||
    blob.type ||
    'application/octet-stream';
  const hasExtension = /\.[A-Za-z0-9]{1,8}$/.test(sourceName);
  const name = hasExtension ? sourceName : `${sourceName}${extensionForMimeType(sourceMime)}`;
  const normalizedBlob = new File([blob], name, { type: sourceMime || blob.type || 'application/octet-stream' });
  const attachmentType = inferAttachmentType(attachment, sourceMime);
  const width = displayNumber(manifestDisplay, 'width') || attachment?.original_width || attachment?.width;
  const height = displayNumber(manifestDisplay, 'height') || attachment?.original_height || attachment?.height;
  const duration = displayNumber(manifestDisplay, 'duration') || attachment?.duration;
  const displayOverride: Record<string, unknown> = {
    name,
    mime_type: sourceMime,
    size: blob.size,
    ...(attachmentType ? { attachment_type: attachmentType } : {}),
    ...(typeof width === 'number' && Number.isFinite(width) ? { width } : {}),
    ...(typeof height === 'number' && Number.isFinite(height) ? { height } : {}),
    ...(typeof duration === 'number' && Number.isFinite(duration) ? { duration } : {}),
  };
  return { file: normalizedBlob, displayOverride };
}

async function materializeForwardSourceAttachments(
  manager: any,
  sourceChannel: Channel,
  sourceAttachments: any[],
): Promise<{ files: File[]; displayOverrides: Map<number, Record<string, unknown>> }> {
  if (!manager?.initialized) throw new Error('E2EE forward requires an initialized encryption manager');
  const files: File[] = [];
  const displayOverrides = new Map<number, Record<string, unknown>>();

  for (const [index, attachment] of sourceAttachments.entries()) {
    let sourceBlob: Blob;
    if (isE2eeAttachmentManifest(attachment)) {
      sourceBlob = await manager.downloadE2eeAttachmentAsset(
        sourceChannel.type,
        sourceChannel.id!,
        attachment,
        'original',
      );
    } else {
      const url = attachmentUrl(attachment);
      if (!url) throw new Error('Forward source attachment has no downloadable URL');
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Forward source attachment download failed: HTTP ${response.status}`);
      sourceBlob = await response.blob();
    }
    const { file, displayOverride } = sourceAttachmentMetadata(attachment, sourceBlob, index);
    files.push(file);
    displayOverrides.set(index, displayOverride);
  }

  return { files, displayOverrides };
}

export function useForwardMessage(message: FormatMessageResponse, onDismiss: () => void) {
  const { client, activeChannel } = useChatCore();
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
    let queuedBackgroundForward = false;

    // Format message text to replace mention IDs with names
    let formattedMessage = { ...message };
    if (formattedMessage.text && formattedMessage.mentioned_users && formattedMessage.mentioned_users.length > 0) {
      let newText = formattedMessage.text;
      const userMap = buildUserMap(activeChannel.state, client.state.users);

      formattedMessage.mentioned_users.forEach((userId) => {
        const name = userMap[userId] || getUserDisplayName(client.state.users[userId], userId);
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

        const sourceAttachments = (formattedMessage.attachments as any[] | undefined) || [];
        if (targetIsE2ee && sourceAttachments.length > 0) {
          const { files, displayOverrides } = await materializeForwardSourceAttachments(
            client.encryptionManager,
            activeChannel,
            sourceAttachments,
          );
          await (targetChannel as any).enqueueE2eeAttachmentMessage(forwardPayload, files, { displayOverrides });
          queuedBackgroundForward = true;
        } else {
          const standardForwardPayload = { ...forwardPayload };
          if (!targetIsE2ee && sourceIsE2ee && sourceAttachments.length > 0) {
            const { files } = await materializeForwardSourceAttachments(
              client.encryptionManager,
              activeChannel,
              sourceAttachments,
            );
            const { attachments, failedFiles } = await targetChannel.uploadAndPrepareAttachments(files);
            if (failedFiles.length > 0) {
              throw new Error(`Forward standard attachment upload failed for ${failedFiles.length} file(s)`);
            }
            standardForwardPayload.attachments = attachments as any;
          }
          await targetChannel.forwardMessage(standardForwardPayload, {
            type: targetChannel.type,
            channelID: targetChannel.id!,
          });
        }
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
      setTimeout(() => onDismiss(), queuedBackgroundForward ? 0 : 1200);
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
