import { useState, useCallback, useRef, useDeferredValue, useMemo } from 'react';
import { moveCaretAfterNode } from '../utils';
import type {
  MentionMember,
  MentionPayload,
  UseMentionsOptions,
  UseMentionsReturn,
} from '../types';

export type { MentionMember, MentionPayload, UseMentionsOptions, UseMentionsReturn } from '../types';

export const MENTION_SPAN_CLASS = 'ermis-message-input__mention-span';

/**
 * Returns the raw HTML string for a mention span, useful for initializing contenteditable divs.
 */
export function getMentionHtml(userId: string, displayName: string): string {
  const safeName = displayName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<span class="${MENTION_SPAN_CLASS}" data-mention-id="${userId}" contenteditable="false">@${safeName}</span>&nbsp;`;
}

/**
 * Insert an atomic mention <span> at the current cursor position inside a
 * contenteditable element, followed by a trailing space.
 */
function insertMentionAtCursor(
  editableEl: HTMLElement,
  userId: string,
  displayName: string,
) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;

  const range = sel.getRangeAt(0);

  const { startContainer, startOffset } = range;
  if (startContainer.nodeType === Node.TEXT_NODE) {
    const textBefore = startContainer.textContent?.slice(0, startOffset) ?? '';
    const atIndex = textBefore.lastIndexOf('@');
    if (atIndex !== -1) {
      range.setStart(startContainer, atIndex);
      range.deleteContents();
    }
  }

  const span = document.createElement('span');
  span.className = MENTION_SPAN_CLASS;
  span.setAttribute('data-mention-id', userId);
  span.contentEditable = 'false';
  span.textContent = `@${displayName}`;

  range.insertNode(span);

  const space = document.createTextNode('\u00A0');
  span.after(space);
  moveCaretAfterNode(space);

  editableEl.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Parse the DOM of a contenteditable div to produce a mention payload.
 */
function buildPayloadFromDOM(editableEl: HTMLElement): MentionPayload {
  let text = '';
  let mentionedAll = false;
  const mentionedUsers: string[] = [];

  function walk(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? '';
      return;
    }

    if (node instanceof HTMLElement) {
      const mentionId = node.getAttribute('data-mention-id');
      if (mentionId && node.classList.contains(MENTION_SPAN_CLASS)) {
        if (mentionId === '__all__') {
          mentionedAll = true;
          text += '@all';
        } else {
          if (!mentionedUsers.includes(mentionId)) {
            mentionedUsers.push(mentionId);
          }
          text += `@${mentionId}`;
        }
        return;
      }

      if (node.tagName === 'BR') {
        text += '\n';
        return;
      }

      if (node.tagName === 'DIV' && text.length > 0 && !text.endsWith('\n')) {
        text += '\n';
      }
    }

    node.childNodes.forEach(walk);
  }

  walk(editableEl);
  text = text.replace(/\u00A0/g, ' ').trim();

  return { text, mentioned_all: mentionedAll, mentioned_users: mentionedUsers };
}

/**
 * Scan the DOM for currently present mention spans and return their IDs.
 */
function getActiveMentionIds(editableEl: HTMLElement): Set<string> {
  const ids = new Set<string>();
  const spans = editableEl.querySelectorAll(`.${MENTION_SPAN_CLASS}`);
  spans.forEach((span) => {
    const id = span.getAttribute('data-mention-id');
    if (id) ids.add(id);
  });
  return ids;
}

/**
 * Binary search to find the first index where the name starts with the given prefix.
 */
function findFirstMatchIndex(arr: MentionMember[], prefix: string): number {
  let low = 0;
  let high = arr.length - 1;
  let result = -1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const name = (arr[mid].name || '').toLowerCase();

    if (name.startsWith(prefix)) {
      result = mid; // Found match, keep searching left for the first one
      high = mid - 1;
    } else if (name < prefix) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return result;
}

export function useMentions({
  members,
  currentUserId,
  editableRef,
}: UseMentionsOptions): UseMentionsReturn {
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [query, setQuery] = useState('');
  const [highlightIndex, setHighlightIndex] = useState(0);
  const [activeMentionIds, setActiveMentionIds] = useState<Set<string>>(new Set());

  const deferredQuery = useDeferredValue(query);

  // All item: special entry
  const allItem: MentionMember = useMemo(
    () => ({ id: '__all__', name: 'all' }),
    [],
  );

  // Pre-sort members for binary range search
  const sortedMembers = useMemo(() => {
    return [...members].sort((a, b) => {
      const nameA = (a.name || '').toLowerCase();
      const nameB = (b.name || '').toLowerCase();
      if (nameA < nameB) return -1;
      if (nameA > nameB) return 1;
      return 0;
    });
  }, [members]);

  // Filter members based on deferred query, exclude self and already-mentioned
  const filteredMembers = useMemo(() => {
    const q = deferredQuery.toLowerCase();

    // Start with @all if not already selected
    const result: MentionMember[] = [];
    if (!activeMentionIds.has('__all__')) {
      if (!q || 'all'.startsWith(q)) {
        result.push(allItem);
      }
    }

    if (!q) {
      for (const m of sortedMembers) {
        if (m.id === currentUserId) continue; // skip self
        result.push(m);
        if (result.length >= 50) break;
      }
      return result;
    }

    // Range search using binary search
    const startIndex = findFirstMatchIndex(sortedMembers, q);
    if (startIndex !== -1) {
      for (let i = startIndex; i < sortedMembers.length; i++) {
        const m = sortedMembers[i];
        const name = (m.name || '').toLowerCase();
        
        if (!name.startsWith(q)) break; // End of range
        
        if (m.id === currentUserId) continue; // skip self
        result.push(m);
        if (result.length >= 50) break;
      }
    }

    return result;
  }, [sortedMembers, deferredQuery, activeMentionIds, currentUserId, allItem]);

  // Detect @ trigger from cursor position
  const detectTrigger = useCallback((): { triggered: boolean; query: string } => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) {
      return { triggered: false, query: '' };
    }

    const { anchorNode, anchorOffset } = sel;
    if (!anchorNode || anchorNode.nodeType !== Node.TEXT_NODE) {
      return { triggered: false, query: '' };
    }

    const textBefore = anchorNode.textContent?.slice(0, anchorOffset) ?? '';

    // Find the last @ that is preceded by a space or is at the start
    const match = textBefore.match(/(^|[\s\u00A0])@(\S*)$/);
    if (!match) {
      return { triggered: false, query: '' };
    }

    return { triggered: true, query: match[2] };
  }, []);

  const handleInput = useCallback(() => {
    const el = editableRef.current;
    if (!el) return;

    // Update active mention IDs by scanning DOM
    setActiveMentionIds(getActiveMentionIds(el));

    // Detect @ trigger
    const result = detectTrigger();
    if (result.triggered) {
      setShowSuggestions(true);
      setQuery(result.query);
      setHighlightIndex(0);
    } else {
      setShowSuggestions(false);
      setQuery('');
    }
  }, [editableRef, detectTrigger]);

  const selectMention = useCallback(
    (member: MentionMember) => {
      const el = editableRef.current;
      if (!el) return;

      insertMentionAtCursor(el, member.id, member.name);

      // Update tracking
      setActiveMentionIds((prev) => new Set(prev).add(member.id));
      setShowSuggestions(false);
      setQuery('');

      // Re-focus the editable
      el.focus();
    },
    [editableRef],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent): boolean => {
      if (!showSuggestions || filteredMembers.length === 0) return false;

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setHighlightIndex((prev) =>
            prev < filteredMembers.length - 1 ? prev + 1 : 0,
          );
          return true;

        case 'ArrowUp':
          e.preventDefault();
          setHighlightIndex((prev) =>
            prev > 0 ? prev - 1 : filteredMembers.length - 1,
          );
          return true;

        case 'Enter':
          e.preventDefault();
          if (filteredMembers[highlightIndex]) {
            selectMention(filteredMembers[highlightIndex]);
          }
          return true;

        case 'Escape':
          e.preventDefault();
          setShowSuggestions(false);
          return true;

        default:
          return false;
      }
    },
    [showSuggestions, filteredMembers, highlightIndex, selectMention],
  );

  const buildPayload = useCallback((): MentionPayload => {
    const el = editableRef.current;
    if (!el) return { text: '', mentioned_all: false, mentioned_users: [] };
    return buildPayloadFromDOM(el);
  }, [editableRef]);

  const reset = useCallback(() => {
    setShowSuggestions(false);
    setQuery('');
    setHighlightIndex(0);
    setActiveMentionIds(new Set());
    const el = editableRef.current;
    if (el) {
      el.innerHTML = '';
    }
  }, [editableRef]);

  return {
    showSuggestions,
    filteredMembers,
    highlightIndex,
    handleInput,
    handleKeyDown,
    selectMention,
    buildPayload,
    reset,
  };
}
