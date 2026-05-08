import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { Channel } from '@ermis-network/ermis-chat-sdk';
import { buildUserMap } from '../../utils';
import type { SearchResultMessage } from '../../types';

export type UseMessageSearchProps = {
  channel: Channel;
  isOpen: boolean;
  debounceMs?: number;
};

export const useMessageSearch = ({ channel, isOpen, debounceMs = 500 }: UseMessageSearchProps) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResultMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  const resetSearch = useCallback(() => {
    setQuery('');
    setResults([]);
    setHasMore(false);
    offsetRef.current = 0;
    queryRef.current = '';
  }, []);

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

  // Scroll handler for infinite scroll container
  const handleScroll = useCallback((e: React.UIEvent<HTMLElement>) => {
    const el = e.currentTarget;
    const threshold = 100;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - threshold) {
      handleLoadMore();
    }
  }, [handleLoadMore]);

  // Derived userMap for resolving mentions, with a lowercase variant for fast lookup
  const userMaps = useMemo(() => {
    const original = buildUserMap(channel.state);
    const lower: typeof original = {};
    for (const [id, name] of Object.entries(original)) {
      lower[id.toLowerCase()] = name;
    }
    return { original, lower };
  }, [channel.state]);

  return {
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
  };
};
