import React, { useRef, useCallback, useMemo, useEffect } from 'react';
import type { Channel } from '@ermis-network/ermis-chat-sdk';
import { replaceMentionsForPreview, formatRelativeDate } from '../../utils';
import { Avatar } from '../Avatar';
import { Panel as DefaultPanel } from '../Panel';
import { useChatComponents } from '../../context/ChatComponentsContext';
import { useChatClient } from '../../hooks/useChatClient';
import type { MessageSearchPanelProps } from '../../types';
import { useMessageSearch } from './useMessageSearch';
import { removeAccents } from '../../utils';

/* ----------------------------------------------------------
   Highlight utility (Accent-insensitive)
   ---------------------------------------------------------- */

export const HighlightedText: React.FC<{ text: string; term: string }> = React.memo(({ text, term }) => {
  if (!term.trim()) return <>{text}</>;

  const cleanTerm = removeAccents(term).toLowerCase();
  if (!cleanTerm) return <>{text}</>;

  const parts = [];
  let currentIndex = 0;
  const cleanText = removeAccents(text).toLowerCase();

  while (true) {
    const startMatch = cleanText.indexOf(cleanTerm, currentIndex);
    if (startMatch === -1) {
      if (currentIndex < text.length) {
        parts.push(<span key={currentIndex}>{text.slice(currentIndex)}</span>);
      }
      break;
    }

    if (startMatch > currentIndex) {
      parts.push(<span key={`text-${currentIndex}`}>{text.slice(currentIndex, startMatch)}</span>);
    }

    const endMatch = startMatch + cleanTerm.length;
    parts.push(
      <mark key={`mark-${startMatch}`} className="ermis-search-panel__highlight">
        {text.slice(startMatch, endMatch)}
      </mark>
    );

    currentIndex = endMatch;
  }

  return <>{parts.length > 0 ? parts : text}</>;
});
HighlightedText.displayName = 'HighlightedText';

/* ----------------------------------------------------------
   MessageSearchPanel
   ---------------------------------------------------------- */
export const MessageSearchPanel: React.FC<MessageSearchPanelProps> = React.memo(({
  isOpen,
  onClose,
  channel,
  AvatarComponent = Avatar,
  placeholder = 'Search messages...',
  title = 'Search Messages',
  emptyText = 'No messages found.',
  loadingText = 'Searching...',
  debounceMs = 500,
}) => {
  const { setJumpToMessageId } = useChatClient();
  const { PanelComponent } = useChatComponents();
  const Panel = PanelComponent || DefaultPanel;

  const {
    query,
    setQuery,
    results,
    loading,
    hasMore,
    loadingMore,
    handleInputChange,
    handleScroll,
    resetSearch,
    userMaps,
  } = useMessageSearch({ channel, isOpen, debounceMs });

  // Auto-focus the input when panel opens
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 300);
    }
  }, [isOpen]);

  // Click a result -> jump to that message
  const handleResultClick = useCallback((messageId: string) => {
    setJumpToMessageId(messageId);
  }, [setJumpToMessageId]);

  return (
    <Panel isOpen={isOpen} onClose={onClose} title={title} className="ermis-search-panel">
      {/* Search Input now inside body */}
      <div className="ermis-search-panel__search-box">
        <div className="ermis-search-panel__input-wrap">
          <svg className="ermis-search-panel__input-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            className="ermis-search-panel__input"
            type="text"
            value={query}
            onChange={handleInputChange}
            placeholder={placeholder}
          />
          {query && (
            <button
              className="ermis-search-panel__input-clear"
              onClick={() => {
                resetSearch();
                inputRef.current?.focus();
              }}
              aria-label="Clear"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>
      </div>

      <div
        className="ermis-search-panel__results"
        onScroll={handleScroll}
      >
        {/* Initial state — no query yet */}
        {!query.trim() && !loading && results.length === 0 && (
          <div className="ermis-search-panel__idle">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <span>{placeholder}</span>
          </div>
        )}

        {/* Loading state */}
        {loading && (
          <div className="ermis-search-panel__loading">
            <div className="ermis-search-panel__spinner" />
            <span>{loadingText}</span>
          </div>
        )}

        {/* Empty state */}
        {!loading && query.trim() && results.length === 0 && (
          <div className="ermis-search-panel__empty">
            <span>{emptyText}</span>
          </div>
        )}

        {/* Results */}
        {!loading && results.map((msg) => {
          let parsedText = '';
          if (msg.text) {
            // Try standard replacement first
            parsedText = replaceMentionsForPreview(msg.text, msg as any, userMaps.original);
            // Fallback: search API may omit mentioned_users array, so we map @0x IDs efficiently
            if (/@0x[a-fA-F0-9]+/i.test(parsedText)) {
              parsedText = parsedText.replace(/@0x[a-fA-F0-9]+/gi, (match) => {
                const matchedId = match.slice(1).toLowerCase();
                return userMaps.lower[matchedId] ? `@${userMaps.lower[matchedId]}` : match;
              });
            }
          }

          return (
            <div
              key={msg.id}
              role="button"
              tabIndex={0}
              className="ermis-search-panel__result-item"
              onClick={() => handleResultClick(msg.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  handleResultClick(msg.id);
                }
              }}
            >
              <AvatarComponent
                image={msg.user?.avatar || msg.user?.image || msg.user?.avatar_url}
                name={msg.user?.name || msg.user_id}
                size={36}
              />
              <div className="ermis-search-panel__result-body">
                <div className="ermis-search-panel__result-meta">
                  <span className="ermis-search-panel__result-name">
                    {msg.user?.name || msg.user_id || 'Unknown'}
                  </span>
                  <span className="ermis-search-panel__result-time">
                    {msg.created_at ? formatRelativeDate(msg.created_at) : ''}
                  </span>
                </div>
                <p className="ermis-search-panel__result-text">
                  {parsedText ? (
                    <HighlightedText text={parsedText} term={query} />
                  ) : (
                    <em>Attachment</em>
                  )}
                </p>
              </div>
            </div>
          );
        })}

        {/* End of results indicator */}
        {!loading && !loadingMore && !hasMore && results.length > 0 && query.trim() && (
          <div className="ermis-search-panel__end-indicator">
            <span>{emptyText}</span>
          </div>
        )}

        {/* Loading more indicator */}
        {loadingMore && (
          <div className="ermis-search-panel__loading-more">
            <div className="ermis-search-panel__spinner ermis-search-panel__spinner--small" />
          </div>
        )}
      </div>
    </Panel>
  );
});
MessageSearchPanel.displayName = 'MessageSearchPanel';
