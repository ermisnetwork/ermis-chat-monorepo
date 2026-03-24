import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { VList, type VListHandle } from 'virtua';
import type { Event, MessageLabel } from '@ermis-network/ermis-chat-sdk';
import { formatMessage } from '@ermis-network/ermis-chat-sdk';
import { useChatClient } from '../hooks/useChatClient';
import { Avatar } from './Avatar';
import { MessageItem } from './MessageItem';
import { SystemMessageItem } from './MessageItem';
import {
  defaultMessageRenderers,
  type MessageBubbleProps,
} from './MessageRenderers';
import { getDateKey, formatDateLabel, getMessageUserId } from '../utils';
import type { MessageListProps } from '../types';

/* ----------------------------------------------------------
   Internal sub-components
   ---------------------------------------------------------- */
const DateSeparator: React.FC<{ label: string }> = React.memo(({ label }) => (
  <div className="ermis-message-list__date-separator">
    <div className="ermis-message-list__date-separator-line" />
    <span className="ermis-message-list__date-separator-label">{label}</span>
    <div className="ermis-message-list__date-separator-line" />
  </div>
));
(DateSeparator as any).displayName = 'DateSeparator';

const DefaultEmpty = React.memo(() => (
  <div className="ermis-message-list__empty">
    <div className="ermis-message-list__empty-icon">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    </div>
    <span className="ermis-message-list__empty-title">No messages yet</span>
    <span className="ermis-message-list__empty-subtitle">Send a message to start the conversation</span>
  </div>
));
DefaultEmpty.displayName = 'DefaultEmpty';

const DefaultBubble: React.FC<MessageBubbleProps> = React.memo(({
  isOwnMessage,
  children,
}) => (
  <div
    className={`ermis-message-bubble ${isOwnMessage ? 'ermis-message-bubble--own' : 'ermis-message-bubble--other'}`}
  >
    {children}
  </div>
));
(DefaultBubble as any).displayName = 'DefaultBubble';

/* ----------------------------------------------------------
   Constants
   ---------------------------------------------------------- */
const LOAD_MORE_THRESHOLD = 200;

/* ----------------------------------------------------------
   VirtualMessageList
   ---------------------------------------------------------- */
export const VirtualMessageList: React.FC<MessageListProps> = React.memo(({
  renderMessage,
  className,
  EmptyStateIndicator = DefaultEmpty,
  AvatarComponent = Avatar,
  MessageBubble = DefaultBubble,
  messageRenderers: customRenderers,
  loadMoreLimit = 25,
}) => {
  const { client, activeChannel, messages, setMessages, syncMessages } = useChatClient();
  const [shiftMode, setShiftMode] = useState(true);
  const vlistRef = useRef<VListHandle>(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const currentUserId = client.userID;

  // --- Load-more state (for UI rendering) ---
  const [hasMore, setHasMore] = useState(true);
  const [hasNewer, setHasNewer] = useState(false);

  // --- Concurrency guards (prevent duplicate API calls from rapid scroll) ---
  const loadingMoreRef = useRef(false);
  const loadingNewerRef = useRef(false);

  // Guard: skip all load triggers during jump transitions
  const jumpingRef = useRef(false);

  // Highlighted message for quote-jump
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* ---------- Scroll to bottom helper ---------- */
  const scrollToBottom = useCallback((smooth = false) => {
    const count = messagesRef.current.length;
    if (count === 0) return;
    vlistRef.current?.scrollToIndex(count - 1, { align: 'end', smooth });
  }, []);

  /* ---------- Highlight ---------- */
  const highlight = useCallback((messageId: string) => {
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    setHighlightedId(messageId);
    highlightTimerRef.current = setTimeout(() => {
      setHighlightedId(null);
      highlightTimerRef.current = null;
    }, 2000);
  }, []);

  /* ==========================================================
   Subscribe to channel messages
   ========================================================== */
  useEffect(() => {
    if (!activeChannel) return;

    // Block scroll triggers during channel-switch scroll
    jumpingRef.current = true;
    // Defer scroll outside React lifecycle to avoid virtua flushSync warning
    setTimeout(() => {
      scrollToBottom(false);
      requestAnimationFrame(() => {
        jumpingRef.current = false;
      });
    }, 0);

    const handleNewMessage = (_event: Event) => {
      setShiftMode(false);
      syncMessages();
      // Wait for React to render the new message, then scroll to bottom
      setTimeout(() => {
        scrollToBottom(true);
      }, 200);
    };

    const sub1 = activeChannel.on('message.new', handleNewMessage);
    const sub2 = activeChannel.on('message.updated', handleNewMessage);
    const sub3 = activeChannel.on('message.deleted', handleNewMessage);

    return () => {
      sub1.unsubscribe();
      sub2.unsubscribe();
      sub3.unsubscribe();
    };
  }, [activeChannel, scrollToBottom, syncMessages]);

  const renderers = useMemo(
    () => ({ ...defaultMessageRenderers, ...customRenderers }),
    [customRenderers],
  );

  /* ==========================================================
     Scroll to message (quote click)
     ==========================================================
     Case 1: Message exists in current list → scrollToIndex
     Case 2: Message NOT in list → queryMessagesAroundId →
             replace messages → scroll to target
     ========================================================== */
  const scrollToMessage = useCallback(
    async (messageId: string) => {
      // Case 1: message is already in current list
      const idx = messagesRef.current.findIndex((m) => m.id === messageId);
      if (idx !== -1) {
        vlistRef.current?.scrollToIndex(idx, { align: 'center', smooth: true });
        highlight(messageId);
        return;
      }

      // Case 2: message NOT in list — fetch around it
      if (!activeChannel) return;

      // Block all load triggers while we jump
      jumpingRef.current = true;

      // Fade out VList to hide the instant scroll jump
      const vlistEl = vlistRef.current
        ? (vlistRef.current as any)._scrollRef?.parentElement
        ?? document.querySelector('.ermis-message-list__vlist')
        : document.querySelector('.ermis-message-list__vlist');
      if (vlistEl) {
        (vlistEl as HTMLElement).style.transition = 'opacity 150ms ease-out';
        (vlistEl as HTMLElement).style.opacity = '0';
      }

      try {
        const rawMessages = await activeChannel.queryMessagesAroundId(messageId, 25);
        if (!rawMessages || rawMessages.length === 0) {
          jumpingRef.current = false;
          if (vlistEl) {
            (vlistEl as HTMLElement).style.opacity = '1';
          }
          return;
        }

        const formatted = rawMessages.map((msg: any) => formatMessage(msg));
        const seen = new Set<string>();
        const unique = formatted.filter((m: any) => {
          if (!m.id || seen.has(m.id)) return false;
          seen.add(m.id);
          return true;
        });

        setHasMore(true);
        setHasNewer(true);
        setMessages(unique);

        // Wait for VList to render, then jump while hidden, then fade in
        setTimeout(() => {
          const newIdx = unique.findIndex((m: any) => m.id === messageId);
          if (newIdx === -1) {
            jumpingRef.current = false;
            if (vlistEl) (vlistEl as HTMLElement).style.opacity = '1';
            return;
          }

          // Instant jump (hidden behind opacity: 0)
          vlistRef.current?.scrollToIndex(newIdx, { align: 'center' });

          // After jump settles, fade in and highlight
          setTimeout(() => {
            if (vlistEl) {
              (vlistEl as HTMLElement).style.transition = 'opacity 200ms ease-in';
              (vlistEl as HTMLElement).style.opacity = '1';
            }
            highlight(messageId);
            // Release guard after fade completes
            setTimeout(() => { jumpingRef.current = false; }, 500);
          }, 100);
        }, 200);
      } catch (err) {
        console.error('Failed to fetch messages around ID:', err);
        jumpingRef.current = false;
        if (vlistEl) (vlistEl as HTMLElement).style.opacity = '1';
      }
    },
    [activeChannel, highlight, setMessages],
  );

  /* ==========================================================
     Load older messages (scroll up)
     ========================================================== */
  const loadMore = useCallback(async () => {
    if (!activeChannel || loadingMoreRef.current) return;
    loadingMoreRef.current = true;

    const currentMessages = messagesRef.current;
    const oldestMessage = currentMessages[0];
    if (!oldestMessage?.id) return;

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
      // Enable shift BEFORE prepend — React 18 batches both in same render
      setShiftMode(true);
      setMessages((prev) => {
        const allIds = new Set(prev.map((m) => m.id));
        const unique = olderFormatted.filter((m: any) => {
          if (!m.id || allIds.has(m.id)) return false;
          allIds.add(m.id);
          return true;
        });
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
  }, [activeChannel, loadMoreLimit]);

  /* ==========================================================
     Load newer messages (scroll down — only after a jump)
     Uses loadingNewerRef + cooldown to prevent rapid calls
     ========================================================== */
  const loadNewer = useCallback(async () => {
    if (!activeChannel || loadingNewerRef.current) return;
    loadingNewerRef.current = true;

    const currentMessages = messagesRef.current;
    const newestMessage = currentMessages[currentMessages.length - 1];
    if (!newestMessage?.id) return;

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
      // Disable shift BEFORE append — React 18 batches both in same render
      setShiftMode(false);
      setMessages((prev) => {
        const allIds = new Set(prev.map((m) => m.id));
        const unique = newerFormatted.filter((m: any) => {
          if (!m.id || allIds.has(m.id)) return false;
          allIds.add(m.id);
          return true;
        });
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
  }, [activeChannel, loadMoreLimit]);

  /* ==========================================================
     Jump to latest — reset to newest messages
     ========================================================== */
  const jumpToLatest = useCallback(() => {
    if (!activeChannel) return;
    jumpingRef.current = true;

    // Fade out VList to hide the transition
    const vlistEl = document.querySelector('.ermis-message-list__vlist') as HTMLElement | null;
    if (vlistEl) {
      vlistEl.style.transition = 'opacity 150ms ease-out';
      vlistEl.style.opacity = '0';
    }

    // Reset all state
    const latestMsgs = [...activeChannel.state.latestMessages];
    setMessages(latestMsgs);
    setHasNewer(false);
    setHasMore(true);
    setShiftMode(true);

    // Wait for render, then scroll while hidden, then fade in
    setTimeout(() => {
      scrollToBottom(false);
      setTimeout(() => {
        if (vlistEl) {
          vlistEl.style.transition = 'opacity 200ms ease-in';
          vlistEl.style.opacity = '1';
        }
        setTimeout(() => { jumpingRef.current = false; }, 500);
      }, 100);
    }, 200);
  }, [activeChannel, scrollToBottom]);

  /* ==========================================================
     onScroll handler
     ========================================================== */
  const handleScroll = useCallback((offset: number) => {
    if (jumpingRef.current) return;
    const handle = vlistRef.current;
    if (!handle) return;
    const { scrollSize, viewportSize } = handle;

    // Skip if content doesn't fill the viewport (offset is always 0)
    if (scrollSize <= viewportSize) return;

    // Load older messages when scrolled near top
    if (offset <= LOAD_MORE_THRESHOLD && hasMore) {
      loadMore();
    }

    // Load newer messages when scrolled near bottom (only in "around" view)
    if (offset + viewportSize >= scrollSize - LOAD_MORE_THRESHOLD && hasNewer) {
      loadNewer();
    }
  }, [loadMore, loadNewer, hasMore, hasNewer]);

  /* ---------- Memoized message elements ---------- */
  const messageElements = useMemo(() => {
    return messages.map((message, index) => {
      const isOwnMessage =
        message.user_id === currentUserId || message.user?.id === currentUserId;
      const messageType = (message.type || 'regular') as MessageLabel;

      // Date separator
      const prevMsg = index > 0 ? messages[index - 1] : null;
      const showDateSeparator =
        !prevMsg || getDateKey(message.created_at) !== getDateKey(prevMsg.created_at);
      const dateSeparator = showDateSeparator ? (
        <DateSeparator label={formatDateLabel(message.created_at)} />
      ) : null;

      if (renderMessage) {
        return (
          <div key={message.id || `msg-${index}`}>
            {dateSeparator}
            <div>{renderMessage(message, isOwnMessage)}</div>
          </div>
        );
      }

      if (messageType === 'system') {
        return (
          <div key={message.id || `msg-${index}`}>
            {dateSeparator}
            <SystemMessageItem
              message={message}
              isOwnMessage={isOwnMessage}
              SystemRenderer={renderers.system}
            />
          </div>
        );
      }

      // Message grouping
      const prevType = (prevMsg?.type || 'regular') as MessageLabel;
      const isFirstInGroup =
        showDateSeparator ||
        !prevMsg ||
        prevType === 'system' ||
        prevType === 'signal' ||
        getMessageUserId(prevMsg) !== getMessageUserId(message);

      const MessageRenderer = renderers[messageType] || renderers.regular;

      return (
        <div key={message.id || `msg-${index}`}>
          {dateSeparator}
          <MessageItem
            message={message}
            isOwnMessage={isOwnMessage}
            isFirstInGroup={isFirstInGroup}
            isHighlighted={highlightedId === message.id}
            AvatarComponent={AvatarComponent}
            MessageBubble={MessageBubble}
            MessageRenderer={MessageRenderer}
            onClickQuote={scrollToMessage}
          />
        </div>
      );
    });
  }, [messages, currentUserId, highlightedId, renderers, renderMessage, AvatarComponent, MessageBubble, scrollToMessage]);

  if (!activeChannel) return null;

  return (
    <div className={`ermis-message-list${className ? ` ${className}` : ''}`}>
      {messages.length === 0 && <EmptyStateIndicator />}

      <VList
        ref={vlistRef}
        shift={shiftMode}
        onScroll={handleScroll}
        className="ermis-message-list__vlist"
      >
        {messageElements}
      </VList>

      {/* Jump to latest button */}
      {hasNewer && (
        <button
          className="ermis-message-list__jump-latest"
          onClick={jumpToLatest}
        >
          ↓ Jump to latest
        </button>
      )}
    </div>
  );
});

VirtualMessageList.displayName = 'VirtualMessageList';
