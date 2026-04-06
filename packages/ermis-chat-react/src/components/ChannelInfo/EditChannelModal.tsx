import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Modal } from '../Modal';
import type { EditChannelModalProps, EditChannelData } from '../../types';

const DEFAULT_MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB

export const EditChannelModal: React.FC<EditChannelModalProps> = React.memo(({
  channel,
  onClose,
  onSave,
  AvatarComponent,
  title = 'Edit Channel',
  nameLabel = 'Channel Name',
  descriptionLabel = 'Description',
  namePlaceholder = 'Enter channel name',
  descriptionPlaceholder = 'Enter channel description',
  publicLabel = 'Public Channel',
  saveLabel = 'Save',
  cancelLabel = 'Cancel',
  savingLabel = 'Saving...',
  changeAvatarLabel = 'Change Avatar',
  imageAccept = 'image/*',
  maxImageSize = DEFAULT_MAX_IMAGE_SIZE,
  maxImageSizeError = 'Image must be less than 5MB',
}) => {
  // Original values from channel data
  const originalName = (channel.data?.name as string) || '';
  const originalImage = (channel.data?.image as string) || '';
  const originalDescription = (channel.data?.description as string) || '';
  const originalPublic = Boolean(channel.data?.public);
  const isTeamChannel = channel.type === 'team';

  // Form state
  const [name, setName] = useState(originalName);
  const [description, setDescription] = useState(originalDescription);
  const [isPublic, setIsPublic] = useState(originalPublic);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Clean up object URL on unmount or when preview changes
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate it's an image
    if (!file.type.startsWith('image/')) {
      setError('Only image files are allowed');
      return;
    }

    // Validate size
    if (file.size > maxImageSize) {
      setError(maxImageSizeError);
      return;
    }

    setError(null);
    // Revoke previous preview
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    setSelectedFile(file);

    // Reset input so same file can be re-selected
    e.target.value = '';
  }, [maxImageSize, maxImageSizeError, previewUrl]);

  const handleAvatarClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  // Check if anything changed — only send changed fields
  const buildPayload = useCallback((): EditChannelData | null => {
    const payload: EditChannelData = {};
    let hasChanges = false;

    if (name.trim() !== originalName) {
      payload.name = name.trim();
      hasChanges = true;
    }
    if (description.trim() !== originalDescription) {
      payload.description = description.trim();
      hasChanges = true;
    }
    if (isTeamChannel && isPublic !== originalPublic) {
      payload.public = isPublic;
      hasChanges = true;
    }
    // Image is handled separately (upload first), but mark as changed
    if (selectedFile) {
      hasChanges = true;
    }

    return hasChanges ? payload : null;
  }, [name, description, isPublic, selectedFile, originalName, originalDescription, originalPublic, isTeamChannel]);

  const handleSave = useCallback(async () => {
    const payload = buildPayload();
    if (!payload && !selectedFile) {
      onClose();
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      // If consumer provides custom save handler, delegate entirely
      if (onSave) {
        if (selectedFile) {
          const response = await channel.sendFile(selectedFile, selectedFile.name, selectedFile.type);
          (payload || {} as EditChannelData).image = response.file;
        }
        await onSave(payload || {});
        onClose();
        return;
      }

      // Default save logic
      const finalPayload: EditChannelData = payload || {};

      // Upload image if changed
      if (selectedFile) {
        const response = await channel.sendFile(selectedFile, selectedFile.name, selectedFile.type);
        finalPayload.image = response.file;
      }

      // Only call update if there's something to update
      if (Object.keys(finalPayload).length > 0) {
        await channel.update(finalPayload as any);
      }

      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to update channel');
    } finally {
      setIsSaving(false);
    }
  }, [buildPayload, selectedFile, onSave, channel, onClose]);

  // Determine displayed avatar image
  const displayImage = previewUrl || originalImage || undefined;

  const footerContent = (
    <div className="ermis-channel-info__edit-footer-buttons">
      <button
        className="ermis-channel-info__edit-btn ermis-channel-info__edit-btn--cancel"
        onClick={onClose}
        disabled={isSaving}
      >
        {cancelLabel}
      </button>
      <button
        className="ermis-channel-info__edit-btn ermis-channel-info__edit-btn--save"
        onClick={handleSave}
        disabled={isSaving}
      >
        {isSaving ? savingLabel : saveLabel}
      </button>
    </div>
  );

  return (
    <Modal
      isOpen={true}
      onClose={isSaving ? () => {} : onClose}
      title={title}
      footer={footerContent}
      maxWidth="420px"
    >
      <div className="ermis-channel-info__edit-body">
        {/* Avatar section */}
        <div className="ermis-channel-info__edit-avatar-section">
          <div className="ermis-channel-info__edit-avatar-wrap" onClick={handleAvatarClick}>
            <AvatarComponent image={displayImage} name={name || originalName} size={80} />
            <div className="ermis-channel-info__edit-avatar-overlay">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                <circle cx="12" cy="13" r="4" />
              </svg>
            </div>
          </div>
          <button
            className="ermis-channel-info__edit-avatar-btn"
            onClick={handleAvatarClick}
            type="button"
            disabled={isSaving}
          >
            {changeAvatarLabel}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept={imageAccept}
            onChange={handleFileSelect}
            style={{ display: 'none' }}
            aria-hidden="true"
          />
        </div>

        {/* Name field */}
        <div className="ermis-channel-info__edit-field">
          <label className="ermis-channel-info__edit-label">{nameLabel}</label>
          <input
            className="ermis-channel-info__edit-input"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={namePlaceholder}
            disabled={isSaving}
            maxLength={100}
          />
        </div>

        {/* Description field */}
        <div className="ermis-channel-info__edit-field">
          <label className="ermis-channel-info__edit-label">{descriptionLabel}</label>
          <textarea
            className="ermis-channel-info__edit-textarea"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={descriptionPlaceholder}
            disabled={isSaving}
            rows={3}
            maxLength={500}
          />
        </div>

        {/* Public toggle — only for team channels */}
        {isTeamChannel && (
          <div className="ermis-channel-info__edit-field ermis-channel-info__edit-field--toggle">
            <label className="ermis-channel-info__edit-label">{publicLabel}</label>
            <button
              type="button"
              role="switch"
              aria-checked={isPublic}
              className={`ermis-channel-info__edit-toggle ${isPublic ? 'ermis-channel-info__edit-toggle--on' : ''}`}
              onClick={() => setIsPublic(v => !v)}
              disabled={isSaving}
            >
              <span className="ermis-channel-info__edit-toggle-thumb" />
            </button>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="ermis-channel-info__edit-error">
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

EditChannelModal.displayName = 'EditChannelModal';
