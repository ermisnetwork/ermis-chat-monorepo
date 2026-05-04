import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useChatClient } from '../hooks/useChatClient';
import { useBannedState } from '../hooks/useBannedState';
import { useBlockedState } from '../hooks/useBlockedState';
import { usePendingState } from '../hooks/usePendingState';
import { useMentions } from '../hooks/useMentions';
import { useFileUpload } from '../hooks/useFileUpload';
import { useEmojiPicker } from '../hooks/useEmojiPicker';
import { useMessageSend } from '../hooks/useMessageSend';
import { DefaultSendButton, DefaultAttachButton, DefaultEmojiButton } from './MessageInputDefaults';
import { MentionSuggestions } from './MentionSuggestions';
import { FilesPreview } from './FilesPreview';
import { ReplyPreview } from './ReplyPreview';
import { EditPreview } from './EditPreview';
import { PreviewOverlay } from './PreviewOverlay';
import { usePreviewState } from '../hooks/usePreviewState';
import { buildUserMap, replaceMentionsForPreview, moveCaretToEnd } from '../utils';
import { getMentionHtml } from '../hooks/useMentions';
import { useChannelCapabilities } from '../hooks/useChannelCapabilities';
import { CHANNEL_ROLES } from '../channelRoleUtils';
import { isTopicChannel } from '../channelTypeUtils';
import type { MentionMember, MessageInputProps, FilePreviewItem } from '../types';

export type { MessageInputProps, SendButtonProps, AttachButtonProps, EmojiPickerProps, EmojiButtonProps } from '../types';

export const MessageInput: React.FC<MessageInputProps> = React.memo(({
  placeholder = 'Type a message...',
  onSend,
  className,
  SendButton = DefaultSendButton,
  AttachButton = DefaultAttachButton,
  FilesPreviewComponent = FilesPreview,
  MentionSuggestionsComponent = MentionSuggestions,
  disableAttachments = false,
  disableMentions = false,
  renderAbove,
  onBeforeSend,
  EmojiPickerComponent,
  EmojiButtonComponent = DefaultEmojiButton,
  ReplyPreviewComponent = ReplyPreview,
  EditPreviewComponent = EditPreview,
  bannedLabel = 'You have been banned from this channel',
  blockedLabel = 'You have blocked this user. Unblock to send messages.',
  linksDisabledLabel = 'Message blocked: Sending links is disabled for members.',
  keywordBlockedLabel = (match: string) => `Message blocked: Contains restricted word "${match}".`,
  sendDisabledLabel = 'Sending messages is disabled in this channel.',
  slowModeLabel = (cooldown: number) => (
    <>Slow mode is active. You can send another message in <strong>{cooldown}s</strong>.</>
  ),
  closedTopicLabel = 'This topic is closed.',
  PreviewOverlayComponent = PreviewOverlay,
  previewOverlayTitle = 'You are viewing a public channel.',
  joinChannelLabel = 'Join Channel',
}) => {
  const { client, activeChannel, syncMessages, quotedMessage, setQuotedMessage, editingMessage, setEditingMessage } = useChatClient();
  const { isBanned } = useBannedState(activeChannel, client.userID);
  const { isBlocked } = useBlockedState(activeChannel, client.userID);
  const { isPending } = usePendingState(activeChannel, client.userID);
  const { isPreviewMode } = usePreviewState(activeChannel, client.userID);
  const editableRef = React.useRef<HTMLDivElement>(null);
  const [hasContent, setHasContent] = useState(false);

  const { role, isGroupChannel: isTeamChannel, hasCapability } = useChannelCapabilities();
  const isTopic = isTopicChannel(activeChannel);
  const isClosedTopic = activeChannel?.data?.is_closed_topic === true;

  // Slow Mode Logic
  const [memberMessageCooldown, setMemberMessageCooldown] = useState(Number(activeChannel?.data?.member_message_cooldown) || 0);

  useEffect(() => {
    if (!activeChannel) return;
    setMemberMessageCooldown(Number(activeChannel.data?.member_message_cooldown) || 0);
    const handleUpdate = (event: Record<string, unknown>) => {
      const channelData = (event?.channel as Record<string, unknown>) || activeChannel.data;
      setMemberMessageCooldown(Number(channelData?.member_message_cooldown) || 0);
    };
    activeChannel.on('channel.updated', handleUpdate);
    return () => {
      activeChannel.off('channel.updated', handleUpdate);
    };
  }, [activeChannel]);

  const isSlowModeApplied = isTeamChannel && role === CHANNEL_ROLES.MEMBER && memberMessageCooldown > 0;

  const [cooldownEnd, setCooldownEnd] = useState<number | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const lastMsgSentAtRef = useRef<number>(0);

  // Initialize cooldown state periodically or on change
  useEffect(() => {
    if (!isSlowModeApplied) {
      setCooldownEnd(null);
      setCooldown(0);
      return;
    }

    let lastMsgSentAt = lastMsgSentAtRef.current || 0;
    const messages = activeChannel?.state?.messages || [];

    // Iterate from newest to oldest to find actual highest timestamp
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].user?.id === client.userID) {
        const msgTime = new Date(messages[i].created_at).getTime();
        if (msgTime && !isNaN(msgTime) && msgTime > lastMsgSentAt) {
          lastMsgSentAt = msgTime;
        }
        break;
      }
    }

    if (lastMsgSentAt) {
      const cdEnd = lastMsgSentAt + memberMessageCooldown;
      if (cdEnd > Date.now()) {
        setCooldownEnd(cdEnd);
      } else {
        setCooldownEnd(null);
        setCooldown(0);
      }
    } else {
      setCooldownEnd(null);
      setCooldown(0);
    }
  }, [isSlowModeApplied, activeChannel, memberMessageCooldown, client.userID]);

  // Tick the countdown visualization
  useEffect(() => {
    if (!cooldownEnd || cooldownEnd <= Date.now()) {
      setCooldown(0);
      return;
    }
    const updateCd = () => {
      const remaining = cooldownEnd - Date.now();
      if (remaining <= 0) {
        setCooldown(0);
      } else {
        setCooldown(Math.ceil(remaining / 1000));
      }
    };
    updateCd();
    const timer = setInterval(updateCd, 1000);
    return () => clearInterval(timer);
  }, [cooldownEnd]);

  const isSlowModeBlocked = isSlowModeApplied && cooldown > 0 && !editingMessage;

  const canSendMessage = hasCapability('send-message');
  const canSendLinks = hasCapability('send-links');

  const [keywordError, setKeywordError] = useState<string | null>(null);

  // Auto-clear link restriction banner if admin suddenly restores the capability
  useEffect(() => {
    if (keywordError?.includes('links') && canSendLinks) {
      setKeywordError(null);
    }
  }, [canSendLinks, keywordError]);

  const localOnBeforeSend = useCallback(async (text: string, attachments: FilePreviewItem[]) => {
    // Permission validation: Send Links
    if (!canSendLinks && text) {
      // Basic URL matching config
      const urlRegex = /(https?:\/\/[^\s]+)|(www\.[^\s]+)|([a-zA-Z0-9-]+\.[a-zA-Z]{2,}(\/[^\s]*)?)/i;
      if (urlRegex.test(text)) {
        setKeywordError(linksDisabledLabel);
        return false;
      }
    }

    // Custom Keyword validation
    const words = (activeChannel?.data?.filter_words as string[]) || [];
    if (words.length > 0 && text) {
      const lowerText = text.toLowerCase();
      const match = words.find(w => lowerText.includes(w.toLowerCase()));
      if (match) {
        setKeywordError(keywordBlockedLabel(match));
        // We could also visually shake the input box here
        return false;
      }
    }
    setKeywordError(null);
    if (onBeforeSend) {
      return await onBeforeSend(text, attachments);
    }
    return true;
  }, [activeChannel, onBeforeSend, canSendLinks]);

  const handleMessageSent = useCallback((text: string) => {
    if (isSlowModeApplied) {
      lastMsgSentAtRef.current = Date.now();
      setCooldownEnd(Date.now() + memberMessageCooldown);
    }
    onSend?.(text);
  }, [isSlowModeApplied, memberMessageCooldown, onSend]);

  // Auto-focus when channel changes or when reply/edit is selected
  useEffect(() => {
    if (activeChannel && editableRef.current) {
      editableRef.current.focus();
    }
  }, [activeChannel, quotedMessage, editingMessage]);


  /* ---------- Hooks ---------- */
  const {
    files, setFiles, fileInputRef,
    handleFilesSelected, handleRemoveFile, handleAttachClick, cleanupFiles,
  } = useFileUpload({ activeChannel, editableRef, setHasContent });

  // Pre-fill text and legacy attachments when editingMessage is set
  useEffect(() => {
    if (editingMessage && editableRef.current) {
      // 1. Prefill text content
      const rawText = editingMessage.text || '';

      // Extract user map locally since we have `activeChannel.state.members`
      const userMap = buildUserMap(activeChannel?.state);

      const htmlText = rawText
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br>');

      editableRef.current.innerHTML = replaceMentionsForPreview(
        htmlText,
        editingMessage,
        userMap,
        getMentionHtml
      );

      // Move cursor to the end
      moveCaretToEnd(editableRef.current);

      // The API does not support attachment modifications during edits.
      // Flush any active files and only allow text/mention modifications.
      setFiles([]);
      setHasContent(!!editingMessage.text);
    }
  }, [editingMessage, setFiles]);

  // Cleanup blob URLs on unmount
  useEffect(() => {
    return () => cleanupFiles();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const {
    emojiPickerOpen,
    handleEmojiSelect,
    handleEmojiClose,
    toggleEmojiPicker,
  } = useEmojiPicker({ editableRef, setHasContent });

  // Build member list from channel state (only for team channels and topics)
  const members = useMemo<MentionMember[]>(() => {
    if (!(isTeamChannel || isTopic)) return [];
    const list: MentionMember[] = [];
    const stateMembers = activeChannel?.state?.members as Record<string, unknown> | undefined;
    if (stateMembers && typeof stateMembers === 'object') {
      for (const [id, memberVal] of Object.entries(stateMembers)) {
        const member = memberVal as Record<string, any>;
        list.push({
          id,
          name: member?.user?.name || member?.user_id || id,
          avatar: member?.user?.avatar,
        });
      }
    }
    return list;
  }, [activeChannel, isTeamChannel, isTopic]);

  const {
    showSuggestions, filteredMembers, highlightIndex,
    handleInput: mentionHandleInput,
    handleKeyDown: mentionHandleKeyDown,
    selectMention, buildPayload, reset,
  } = useMentions({
    members,
    currentUserId: client.userID,
    editableRef,
  });

  const cancelEdit = useCallback(() => {
    setEditingMessage(null);
    cleanupFiles();
    setFiles([]);
    setHasContent(false);
    reset();
    if (editableRef.current) {
      editableRef.current.innerHTML = '';
    }
  }, [setEditingMessage, cleanupFiles, setFiles, setHasContent, reset]);

  const { sending, handleSend } = useMessageSend({
    activeChannel,
    editableRef,
    files,
    setFiles,
    hasContent,
    setHasContent,
    isTeamChannel: isTeamChannel || isTopic,
    buildPayload,
    reset,
    syncMessages,
    onSend: handleMessageSent,
    onBeforeSend: localOnBeforeSend,
    quotedMessage,
    clearQuotedMessage: () => setQuotedMessage(null),
    editingMessage,
    clearEditingMessage: () => setEditingMessage(null),
  });

  useEffect(() => {
    reset();
    handleEmojiClose();
    setFiles((prev) => {
      prev.forEach((f) => {
        if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
      });
      return [];
    });
    setHasContent(false);

    // Stop typing indicator on channel switch / unmount
    return () => {
      activeChannel?.stopTyping();
    };
  }, [activeChannel, reset, handleEmojiClose, setFiles]);

  /* ---------- Input event handlers ---------- */
  const handleInput = useCallback(() => {
    const el = editableRef.current;
    const content = el?.textContent?.trim() ?? '';
    setHasContent(content.length > 0 || files.length > 0);
    setKeywordError(null); // clear keyword error if user modifies input
    if ((isTeamChannel || isTopic) && !disableMentions) {
      mentionHandleInput();
    }
    // Send typing indicator (SDK throttles to 1 event per 2s)
    activeChannel?.keystroke();
  }, [isTeamChannel, isTopic, disableMentions, mentionHandleInput, files.length, activeChannel]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Prevent reacting to "Enter" when constructing characters with an IME (e.g. Vietnamese telex)
      if (e.nativeEvent.isComposing) return;

      if (e.key === 'Escape') {
        if (editingMessage) {
          cancelEdit();
          return;
        }
        if (quotedMessage) {
          setQuotedMessage(null);
          return;
        }
      }
      if ((isTeamChannel || isTopic) && !disableMentions) {
        const consumed = mentionHandleKeyDown(e);
        if (consumed) return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!isSlowModeBlocked) {
          handleSend();
        }
      }
    },
    [isTeamChannel, isTopic, disableMentions, mentionHandleKeyDown, handleSend, editingMessage, quotedMessage, setEditingMessage, setQuotedMessage, reset],
  );

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault();
    const plainText = e.clipboardData.getData('text/plain');
    document.execCommand('insertText', false, plainText);
  }, []);

  if (!activeChannel) return null;

  // Don't show input for pending invitations at all
  if (isPending) return null;

  // Show banned banner instead of input
  if (isBanned) {
    return (
      <div className={`ermis-message-input ermis-message-input--banned${className ? ` ${className}` : ''}`}>
        <div className="ermis-message-input__banned-banner">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
          </svg>
          <span>{bannedLabel}</span>
        </div>
      </div>
    );
  }

  // Show blocked banner instead of input (messaging channels only)
  if (isBlocked) {
    return (
      <div className={`ermis-message-input ermis-message-input--blocked${className ? ` ${className}` : ''}`}>
        <div className="ermis-message-input__blocked-banner">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
          </svg>
          <span>{blockedLabel}</span>
        </div>
      </div>
    );
  }

  // Show closed topic banner instead of input
  if (isClosedTopic) {
    return (
      <div className={`ermis-message-input ermis-message-input--closed${className ? ` ${className}` : ''}`}>
        <div className="ermis-message-input__closed-banner">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          <span>{closedTopicLabel}</span>
        </div>
      </div>
    );
  }

  // Show Preview Overlay for public channels when the user has not joined
  if (isPreviewMode) {
    return (
      <PreviewOverlayComponent
        title={previewOverlayTitle}
        buttonLabel={joinChannelLabel}
        onJoin={() => {
          activeChannel?.acceptInvite('join').catch(e => console.error('Failed to join public channel', e));
        }}
        className={className}
      />
    );
  }

  const isStillUploading = files.some((f) => f.status === 'uploading');

  return (
    <div className={`ermis-message-input${className ? ` ${className}` : ''}`}>
      {/* Reply preview */}
      {quotedMessage && !editingMessage && (
        <ReplyPreviewComponent
          message={quotedMessage}
          onDismiss={() => setQuotedMessage(null)}
        />
      )}

      {/* Edit preview */}
      {editingMessage && (
        <EditPreviewComponent
          message={editingMessage}
          onDismiss={cancelEdit}
        />
      )}

      {/* Custom content above input */}
      {renderAbove?.()}

      {/* File previews */}
      {!disableAttachments && <FilesPreviewComponent files={files} onRemove={handleRemoveFile} />}

      {/* Keyword Error Banner */}
      {keywordError && (
        <div className="ermis-message-input__keyword-banner">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
          {keywordError}
        </div>
      )}

      {/* Permission Disabled Banner */}
      {!canSendMessage && !editingMessage && (
        <div className="ermis-message-input__permission-banner">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
          {sendDisabledLabel}
        </div>
      )}

      {/* Slow Mode Cooldown Banner */}
      {canSendMessage && isSlowModeBlocked && !keywordError && (
        <div className="ermis-message-input__slow-mode-banner">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
          {typeof slowModeLabel === 'function' ? slowModeLabel(cooldown) : slowModeLabel}
        </div>
      )}

      {/* Text input + send row */}
      <div className={`ermis-message-input__row${(!canSendMessage || isSlowModeBlocked || keywordError) ? ' ermis-message-input__row--banners-active' : ''}`}>
        <div className="ermis-message-input__editable-wrapper">
          {canSendMessage && (isTeamChannel || isTopic) && !disableMentions && showSuggestions && (
            <MentionSuggestionsComponent
              members={filteredMembers}
              highlightIndex={highlightIndex}
              onSelect={selectMention}
            />
          )}

          {/* Attach button */}
          {!disableAttachments && (
            <AttachButton disabled={sending || !!editingMessage || isSlowModeBlocked || !canSendMessage} onClick={handleAttachClick} />
          )}

          {/* Hidden file input */}
          {!disableAttachments && (
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="ermis-message-input__file-input"
              onChange={(e) => {
                handleFilesSelected(e.target.files);
                e.target.value = '';
              }}
              disabled={!!editingMessage || isSlowModeBlocked || !canSendMessage}
            />
          )}

          <div
            ref={editableRef}
            className="ermis-message-input__editable"
            contentEditable={!sending && !isSlowModeBlocked && canSendMessage}
            role="textbox"
            aria-placeholder={placeholder}
            data-placeholder={placeholder}
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            suppressContentEditableWarning
          />

          {/* Emoji button — shown only when EmojiPickerComponent is provided */}
          {EmojiPickerComponent && (
            <EmojiButtonComponent active={emojiPickerOpen} onClick={isSlowModeBlocked ? () => { } : toggleEmojiPicker} />
          )}
        </div>
        <SendButton disabled={!hasContent || sending || isStillUploading || isSlowModeBlocked} onClick={handleSend} />
      </div>

      {/* Emoji picker — positioned above input */}
      {EmojiPickerComponent && emojiPickerOpen && (
        <div className="ermis-message-input__emoji-picker">
          <EmojiPickerComponent onSelect={handleEmojiSelect} onClose={handleEmojiClose} />
        </div>
      )}
    </div>
  );
});

MessageInput.displayName = 'MessageInput';
