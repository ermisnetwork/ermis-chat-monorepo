import React, { useEffect, useRef } from 'react';
import { Avatar } from './Avatar';
import type { MentionSuggestionsProps } from '../types';

export type { MentionSuggestionsProps } from '../types';

export const MentionSuggestions: React.FC<MentionSuggestionsProps> = React.memo(({
  members,
  highlightIndex,
  onSelect,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const itemsRef = useRef<Map<number, HTMLDivElement>>(new Map());

  // Auto-scroll highlighted item into view
  useEffect(() => {
    const el = itemsRef.current.get(highlightIndex);
    if (el && containerRef.current) {
      const container = containerRef.current;
      const elementTop = el.offsetTop;
      const elementBottom = elementTop + el.offsetHeight;
      const containerTop = container.scrollTop;
      const containerBottom = containerTop + container.clientHeight;

      if (elementTop < containerTop) {
        container.scrollTop = elementTop;
      } else if (elementBottom > containerBottom) {
        container.scrollTop = elementBottom - container.clientHeight;
      }
    }
  }, [highlightIndex]);

  if (members.length === 0) return null;

  return (
    <div 
      className="ermis-mention-suggestions" 
      ref={containerRef}
      style={{ overflowY: 'auto', maxHeight: '200px' }}
    >
      {members.map((member, index) => (
        <div
          key={member.id}
          ref={(el) => {
            if (el) itemsRef.current.set(index, el);
            else itemsRef.current.delete(index);
          }}
          className={`ermis-mention-suggestions__item${
            index === highlightIndex ? ' ermis-mention-suggestions__item--highlighted' : ''
          }`}
          onMouseDown={(e) => {
            // Use mousedown (not click) to fire before blur
            e.preventDefault();
            onSelect(member);
          }}
        >
          {member.id === '__all__' ? (
            <div className="ermis-mention-suggestions__all-icon">@</div>
          ) : (
            <Avatar image={member.avatar} name={member.name} size={24} />
          )}
          <span className="ermis-mention-suggestions__name">
            {member.id === '__all__' ? 'all' : member.name}
          </span>
        </div>
      ))}
    </div>
  );
});

MentionSuggestions.displayName = 'MentionSuggestions';
