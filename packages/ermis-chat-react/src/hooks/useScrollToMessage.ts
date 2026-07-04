import { useState, useEffect, useCallback, useRef } from 'react';
import type { FormatMessageResponse } from '@ermis-network/ermis-chat-sdk';
import { formatMessage } from '@ermis-network/ermis-chat-sdk';
import type { VListHandle } from 'virtua';
import { dedupMessages } from './useLoadMessages';
import { useChatClient } from './useChatClient';
import { getDateKey, getMessageUserId } from '../utils';
import { isStickerMessage } from '../messageTypeUtils';

export type UseScrollToMessageOptions = {
  vlistRef: React.RefObject<VListHandle | null>;
  messagesRef: React.MutableRefObject<FormatMessageResponse[]>;
  setHasMore: React.Dispatch<React.SetStateAction<boolean>>;
  setHasNewer: React.Dispatch<React.SetStateAction<boolean>>;
  /** Getter to access the VList DOM element (scoped to container) */
  getVListElement: () => HTMLElement | null;
  scrollToBottom: (smooth: boolean) => void;
  /** Shared guard ref — blocks scroll-triggered loads during jumps */
  jumpingRef: React.MutableRefObject<boolean>;
};

export type UseScrollToMessageReturn = {
  highlightedId: string | null;
  scrollToMessage: (messageId: string) => void;
  jumpToLatest: () => void;
};

/** Time gap threshold in ms — must match VirtualMessageList's TIME_GAP_THRESHOLD_MS */
const TIME_GAP_THRESHOLD_MS = 5 * 60 * 1000;

function getTimestamp(date: Date | string | undefined): number {
  if (!date) return 0;
  return date instanceof Date ? date.getTime() : new Date(date).getTime();
}

/**
 * Calculate the VList element index for a given messageId.
 *
 * This mirrors VirtualMessageList's element-building logic exactly:
 * - Date separators are separate VList items.
 * - System messages are standalone VList items.
 * - Consecutive regular/signal messages from the same user (within 5min)
 *   are grouped into ONE VList item.
 * - Time separators between same-user groups with a time gap are separate
 *   VList items.
 */
function getRenderedMessageIndex(messages: FormatMessageResponse[], messageId: string): number {
  let renderedIndex = 0;
  let i = 0;

  while (i < messages.length) {
    const message = messages[i];
    const prevMessage = i > 0 ? messages[i - 1] : null;
    const showDateSeparator =
      !prevMessage || getDateKey(message.created_at) !== getDateKey(prevMessage.created_at);
    const messageType = (
      isStickerMessage(message) ? 'sticker' : (message.type || 'regular')
    ) as string;

    // Date separator = 1 VList item
    if (showDateSeparator) renderedIndex += 1;

    // System messages are standalone VList items
    if (messageType === 'system') {
      if (message.id === messageId) return renderedIndex;
      renderedIndex += 1;
      i++;
      continue;
    }

    // Collect consecutive regular/signal messages from same user into a group
    // (mirrors VirtualMessageList grouping logic)
    const groupStartIndex = i;
    let j = i + 1;
    while (j < messages.length) {
      const nextMessage = messages[j];
      const prevInGroup = messages[j - 1];
      const nextShowDateSeparator =
        getDateKey(nextMessage.created_at) !== getDateKey(prevInGroup.created_at);
      const nextType = (
        isStickerMessage(nextMessage) ? 'sticker' : (nextMessage.type || 'regular')
      ) as string;
      const timeGap = Math.abs(
        getTimestamp(nextMessage.created_at) - getTimestamp(prevInGroup.created_at)
      );

      if (
        nextShowDateSeparator ||
        nextType === 'system' ||
        getMessageUserId(nextMessage) !== getMessageUserId(message) ||
        timeGap > TIME_GAP_THRESHOLD_MS
      ) {
        break;
      }
      j++;
    }

    // Check if we need a time separator BEFORE this group
    if (i > 0) {
      const prevEntry = messages[i - 1];
      const prevEntryType = (
        isStickerMessage(prevEntry) ? 'sticker' : (prevEntry.type || 'regular')
      ) as string;
      const timeGap = Math.abs(
        getTimestamp(message.created_at) - getTimestamp(prevEntry.created_at)
      );
      if (
        !showDateSeparator &&
        prevEntryType !== 'system' &&
        getMessageUserId(prevEntry) === getMessageUserId(message) &&
        timeGap > TIME_GAP_THRESHOLD_MS
      ) {
        // Time separator = 1 VList item
        renderedIndex += 1;
      }
    }

    // Check if target message is in this group
    for (let k = groupStartIndex; k < j; k++) {
      if (messages[k].id === messageId) return renderedIndex;
    }

    // Entire group = 1 VList item
    renderedIndex += 1;
    i = j;
  }

  return -1;
}

export function useScrollToMessage({
  vlistRef,
  messagesRef,
  setHasMore,
  setHasNewer,
  getVListElement,
  scrollToBottom,
  jumpingRef,
}: UseScrollToMessageOptions): UseScrollToMessageReturn {
  const { activeChannel, setMessages } = useChatClient();
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup highlight timer on unmount
  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    };
  }, []);

  const highlight = useCallback((messageId: string) => {
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    setHighlightedId(messageId);
    highlightTimerRef.current = setTimeout(() => {
      setHighlightedId(null);
      highlightTimerRef.current = null;
    }, 2500);
  }, []);

  const scrollToMessage = useCallback(
    async (messageId: string) => {
      // Prevent concurrent calls
      if (jumpingRef.current) return;

      // Case 1: message is already in current list
      const idx = messagesRef.current.findIndex((m) => m.id === messageId);
      if (idx !== -1) {
        const renderedIdx = getRenderedMessageIndex(messagesRef.current, messageId);
        if (renderedIdx !== -1) {
          jumpingRef.current = true;
          vlistRef.current?.scrollToIndex(renderedIdx, { align: 'center', smooth: true });
          setTimeout(() => {
            jumpingRef.current = false;
          }, 500);
        }
        highlight(messageId);
        return;
      }

      // Case 2: message NOT in list — fetch around it
      if (!activeChannel) return;

      jumpingRef.current = true;

      const vlistEl = getVListElement();
      if (vlistEl) {
        vlistEl.style.transition = 'opacity 150ms ease-out';
        vlistEl.style.opacity = '0';
      }

      try {
        const rawMessages = await activeChannel.queryMessagesAroundId(messageId, 25);
        if (!rawMessages || rawMessages.length === 0) {
          jumpingRef.current = false;
          if (vlistEl) vlistEl.style.opacity = '1';
          return;
        }

        const formatted = rawMessages.map((msg: any) => formatMessage(msg));
        const unique = dedupMessages(formatted);

        setHasMore(true);
        setHasNewer(true);
        setMessages(unique);

        // Wait for VList to render, then jump while hidden, then fade in
        setTimeout(() => {
          const renderedIdx = getRenderedMessageIndex(unique, messageId);
          if (renderedIdx === -1) {
            jumpingRef.current = false;
            if (vlistEl) vlistEl.style.opacity = '1';
            return;
          }

          vlistRef.current?.scrollToIndex(renderedIdx, { align: 'center' });

          setTimeout(() => {
            if (vlistEl) {
              vlistEl.style.transition = 'opacity 200ms ease-in';
              vlistEl.style.opacity = '1';
            }
            highlight(messageId);
            setTimeout(() => {
              jumpingRef.current = false;
            }, 500);
          }, 100);
        }, 200);
      } catch (err) {
        console.error('Failed to fetch messages around ID:', err);
        jumpingRef.current = false;
        if (vlistEl) vlistEl.style.opacity = '1';
      }
    },
    [activeChannel, highlight, setMessages, setHasMore, setHasNewer, getVListElement],
  );

  const jumpToLatest = useCallback(() => {
    if (!activeChannel) return;
    jumpingRef.current = true;

    const vlistEl = getVListElement();
    if (vlistEl) {
      vlistEl.style.transition = 'opacity 150ms ease-out';
      vlistEl.style.opacity = '0';
    }

    const latestMsgs = [...activeChannel.state.latestMessages];
    setMessages(latestMsgs);
    setHasNewer(false);
    setHasMore(true);

    setTimeout(() => {
      scrollToBottom(false);
      setTimeout(() => {
        if (vlistEl) {
          vlistEl.style.transition = 'opacity 200ms ease-in';
          vlistEl.style.opacity = '1';
        }
        setTimeout(() => {
          jumpingRef.current = false;
        }, 500);
      }, 100);
    }, 200);
  }, [activeChannel, scrollToBottom, getVListElement, setMessages, setHasMore, setHasNewer]);

  return { highlightedId, scrollToMessage, jumpToLatest };
}
