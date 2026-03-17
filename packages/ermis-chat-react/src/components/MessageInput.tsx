import React, { useState, useCallback } from 'react';
import { useChatClient } from '../hooks/useChatClient';

export type MessageInputProps = {
  /** Placeholder text */
  placeholder?: string;
  /** Called after message is sent successfully */
  onSend?: (text: string) => void;
};

export const MessageInput: React.FC<MessageInputProps> = ({
  placeholder = 'Type a message...',
  onSend,
}) => {
  const { activeChannel } = useChatClient();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  const handleSend = useCallback(async () => {
    if (!activeChannel || !text.trim() || sending) return;

    try {
      setSending(true);
      await activeChannel.sendMessage({ text: text.trim() });
      setText('');
      onSend?.(text.trim());
    } catch (err) {
      console.error('Failed to send message:', err);
    } finally {
      setSending(false);
    }
  }, [activeChannel, text, sending, onSend]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  if (!activeChannel) return null;

  return (
    <div className="ermis-message-input">
      <textarea
        className="ermis-message-input__textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={sending}
        rows={1}
      />
      <button
        className="ermis-message-input__send-btn"
        onClick={handleSend}
        disabled={!text.trim() || sending}
      >
        Send
      </button>
    </div>
  );
};
