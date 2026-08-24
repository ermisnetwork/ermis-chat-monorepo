import type { MessageLabel } from '@ermis-network/ermis-chat-sdk';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { VList as _VList, type VListHandle } from 'virtua';
import { canManageChannel, isPendingMember, isSkippedMember } from '../channelRoleUtils';
import { isDirectChannel, isPublicGroupChannel } from '../channelTypeUtils';
import { useBannedState } from '../hooks/useBannedState';
import { useBlockedState } from '../hooks/useBlockedState';
import { useChannelProfile } from '../hooks/useChannelData';
import { useChannelMessages } from '../hooks/useChannelMessages';
import { useChatCore } from '../hooks/useChatCore';
import { useChatMessages } from '../hooks/useChatMessages';
import { useChatNavigation } from '../hooks/useChatNavigation';
import { useLoadMessages } from '../hooks/useLoadMessages';
import { usePendingState } from '../hooks/usePendingState';
import { useScrollToMessage } from '../hooks/useScrollToMessage';
import { isStickerMessage, isUnavailableDisplayMessage } from '../messageTypeUtils';
import type { MessageListProps } from '../types';
import { formatDateLabel, getDateKey, getMessageUserId, getUserDisplayName } from '../utils';
import { Avatar } from './Avatar';
import { BannedOverlay } from './BannedOverlay';
import { ClosedTopicOverlay } from './ClosedTopicOverlay';
import { MessageItem, SystemMessageItem } from './MessageItem';
import {
  defaultMessageRenderers,
  type MessageBubbleProps,
} from './MessageRenderers';

import { PendingOverlay } from './PendingOverlay';
import { PinnedMessages } from './PinnedMessages';
import { QuotedMessagePreview } from './QuotedMessagePreview';
import { ReadReceipts } from './ReadReceipts';
import { SkippedOverlay } from './SkippedOverlay';
import { TypingIndicator } from './TypingIndicator';

// Workaround for React 19 JSX element type mismatch with virtua's VList
const VList = _VList as any;

/* ----------------------------------------------------------
   Internal sub-components
   ---------------------------------------------------------- */
const DefaultDateSeparator: React.FC<{ label: string }> = React.memo(({ label }) => (
  <div className="ermis-message-list__date-separator">
    <div className="ermis-message-list__date-separator-line" />
    <span className="ermis-message-list__date-separator-label">{label}</span>
    <div className="ermis-message-list__date-separator-line" />
  </div>
));
(DefaultDateSeparator as any).displayName = 'DefaultDateSeparator';

/** Time gap threshold in ms: messages more than 5 minutes apart get a time separator */
const TIME_GAP_THRESHOLD_MS = 5 * 60 * 1000;
const BOTTOM_FOLLOW_SETTLE_MS = 96;

function getTimestamp(date: Date | string | undefined): number {
  if (!date) return 0;
  return date instanceof Date ? date.getTime() : new Date(date).getTime();
}

function formatTimeSeparator(date: Date | string | undefined): string {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const DefaultJumpToLatest = React.memo(({ onClick, label = '↓ Jump to latest' }: any) => (
  <button className="ermis-message-list__jump-latest" onClick={onClick}>
    {label}
  </button>
));
DefaultJumpToLatest.displayName = 'DefaultJumpToLatest';

const DefaultEmpty = React.memo(({ title = 'No messages yet', subtitle = 'Send a message to start the conversation' }: any) => (
  <div className="ermis-message-list__empty">
    <div className="ermis-message-list__empty-icon">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    </div>
    <span className="ermis-message-list__empty-title">{title}</span>
    <span className="ermis-message-list__empty-subtitle">{subtitle}</span>
  </div>
));
DefaultEmpty.displayName = 'DefaultEmpty';

const DefaultBubble: React.FC<MessageBubbleProps> = React.memo(({
  isOwnMessage,
  message,
  children,
}) => (
  <div
    className={`ermis-message-bubble ${isOwnMessage ? 'ermis-message-bubble--own' : 'ermis-message-bubble--other'}`}
  >
    {message?.pinned && (
      <div className={`ermis-message-list__pinned-indicator ${isOwnMessage ? 'ermis-message-list__pinned-indicator--own' : 'ermis-message-list__pinned-indicator--other'}`}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
          <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z" />
        </svg>
      </div>
    )}
    {children}
  </div>
));
(DefaultBubble as any).displayName = 'DefaultBubble';

const DefaultPendingInviteeNotification = React.memo(({ inviteeName, label }: { inviteeName?: string, label?: string }) => {
  const defaultLabel = inviteeName ? `${inviteeName} needs to accept your invitation to see the messages you've sent` : 'The invited user needs to accept your invitation to see the messages you\'ve sent';
  return (
    <div className="ermis-message-list__pending-invitee">
      <div className="ermis-message-list__pending-invitee-content">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <span>{label || defaultLabel}</span>
      </div>
    </div>
  );
});
DefaultPendingInviteeNotification.displayName = 'DefaultPendingInviteeNotification';

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
  DateSeparatorComponent = DefaultDateSeparator,
  dateLocale,
  MessageItemComponent = MessageItem,
  SystemMessageItemComponent = SystemMessageItem,
  JumpToLatestButton = DefaultJumpToLatest,
  QuotedMessagePreviewComponent = QuotedMessagePreview,
  MessageActionsBoxComponent,
  showPinnedMessages = true,
  PinnedMessagesComponent = PinnedMessages,
  showReadReceipts = true,
  ReadReceiptsComponent = ReadReceipts,
  ReadReceiptsTooltipComponent,
  readReceiptsMaxAvatars = 5,
  showTypingIndicator = true,
  TypingIndicatorComponent = TypingIndicator,
  MessageReactionsComponent,
  emptyTitle = 'No messages yet',
  emptySubtitle = 'Send a message to start the conversation',
  jumpToLatestLabel = '↓ Jump to latest',
  bannedOverlayTitle = 'You have been banned from this channel',
  bannedOverlaySubtitle = 'You can no longer read or send messages here',
  blockedOverlayTitle = 'You have blocked this user',
  blockedOverlaySubtitle = 'Unblock to continue the conversation',
  pendingOverlayTitle = 'You are invited to this channel',
  pendingOverlaySubtitle = 'Accept the invitation to view messages and interact',
  pendingAcceptLabel = 'Accept',
  pendingRejectLabel = 'Reject',
  pendingSkipLabel = 'Skip',
  skippedOverlayTitle = 'You skipped this conversation',
  skippedOverlaySubtitle = 'Accept the invitation to start chatting',
  skippedAcceptLabel = 'Accept',
  closedTopicOverlayTitle = 'This topic has been closed',
  closedTopicOverlaySubtitle = 'You can no longer read or send messages in this topic.',
  closedTopicReopenLabel = 'Reopen Topic',
  PendingInviteeNotificationComponent = DefaultPendingInviteeNotification,
  pendingInviteeLabel,
  pinnedMessagesLabel,
  seeAllLabel,
  collapseLabel,
  unpinLabel,
  stickerLabel,
  attachmentLabel = 'Attachment',
  unavailableMessageLabel = 'Message unavailable',
  encryptedMessageLabel,
  encryptedMessageFailedLabel,
  encryptedMessageDecryptingLabel,
  encryptedMessageUnavailableLabel,
  typingIndicatorLabel,
  deletedMessageLabel = 'This message was deleted',
  systemMessageTranslations,
  signalMessageTranslations,
  includeHiddenMessages = true,
  onMentionClick,
  onUserNameClick,
  onAddReactionClick,
  GapIndicatorComponent,
  gapIndicatorLabel,
}) => {
  const { client, activeChannel, setActiveChannel } = useChatCore();
  const { messages, readState } = useChatMessages();
  const { jumpToMessageId, setJumpToMessageId } = useChatNavigation();
  const { isBanned } = useBannedState(activeChannel, client.userID);
  const { isBlocked } = useBlockedState(activeChannel, client.userID);
  const { isPending, inviteUpdateCount } = usePendingState(activeChannel, client.userID);

  const isSkipped = client.userID
    ? isSkippedMember(activeChannel?.state?.members?.[client.userID]?.channel_role as string) ||
    isSkippedMember(activeChannel?.state?.membership?.channel_role as string)
    : false;

  const isClosedTopic = activeChannel?.data?.is_closed_topic === true;
  const parentCid = activeChannel?.data?.parent_cid as string | undefined;
  const parentChannel = parentCid && client ? client.activeChannels[parentCid] : undefined;

  const { channelName, channelImage } = useChannelProfile(activeChannel);

  const vlistRef = useRef<VListHandle>(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const currentUserId = client.userID;
  const currentUserRole = currentUserId ? activeChannel?.state?.members?.[currentUserId]?.channel_role : undefined;
  const canManageTopic = canManageChannel(currentUserRole);

  const pendingInviteeName = useMemo(() => {
    if (!activeChannel || !currentUserId) return null;
    if (!isDirectChannel(activeChannel)) return null;
    const membersList = Object.values(activeChannel.state?.members || {});
    if (membersList.length === 2 && !isPending) {
      const otherUser = membersList.find(m => m.user_id !== currentUserId);
      if (otherUser && isPendingMember(otherUser.channel_role)) {
        return getUserDisplayName(otherUser.user, otherUser.user_id) || 'User';
      }
    }
    return null;
  }, [activeChannel, currentUserId, isPending, inviteUpdateCount]);

  // Ref to scope DOM queries (safe for multiple instances)
  const containerRef = useRef<HTMLDivElement>(null);
  const getVListElement = useCallback((): HTMLElement | null => {
    return containerRef.current?.querySelector('.ermis-message-list__vlist') ?? null;
  }, []);

  const handleAcceptInvite = useCallback(async () => {
    if (!activeChannel) return;
    try {
      let action: 'join' | 'accept' = 'accept';
      if (isPublicGroupChannel(activeChannel)) {
        const isMember = !!(currentUserId && activeChannel.state?.members?.[currentUserId]);
        action = isMember ? 'accept' : 'join';
      }
      await activeChannel.acceptInvite(action);

      // Optimistically update local membership so React picks up the change immediately.
      // The async _handleChannelEvent in the SDK races with client listeners,
      // so the WS event alone is not reliable for updating React state in time.
      if (activeChannel.state && currentUserId) {
        const updatedMembership = {
          ...activeChannel.state.membership,
          channel_role: 'member',
          user_id: currentUserId,
        } as Record<string, unknown>;
        activeChannel.state.membership = updatedMembership;

        if (activeChannel.state.members?.[currentUserId]) {
          activeChannel.state.members[currentUserId] = {
            ...activeChannel.state.members[currentUserId],
            channel_role: 'member',
          };
        }

        // Dispatch synthetic event so all React listeners update
        const clientObj = activeChannel.getClient();
        const eventType = action === 'join' ? 'member.joined' : 'notification.invite_accepted';
        clientObj.dispatchEvent({
          type: eventType,
          cid: activeChannel.cid,
          channel_type: activeChannel.type,
          channel_id: activeChannel.id,
          channel: activeChannel.data,
          member: updatedMembership,
          user: clientObj.user,
        } as any);
      }

    } catch (e: any) {
      console.error('Error accepting invite', e);
    }
  }, [activeChannel, currentUserId]);

  const handleRejectInvite = useCallback(async () => {
    if (!activeChannel) return;
    try {
      await activeChannel.rejectInvite();
      if (setActiveChannel) setActiveChannel(null);
    } catch (e: any) {
      console.error('Error rejecting invite', e);
    }
  }, [activeChannel, setActiveChannel]);

  const handleSkipInvite = useCallback(async () => {
    if (!activeChannel) return;
    try {
      await activeChannel.skipInvite();
      if (setActiveChannel) setActiveChannel(null);
    } catch (e: any) {
      console.error('Error skipping invite', e);
    }
  }, [activeChannel, setActiveChannel]);

  const elementsCountRef = useRef(0);

  const scrollToBottom = useCallback((smooth = false, attempts = 0) => {
    const handle = vlistRef.current;
    if (!handle) return;

    const count = elementsCountRef.current;
    if (count === 0) return;

    // Ensure virtua has measured the viewport via ResizeObserver.
    // If viewportSize is unmeasured (0) or scrollSize is 0, align: 'end' calculates wrong.
    if ((!handle.viewportSize || handle.viewportSize === 0) && attempts < 10) {
      requestAnimationFrame(() => scrollToBottom(smooth, attempts + 1));
      return;
    }

    handle.scrollToIndex(count - 1, { align: 'end', smooth });
  }, []);

  // Shared guard: skip scroll-triggered loads during jump transitions
  const jumpingRef = useRef(false);
  const scrollLoadLockRef = useRef(false);
  const scrollLoadLockTokenRef = useRef(0);
  const holdScrollLoadLock = useCallback((duration = 750) => {
    const token = scrollLoadLockTokenRef.current + 1;
    scrollLoadLockTokenRef.current = token;
    scrollLoadLockRef.current = true;
    setTimeout(() => {
      if (scrollLoadLockTokenRef.current === token) {
        scrollLoadLockRef.current = false;
      }
    }, duration);
  }, []);

  /* ---------- Hooks ---------- */
  const {
    shiftMode,
    hasMore, setHasMore,
    hasNewer, setHasNewer,
    loadingMoreRef, loadingNewerRef,
    handleScroll,
    isAtBottomRef,
  } = useLoadMessages({
    vlistRef,
    messagesRef,
    jumpingRef,
    scrollLoadLockRef,
    loadMoreLimit,
  });

  // Track whether user has scrolled up from the bottom
  const [isScrolledUp, setIsScrolledUp] = useState(false);
  const wrappedHandleScroll = useCallback(
    (offset: number) => {
      handleScroll(offset);
      const handle = vlistRef.current;
      if (!handle) return;
      const { scrollSize, viewportSize } = handle;
      if (scrollSize <= viewportSize) {
        setIsScrolledUp(false);
        return;
      }
      if (scrollLoadLockRef.current || jumpingRef.current) {
        setIsScrolledUp(false);
        return;
      }
      const distFromBottom = scrollSize - (offset + viewportSize);
      setIsScrolledUp(distFromBottom > 200);
    },
    [handleScroll],
  );

  const isNearBottom = useCallback(() => {
    const handle = vlistRef.current;
    if (!handle) return isAtBottomRef.current;

    const { scrollOffset, scrollSize, viewportSize } = handle;
    if (!Number.isFinite(scrollOffset) || !Number.isFinite(scrollSize) || !Number.isFinite(viewportSize)) {
      return isAtBottomRef.current;
    }
    if (scrollSize <= viewportSize || viewportSize <= 0) return true;

    return scrollSize - (scrollOffset + viewportSize) <= 160;
  }, [isAtBottomRef]);
  const bottomFollowFrameRef = useRef<number | null>(null);
  const bottomFollowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const followBottomAfterRender = useCallback(
    (force = false) => {
      const shouldFollow = force || isAtBottomRef.current || isNearBottom();
      if (!shouldFollow) return;

      isAtBottomRef.current = true;
      holdScrollLoadLock(750);

      if (bottomFollowFrameRef.current !== null) {
        cancelAnimationFrame(bottomFollowFrameRef.current);
      }
      if (bottomFollowTimerRef.current !== null) {
        clearTimeout(bottomFollowTimerRef.current);
      }

      bottomFollowFrameRef.current = requestAnimationFrame(() => {
        bottomFollowFrameRef.current = null;
        if (!force && !isAtBottomRef.current && !isNearBottom()) return;

        scrollToBottom(false);
        bottomFollowTimerRef.current = setTimeout(() => {
          bottomFollowTimerRef.current = null;
          if (force || isAtBottomRef.current || isNearBottom()) {
            scrollToBottom(false);
          }
        }, BOTTOM_FOLLOW_SETTLE_MS);
      });
    },
    [holdScrollLoadLock, isAtBottomRef, isNearBottom, scrollToBottom],
  );

  useEffect(() => {
    return () => {
      if (bottomFollowFrameRef.current !== null) cancelAnimationFrame(bottomFollowFrameRef.current);
      if (bottomFollowTimerRef.current !== null) clearTimeout(bottomFollowTimerRef.current);
    };
  }, [activeChannel?.cid]);

  const { highlightedId, scrollToMessage, jumpToLatest } = useScrollToMessage({
    vlistRef,
    messagesRef,
    setHasMore,
    setHasNewer,
    getVListElement,
    scrollToBottom,
    jumpingRef,
  });

  // React to jumpToMessageId from context (e.g. search panel)
  useEffect(() => {
    if (jumpToMessageId) {
      scrollToMessage(jumpToMessageId);
      setJumpToMessageId(null);
    }
  }, [jumpToMessageId, scrollToMessage, setJumpToMessageId]);

  useChannelMessages({
    scrollToBottom,
    isNearBottom,
    followBottomAfterRender,
    jumpingRef,
    isAtBottomRef,
    onChannelSwitch: useCallback(() => {
      setHasMore(true);
      setHasNewer(false);
      loadingMoreRef.current = false;
      loadingNewerRef.current = false;
    }, [setHasMore, setHasNewer]),
    includeHiddenMessages,
    containerRef,
    vlistRef,
  });

  const lastAutoScrollKeyRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage?.id || !currentUserId) return;

    const key = `${activeChannel?.cid || ''}:${lastMessage.id}`;
    if (lastAutoScrollKeyRef.current === key) return;

    const isOwnLastMessage =
      lastMessage.user_id === currentUserId || lastMessage.user?.id === currentUserId;
    if (!isOwnLastMessage && !isAtBottomRef.current && !isNearBottom()) return;
    if (loadingMoreRef.current || loadingNewerRef.current) return;

    lastAutoScrollKeyRef.current = key;
    followBottomAfterRender(true);
  }, [activeChannel?.cid, currentUserId, messages, isNearBottom, followBottomAfterRender]);

  const hasOverlay = Boolean(isClosedTopic || isPending || isBanned || isBlocked || isSkipped);
  const prevOverlayRef = useRef(hasOverlay);

  useEffect(() => {
    if (prevOverlayRef.current && !hasOverlay) {
      // Transitioned from having an overlay to normal view.
      // Give VList a moment to measure its new DOM size via ResizeObserver, then jump to the bottom.
      setTimeout(() => scrollToBottom(false), 50);
      setTimeout(() => scrollToBottom(false), 200);
      setTimeout(() => scrollToBottom(false), 500);
    }
    prevOverlayRef.current = hasOverlay;
  }, [hasOverlay, scrollToBottom]);

  const renderers = useMemo(
    () => ({ ...defaultMessageRenderers, ...customRenderers }),
    [customRenderers],
  );

  /* ---------- Compute read-by map (message.id → readers) ---------- */
  const readByMap = useMemo(() => {
    const map: Record<string, Array<{ id: string; name?: string; avatar?: string; last_read?: Date | string }>> = {};
    if (!readState) return map;
    for (const userId of Object.keys(readState)) {
      if (userId === currentUserId) continue; // exclude self
      const entry = readState[userId];
      if (entry.last_read_message_id) {
        if (!map[entry.last_read_message_id]) {
          map[entry.last_read_message_id] = [];
        }
        map[entry.last_read_message_id].push({
          id: userId,
          name: entry.user?.name,
          avatar: entry.user?.avatar,
          last_read: entry.last_read,
        });
      }
    }
    return map;
  }, [readState, currentUserId]);

  /* ---------- Memoized message elements ---------- */
  const messageElements = useMemo(() => {
    const elements: React.ReactNode[] = [];

    // Pre-compute per-message data
    type MsgEntry = {
      message: typeof messages[0];
      index: number;
      isOwnMessage: boolean;
      messageType: MessageLabel;
      showDateSeparator: boolean;
      isFirstInGroup: boolean;
      isLastInGroup: boolean;
      nextIsSignal: boolean;
      validReaders: Array<{ id: string; name?: string; avatar?: string; last_read?: Date | string }>;
      hasReaders: boolean;
    };
    // Helpers to find adjacent renderable messages (skipping 'unavailable' placeholders)
    const getPrevValidMessage = (currentIndex: number) => {
      for (let i = currentIndex - 1; i >= 0; i--) {
        if (!isUnavailableDisplayMessage(messages[i])) return messages[i];
      }
      return null;
    };

    const getNextValidMessage = (currentIndex: number) => {
      for (let i = currentIndex + 1; i < messages.length; i++) {
        if (!isUnavailableDisplayMessage(messages[i])) return messages[i];
      }
      return null;
    };

    const entries: MsgEntry[] = messages.map((message, index) => {
      const isOwnMessage =
        message.user_id === currentUserId || message.user?.id === currentUserId;
      const messageType = (
        isStickerMessage(message) ? 'sticker' : (message.type || 'regular')
      ) as MessageLabel;

      // Find previous valid message (skip unavailable)
      const prevMsg = getPrevValidMessage(index);
      const showDateSeparator =
        !prevMsg || getDateKey(message.created_at) !== getDateKey(prevMsg.created_at);
      const prevType = (prevMsg?.type || 'regular') as MessageLabel;
      const prevTimeGap = prevMsg
        ? Math.abs(getTimestamp(message.created_at) - getTimestamp(prevMsg.created_at)) > TIME_GAP_THRESHOLD_MS
        : false;
      const isFirstInGroup =
        showDateSeparator ||
        !prevMsg ||
        prevType === 'system' ||
        prevType === 'signal' ||
        getMessageUserId(prevMsg) !== getMessageUserId(message) ||
        prevTimeGap;
      const nextMsg = getNextValidMessage(index);
      const nextType = (nextMsg?.type || 'regular') as MessageLabel;
      const nextShowDateSeparator = nextMsg
        ? getDateKey(nextMsg.created_at) !== getDateKey(message.created_at)
        : false;
      const validReaders = message.id && readByMap[message.id] ? readByMap[message.id].filter(r => r.id !== getMessageUserId(message)) : [];
      const hasReaders = showReadReceipts && validReaders.length > 0;
      const nextTimeGap = nextMsg
        ? Math.abs(getTimestamp(nextMsg.created_at) - getTimestamp(message.created_at)) > TIME_GAP_THRESHOLD_MS
        : false;
      const isLastInGroup =
        !nextMsg ||
        nextShowDateSeparator ||
        nextType === 'system' ||
        nextType === 'signal' ||
        getMessageUserId(nextMsg) !== getMessageUserId(message) ||
        nextTimeGap;
      // Flag: next message is a signal from the same user — used to suppress pointed tail
      const nextIsSignal = nextType === 'signal' && !!nextMsg && getMessageUserId(nextMsg) === getMessageUserId(message);
      return { message, index, isOwnMessage, messageType, showDateSeparator, isFirstInGroup, isLastInGroup, nextIsSignal, validReaders, hasReaders };
    });

    // Build groups: consecutive regular messages from same user
    let i = 0;
    while (i < entries.length) {
      const entry = entries[i];

      // Date separator before any message
      if (entry.showDateSeparator) {
        elements.push(
          <div key={`date-${getDateKey(entry.message.created_at)}`}>
            <DateSeparatorComponent label={formatDateLabel(entry.message.created_at, dateLocale)} />
          </div>
        );
      }

      // Gap indicator: detect real msg_seq gaps between adjacent messages
      if (GapIndicatorComponent && entry.index > 0 && activeChannel) {
        const prevMsg = messages[entry.index - 1];
        const currMsg = entry.message;
        const prevSeq = (prevMsg as any).msg_seq as number | undefined;
        const currSeq = (currMsg as any).msg_seq as number | undefined;
        if (prevSeq && currSeq && currSeq - prevSeq > 1) {
          const isFake = typeof activeChannel.state?.isFakeMessageGap === 'function'
            ? activeChannel.state.isFakeMessageGap(prevSeq, currSeq)
            : false;
          if (!isFake) {
            elements.push(
              <div key={`gap-${prevSeq}-${currSeq}`} className="ermis-message-list__gap-indicator">
                <GapIndicatorComponent
                  channel={activeChannel}
                  gapSeqRange={[prevSeq + 1, currSeq - 1]}
                />
              </div>
            );
          }
        }
      }

      // Custom renderMessage
      if (renderMessage) {
        elements.push(
          <div key={entry.message.id || `msg-${entry.index}`}>
            <div>{renderMessage(entry.message, entry.isOwnMessage)}</div>
          </div>
        );
        i++;
        continue;
      }

      // System messages — standalone
      if (entry.messageType === 'system') {
        elements.push(
          <div key={entry.message.id || `msg-${entry.index}`}>
            <SystemMessageItemComponent
              message={entry.message}
              isOwnMessage={entry.isOwnMessage}
              SystemRenderer={renderers.system}
              systemMessageTranslations={systemMessageTranslations}
            />
          </div>
        );
        i++;
        continue;
      }

      // Unavailable messages — skip rendering entirely (they act only as msg_seq placeholders for gap detection)
      if (isUnavailableDisplayMessage(entry.message)) {
        i++;
        continue;
      }

      // Collect consecutive regular/signal messages from the same user into a group
      // Break group on: different user, system message, date separator, or time gap > 5min
      const groupEntries: MsgEntry[] = [entry];
      let j = i + 1;
      while (j < entries.length) {
        const nextEntry = entries[j];
        const prevEntry = entries[j - 1];
        const timeGap = Math.abs(
          getTimestamp(nextEntry.message.created_at) - getTimestamp(prevEntry.message.created_at)
        );
        // Break group if: different user, system/poll message, date separator, or time gap
        if (
          nextEntry.showDateSeparator ||
          nextEntry.messageType === 'system' ||
          nextEntry.messageType === 'poll' ||
          entry.messageType === 'poll' ||
          getMessageUserId(nextEntry.message) !== getMessageUserId(entry.message) ||
          timeGap > TIME_GAP_THRESHOLD_MS
        ) {
          break;
        }
        groupEntries.push(nextEntry);
        j++;
      }

      const isOwn = entry.isOwnMessage;
      const userId = getMessageUserId(entry.message);
      const cachedUser = userId ? client?.state?.users?.[userId] : undefined;
      const userName = getUserDisplayName(entry.message.user, userId, cachedUser);
      const userAvatar =
        entry.message.user?.avatar || entry.message.user?.avatar_url || cachedUser?.avatar || cachedUser?.avatar_url;
      const groupKey = `group-${entry.message.id || `g-${entry.index}`}`;

      // Check if we need a time separator BEFORE this group
      // (when previous group was from same user but time gap split them)
      if (i > 0) {
        const prevEntry = entries[i - 1];
        const timeGap = Math.abs(
          getTimestamp(entry.message.created_at) - getTimestamp(prevEntry.message.created_at)
        );
        if (
          !entry.showDateSeparator &&
          prevEntry.messageType !== 'system' &&
          getMessageUserId(prevEntry.message) === getMessageUserId(entry.message) &&
          timeGap > TIME_GAP_THRESHOLD_MS
        ) {
          elements.push(
            <div key={`timesep-${entry.message.id}`}>
              <div className="ermis-message-list__time-separator">
                <span className="ermis-message-list__time-separator-label">
                  {formatTimeSeparator(entry.message.created_at)}
                </span>
              </div>
            </div>
          );
        }
      }

      // Render group wrapper with sticky avatar
      elements.push(
        <div key={groupKey}>
          <div className={`ermis-message-group ${isOwn ? 'ermis-message-group--own' : 'ermis-message-group--other'}`}>
            {/* Avatar column — sticky for scroll tracking */}
            {!isOwn && (
              <div className="ermis-message-group__avatar-col">
                <AvatarComponent image={userAvatar} name={userName} size={36} />
              </div>
            )}
            {/* Messages column */}
            <div className="ermis-message-group__messages-col">
              {groupEntries.map((ge) => {
                const MessageRenderer = renderers[ge.messageType] || renderers.regular;
                return (
                  <React.Fragment key={ge.message.id || `msg-${ge.index}`}>
                    {/* Date separators within group (if needed for mid-group entries) */}
                    {ge !== entry && ge.showDateSeparator && (
                      <DateSeparatorComponent label={formatDateLabel(ge.message.created_at, dateLocale)} />
                    )}
                    <MessageItemComponent
                      message={ge.message}
                      isOwnMessage={ge.isOwnMessage}
                      isFirstInGroup={ge.isFirstInGroup}
                      isLastInGroup={ge.isLastInGroup}
                      nextIsSignal={ge.nextIsSignal}
                      isHighlighted={highlightedId === ge.message.id}
                      AvatarComponent={AvatarComponent}
                      MessageBubble={MessageBubble}
                      MessageRenderer={MessageRenderer}
                      onClickQuote={scrollToMessage}
                      QuotedMessagePreviewComponent={QuotedMessagePreviewComponent}
                      MessageActionsBoxComponent={MessageActionsBoxComponent}
                      MessageReactionsComponent={MessageReactionsComponent}
                      deletedMessageLabel={deletedMessageLabel}
                      attachmentLabel={attachmentLabel}
                      unavailableMessageLabel={unavailableMessageLabel}
                      stickerLabel={stickerLabel}
                      encryptedMessageLabel={encryptedMessageLabel}
                      encryptedMessageFailedLabel={encryptedMessageFailedLabel}
                      encryptedMessageDecryptingLabel={encryptedMessageDecryptingLabel}
                      systemMessageTranslations={systemMessageTranslations}
                      signalMessageTranslations={signalMessageTranslations}
                      onMentionClick={onMentionClick}
                      onUserNameClick={onUserNameClick}
                      onAddReactionClick={onAddReactionClick}
                      hideAvatar
                    />
                  </React.Fragment>
                );
              })}
            </div>
          </div>
          {/* Read receipts — consolidated: merge all readers in this group into one row */}
          {(() => {
            if (!showReadReceipts) return null;
            const allReaders: Array<{ id: string; name?: string; avatar?: string; last_read?: Date | string }> = [];
            const seen = new Set<string>();
            for (const ge of groupEntries) {
              for (const r of ge.validReaders) {
                if (!seen.has(r.id)) {
                  seen.add(r.id);
                  allReaders.push(r);
                }
              }
            }
            if (allReaders.length === 0) return null;
            const lastEntry = groupEntries[groupEntries.length - 1];
            return (
              <ReadReceiptsComponent
                key={`receipt-${lastEntry.message.id}`}
                readers={allReaders}
                maxAvatars={readReceiptsMaxAvatars}
                AvatarComponent={AvatarComponent}
                TooltipComponent={ReadReceiptsTooltipComponent}
                isOwnMessage={lastEntry.isOwnMessage}
                isLastInGroup={lastEntry.isLastInGroup}
                status={lastEntry.message.status}
              />
            );
          })()}
        </div>
      );

      i = j;
    }


    elementsCountRef.current = elements.length;
    return elements;
  }, [
    messages,
    currentUserId,
    highlightedId,
    renderers,
    renderMessage,
    AvatarComponent,
    MessageBubble,
    scrollToMessage,
    DateSeparatorComponent,
    MessageItemComponent,
    SystemMessageItemComponent,
    QuotedMessagePreviewComponent,
    MessageActionsBoxComponent,
    MessageReactionsComponent,
    readByMap,
    showReadReceipts,
    ReadReceiptsComponent,
    ReadReceiptsTooltipComponent,
    readReceiptsMaxAvatars,
    dateLocale,
    onMentionClick,
    onUserNameClick,
    onAddReactionClick,
    encryptedMessageLabel,
    encryptedMessageFailedLabel,
    encryptedMessageDecryptingLabel,
    GapIndicatorComponent,
    activeChannel,
  ]);

  if (isBanned || isBlocked) {
    return (
      <BannedOverlay
        isBlocked={isBlocked}
        blockedTitle={blockedOverlayTitle}
        bannedTitle={bannedOverlayTitle}
        blockedSubtitle={blockedOverlaySubtitle}
        bannedSubtitle={bannedOverlaySubtitle}
        onUnblock={() => { activeChannel?.unblockUser().catch((e: any) => console.error('Error unblocking user', e)); }}
      />
    );
  }

  if (isPending) {
    const isDirect = activeChannel ? isDirectChannel(activeChannel) : false;
    return (
      <PendingOverlay
        channelImage={channelImage}
        channelName={channelName}
        title={pendingOverlayTitle}
        subtitle={pendingOverlaySubtitle}
        rejectLabel={pendingRejectLabel}
        acceptLabel={pendingAcceptLabel}
        onReject={handleRejectInvite}
        onAccept={handleAcceptInvite}
        skipLabel={isDirect ? pendingSkipLabel : undefined}
        onSkip={isDirect ? handleSkipInvite : undefined}
        AvatarComponent={AvatarComponent}
      />
    );
  }

  if (isSkipped) {
    return (
      <SkippedOverlay
        channelImage={channelImage}
        channelName={channelName}
        title={skippedOverlayTitle}
        subtitle={skippedOverlaySubtitle}
        acceptLabel={skippedAcceptLabel}
        onAccept={handleAcceptInvite}
        AvatarComponent={AvatarComponent}
      />
    );
  }

  if (isClosedTopic) {
    return (
      <ClosedTopicOverlay
        title={closedTopicOverlayTitle}
        subtitle={closedTopicOverlaySubtitle}
        canManageTopic={Boolean(canManageTopic && activeChannel && parentChannel)}
        reopenLabel={closedTopicReopenLabel}
        onReopen={() => { parentChannel?.reopenTopic(activeChannel!.cid).catch((e: any) => console.error('Error reopening topic', e)); }}
      />
    );
  }

  return (
    <>
      <div ref={containerRef} className={`ermis-message-list${className ? ` ${className}` : ''}`}>
        {showPinnedMessages && (
          <PinnedMessagesComponent
            onClickMessage={scrollToMessage}
            AvatarComponent={AvatarComponent}
            pinnedMessagesLabel={pinnedMessagesLabel}
            seeAllLabel={seeAllLabel}
            collapseLabel={collapseLabel}
            unpinLabel={unpinLabel}
            stickerLabel={stickerLabel}
            attachmentLabel={attachmentLabel}
            unavailableMessageLabel={unavailableMessageLabel}
          />
        )}

        {messages.length === 0 && (
          EmptyStateIndicator === DefaultEmpty
            ? <DefaultEmpty title={emptyTitle} subtitle={emptySubtitle} />
            : <EmptyStateIndicator />
        )}

        {pendingInviteeName && (
          <PendingInviteeNotificationComponent
            inviteeName={pendingInviteeName}
            label={typeof pendingInviteeLabel === 'function' ? pendingInviteeLabel(pendingInviteeName) : pendingInviteeLabel}
          />
        )}

        <VList
          key={activeChannel?.cid || 'empty'}
          ref={vlistRef}
          shift={shiftMode}
          onScroll={wrappedHandleScroll}
          className="ermis-message-list__vlist"
        >
          {messageElements}
        </VList>

        {/* Jump to latest button */}
        {(hasNewer || isScrolledUp) && (
          JumpToLatestButton === DefaultJumpToLatest
            ? <DefaultJumpToLatest onClick={hasNewer ? jumpToLatest : () => { scrollToBottom(true); setIsScrolledUp(false); }} label={jumpToLatestLabel} />
            : <JumpToLatestButton onClick={hasNewer ? jumpToLatest : () => { scrollToBottom(true); setIsScrolledUp(false); }} />
        )}
      </div>

      {/* Typing indicator — outside message list, flows between messages and input */}
      {showTypingIndicator && <TypingIndicatorComponent typingIndicatorLabel={typingIndicatorLabel} />}
    </>
  );
});

VirtualMessageList.displayName = 'VirtualMessageList';
