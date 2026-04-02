---
sidebar_position: 4
---

# Theming & Customization

Providing a completely bespoke aesthetic is easy in the default React UI Kit.

## CSS Customization

The package exposes variables and class names that you can easily override with standard CSS or SCSS. Avoid using `!important` unless overriding an inline style logic.

```css
:root {
  --ermis-chat-primary-color: #005fff;
  --ermis-chat-bg-color: #ffffff;
  --ermis-chat-font-family: 'Inter', sans-serif;
}

/* Override bubble appearance */
.ermis-chat__message-bubble {
   border-radius: 10px;
}
```

## Component Swapping

Instead of changing CSS, you can replace entire components with your custom React code using the context providers.

For example, to swap how messages are rendered:

```tsx
import { Channel } from '@ermis-network/ermis-chat-react';

const MyMessage = ({ message }) => {
    return <div className="custom-msg">{message.text}</div>;
}

<Channel Message={MyMessage}>
   <MessageList />
</Channel>
```

Virtually every sub-component (`Avatar`, `Attachment`, `DateSeparator`, etc.) can be overridden via Props out of the box.
