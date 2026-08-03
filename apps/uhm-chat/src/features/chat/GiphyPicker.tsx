import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Search, X, Loader2, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export interface GiphyPickerProps {
  onSelect: (gifUrl: string) => void;
}

interface GiphyItem {
  id: string;
  title: string;
  images: {
    fixed_height: {
      url: string;
      width: string;
      height: string;
    };
    original: {
      url: string;
    };
    downsized_medium?: {
      url: string;
    };
  };
}

const SUGGESTION_TAGS = [
  'Trending',
  'Reaction',
  'Funny',
  'Anime',
  'Meme',
  'Cat',
  'Dance',
  'Love',
];

const getApiKeys = (): string[] => {
  const envVal = import.meta.env.VITE_GIPHY_API_KEY || '';
  const keys = envVal
    .split(',')
    .map((k: string) => k.trim())
    .filter(Boolean);
  return keys.length > 0 ? keys : ['sXpCfdHBLXyp9WdQV8B0J9wAC43Nz8HM'];
};

let globalKeyIndex = 0;

export const GiphyPicker: React.FC<GiphyPickerProps> = ({ onSelect }) => {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'gifs' | 'stickers'>('gifs');
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [items, setItems] = useState<GiphyItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [isUnauthorized, setIsUnauthorized] = useState(false);

  const debounceTimerRef = useRef<number | null>(null);

  // Handle debounced search query
  useEffect(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);

    debounceTimerRef.current = window.setTimeout(() => {
      setDebouncedQuery(query.trim());
    }, 350);

    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [query]);

  // Fetch GIPHY items with multi-key rotation and failover
  const fetchGiphy = useCallback(async (searchQuery: string, type: 'gifs' | 'stickers') => {
    setLoading(true);
    setError(false);
    setIsUnauthorized(false);

    const keys = getApiKeys();
    const endpoint = searchQuery
      ? `https://api.giphy.com/v1/${type}/search`
      : `https://api.giphy.com/v1/${type}/trending`;

    let attempts = 0;
    let success = false;

    while (attempts < keys.length && !success) {
      const activeKey = keys[globalKeyIndex % keys.length];
      const params = new URLSearchParams({
        api_key: activeKey,
        limit: '30',
        rating: 'g',
        ...(searchQuery ? { q: searchQuery } : {}),
      });

      try {
        const res = await fetch(`${endpoint}?${params.toString()}`);
        const data = await res.json();

        // Rotate key if rate limited (429), unauthorized (401), or bad status
        if (!res.ok || data.meta?.status === 429 || data.meta?.status === 401) {
          console.warn(`GIPHY Key #${globalKeyIndex % keys.length} returned status ${data.meta?.status || res.status}. Rotating key...`);
          globalKeyIndex = (globalKeyIndex + 1) % keys.length;
          attempts++;
          continue;
        }

        setItems(data.data || []);
        success = true;
      } catch (err) {
        console.error('GIPHY Fetch error with key:', err);
        globalKeyIndex = (globalKeyIndex + 1) % keys.length;
        attempts++;
      }
    }

    if (!success) {
      setIsUnauthorized(true);
      setItems([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    const activeSearchTerm = selectedTag || debouncedQuery;
    fetchGiphy(activeSearchTerm, activeTab);
  }, [debouncedQuery, activeTab, selectedTag, fetchGiphy]);

  const handleTagClick = (tag: string) => {
    if (tag === 'Trending') {
      setSelectedTag(null);
      setQuery('');
    } else {
      setSelectedTag(tag);
      setQuery(tag);
    }
  };

  const handleSelectGif = (item: GiphyItem) => {
    // Prefer downsized_medium or fixed_height for optimized messaging payload
    const gifUrl =
      item.images.downsized_medium?.url ||
      item.images.fixed_height?.url ||
      item.images.original.url;

    if (gifUrl) {
      onSelect(gifUrl);
    }
  };

  return (
    <div className="flex flex-col h-[420px] w-[360px] bg-white dark:bg-[#1a1828] text-zinc-900 dark:text-zinc-100 select-none overflow-hidden">
      {/* Header with Search */}
      <div className="p-3 border-b border-zinc-100 dark:border-zinc-800 space-y-2 shrink-0">
        <div className="relative flex items-center">
          <Search className="absolute left-3 w-4 h-4 text-zinc-400 pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (selectedTag && e.target.value !== selectedTag) {
                setSelectedTag(null);
              }
            }}
            placeholder={t('chat.searchGiphy', 'Search GIPHY...')}
            className="w-full pl-9 pr-8 py-2 text-sm bg-zinc-100 dark:bg-zinc-800/80 rounded-xl outline-none focus:ring-2 focus:ring-primary/50 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 transition-all"
            autoFocus
          />
          {query && (
            <button
              type="button"
              onClick={() => {
                setQuery('');
                setSelectedTag(null);
              }}
              className="absolute right-2.5 p-1 rounded-full text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Tab Switcher: GIFs vs Stickers */}
        <div className="flex items-center gap-1 p-1 bg-zinc-100 dark:bg-zinc-800/50 rounded-xl text-xs font-medium">
          <button
            type="button"
            onClick={() => setActiveTab('gifs')}
            className={`flex-1 py-1.5 rounded-lg transition-all text-center ${
              activeTab === 'gifs'
                ? 'bg-white dark:bg-zinc-700 text-zinc-900 dark:text-white shadow-xs font-semibold'
                : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200'
            }`}
          >
            {t('chat.giphyTabGifs', 'GIFs')}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('stickers')}
            className={`flex-1 py-1.5 rounded-lg transition-all text-center ${
              activeTab === 'stickers'
                ? 'bg-white dark:bg-zinc-700 text-zinc-900 dark:text-white shadow-xs font-semibold'
                : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200'
            }`}
          >
            {t('chat.giphyTabStickers', 'Stickers')}
          </button>
        </div>

        {/* Suggestion Tags Pills */}
        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-0.5 text-[11px]">
          {SUGGESTION_TAGS.map((tag) => {
            const isActive = tag === 'Trending' ? !selectedTag && !query : selectedTag === tag;
            return (
              <button
                key={tag}
                type="button"
                onClick={() => handleTagClick(tag)}
                className={`px-2.5 py-1 rounded-full whitespace-nowrap transition-all font-medium border ${
                  isActive
                    ? 'bg-primary text-white border-primary shadow-xs'
                    : 'bg-zinc-50 dark:bg-zinc-800/40 text-zinc-600 dark:text-zinc-300 border-zinc-200 dark:border-zinc-700/60 hover:border-primary/50'
                }`}
              >
                {tag === 'Trending' ? (
                  <span className="flex items-center gap-1">
                    <Sparkles className="w-3 h-3" />
                    Trending
                  </span>
                ) : (
                  tag
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Content Grid */}
      <div className="flex-1 overflow-y-auto p-3 no-scrollbar">
        {loading ? (
          <div className="flex flex-col items-center justify-center h-full text-zinc-400 gap-2">
            <Loader2 className="w-6 h-6 animate-spin text-primary" />
            <span className="text-xs font-medium">Loading GIPHY...</span>
          </div>
        ) : isUnauthorized ? (
          <div className="flex flex-col items-center justify-center h-full text-zinc-400 gap-1.5 px-4 text-center">
            <span className="text-sm font-semibold text-amber-500">Chưa cấu hình GIPHY API Key</span>
            <span className="text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">
              Vui lòng thêm <strong>VITE_GIPHY_API_KEY</strong> vào file <code>.env.local</code> để tải danh sách GIF.
            </span>
          </div>
        ) : error || items.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-zinc-400 gap-1">
            <span className="text-sm font-medium">
              {t('chat.noGiphyFound', 'No GIFs found.')}
            </span>
            <span className="text-xs text-zinc-500">Try searching for something else</span>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => handleSelectGif(item)}
                className="group relative w-full aspect-4/3 rounded-xl overflow-hidden bg-zinc-100 dark:bg-zinc-800/50 hover:ring-2 hover:ring-primary focus:outline-none transition-all cursor-pointer shadow-2xs"
              >
                <img
                  src={item.images.fixed_height.url}
                  alt={item.title || 'GIF'}
                  className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-105"
                  loading="lazy"
                />
                <div className="absolute inset-0 bg-black/10 opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Footer: Attribution */}
      <div className="px-3 py-1.5 border-t border-zinc-100 dark:border-zinc-800/80 bg-zinc-50 dark:bg-zinc-900/50 flex items-center justify-between text-[10px] text-zinc-400 shrink-0">
        <span className="font-semibold tracking-wide text-zinc-500 dark:text-zinc-400 uppercase">
          Powered by GIPHY
        </span>
        <span className="text-zinc-400">g.co</span>
      </div>
    </div>
  );
};
