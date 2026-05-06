import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { Channel } from '@ermis-network/ermis-chat-sdk';
import { useChatClient } from '../../hooks/useChatClient';
import { replaceMentionsForPreview, buildUserMap, formatRelativeDate, removeAccents } from '../../utils';
import { Avatar } from '../Avatar';
import { Panel as DefaultPanel } from '../Panel';
import { useChatComponents } from '../../context/ChatComponentsContext';
import type { AvatarProps, SearchResultMessage, MessageSearchPanelProps } from '../../types';

/* ----------------------------------------------------------
   Highlight utility (Accent-insensitive)
   ---------------------------------------------------------- */

const HighlightedText: React.FC<{ text: string; term: string }> = React.memo(({ text, term }) => {
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

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResultMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const offsetRef = useRef(0);
  const queryRef = useRef('');

  // Reset all state when the channel changes (or panel closes)
  useEffect(() => {
    setQuery('');
    setResults([]);
    setLoading(false);
    setHasMore(false);
    setLoadingMore(false);
    offsetRef.current = 0;
    queryRef.current = '';
  }, [channel?.cid, isOpen]);

  // Auto-focus the input when panel opens
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 300);
    }
  }, [isOpen]);

  // Debounced search
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setQuery(value);

    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!value.trim()) {
      setResults([]);
      setLoading(false);
      setHasMore(false);
      offsetRef.current = 0;
      queryRef.current = '';
      return;
    }

    setLoading(true);

    debounceRef.current = setTimeout(async () => {
      queryRef.current = value;
      offsetRef.current = 0;

      try {
        const response = await channel.searchMessage(value, 0);
        // Only apply if this is still the latest query
        if (queryRef.current !== value) return;

        if (!response) {
          setResults([]);
          setHasMore(false);
        } else {
          setResults(response.messages || []);
          setHasMore((response.messages?.length || 0) >= 25);
        }
      } catch (err) {
        console.error('Search failed:', err);
        setResults([]);
        setHasMore(false);
      } finally {
        setLoading(false);
      }
    }, debounceMs);
  }, [channel, debounceMs]);

  // Infinite scroll: load more results
  const handleLoadMore = useCallback(async () => {
    if (loadingMore || !hasMore || !queryRef.current) return;

    setLoadingMore(true);
    const nextOffset = offsetRef.current + 25; // offset skips records, limit is 25

    try {
      const response = await channel.searchMessage(queryRef.current, nextOffset);

      if (!response || !response.messages?.length) {
        setHasMore(false);
      } else {
        offsetRef.current = nextOffset;
        setResults((prev) => [...prev, ...response.messages]);
        setHasMore(response.messages.length >= 25);
      }
    } catch (err) {
      console.error('Load more search results failed:', err);
    } finally {
      setLoadingMore(false);
    }
  }, [channel, hasMore, loadingMore]);

  // Scroll handler for infinite scroll
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;

    const threshold = 100;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - threshold) {
      handleLoadMore();
    }
  }, [handleLoadMore]);

  // Click a result -> jump to that message
  const handleResultClick = useCallback((messageId: string) => {
    setJumpToMessageId(messageId);
  }, [setJumpToMessageId]);

  // Derived userMap for resolving mentions, with a lowercase variant for fast lookup
  const userMaps = useMemo(() => {
    const original = buildUserMap(channel.state);
    const lower: typeof original = {};
    for (const [id, name] of Object.entries(original)) {
      lower[id.toLowerCase()] = name;
    }
    return { original, lower };
  }, [channel.state]);

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
                setQuery('');
                setResults([]);
                setHasMore(false);
                offsetRef.current = 0;
                queryRef.current = '';
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
        ref={scrollRef}
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
