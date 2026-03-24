import { useState, useRef, useCallback, useEffect } from 'react';
import type { FormatMessageResponse } from '@ermis-network/ermis-chat-sdk';
import { formatMessage } from '@ermis-network/ermis-chat-sdk';
import type { Channel } from '@ermis-network/ermis-chat-sdk';
import type { VListHandle } from 'virtua';

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
  activeChannel: Channel | null;
  vlistRef: React.RefObject<VListHandle | null>;
  setMessages: React.Dispatch<React.SetStateAction<FormatMessageResponse[]>>;
  messagesRef: React.MutableRefObject<FormatMessageResponse[]>;
  /** Shared guard ref — skip scroll-triggered loads during jump transitions */
  jumpingRef: React.MutableRefObject<boolean>;
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
};

export function useLoadMessages({
  activeChannel,
  vlistRef,
  setMessages,
  messagesRef,
  jumpingRef,
  loadMoreLimit = 25,
}: UseLoadMessagesOptions): UseLoadMessagesReturn {
  const [hasMore, setHasMore] = useState(true);
  const [hasNewer, setHasNewer] = useState(false);
  const [shiftMode, setShiftMode] = useState(false);

  // Auto-reset shiftMode after each prepend render
  useEffect(() => {
    if (shiftMode) {
      requestAnimationFrame(() => setShiftMode(false));
    }
  }, [shiftMode]);

  // Refs synced from state (avoid handleScroll recreation on state change)
  const hasMoreRef = useRef(true);
  hasMoreRef.current = hasMore;
  const hasNewerRef = useRef(false);
  hasNewerRef.current = hasNewer;

  // Concurrency guards
  const loadingMoreRef = useRef(false);
  const loadingNewerRef = useRef(false);

  const loadMore = useCallback(async () => {
    if (!activeChannel || loadingMoreRef.current) return;

    const currentMessages = messagesRef.current;
    const oldestMessage = currentMessages[0];
    if (!oldestMessage?.id) return;

    loadingMoreRef.current = true;
    try {
      const olderRaw = await activeChannel.queryMessagesLessThanId(
        oldestMessage.id,
        loadMoreLimit,
      );

      if (olderRaw.length === 0) {
        setHasMore(false);
        return;
      }

      const olderFormatted = olderRaw.map((msg: any) => formatMessage(msg));
      setShiftMode(true);
      setMessages((prev) => {
        const unique = dedupMessages(olderFormatted, prev);
        if (unique.length === 0) {
          setHasMore(false);
        }
        return [...unique, ...prev];
      });
    } catch (err) {
      console.error('Failed to load more messages:', err);
    } finally {
      loadingMoreRef.current = false;
    }
  }, [activeChannel, loadMoreLimit, setMessages]);

  const loadNewer = useCallback(async () => {
    if (!activeChannel || loadingNewerRef.current) return;

    const currentMessages = messagesRef.current;
    const newestMessage = currentMessages[currentMessages.length - 1];
    if (!newestMessage?.id) return;

    loadingNewerRef.current = true;
    try {
      const newerRaw = await activeChannel.queryMessagesGreaterThanId(
        newestMessage.id,
        loadMoreLimit,
      );

      if (newerRaw.length === 0) {
        setHasNewer(false);
        return;
      }

      const newerFormatted = newerRaw.map((msg: any) => formatMessage(msg));
      setMessages((prev) => {
        const unique = dedupMessages(newerFormatted, prev);
        if (unique.length === 0) {
          setHasNewer(false);
        }
        return [...prev, ...unique];
      });
    } catch (err) {
      console.error('Failed to load newer messages:', err);
    } finally {
      loadingNewerRef.current = false;
    }
  }, [activeChannel, loadMoreLimit, setMessages]);

  const handleScroll = useCallback((offset: number) => {
    if (jumpingRef.current) return;
    const handle = vlistRef.current;
    if (!handle) return;
    const { scrollSize, viewportSize } = handle;

    // Skip if content doesn't fill the viewport
    if (scrollSize <= viewportSize) return;

    if (offset <= LOAD_MORE_THRESHOLD && hasMoreRef.current) {
      loadMore();
    }

    if (offset + viewportSize >= scrollSize - LOAD_MORE_THRESHOLD && hasNewerRef.current) {
      loadNewer();
    }
  }, [loadMore, loadNewer]);

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
  };
}
