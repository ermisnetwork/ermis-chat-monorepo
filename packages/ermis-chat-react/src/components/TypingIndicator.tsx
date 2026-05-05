import React from 'react';
import { useTypingIndicator, type TypingUser } from '../hooks/useTypingIndicator';

export type TypingIndicatorProps = {
  /** Custom render function for the typing text (I18n) */
  typingIndicatorLabel?: (users: TypingUser[]) => string;
  /** Custom render function for the typing text (JSX) */
  renderText?: (users: TypingUser[]) => React.ReactNode;
};

/**
 * Displays a "X is typing..." indicator below the message list.
 * Automatically subscribes to typing events via the useTypingIndicator hook.
 */
export const TypingIndicator: React.FC<TypingIndicatorProps> = React.memo(({ typingIndicatorLabel, renderText }) => {
  const { typingUsers } = useTypingIndicator();

  const isActive = typingUsers.length > 0;

  let text: React.ReactNode = null;
  if (isActive) {
    if (renderText) {
      text = renderText(typingUsers);
    } else if (typingIndicatorLabel) {
      text = typingIndicatorLabel(typingUsers);
    } else {
      text = formatTypingText(typingUsers);
    }
  }

  return (
    <div className={`ermis-typing-indicator${isActive ? ' ermis-typing-indicator--active' : ''}`}>
      {isActive && (
        <>
          <div className="ermis-typing-indicator__dots">
            <span className="ermis-typing-indicator__dot" />
            <span className="ermis-typing-indicator__dot" />
            <span className="ermis-typing-indicator__dot" />
          </div>
          <span className="ermis-typing-indicator__text">{text}</span>
        </>
      )}
    </div>
  );
});

TypingIndicator.displayName = 'TypingIndicator';

/**
 * Format typing text based on number of users:
 * - 1 user: "Alice is typing..."
 * - 2 users: "Alice and Bob are typing..."
 * - 3+ users: "Alice, Bob and 2 others are typing..."
 */
function formatTypingText(users: TypingUser[]): string {
  const names = users.map((u) => u.name || u.id);

  if (names.length === 1) {
    return `${names[0]} is typing...`;
  }
  if (names.length === 2) {
    return `${names[0]} and ${names[1]} are typing...`;
  }
  const remaining = names.length - 2;
  return `${names[0]}, ${names[1]} and ${remaining} other${remaining > 1 ? 's' : ''} are typing...`;
}
