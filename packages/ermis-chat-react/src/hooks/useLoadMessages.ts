import { useState, useRef, useCallback, useEffect } from 'react';
import type { FormatMessageResponse } from '@ermis-network/ermis-chat-sdk';
import { formatMessage } from '@ermis-network/ermis-chat-sdk';
import type { VListHandle } from 'virtua';
import { useChatCore } from './useChatCore';
import { useChatMessages } from './useChatMessages';

const LOAD_MORE_THRESHOLD = 200;

/** Filter out messages whose id already exists in `existing` (or self-dedup if omitted). */
export const dedupMessages = (incoming: any[], existing?: any[]) => {
  const ids = new Set(existing?.map((m) => m.id) ?? []);
  return incoming.filter((m: any) => {
    if (!m.id || ids.has(m.id)) return false;
    ids.add(m.id);
    return true;
  });
};

export type UseLoadMessagesOptions = {
  vlistRef: React.RefObject<VListHandle | null>;
  messagesRef: React.MutableRefObject<FormatMessageResponse[]>;
  /** Shared guard ref — skip scroll-triggered loads during jump transitions */
  jumpingRef: React.MutableRefObject<boolean>;
  /** Blocks scroll-triggered pagination while auto-following appended messages. */
  scrollLoadLockRef?: React.MutableRefObject<boolean>;
  loadMoreLimit?: number;
};

export type UseLoadMessagesReturn = {
  /** VList shift mode — true during prepend, auto-resets to false */
  shiftMode: boolean;
  hasMore: boolean;
  setHasMore: React.Dispatch<React.SetStateAction<boolean>>;
  hasNewer: boolean;
  setHasNewer: React.Dispatch<React.SetStateAction<boolean>>;
  hasMoreRef: React.RefObject<boolean>;
  hasNewerRef: React.RefObject<boolean>;
  loadingMoreRef: React.MutableRefObject<boolean>;
  loadingNewerRef: React.MutableRefObject<boolean>;
  loadMore: () => Promise<void>;
  loadNewer: () => Promise<void>;
  handleScroll: (offset: number) => void;
  isAtBottomRef: React.MutableRefObject<boolean>;
};

export function useLoadMessages({
  vlistRef,
  messagesRef,
  jumpingRef,
  scrollLoadLockRef,
  loadMoreLimit = 25,
}: UseLoadMessagesOptions): UseLoadMessagesReturn {
  const { activeChannel } = useChatCore();
  const { setMessages } = useChatMessages();
  const activeChannelCidRef = useRef(activeChannel?.cid);
  activeChannelCidRef.current = activeChannel?.cid;
  const channelGenerationRef = useRef(0);
  const [hasMore, setHasMore] = useState(true);
  const [hasNewer, setHasNewer] = useState(false);
  const [shiftMode, setShiftMode] = useState(false);
  const loadingMoreRef = useRef(false);
  const loadingNewerRef = useRef(false);
  const lastRequestedAnchorRef = useRef<number | string | null>(null);
  const lastRequestedNewerAnchorRef = useRef<number | string | null>(null);

  // Reset shiftMode on channel switch so initial load isn't treated as a prepend
  useEffect(() => {
    channelGenerationRef.current += 1;
    loadingMoreRef.current = false;
    loadingNewerRef.current = false;
    lastRequestedAnchorRef.current = null;
    lastRequestedNewerAnchorRef.current = null;
    setShiftMode(false);
  }, [activeChannel?.cid]);

  // Reset shiftMode to false after the prepend render is committed.
  // shift should only be true for the single render cycle when older messages
  // are prepended; leaving it on causes virtua to mis-compensate scroll
  // positions when new messages are appended at the bottom, which leads
  // to intermittent message overlapping.
  useEffect(() => {
    if (shiftMode) {
      setShiftMode(false);
    }
  }, [shiftMode]);

  // Refs synced from state (avoid handleScroll recreation on state change)
  const hasMoreRef = useRef(true);
  hasMoreRef.current = hasMore;
  const hasNewerRef = useRef(false);
  hasNewerRef.current = hasNewer;
  const isAtBottomRef = useRef(true);

  const loadMore = useCallback(async () => {
    if (!activeChannel || loadingMoreRef.current) return;

    const requestCid = activeChannel.cid;
    const requestGeneration = channelGenerationRef.current;
    const isCurrentRequest = () =>
      channelGenerationRef.current === requestGeneration && activeChannelCidRef.current === requestCid;
    const currentMessages = messagesRef.current;
    const oldestMessage = currentMessages.find((m) => Boolean(m?.id));
    if (!oldestMessage?.id) return;

    const anchorKey = (oldestMessage as any).msg_seq ?? oldestMessage.id;
    if (lastRequestedAnchorRef.current === anchorKey) return;

    loadingMoreRef.current = true;
    lastRequestedAnchorRef.current = anchorKey;
    try {
      let olderRaw: any[] = [];
      const msgSeq = (oldestMessage as any).msg_seq;
      if (typeof msgSeq === 'number' && msgSeq > 0) {
        const response = await activeChannel.queryMessagesBySeq({
          messages_seq: { anchor_seq: msgSeq, before: loadMoreLimit }
        });
        olderRaw = response.messages || [];
      } else {
        olderRaw = await activeChannel.queryMessagesLessThanId(oldestMessage.id, loadMoreLimit);
      }

      if (!isCurrentRequest()) return;
      if (olderRaw.length === 0) {
        setHasMore(false);
        return;
      }

      olderRaw.sort((a: any, b: any) => {
        const seqA = a.msg_seq ?? 0;
        const seqB = b.msg_seq ?? 0;
        if (seqA !== seqB) return seqA - seqB;
        return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      });

      if (olderRaw.length < loadMoreLimit) {
        setHasMore(false);
      }

      const olderFormatted = olderRaw.map((msg: any) => formatMessage(msg));
      setShiftMode(true);
      setMessages((prev) => {
        if (!isCurrentRequest()) return prev;
        const unique = dedupMessages(olderFormatted, prev);
        if (unique.length === 0 && olderRaw.length < loadMoreLimit) {
          setHasMore(false);
        }
        return [...unique, ...prev];
      });
    } catch (err) {
      if (isCurrentRequest()) console.error('Failed to load more messages:', err);
    } finally {
      if (isCurrentRequest()) {
        loadingMoreRef.current = false;
        requestAnimationFrame(() => {
          if (jumpingRef.current || scrollLoadLockRef?.current) return;
          const handle = vlistRef.current;
          if (handle && handle.scrollOffset <= LOAD_MORE_THRESHOLD && hasMoreRef.current && !loadingMoreRef.current) {
            loadMore();
          }
        });
      }
    }
  }, [activeChannel, loadMoreLimit, setMessages, jumpingRef, scrollLoadLockRef, vlistRef]);

  const loadNewer = useCallback(async () => {
    if (!activeChannel || loadingNewerRef.current) return;

    const requestCid = activeChannel.cid;
    const requestGeneration = channelGenerationRef.current;
    const isCurrentRequest = () =>
      channelGenerationRef.current === requestGeneration && activeChannelCidRef.current === requestCid;
    const currentMessages = messagesRef.current;
    const newestMessage = [...currentMessages].reverse().find((m) => Boolean(m?.id));
    if (!newestMessage?.id) return;

    const anchorKey = (newestMessage as any).msg_seq ?? newestMessage.id;
    if (lastRequestedNewerAnchorRef.current === anchorKey) return;

    loadingNewerRef.current = true;
    lastRequestedNewerAnchorRef.current = anchorKey;
    try {
      let newerRaw: any[] = [];
      const msgSeq = (newestMessage as any).msg_seq;
      if (typeof msgSeq === 'number' && msgSeq > 0) {
        const response = await activeChannel.queryMessagesBySeq({
          messages_seq: { anchor_seq: msgSeq, after: loadMoreLimit }
        });
        newerRaw = response.messages || [];
      } else {
        newerRaw = await activeChannel.queryMessagesGreaterThanId(newestMessage.id, loadMoreLimit);
      }

      if (!isCurrentRequest()) return;
      if (newerRaw.length === 0) {
        setHasNewer(false);
        return;
      }

      newerRaw.sort((a: any, b: any) => {
        const seqA = a.msg_seq ?? 0;
        const seqB = b.msg_seq ?? 0;
        if (seqA !== seqB) return seqA - seqB;
        return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      });

      if (newerRaw.length < loadMoreLimit) {
        setHasNewer(false);
      }

      const newerFormatted = newerRaw.map((msg: any) => formatMessage(msg));
      setMessages((prev) => {
        if (!isCurrentRequest()) return prev;
        const unique = dedupMessages(newerFormatted, prev);
        if (unique.length === 0 && newerRaw.length < loadMoreLimit) {
          setHasNewer(false);
        }
        return [...prev, ...unique];
      });
    } catch (err) {
      if (isCurrentRequest()) console.error('Failed to load newer messages:', err);
    } finally {
      if (isCurrentRequest()) {
        loadingNewerRef.current = false;
        requestAnimationFrame(() => {
          if (jumpingRef.current || scrollLoadLockRef?.current) return;
          const handle = vlistRef.current;
          if (handle) {
            const { scrollOffset, scrollSize, viewportSize } = handle;
            if (scrollOffset + viewportSize >= scrollSize - LOAD_MORE_THRESHOLD && hasNewerRef.current && !loadingNewerRef.current) {
              loadNewer();
            }
          }
        });
      }
    }
  }, [activeChannel, loadMoreLimit, setMessages, jumpingRef, scrollLoadLockRef, vlistRef]);

  const handleScroll = useCallback(
    (offset: number) => {
      if (jumpingRef.current || scrollLoadLockRef?.current) return;
      const handle = vlistRef.current;
      if (!handle) return;
      const { scrollSize, viewportSize } = handle;

      const isBottom = Math.ceil(offset + viewportSize) >= scrollSize - 20;
      isAtBottomRef.current = isBottom;

      // Skip if content doesn't fill the viewport
      if (scrollSize <= viewportSize) {
        isAtBottomRef.current = true;
        return;
      }

      if (offset <= LOAD_MORE_THRESHOLD && hasMoreRef.current) {
        loadMore();
      }

      if (offset + viewportSize >= scrollSize - LOAD_MORE_THRESHOLD && hasNewerRef.current) {
        loadNewer();
      }
    },
    [loadMore, loadNewer, scrollLoadLockRef, jumpingRef, vlistRef],
  );

  return {
    shiftMode,
    hasMore,
    setHasMore,
    hasNewer,
    setHasNewer,
    hasMoreRef,
    hasNewerRef,
    loadingMoreRef,
    loadingNewerRef,
    loadMore,
    loadNewer,
    handleScroll,
    isAtBottomRef,
  };
}
