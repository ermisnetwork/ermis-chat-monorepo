import { useState, useCallback, useRef } from 'react';
import type { FormatMessageResponse } from '@ermis-network/ermis-chat-sdk';
import { formatMessage } from '@ermis-network/ermis-chat-sdk';

export type ScrollToMessageFn = (messageId: string) => void;

export type UseScrollToMessageOptions = {
  /** Reference to the scroll container */
  listRef: React.RefObject<HTMLDivElement | null>;
  /** Current active channel from SDK */
  activeChannel: any;
  /** Setter to replace message state when fetching around a message */
  setMessages: React.Dispatch<React.SetStateAction<FormatMessageResponse[]>>;
  /** Reset hasMore flag when message state is replaced */
  setHasMore: React.Dispatch<React.SetStateAction<boolean>>;
  /** Set hasNewer flag when jumping to an older message */
  setHasNewer: React.Dispatch<React.SetStateAction<boolean>>;
};

export type UseScrollToMessageReturn = {
  /** Currently highlighted message ID (null if none) */
  highlightedId: string | null;
  /** Scroll to a message by ID, fetching if not in DOM */
  scrollToMessage: ScrollToMessageFn;
};

/**
 * Hook that encapsulates logic for scrolling to a specific message
 * and applying a temporary highlight animation.
 *
 * Handles two cases:
 * 1. Message already in DOM → smooth scroll + highlight
 * 2. Message not in DOM → fetch via queryMessagesAroundId → replace state → scroll after render
 */
export function useScrollToMessage({
  listRef,
  activeChannel,
  setMessages,
  setHasMore,
  setHasNewer,
}: UseScrollToMessageOptions): UseScrollToMessageReturn {
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const highlight = useCallback((messageId: string) => {
    // Clear any existing highlight timer
    if (highlightTimerRef.current) {
      clearTimeout(highlightTimerRef.current);
    }
    setHighlightedId(messageId);
    highlightTimerRef.current = setTimeout(() => {
      setHighlightedId(null);
      highlightTimerRef.current = null;
    }, 2000);
  }, []);

  const scrollAndHighlight = useCallback(
    (messageId: string) => {
      const el = listRef.current?.querySelector(`[data-message-id="${messageId}"]`) as HTMLElement | null;

      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        highlight(messageId);
      }
    },
    [listRef, highlight],
  );

  /**
   * Wait for a DOM element to appear after state update,
   * then scroll to it. Uses requestAnimationFrame polling.
   */
  const waitForDOMAndScroll = useCallback(
    (messageId: string, maxAttempts = 20) => {
      let attempt = 0;
      const check = () => {
        const el = listRef.current?.querySelector(`[data-message-id="${messageId}"]`) as HTMLElement | null;

        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          highlight(messageId);
          return;
        }

        attempt++;
        if (attempt < maxAttempts) {
          requestAnimationFrame(check);
        }
      };
      requestAnimationFrame(check);
    },
    [listRef, highlight],
  );

  const scrollToMessage: ScrollToMessageFn = useCallback(
    async (messageId: string) => {
      // Case 1: Message already in DOM
      const existingEl = listRef.current?.querySelector(`[data-message-id="${messageId}"]`);

      if (existingEl) {
        scrollAndHighlight(messageId);
        return;
      }

      // Case 2: Message not in DOM — fetch around it
      if (!activeChannel) return;

      try {
        const rawMessages = await activeChannel.queryMessagesAroundId(messageId, 25);

        if (rawMessages && rawMessages.length > 0) {
          const formatted = rawMessages.map((msg: any) => formatMessage(msg));
          // Deduplicate by ID
          const seen = new Set<string>();
          const unique = formatted.filter((m: any) => {
            if (!m.id || seen.has(m.id)) return false;
            seen.add(m.id);
            return true;
          });
          // Replace messages — bidirectional loading will fill gaps
          setMessages(unique);
          setHasMore(true);
          setHasNewer(true);

          // Wait for React to render the new messages, then scroll
          waitForDOMAndScroll(messageId);
        }
      } catch (err) {
        console.error('Failed to fetch messages around ID:', err);
      }
    },
    [listRef, activeChannel, scrollAndHighlight, waitForDOMAndScroll, setMessages, setHasMore, setHasNewer],
  );

  return { highlightedId, scrollToMessage };
}
