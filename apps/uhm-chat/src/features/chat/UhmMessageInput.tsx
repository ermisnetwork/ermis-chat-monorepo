import React, { useRef, useState, useCallback, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  useChatClient,
  useMessageSend,
  useFileUpload,
  useChannelCapabilities,
  useBannedState,
  useBlockedState,
  usePendingState,
  usePreviewState,
  FilesPreview,
  MentionSuggestions,
  ReplyPreview,
  EditPreview,
  PreviewOverlay,
  isTopicChannel,
  buildUserMap,
  replaceMentionsForPreview,
  getMentionHtml,
  useMentions,
  useStickerPicker,
} from '@ermis-network/ermis-chat-react';
import { Paperclip, SendHorizonal } from 'lucide-react';
import { EmojiPickerPopover } from './EmojiPickerPopover';
import { StickerPickerPopover } from './StickerPickerPopover';

export const UhmMessageInput: React.FC = () => {
  const { t } = useTranslation();
  const { client, activeChannel, syncMessages, quotedMessage, setQuotedMessage, editingMessage, setEditingMessage } = useChatClient();
  const { isBanned } = useBannedState(activeChannel, client.userID);
  const { isBlocked } = useBlockedState(activeChannel, client.userID);
  const { isPending } = usePendingState(activeChannel, client.userID);
  const { isPreviewMode } = usePreviewState(activeChannel, client.userID);

  const editableRef = useRef<HTMLDivElement>(null);
  const [hasContent, setHasContent] = useState(false);

  const { isGroupChannel: isTeamChannel, hasCapability } = useChannelCapabilities();
  const isTopic = isTopicChannel(activeChannel);
  const isClosedTopic = activeChannel?.data?.is_closed_topic === true;

  // Permissions
  const canSendMessage = hasCapability('send-message');
  const canSendLinks = hasCapability('send-links');

  const [keywordError, setKeywordError] = useState<string | null>(null);

  // File Upload Hook
  const {
    files, setFiles, fileInputRef,
    handleFilesSelected, handleRemoveFile, handleAttachClick, cleanupFiles,
  } = useFileUpload({ activeChannel, editableRef, setHasContent });

  // Mentions
  const members = useMemo(() => {
    if (!(isTeamChannel || isTopic)) return [];
    const list = [];
    const stateMembers = activeChannel?.state?.members as Record<string, { user?: { name?: string, avatar?: string }, user_id?: string }> | undefined;
    if (stateMembers && typeof stateMembers === 'object') {
      for (const [id, memberVal] of Object.entries(stateMembers)) {
        list.push({
          id,
          name: memberVal?.user?.name || memberVal?.user_id || id,
          avatar: memberVal?.user?.avatar,
        });
      }
    }
    return list;
  }, [activeChannel, isTeamChannel, isTopic]);

  const {
    showSuggestions, filteredMembers, highlightIndex,
    handleInput: mentionHandleInput,
    handleKeyDown: mentionHandleKeyDown,
    selectMention, buildPayload, reset: resetMentions,
  } = useMentions({
    members,
    currentUserId: client.userID,
    editableRef,
  });

  // Message Send Hook
  const { sending, handleSend } = useMessageSend({
    activeChannel,
    editableRef,
    files,
    setFiles,
    hasContent,
    setHasContent,
    isTeamChannel: isTeamChannel || isTopic,
    buildPayload,
    reset: resetMentions,
    syncMessages,
    onSend: () => { },
    onBeforeSend: async (text: string) => {
      // Keyword validation (links)
      if (!canSendLinks && text) {
        const urlRegex = /(https?:\/\/[^\s]+)|(www\.[^\s]+)|([a-zA-Z0-9-]+\.[a-zA-Z]{2,}(\/[^\s]*)?)/i;
        if (urlRegex.test(text)) {
          setKeywordError(t('chat.linksDisabled', 'Message blocked: Sending links is disabled for members.'));
          return false;
        }
      }
      return true;
    },
    quotedMessage,
    clearQuotedMessage: () => setQuotedMessage(null),
    editingMessage,
    clearEditingMessage: () => setEditingMessage(null),
  });

  const handleInput = useCallback(() => {
    const el = editableRef.current;
    const content = el?.textContent?.trim() ?? '';
    setHasContent(content.length > 0 || files.length > 0);
    setKeywordError(null);
    if ((isTeamChannel || isTopic)) {
      mentionHandleInput();
    }
    activeChannel?.keystroke();
  }, [isTeamChannel, isTopic, mentionHandleInput, files.length, activeChannel]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;

    if (e.key === 'Escape') {
      if (editingMessage) {
        setEditingMessage(null);
        cleanupFiles();
        setFiles([]);
        setHasContent(false);
        resetMentions();
        if (editableRef.current) editableRef.current.innerHTML = '';
        return;
      }
      if (quotedMessage) {
        setQuotedMessage(null);
        return;
      }
    }
    if ((isTeamChannel || isTopic)) {
      const consumed = mentionHandleKeyDown(e);
      if (consumed) return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [isTeamChannel, isTopic, mentionHandleKeyDown, handleSend, editingMessage, quotedMessage, setEditingMessage, setQuotedMessage, resetMentions, cleanupFiles, setFiles, setHasContent]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault();
    const plainText = e.clipboardData.getData('text/plain');
    document.execCommand('insertText', false, plainText);
  }, []);

  const handleEmojiSelect = useCallback((emoji: { native: string }) => {
    const el = editableRef.current;
    if (el) {
      el.focus();
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        range.deleteContents();
        const textNode = document.createTextNode(emoji.native);
        range.insertNode(textNode);
        range.setStartAfter(textNode);
        range.setEndAfter(textNode);
        selection.removeAllRanges();
        selection.addRange(range);
      } else {
        el.innerHTML += emoji.native;
      }
      handleInput();
    }
  }, [handleInput]);

  const { stickerPickerOpen, toggleStickerPicker, closeStickerPicker } = useStickerPicker({
    activeChannel,
    stickerIframeUrl: 'https://sticker.ermis.network'
  });

  useEffect(() => {
    if (activeChannel && editableRef.current) {
      editableRef.current.focus();
    }
  }, [activeChannel, quotedMessage, editingMessage]);

  useEffect(() => {
    if (editingMessage && editableRef.current) {
      const rawText = editingMessage.text || '';
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

      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editableRef.current);
      range.collapse(false);
      sel?.removeAllRanges();
      sel?.addRange(range);

      setFiles([]);
      setHasContent(!!editingMessage.text);
    }
  }, [editingMessage, setFiles, activeChannel?.state]);

  if (!activeChannel) return null;
  if (isPending) return null;

  if (isBanned) {
    return (
      <div className="p-4 m-4 bg-red-50 text-red-600 dark:bg-red-950/30 dark:text-red-400 rounded-xl text-center text-sm font-medium border border-red-200 dark:border-red-900/50">
        {t('chat.bannedLabel', 'You have been banned from this channel')}
      </div>
    );
  }

  if (isBlocked) {
    return (
      <div className="p-4 m-4 bg-zinc-100 text-zinc-600 dark:bg-zinc-800/50 dark:text-zinc-400 rounded-xl text-center text-sm font-medium border border-zinc-200 dark:border-zinc-800">
        {t('chat.blockedLabel', 'You have blocked this user. Unblock to send messages.')}
      </div>
    );
  }

  if (isClosedTopic) {
    return (
      <div className="p-4 m-4 bg-zinc-100 text-zinc-600 dark:bg-zinc-800/50 dark:text-zinc-400 rounded-xl text-center text-sm font-medium border border-zinc-200 dark:border-zinc-800">
        {t('chat.closedTopic', 'This topic is closed.')}
      </div>
    );
  }

  if (isPreviewMode) {
    return (
      <PreviewOverlay
        title={t('chat.previewTitle', 'You are viewing a public channel.')}
        buttonLabel={t('chat.joinChannel', 'Join Channel')}
        onJoin={() => activeChannel.acceptInvite('join').catch(e => console.error(e))}
      />
    );
  }

  const isStillUploading = files.some(f => f.status === 'uploading');
  const disabledInput = !canSendMessage || sending || isStillUploading;

  return (
    <div className="p-4 relative">
      <div className="relative flex flex-col bg-white dark:bg-[#1a1828] border border-zinc-200 dark:border-zinc-800 rounded-2xl shadow-sm transition-shadow focus-within:ring-2 focus-within:ring-primary/20 focus-within:border-primary/50">

        {quotedMessage && !editingMessage && (
          <div className="border-b border-zinc-100 dark:border-zinc-800/50 bg-zinc-50/50 dark:bg-black/20 p-2">
            <ReplyPreview
              message={quotedMessage}
              onDismiss={() => setQuotedMessage(null)}
              replyingToLabel={t('chat.replyingTo', 'Replying to')}
            />
          </div>
        )}

        {editingMessage && (
          <div className="border-b border-zinc-100 dark:border-zinc-800/50 bg-zinc-50/50 dark:bg-black/20 p-2">
            <EditPreview
              message={editingMessage}
              onDismiss={() => {
                setEditingMessage(null);
                resetMentions();
                setFiles([]);
                setHasContent(false);
                if (editableRef.current) editableRef.current.innerHTML = '';
              }}
              editingMessageLabel={t('chat.editingMessage', 'Editing message')}
            />
          </div>
        )}

        {files.length > 0 && (
          <div className="border-b border-zinc-100 dark:border-zinc-800/50 bg-zinc-50/50 dark:bg-black/20 p-2">
            <FilesPreview files={files} onRemove={handleRemoveFile} />
          </div>
        )}

        {keywordError && (
          <div className="px-3 py-2 text-sm text-red-600 bg-red-50 dark:bg-red-950/30 border-b border-red-100 dark:border-red-900/30">
            {keywordError}
          </div>
        )}

        {/* Main input area */}
        <div className="relative flex min-h-[44px]">
          {showSuggestions && (
            <MentionSuggestions
              members={filteredMembers}
              highlightIndex={highlightIndex}
              onSelect={selectMention}
            />
          )}

          <div
            ref={editableRef}
            className="w-full flex-1 max-h-[150px] overflow-y-auto px-4 py-3 text-sm text-zinc-900 dark:text-zinc-100 outline-none empty:before:content-[attr(data-placeholder)] empty:before:text-zinc-400 dark:empty:before:text-zinc-500 cursor-text break-words leading-relaxed"
            contentEditable={!disabledInput}
            role="textbox"
            data-placeholder={t('chat.placeholder', 'Type a message...')}
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            suppressContentEditableWarning
          />
        </div>

        {/* Action Bar */}
        <div className="flex items-center justify-between px-2 pb-2">
          <div className="flex items-center gap-1">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                handleFilesSelected(e.target.files);
                e.target.value = '';
              }}
              disabled={disabledInput || !!editingMessage}
            />

            <button
              type="button"
              disabled={disabledInput || !!editingMessage}
              onClick={handleAttachClick}
              className="inline-flex items-center justify-center w-9 h-9 rounded-full text-zinc-500 hover:text-zinc-700 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:text-zinc-200 dark:hover:bg-zinc-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              title={t('chat.attachFile', 'Attach file')}
            >
              <Paperclip className="w-[18px] h-[18px]" />
            </button>

            <EmojiPickerPopover onEmojiSelect={handleEmojiSelect} disabled={disabledInput} />
            <StickerPickerPopover
              open={stickerPickerOpen}
              onOpenChange={(isOpen) => isOpen ? toggleStickerPicker() : closeStickerPicker()}
              stickerIframeUrl="https://sticker.ermis.network"
              disabled={disabledInput || !!editingMessage || !!quotedMessage}
              title={t('chat.sendSticker', 'Send Sticker')}
            />
          </div>

          <button
            type="button"
            disabled={!hasContent || disabledInput}
            onClick={handleSend}
            className="inline-flex items-center justify-center w-9 h-9 rounded-full text-primary-foreground bg-primary hover:bg-primary/90 disabled:opacity-50 disabled:bg-zinc-300 dark:disabled:bg-zinc-800 transition-colors shadow-sm active:scale-95"
            title={t('chat.send', 'Send')}
          >
            <SendHorizonal className="w-[18px] h-[18px] ml-0.5" />
          </button>
        </div>

      </div>
    </div>
  );
};
