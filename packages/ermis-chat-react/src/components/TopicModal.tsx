import React, { useState, useCallback } from 'react';
import type { CreateTopicData, EditTopicData } from '@ermis-network/ermis-chat-sdk';
import { Modal as DefaultModal } from './Modal';
import { useChatClient } from '../hooks/useChatClient';
import { useChatComponents } from '../context/ChatComponentsContext';
import type { TopicModalProps } from '../types';

const DEFAULT_TOPIC_ICONS = ['💬', '🔥', '🚀', '⭐', '💡', '🎉', '📌', '📁', '🎨', '💻', '📈', '🤝'];

export const TopicModal: React.FC<TopicModalProps> = React.memo(({
  isOpen,
  onClose,
  onSuccess,
  EmojiPickerComponent,
  parentChannel,
  topic,
  title = topic ? 'Edit Topic' : 'Create Topic',
  nameLabel = 'Topic Name',
  namePlaceholder = 'Enter topic name',
  emojiLabel = 'Topic icon',
  descriptionLabel = 'Description',
  descriptionPlaceholder = 'Enter topic description',
  cancelButtonLabel = 'Cancel',
  saveButtonLabel = topic ? 'Save' : 'Create',
  savingButtonLabel = topic ? 'Saving...' : 'Creating...',
}) => {
  const { activeChannel, client } = useChatClient();
  const { ModalComponent } = useChatComponents();
  const Modal = ModalComponent || DefaultModal;
  
  const originalName = (topic?.data?.name as string) || '';
  const originalImage = (topic?.data?.image as string) || '';
  const originalEmoji = originalImage.startsWith('emoji://') ? originalImage.replace('emoji://', '') : '';
  const originalDescription = (topic?.data?.description as string) || '';

  const [name, setName] = useState(originalName);
  const [emoji, setEmoji] = useState(originalEmoji);
  const [description, setDescription] = useState(originalDescription);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const targetParent = parentChannel || activeChannel;

  const handleSave = useCallback(async () => {
    if (!name.trim() || !emoji) return;

    // Resolve parent channel (owner of topics)
    let editorParent = targetParent;
    if (topic && topic.data?.parent_cid) {
      editorParent = client.activeChannels[topic.data.parent_cid as string] || editorParent;
    }
    
    if (!editorParent && !topic) return;

    setIsSaving(true);
    setError(null);

    try {
      if (topic) {
        if (!editorParent) throw new Error("Parent channel not found");
        
        const payload: EditTopicData = {};
        if (name.trim() !== originalName) payload.name = name.trim();
        if (emoji !== originalEmoji) payload.image = emoji ? `emoji://${emoji}` : '';
        if (description.trim() !== originalDescription) payload.description = description.trim();

        if (Object.keys(payload).length > 0 && topic.cid) {
          await editorParent.editTopic(topic.cid, payload);
        }

        if (onSuccess) {
          onSuccess(topic);
        } else {
          onClose();
        }
      } else {
        if (!editorParent) return;
        const payload: CreateTopicData = {
          name: name.trim(),
        };

        if (emoji) {
          payload.image = `emoji://${emoji}`;
        }
        if (description.trim()) {
          payload.description = description.trim();
        }

        await editorParent.createTopic(payload);

        if (onSuccess) {
          onSuccess(editorParent);
        } else {
          onClose();
          setName('');
          setEmoji('');
          setDescription('');
        }
      }
    } catch (err: any) {
      setError(err?.message || (topic ? 'Failed to save topic' : 'Failed to create topic'));
    } finally {
      setIsSaving(false);
    }
  }, [targetParent, topic, name, emoji, description, originalName, originalEmoji, originalDescription, onSuccess, onClose, client.activeChannels]);

  const isValid = name.trim().length > 0 && emoji.length > 0;

  const footer = (
    <div className="ermis-create-topic__footer">
      <button className="ermis-create-topic__btn ermis-create-topic__btn--cancel" onClick={onClose} disabled={isSaving}>{cancelButtonLabel}</button>
      <button className="ermis-create-topic__btn ermis-create-topic__btn--create" onClick={handleSave} disabled={isSaving || !isValid}>
        {isSaving ? savingButtonLabel : saveButtonLabel}
      </button>
    </div>
  );

  return (
    <Modal isOpen={isOpen} onClose={isSaving ? () => { } : onClose} title={title} maxWidth="400px" footer={footer}>
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
            disabled={isSaving}
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
                    disabled={isSaving}
                  >
                    {icon}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="ermis-create-topic__field">
          <label className="ermis-create-topic__label">{descriptionLabel}</label>
          <textarea
            className="ermis-create-topic__input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={descriptionPlaceholder}
            disabled={isSaving}
            rows={3}
            maxLength={500}
            style={{ resize: 'vertical' }}
          />
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

TopicModal.displayName = 'TopicModal';
