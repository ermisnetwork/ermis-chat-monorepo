---
sidebar_position: 8
---

# Attachments & Media Uploads

Media transfer capabilities are natively embedded into the `<MessageInput />` module, backed by an efficient caching architecture inside the Ermis SDK.

## Upload Flow Mechanism

When a user selects files using the attachment button (or drops files directly via dragging configurations), the `<MessageInput />` utilizes standard browser File web-APIs mapping them to internal `FilePreviewItem` records. 

1. **Staging:** The files enter a `"pending"` status mapping. They render inside the `<FilesPreviewComponent />` directly above the text input.
2. **Transfer:** When the user hits send, files are uploaded directly to the Ermis Asset Gateway, obtaining a CDN URL. During this phase, their status rapidly switches to `"uploading"`.
3. **Packaging:** The returned URLs are formatted into `Attachment` arrays and sent along with the chat text body as a complete Message payload to WebSocket infrastructure.

## Disabling Attachments entirely

Use the `disableAttachments` flag manually placed upon `<MessageInput />` if certain sub-channels do not require heavy footprint media uploads to operate.

```tsx
<MessageInput disableAttachments={true} />
```

## Overriding the Pre-upload UI

To change how pending files are shown to users before transmission, provide a bespoke `<FilesPreviewComponent />` tracking states cleanly:

```tsx
import type { FilesPreviewProps } from '@ermis-network/ermis-chat-react';
import { MessageInput } from '@ermis-network/ermis-chat-react';

const CustomFilesPreview = ({ files, onRemove }: FilesPreviewProps) => {
  if (!files || files.length === 0) return null;

  return (
    <div className="custom-files-preview">
      {files.map((item) => {
        // Newly added local files have a full 'file' object.
        // Existing attachments when editing a prior message fallback to 'originalAttachment'.
        const fileName = item.file?.name || item.originalAttachment?.title || 'Unknown File';
        const isUploading = item.status === 'uploading';
        const hasError = item.status === 'error';

        return (
          <div key={item.id} className={`file-chip ${isUploading ? 'loading' : ''}`}>
             <span>{fileName}</span>
             
             {isUploading && <span className="spinner">⌛</span>}
             {hasError && <span className="error" title={item.error}>⚠</span>}
             
             {!isUploading && (
               <button onClick={() => onRemove(item.id)}>✕</button>
             )}
          </div>
        );
      })}
    </div>
  );
};

export const Composer = () => (
   <MessageInput FilesPreviewComponent={CustomFilesPreview} />
);
```

## Rendering Attachments in the Timeline

Media files attached to incoming channel messages rely on the internal `<AttachmentList />` module registered universally within the `defaultMessageRenderers`.

Because the list relies on the Core SDK `Attachment` type structures, rendering behavior differs organically based on file parsing: 
- Image URLs and Videos are fetched through aspect-ratio constrained boxes to avoid UI layout shifts, accompanied by blur-thumbs while caching.
- Audio formats expose native browser HTML5 players.
- Binary blobs/PDF files render as generic file-download blocks. 

If overriding the `regular` MessageRenderer completely, you will typically need to import and invoke `<AttachmentList attachments={message.attachments} />` securely inside your markup if you want uploaded files to be retrievable seamlessly. Alternatively, you can use `<MessageAttachment attachment={item} />` in a loop for granular individual positioning.
