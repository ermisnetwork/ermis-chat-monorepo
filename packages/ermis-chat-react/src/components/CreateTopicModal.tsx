import React, { useState, useCallback } from 'react';
import type { CreateTopicData } from '@ermis-network/ermis-chat-sdk';
import { Modal } from './Modal';
import { useChatClient } from '../hooks/useChatClient';
import type { CreateTopicModalProps } from '../types';

const DEFAULT_TOPIC_ICONS = ['💬', '🔥', '🚀', '⭐', '💡', '🎉', '📌', '📁', '🎨', '💻', '📈', '🤝'];

export const CreateTopicModal: React.FC<CreateTopicModalProps> = React.memo(({
  isOpen,
  onClose,
  onSuccess,
  EmojiPickerComponent,
  parentChannel,
  title = 'Create Topic',
  nameLabel = 'Topic Name',
  namePlaceholder = 'Enter topic name',
  emojiLabel = 'Topic icon',
  cancelButtonLabel = 'Cancel',
  createButtonLabel = 'Create',
  creatingButtonLabel = 'Creating...',
}) => {
  const { activeChannel } = useChatClient();
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const targetChannel = parentChannel || activeChannel;

  const handleCreate = useCallback(async () => {
    if (!targetChannel || !name.trim() || !emoji) return;

    setIsCreating(true);
    setError(null);

    try {
      const payload: CreateTopicData = {
        name: name.trim(),
      };

      if (emoji) {
        payload.image = `emoji://${emoji}`;
      }

      await targetChannel.createTopic(payload);

      if (onSuccess) {
        onSuccess(targetChannel);
      } else {
        onClose();
        setName('');
        setEmoji('');
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to create topic');
    } finally {
      setIsCreating(false);
    }
  }, [targetChannel, name, emoji, onSuccess, onClose]);

  const isValid = name.trim().length > 0 && emoji.length > 0;

  const footer = (
    <div className="ermis-create-topic__footer">
      <button className="ermis-create-topic__btn ermis-create-topic__btn--cancel" onClick={onClose} disabled={isCreating}>{cancelButtonLabel}</button>
      <button className="ermis-create-topic__btn ermis-create-topic__btn--create" onClick={handleCreate} disabled={isCreating || !isValid}>
        {isCreating ? creatingButtonLabel : createButtonLabel}
      </button>
    </div>
  );

  return (
    <Modal isOpen={isOpen} onClose={isCreating ? () => { } : onClose} title={title} maxWidth="400px" footer={footer}>
      <div className="ermis-create-topic__body">
        <div className="ermis-create-topic__live-preview">
          <span className="ermis-create-topic__live-preview-emoji">{emoji || <span style={{opacity: 0.3}}>#</span>}</span>
          <span className="ermis-create-topic__live-preview-name">{name || namePlaceholder}</span>
        </div>

        <div className="ermis-create-topic__field">
          <label className="ermis-create-topic__label">{nameLabel} <span className="ermis-create-topic__required">*</span></label>
          <input
            className="ermis-create-topic__input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={namePlaceholder}
            disabled={isCreating}
            maxLength={100}
            autoFocus
          />
        </div>

        <div className="ermis-create-topic__field">
          <label className="ermis-create-topic__label">{emojiLabel} <span className="ermis-create-topic__required">*</span></label>

          <div className="ermis-create-topic__emoji-picker">
            {EmojiPickerComponent ? (
              <EmojiPickerComponent onSelect={(e: any) => setEmoji(e.native || e.emoji || e.id || e)} />
            ) : (
              <div className="ermis-create-topic__default-icons">
                {DEFAULT_TOPIC_ICONS.map(icon => (
                  <button
                    key={icon}
                    type="button"
                    className={`ermis-create-topic__default-icon ${icon === emoji ? 'ermis-create-topic__default-icon--active' : ''}`}
                    onClick={() => setEmoji(icon)}
                    disabled={isCreating}
                  >
                    {icon}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {error && (
          <div className="ermis-create-topic__error">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
});

CreateTopicModal.displayName = 'CreateTopicModal';
