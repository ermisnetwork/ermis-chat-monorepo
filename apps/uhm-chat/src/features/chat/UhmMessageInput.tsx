import { useUIStore } from '@/store/useUIStore';
import {
  EditPreview,
  FilesPreview,
  MentionSuggestions,
  PreviewOverlay,
  ReplyPreview,
  buildUserMap,
  getMentionHtml,
  replaceMentionsForPreview,
  useBannedState,
  useBlockedState,
  useChannelCapabilities,
  useChatClient,
  useDragAndDrop,
  useFileUpload,
  useMentions,
  useMessageSend,
  usePendingState,
  usePreviewState,
} from '@ermis-network/ermis-chat-react';
import { Cat, Mic, Plus, SendHorizonal, Smile, Trash2 } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MultiRecorder } from 'react-ts-audio-recorder';
import pcmWorkletUrl from 'react-ts-audio-recorder/assets/pcm-worklet.js?url';

import { UhmDragAndDropOverlay } from './UhmDragAndDropOverlay';

export type UhmMessageInputProps = {
  dragAndDropLabel?: string;
  DragAndDropOverlayComponent?: React.ComponentType<{ dragAndDropLabel: string }>;
};

export const UhmMessageInput: React.FC<UhmMessageInputProps> = ({
  dragAndDropLabel,
  DragAndDropOverlayComponent = UhmDragAndDropOverlay,
}) => {
  const { t } = useTranslation();
  const { client, activeChannel, syncMessages, quotedMessage, setQuotedMessage, editingMessage, setEditingMessage } = useChatClient();
  const { isBanned } = useBannedState(activeChannel, client.userID);
  const { isBlocked } = useBlockedState(activeChannel, client.userID);
  const { isPending } = usePendingState(activeChannel, client.userID);
  const { isPreviewMode } = usePreviewState(activeChannel, client.userID);

  const editableRef = useRef<HTMLDivElement>(null);
  const [hasContent, setHasContent] = useState(false);

  const { hasCapability } = useChannelCapabilities();
  const isClosedTopic = activeChannel?.data?.is_closed_topic === true;

  // Permissions
  const canSendMessage = hasCapability('send-message');
  const canSendLinks = hasCapability('send-links');

  const [keywordError, setKeywordError] = useState<string | null>(null);
  const [errorType, setErrorType] = useState<'maxChars' | 'links' | null>(null);

  // Voice Recording state
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [isUploadingVoice, setIsUploadingVoice] = useState(false);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [recordedUrl, setRecordedUrl] = useState<string | null>(null);
  const recorderRef = useRef<MultiRecorder | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (recorderRef.current) recorderRef.current.close();
    };
  }, []);

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const cancelRecording = () => {
    if (recorderRef.current) {
      recorderRef.current.close();
      recorderRef.current = null;
    }
    if (recordedUrl) URL.revokeObjectURL(recordedUrl);
    setIsRecording(false);
    setRecordingTime(0);
    setIsUploadingVoice(false);
    setRecordedBlob(null);
    setRecordedUrl(null);
    if (timerRef.current) clearInterval(timerRef.current);
  };

  const sendVoiceMessage = async () => {
    if (!recordedBlob || !activeChannel) return;

    setIsUploadingVoice(true);
    try {
      const file = new File([recordedBlob], `Voice_Message.wav`, { type: 'audio/wav' });
      const uploadRes = await activeChannel.sendFile(file, file.name, file.type);
      await activeChannel.sendMessage({
        text: '',
        attachments: [{
          type: 'voiceRecording',
          asset_url: uploadRes.file,
          title: file.name,
          file_size: file.size,
          mime_type: file.type,
          duration: recordingTime,
        }],
      });
      cancelRecording();
    } catch (err) {
      console.error('Failed to send voice message:', err);
      setIsUploadingVoice(false);
    }
  };

  const toggleRecording = async () => {
    if (isRecording) {
      if (!recorderRef.current) return;
      try {
        const blob = await recorderRef.current.stopRecording();
        setRecordedBlob(blob);
        setRecordedUrl(URL.createObjectURL(blob));
      } catch (err) {
        console.error('Failed to process voice message:', err);
      } finally {
        recorderRef.current.close();
        recorderRef.current = null;
        setIsRecording(false);
        if (timerRef.current) clearInterval(timerRef.current);
      }
    } else {
      try {
        const recorder = new MultiRecorder({
          format: 'wav',
          workletURL: pcmWorkletUrl,
        });
        await recorder.init();
        await recorder.startRecording();
        recorderRef.current = recorder;
        setIsRecording(true);
        setRecordingTime(0);
        timerRef.current = window.setInterval(() => {
          setRecordingTime(prev => prev + 1);
        }, 1000);
      } catch (err) {
        console.error('Failed to start recording:', err);
      }
    }
  };

  // Refresh error message when language changes
  useEffect(() => {
    if (errorType === 'maxChars') {
      setKeywordError(t('chat.maxCharsExceeded', 'Message blocked: Maximum 5000 characters allowed.'));
    } else if (errorType === 'links') {
      setKeywordError(t('chat.linksDisabled', 'Message blocked: Sending links is disabled for members.'));
    } else {
      setKeywordError(null);
    }
  }, [t, errorType]);

  // File Upload Hook
  const {
    files, setFiles, fileInputRef,
    handleFilesSelected, handleRemoveFile, handleAttachClick, cleanupFiles,
  } = useFileUpload({ activeChannel, editableRef, setHasContent });

  const { isDragging } = useDragAndDrop(
    handleFilesSelected,
    !canSendMessage || !!editingMessage || !!quotedMessage
  );

  // Mentions
  const members = useMemo(() => {
    if (!activeChannel) return [];
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
  }, [activeChannel, activeChannel?.state?.members]);

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
    isTeamChannel: true,
    buildPayload,
    reset: resetMentions,
    syncMessages,
    onSend: () => { },
    onBeforeSend: async (text: string) => {
      // Keyword validation (links)
      if (!canSendLinks && text) {
        const urlRegex = /(https?:\/\/[^\s]+)|(www\.[^\s]+)|([a-zA-Z0-9-]+\.[a-zA-Z]{2,}(\/[^\s]*)?)/i;
        if (urlRegex.test(text)) {
          setErrorType('links');
          return false;
        }
      }

      // Max Characters validation (5000 chars)
      const charCount = text.length;
      if (text && charCount > 5000) {
        setErrorType('maxChars');
        return false;
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
    if (!el) return;

    // Normalize empty state for placeholder to work (fix browser leaving <br> or whitespace)
    if (el.textContent === '' && el.innerHTML !== '') {
      el.innerHTML = '';
    }

    const content = el.textContent?.trim() ?? '';
    setHasContent(content.length > 0 || files.length > 0);

    // Real-time character count check
    if (content.length > 5000) {
      setErrorType('maxChars');
    } else if (errorType === 'maxChars') {
      setErrorType(null);
    }

    mentionHandleInput();
    activeChannel?.keystroke();
  }, [mentionHandleInput, files.length, activeChannel, t, errorType]);

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
    const consumed = mentionHandleKeyDown(e);
    if (consumed) return;

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!keywordError) {
        handleSend();
      }
    }
  }, [mentionHandleKeyDown, handleSend, editingMessage, quotedMessage, setEditingMessage, setQuotedMessage, resetMentions, cleanupFiles, setFiles, setHasContent, keywordError]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault();
    if (e.clipboardData.files && e.clipboardData.files.length > 0) {
      if (canSendMessage && !editingMessage) {
        handleFilesSelected(e.clipboardData.files);
      }
      return;
    }
    const plainText = e.clipboardData.getData('text/plain');
    if (plainText) {
      document.execCommand('insertText', false, plainText);
    }
  }, [canSendMessage, editingMessage, handleFilesSelected]);

  const handleEmojiSelect = useCallback((emojiNative: string) => {
    const el = editableRef.current;
    if (el) {
      el.focus();
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        range.deleteContents();
        const textNode = document.createTextNode(emojiNative);
        range.insertNode(textNode);
        range.setStartAfter(textNode);
        range.setEndAfter(textNode);
        selection.removeAllRanges();
        selection.addRange(range);
      } else {
        el.innerHTML += emojiNative;
      }
      handleInput();
    }
  }, [handleInput]);

  const { openEmojiPicker, openStickerPicker, closePickers, pickerAction } = useUIStore();

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
  const disabledInput = !canSendMessage || sending || isStillUploading || isUploadingVoice;

  return (
    <div className="relative z-50 shrink-0">
      <div className="relative flex flex-col background-transparent transition-shadow">

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
          <div className="px-4 py-2 text-xs font-medium text-red-600 bg-red-50/80 dark:bg-red-950/40 border-b border-red-100 dark:border-red-900/30 backdrop-blur-sm animate-in slide-in-from-top-1 duration-200">
            {keywordError}
          </div>
        )}

        <div className="px-4 pb-3 pt-1.5">
          <div className="relative flex items-end w-full pl-2 pr-1.5 py-1.5 bg-zinc-100 dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-700/50 rounded-3xl min-h-[44px]">
            {(isRecording || recordedBlob || isUploadingVoice) ? (
              <div className="flex flex-1 items-center justify-between w-full h-[32px] mb-[1px]">
                <style>{`
                  @keyframes audio-wave {
                    0% { height: 20%; opacity: 0.7; }
                    50% { height: 100%; opacity: 1; }
                    100% { height: 20%; opacity: 0.7; }
                  }
                  .animate-wave {
                    animation: audio-wave 1s ease-in-out infinite;
                    height: 20%;
                  }
                `}</style>

                {isRecording ? (
                  <>
                    {/* Left side: Pulsing Mic + Timer */}
                    <div className="flex items-center gap-2 pl-2">
                      <div className="flex items-center justify-center w-7 h-7 rounded-full bg-red-100 text-red-500 dark:bg-red-500/20 shadow-sm shrink-0">
                        <Mic className="w-3.5 h-3.5 animate-pulse" />
                      </div>
                      <span className="font-mono text-[14px] font-medium text-red-600 dark:text-red-400">
                        {formatTime(recordingTime)}
                      </span>
                    </div>

                    {/* Middle: Audio Wave */}
                    <div className="flex-1 flex justify-center items-center px-4">
                      <div className="flex items-center gap-[3px] h-5 w-full max-w-[150px] justify-center">
                        {Array.from({ length: 24 }).map((_, i) => (
                          <div
                            key={i}
                            className="w-[3px] bg-red-400 dark:bg-red-500 rounded-full animate-wave"
                            style={{
                              animationDelay: `${Math.random() * 0.5}s`,
                              animationDuration: `${0.8 + Math.random() * 0.4}s`
                            }}
                          />
                        ))}
                      </div>
                    </div>
                  </>
                ) : recordedUrl ? (
                  <div className="flex-1 flex items-center gap-3 pl-2 pr-4">
                    <div className="flex items-center justify-center w-7 h-7 rounded-full bg-primary/10 text-primary shadow-sm shrink-0">
                      <Mic className="w-3.5 h-3.5" />
                    </div>
                    <audio src={recordedUrl} controls className="h-7 w-full outline-none" />
                  </div>
                ) : null}

                {/* Right side: Cancel & Send/Stop */}
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={cancelRecording}
                    disabled={isUploadingVoice}
                    className="inline-flex items-center justify-center w-8 h-8 text-zinc-500 hover:text-red-500 hover:bg-red-100 rounded-full dark:hover:bg-red-900/30 transition-colors disabled:opacity-50"
                    title={t('chat.cancelRecording', 'Cancel')}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>

                  <button
                    type="button"
                    onClick={isRecording ? toggleRecording : sendVoiceMessage}
                    disabled={isUploadingVoice}
                    className="inline-flex items-center justify-center w-8 h-8 text-white bg-primary rounded-full hover:bg-primary/90 transition-transform active:scale-95 disabled:opacity-50 shadow-sm"
                    title={isRecording ? t('chat.stopRecording', 'Stop') : t('chat.sendVoice', 'Send')}
                  >
                    {isUploadingVoice ? (
                      <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    ) : isRecording ? (
                      <span className="w-2.5 h-2.5 bg-white rounded-sm" />
                    ) : (
                      <SendHorizonal className="w-4 h-4 ml-0.5" />
                    )}
                  </button>
                </div>
              </div>
            ) : (
              <>
                {showSuggestions && (
                  <MentionSuggestions
                    members={filteredMembers}
                    highlightIndex={highlightIndex}
                    onSelect={selectMention}
                  />
                )}

                {/* Left Actions */}
                <div className="flex items-center shrink-0 mb-[2px] gap-1">
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
                    className="inline-flex items-center justify-center w-8 h-8 rounded-full text-zinc-500 hover:text-zinc-700 hover:bg-zinc-200 dark:text-zinc-400 dark:hover:text-zinc-200 dark:hover:bg-zinc-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    title={t('chat.attachFile', 'Attach file')}
                  >
                    <Plus className="w-5 h-5" />
                  </button>

                  <button
                    type="button"
                    disabled={disabledInput || !!editingMessage}
                    className={`picker-trigger inline-flex items-center justify-center w-8 h-8 rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${pickerAction.type === 'emoji'
                      ? 'text-primary bg-primary/10'
                      : 'text-zinc-500 hover:text-zinc-700 hover:bg-zinc-200 dark:text-zinc-400 dark:hover:text-zinc-200 dark:hover:bg-zinc-700'
                      }`}
                    onClick={(e) => {
                      if (pickerAction.type === 'emoji') {
                        closePickers();
                      } else {
                        const rect = e.currentTarget.getBoundingClientRect();
                        openEmojiPicker(rect, handleEmojiSelect);
                      }
                    }}
                    title={t('chat.addEmoji', 'Add Emoji')}
                  >
                    <Smile className="w-5 h-5" />
                  </button>

                  <button
                    type="button"
                    disabled={disabledInput || !!editingMessage || !!quotedMessage}
                    className={`picker-trigger inline-flex items-center justify-center w-8 h-8 rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${pickerAction.type === 'sticker'
                      ? 'text-primary bg-primary/10'
                      : 'text-zinc-500 hover:text-zinc-700 hover:bg-zinc-200 dark:text-zinc-400 dark:hover:text-zinc-200 dark:hover:bg-zinc-700'
                      }`}
                    onClick={(e) => {
                      if (pickerAction.type === 'sticker') {
                        closePickers();
                      } else {
                        const rect = e.currentTarget.getBoundingClientRect();
                        openStickerPicker(rect, (url) => {
                          if (activeChannel) {
                            activeChannel.sendMessage({
                              text: '',
                              attachments: [],
                              sticker_url: url,
                            });
                          }
                        });
                      }
                    }}
                    title={t('chat.addSticker', 'Add Sticker')}
                  >
                    <Cat className="w-5 h-5" />
                  </button>
                </div>

                {/* Main input area */}
                <div className="relative flex-1 flex flex-col justify-center">
                  {!hasContent && (
                    <div className="absolute left-2 text-[15px] text-zinc-500 dark:text-zinc-400 pointer-events-none select-none">
                      {t('chat.placeholder', 'Type a message...')}
                    </div>
                  )}
                  <div
                    ref={editableRef}
                    className="flex-1 w-full max-h-[150px] overflow-y-auto px-2 py-1.5 text-[15px] text-zinc-900 dark:text-zinc-100 outline-none cursor-text break-words whitespace-pre-wrap leading-relaxed"
                    contentEditable={!disabledInput}
                    role="textbox"
                    onInput={handleInput}
                    onKeyDown={handleKeyDown}
                    onPaste={handlePaste}
                    suppressContentEditableWarning
                  />
                </div>

                {/* Right Actions */}
                <div className="flex items-center shrink-0 mb-[2px] ml-1">
                  {hasContent ? (
                    <button
                      type="button"
                      disabled={!hasContent || disabledInput || !!keywordError}
                      onClick={handleSend}
                      className="inline-flex items-center justify-center w-8 h-8 rounded-full text-primary-foreground bg-primary hover:bg-primary/90 disabled:opacity-50 transition-all shadow-sm active:scale-95 disabled:scale-100"
                      title={t('chat.send', 'Send')}
                    >
                      <SendHorizonal className="w-[18px] h-[18px] ml-0.5" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={isUploadingVoice || disabledInput || !!editingMessage || !!quotedMessage}
                      className="inline-flex items-center justify-center w-8 h-8 rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-zinc-500 hover:text-zinc-700 hover:bg-zinc-200 dark:text-zinc-400 dark:hover:text-zinc-200 dark:hover:bg-zinc-700"
                      onClick={toggleRecording}
                      title={t('chat.recordVoice', 'Record Voice')}
                    >
                      <Mic className="w-5 h-5" />
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Drag & Drop Overlay */}
      {isDragging && (
        <DragAndDropOverlayComponent
          dragAndDropLabel={dragAndDropLabel || t('chat.dragAndDrop', 'Thả file vào đây để gửi')}
        />
      )}
    </div>
  );
};
