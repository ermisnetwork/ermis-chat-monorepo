import React, { useEffect, useRef } from 'react';
import { VList as _VList, VListHandle } from 'virtua';
const VList = _VList as any;
import { Avatar } from './Avatar';
import type { MentionSuggestionsProps } from '../types';

export type { MentionSuggestionsProps } from '../types';

// Estimated item height
const ITEM_HEIGHT = 42; 

export const MentionSuggestions: React.FC<MentionSuggestionsProps> = React.memo(({
  members,
  highlightIndex,
  onSelect,
}) => {
  const listRef = useRef<VListHandle>(null);

  // Auto-scroll highlighted item into view
  useEffect(() => {
    // VList uses scrollToIndex
    listRef.current?.scrollToIndex(highlightIndex);
  }, [highlightIndex]);

  if (members.length === 0) return null;

  // Calculate dynamic height based on item count, cap at 200px
  const listHeight = Math.min(members.length * ITEM_HEIGHT, 200);

  return (
    <div className="ermis-mention-suggestions" style={{ overflow: 'hidden' }}>
      <VList ref={listRef} style={{ height: listHeight }}>
        {members.map((member, index) => (
          <div
            key={member.id}
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
      </VList>
    </div>
  );
});

MentionSuggestions.displayName = 'MentionSuggestions';
