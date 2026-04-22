---
sidebar_position: 9
---

# Utility Functions

Beyond layouts and hooks, the Ermis Chat React framework exports a suite of specialized functional utilities. These helpers natively power the core platform and are exposed so you can easily maintain parsing synchronicity across your custom components.

---

## Date & Time Formatting

Helpers standardizing temporal structures across the interface.

### `formatTime(date)`
`formatTime(date: Date | string | undefined): string`

Translates instances into short localized time strings (`HH:MM`). Commonly used to render message receipt indicators.

```tsx
import { formatTime } from '@ermis-network/ermis-chat-react';

const stamp = formatTime(new Date()); 
// => "08:45 AM"
```

### `formatReadTimestamp(date)`
`formatReadTimestamp(date: Date | string | undefined): string`

Validates durations natively identifying edge proximities, formatting verbose strings (e.g., "HH:MM, Today" or "HH:MM, MM/DD/YYYY").

```tsx
import { formatReadTimestamp } from '@ermis-network/ermis-chat-react';

const log = formatReadTimestamp(message.read_at);
// => "08:45 AM, Yesterday"
```

### `getDateKey(date)`
`getDateKey(date: Date | string | undefined): string`

Calculates a strictly uniform `YYYY-M-D` string payload. Used internally to group disparate timelines into contiguous visual buckets without timezone glitches.

```tsx
import { getDateKey } from '@ermis-network/ermis-chat-react';

const blockId = getDateKey(message.created_at); 
// => "2024-11-23"
```

### `formatDateLabel(date)`
`formatDateLabel(date: Date | string | undefined): string`

Generates human-friendly barrier labels for timeline markers ("Today", "Yesterday", or "November 23, 2024").

```tsx
import { formatDateLabel } from '@ermis-network/ermis-chat-react';

const separatorText = formatDateLabel(currentBlock.date);
```

### `formatRelativeDate(dateStr)`
`formatRelativeDate(dateStr: string): string`

Provides responsive interval identifiers dynamically (e.g., "3d ago", "Mon 23"). Excellent for Sidebar channel row previews where space is limited.

```tsx
import { formatRelativeDate } from '@ermis-network/ermis-chat-react';

const shortLog = formatRelativeDate(channel.updated_at);
// => "3d ago"
```

---

## User Data & Mentions

Safe extractors and string formatters avoiding manual Regex parsing.

### `getMessageUserId(message)`
`getMessageUserId(message: FormatMessageResponse): string`

Resolves the absolute User ID across heavily nested or historically deprecated message payload structures safely.

```tsx
import { getMessageUserId } from '@ermis-network/ermis-chat-react';

const authorId = getMessageUserId(payload);
```

### `buildUserMap(channelState)`
`buildUserMap(channelState: any): Record<string, string>`

Traverses the active channel structure generating a flat dictionary translating raw User IDs to their formatted Display Names automatically.

```tsx
import { buildUserMap, useChannel } from '@ermis-network/ermis-chat-react';

const { channel } = useChannel();
const map = buildUserMap(channel?.state);
// => { "user-123": "Tony", "user-456": "Alice" }
```

### `replaceMentionsForPreview(text, message, userMap, [renderWrapper])`
`replaceMentionsForPreview(text: string, message: FormatMessageResponse, userMap: Record<string, string>, renderWrapper?: Function): string`

Extracts inline UUID mention payloads (e.g., `@user-123`) from text streams and maps them into human-readable strings (`@Tony`) using the generated `userMap`.

```tsx
import { replaceMentionsForPreview } from '@ermis-network/ermis-chat-react';

const readable = replaceMentionsForPreview(rawText, message, map);
// => "Hello @Tony"
```

---

## DOM & Caret Helpers

Niche methods explicitly resolving ContentEditable cursor tracking.

### `moveCaretToEnd(el)`
`moveCaretToEnd(el: HTMLElement): void`

Calculates selection ranges natively jumping the browser cursor directly to the terminal end of an active input box container.

```tsx
import { moveCaretToEnd } from '@ermis-network/ermis-chat-react';

const inputRef = useRef<HTMLDivElement>(null);
// On mount focus:
moveCaretToEnd(inputRef.current);
```

### `moveCaretAfterNode(node)`
`moveCaretAfterNode(node: Node): void`

Locates a specific injected DOM boundary (like an `@mention` graphic node) and forces the cursor to trail exactly following it.

```tsx
import { moveCaretAfterNode } from '@ermis-network/ermis-chat-react';

moveCaretAfterNode(insertedBadgeElement);
```

---

## Media & File Parsing

File handling and network utilities mitigating custom component bugs.

### `isUserManagedAttachment(attachment)`
`isUserManagedAttachment(attachment: Attachment): boolean`

Filters custom media uploads intelligently versus system-injected cards (like link previews or slash command integrations).

```tsx
import { isUserManagedAttachment } from '@ermis-network/ermis-chat-react';

const userFiles = message.attachments.filter(isUserManagedAttachment);
```

### `getDisplayName(fileName)`
`getDisplayName(fileName: string): string`

Strips ugly encrypted UUID prefixes aggressively prepended by CDNs from the absolute filename.

```tsx
import { getDisplayName } from '@ermis-network/ermis-chat-react';

const safeText = getDisplayName("1234-uuid-xyz-doc.pdf");
// => "doc.pdf"
```

### `formatFileSize(bytes)`
`formatFileSize(bytes: number): string`

Translates numerical memory weights into rounded readable identifiers.

```tsx
import { formatFileSize } from '@ermis-network/ermis-chat-react';

const log = formatFileSize(1254000); 
// => "1.2 MB"
```

### `extractDomain(url)`
`extractDomain(url: string): string`

Safely wraps internal URL parsers preventing runtime crashes on malformed edge-case string links.

```tsx
import { extractDomain } from '@ermis-network/ermis-chat-react';

const anchor = extractDomain("https://github.com/ermisnetwork");
// => "github.com"
```

### `preloadImage(url)`
`preloadImage(url: string): void`

Registers image payloads inside an intelligent 500-item memory cache logic. Drastically smoothing virtual scrolling by negating HTTP waterfall queues visually.

```tsx
import { preloadImage } from '@ermis-network/ermis-chat-react';

preloadImage("https://cdn.example.com/huge-image.png");
```

### `isImagePreloaded(url)`
`isImagePreloaded(url: string): boolean`

Cross-verifies cache signatures deterministically bypassing duplicate HTTP load operations.

```tsx
import { isImagePreloaded } from '@ermis-network/ermis-chat-react';

if (!isImagePreloaded(url)) {
   setDisplaySpinner(true);
}
```

---

## Type & System Checks

These semantic helper functions replace hardcoded string comparisons (like `channel.type === 'messaging'` or `message.type === 'system'`). Using these ensures robust UI logic when evaluating permissions or visual states.

### Channel Type Utilities

- `isGroupChannel(channel)`: Checks if the channel supports group messaging.
- `isDirectChannel(channel)`: Checks if the channel is a 1-on-1 direct message.
- `isTopicChannel(channel)`: Checks if the channel is a threaded topic.
- `isPublicGroupChannel(channel)`: Checks if it's an open group (like livestream channels).
- `hasTopicsEnabled(channel)`: Validates if the channel structure supports opening topics.
- `supportsBlocking(channel)`: Checks if the channel allows peer blocking.

### Channel Role Utilities

- `isPendingMember(member)`: Checks if the user is in the `pending` invite state.
- `isSkippedMember(member)`: Checks if the user explicitly skipped the channel invite.
- `isOwnerMember(member)`: Validates owner permissions.
- `isFriendChannel(channel)`: Syntactic sugar combining `isDirectChannel` and checking that both members have `owner` roles natively.
- `canManageChannel(channel, userId)`: Evaluates if the specific user has moderation privileges.
- `canRemoveTargetMember(...)`, `canBanTargetMember(...)`, `canPromoteTargetMember(...)`, `canDemoteTargetMember(...)`: Helper functions to compute if the current user can execute administrative actions against a target member object.

### Message & Attachment Utilities

- `isSystemMessage(message)`: Validates if the message is a system notification (`message.type === 'system'`).
- `isStickerMessage(message)`: Validates if the message is a sticker.
- `isRegularMessage(message)`: Validates if the message is a standard user text or file message.
- `isSignalMessage(message)`: Validates if the message is an invisible UI trigger (`signal`).
- `isImageAttachment(attachment)`: Checks if the media is an image.
- `isVideoAttachment(attachment)`: Checks if the media is a video.
- `isVoiceRecordingAttachment(attachment)`: Checks if the media is an audio recording.
- `isLinkPreviewAttachment(attachment)`: Checks if the attachment is a scraped URL metadata block.
- `isImage(attachment)` / `isVideo(attachment)`: Granular checks on the attachment type.
