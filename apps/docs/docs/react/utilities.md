---
sidebar_position: 9
---

# Utility Functions

Beyond heavy layout components and React custom hooks, the Ermis Chat React framework exports a suite of functional utilities that are universally utilized deeply within its architecture. 

It is highly recommended that you incorporate these helpers within your own localized code when replacing date separators or tracking message identification contexts to guarantee format compliance reliably against the core platform.

## Date Formatting

### `formatTime(date)`
`formatTime(date: Date | string | undefined): string`

Formats javascript `Date` objects or ISO strings effectively into a localized time string (`HH:MM AM/PM`). It is predominantly employed to construct timestamps displayed beside user avatars on message rows.

```tsx
import { formatTime } from '@ermis-network/ermis-chat-react';

const timeStr = formatTime(new Date(message.created_at));
// => "8:45 AM"
```

### `getDateKey(date)`
`getDateKey(date: Date | string | undefined): string`

Calculates a unique, strictly formatted daily string payload (e.g. `2024-11-23`) from timestamps. The engine heavily employs this mapping to collate isolated messages into continuous blocks that correspond tightly to a specific day logic grouping.

```tsx
import { getDateKey } from '@ermis-network/ermis-chat-react';

const groupingId = getDateKey(new Date()); 
// => "2024-11-23"
```

### `formatDateLabel(date)`
`formatDateLabel(date: Date | string | undefined): string`

Transforms internal timestamps into colloquial descriptive strings prominently utilized for rendering `DateSeparator` horizontal barriers across the Message ListView interface.

```tsx
import { formatDateLabel } from '@ermis-network/ermis-chat-react';

const barrierLabel = formatDateLabel(new Date());
// => "Today", "Yesterday", or "November 23, 2024"
```

---

## Message Metadata Helpers

### `getMessageUserId(message)`
`getMessageUserId(message: FormatMessageResponse): string`

Safely traces user identification payload attributes across dynamically typed Message variants to obtain the singular source/author ID deterministically.

```tsx
import { getMessageUserId } from '@ermis-network/ermis-chat-react';

const authorId = getMessageUserId(messagePayload);
```

### `replaceMentionsForPreview(text, message, userMap, [renderWrapper])`
`replaceMentionsForPreview(text: string, message: FormatMessageResponse, userMap: Record<string, string>, renderWrapper?: Function): string`

Extracts raw payload sequences carrying structured `@uuid` configurations embedded natively by the text buffers, replacing them uniformly with nicely formatted `@Username` syntaxes cleanly meant for sidebar channel previews or push notification derivations.

```tsx
import { replaceMentionsForPreview } from '@ermis-network/ermis-chat-react';

// Example: building a fast user map lookup from channel state
const userMap = { '12345': 'Tony Nguyen' };

// Parses 'Hello @12345' into 'Hello @Tony Nguyen'
const cleanPreviewText = replaceMentionsForPreview(
   rawMessageObject.text, 
   rawMessageObject,
   userMap
);
```
