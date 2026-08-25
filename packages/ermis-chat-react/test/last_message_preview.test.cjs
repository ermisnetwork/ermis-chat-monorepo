const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getAttachmentDisplayName,
  getLastMessagePreview,
  isE2eeAttachmentManifest,
  isImage,
  isVideo,
} = require('../dist/index.cjs');

const previewFor = (message) => {
  const channel = {
    state: { latestMessages: [message] },
    getClient: () => ({ state: { users: {} } }),
  };

  return getLastMessagePreview(channel, 'current-user', {
    photoMessageLabel: 'Photo',
    videoMessageLabel: 'Video',
    voiceRecordingMessageLabel: 'Voice message',
    fileMessageLabel: 'File',
    encryptedMessageLabel: 'Encrypted message',
    encryptedMessageUnavailableLabel: 'Encrypted message unavailable',
  }).text;
};

const e2eeAttachment = (mimeType, name, attachmentType) => ({
  version: 1,
  attachment_id: `attachment-${name}`,
  assets: [
    {
      kind: 'original',
      display: {
        name,
        mime_type: mimeType,
        ...(attachmentType ? { attachment_type: attachmentType } : {}),
      },
    },
  ],
});

test('exposes E2EE attachment metadata for compact reply thumbnails', () => {
  const video = {
    ...e2eeAttachment('video/mp4', 'clip.mp4'),
    assets: [
      ...e2eeAttachment('video/mp4', 'clip.mp4').assets,
      {
        asset_id: 'preview-clip',
        kind: 'preview',
        display: { mime_type: 'image/jpeg', name: 'clip-preview.jpg' },
      },
    ],
  };

  assert.equal(isE2eeAttachmentManifest(video), true);
  assert.equal(getAttachmentDisplayName(video), 'clip.mp4');
  assert.equal(isVideo(video), true);
  assert.equal(isImage(video), false);
});
test('uses decrypted text for an encrypted message preview', () => {
  assert.equal(
    previewFor({
      id: 'text-message',
      content_type: 'mls',
      mls_ciphertext: new Uint8Array([1]),
      text: 'Decrypted text',
    }),
    'Decrypted text',
  );
});

test('shows the media type for an encrypted video attachment', () => {
  assert.equal(
    previewFor({
      id: 'video-message',
      content_type: 'mls',
      mls_ciphertext: new Uint8Array([1]),
      text: '',
      attachments: [e2eeAttachment('video/mp4', 'clip.mp4')],
    }),
    'Video',
  );
});

test('recognizes image and voice attachment metadata from E2EE manifests', () => {
  assert.equal(
    previewFor({
      id: 'image-message',
      content_type: 'standard',
      text: '',
      attachments: [e2eeAttachment('image/jpeg', 'photo.jpg')],
    }),
    'Photo',
  );
  assert.equal(
    previewFor({
      id: 'voice-message',
      content_type: 'standard',
      text: '',
      attachments: [e2eeAttachment('audio/webm', 'voice.webm', 'voiceRecording')],
    }),
    'Voice message',
  );
});

test('keeps the encrypted fallback when no decrypted content is available', () => {
  assert.equal(
    previewFor({
      id: 'pending-message',
      content_type: 'mls',
      mls_ciphertext: new Uint8Array([1]),
      text: '',
      attachments: [],
    }),
    'Encrypted message',
  );
  assert.equal(
    previewFor({
      id: 'failed-message',
      content_type: 'mls',
      mls_ciphertext: new Uint8Array([1]),
      e2ee_status: 'failed',
      text: '',
      attachments: [],
    }),
    'Encrypted message unavailable',
  );
});
