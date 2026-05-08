import React from 'react';
import { useTranslation } from 'react-i18next';
import { Search, X, Loader2, ArrowLeft } from 'lucide-react';
import { useMessageSearch, HighlightedText, replaceMentionsForPreview, formatRelativeDate } from '@ermis-network/ermis-chat-react';
import type { MessageSearchPanelProps } from '@ermis-network/ermis-chat-react';
import { useChatClient } from '@ermis-network/ermis-chat-react';

export const UhmMessageSearchPanel: React.FC<MessageSearchPanelProps> = ({
  isOpen,
  onClose,
  channel,
  AvatarComponent,
  debounceMs = 500,
}) => {
  const { t } = useTranslation();
  const { setJumpToMessageId } = useChatClient();
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

  if (!isOpen) return null;

  return (
    <div className="absolute inset-0 z-[100] bg-white dark:bg-[#1a1828] flex flex-col animate-in slide-in-from-right-full duration-300">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-zinc-100 dark:border-zinc-800/50 bg-white/80 dark:bg-[#1a1828]/80 backdrop-blur-md sticky top-0 z-10">
        <button
          onClick={onClose}
          className="p-2 -ml-2 rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-500 transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h2 className="text-[16px] font-semibold text-zinc-900 dark:text-zinc-100">
          {t('search.title', 'Search Messages')}
        </h2>
      </div>

      {/* Search Input */}
      <div className="p-4 border-b border-zinc-100 dark:border-zinc-800/50">
        <div className="relative group">
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-zinc-400 group-focus-within:text-indigo-500 transition-colors">
            <Search className="w-4 h-4" />
          </div>
          <input
            type="text"
            className="w-full bg-zinc-100 dark:bg-zinc-800 border-none rounded-xl py-2.5 pl-10 pr-10 text-[14px] text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-500 focus:ring-2 focus:ring-indigo-500/20 focus:bg-white dark:focus:bg-zinc-900 transition-all outline-none"
            placeholder={t('search.message_placeholder', 'Search in conversation...')}
            value={query}
            onChange={handleInputChange}
            autoFocus
          />
          {query && (
            <button
              onClick={() => {
                resetSearch();
              }}
              className="absolute inset-y-0 right-0 pr-3 flex items-center text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Results List */}
      <div
        className="flex-1 overflow-y-auto no-scrollbar relative bg-zinc-50 dark:bg-black/20"
        onScroll={handleScroll}
      >
        {/* Idle */}
        {!query.trim() && !loading && results.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-zinc-400 p-8 text-center gap-3">
            <div className="w-12 h-12 rounded-full bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center">
              <Search className="w-6 h-6" />
            </div>
            <p className="text-[13px]">{t('search.idle', 'Enter keyword to search messages')}</p>
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-zinc-400 gap-3">
            <Loader2 className="w-6 h-6 animate-spin text-indigo-500" />
            <p className="text-[13px]">{t('search.loading', 'Searching...')}</p>
          </div>
        )}

        {/* Empty */}
        {!loading && query.trim() && results.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-zinc-400 p-8 text-center gap-3">
            <p className="text-[13px]">{t('search.empty', 'No messages found.')}</p>
          </div>
        )}

        {/* Results */}
        {!loading && results.map((msg) => {
          let parsedText = '';
          if (msg.text) {
            parsedText = replaceMentionsForPreview(msg.text, msg as any, userMaps.original);
            if (/@0x[a-fA-F0-9]+/i.test(parsedText)) {
              parsedText = parsedText.replace(/@0x[a-fA-F0-9]+/gi, (match) => {
                const matchedId = match.slice(1).toLowerCase();
                return userMaps.lower[matchedId] ? `@${userMaps.lower[matchedId]}` : match;
              });
            }
          }

          return (
            <button
              key={msg.id}
              onClick={() => {
                setJumpToMessageId(msg.id);
                // onClose(); // Do not close the search panel
              }}
              className="w-full flex items-start gap-3 p-4 border-b border-zinc-100 dark:border-zinc-800/30 hover:bg-white dark:hover:bg-zinc-800/50 transition-colors text-left group"
            >
              {AvatarComponent && (
                <AvatarComponent
                  image={msg.user?.avatar || msg.user?.image || msg.user?.avatar_url}
                  name={msg.user?.name || msg.user_id}
                  size={36}
                />
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[13px] font-semibold text-zinc-900 dark:text-zinc-100 truncate">
                    {msg.user?.name || msg.user_id || 'Unknown'}
                  </span>
                  <span className="text-[11px] text-zinc-500 whitespace-nowrap">
                    {msg.created_at ? formatRelativeDate(msg.created_at) : ''}
                  </span>
                </div>
                <p className="text-[13px] text-zinc-600 dark:text-zinc-400 break-words leading-snug">
                  {parsedText ? (
                    <HighlightedText text={parsedText} term={query} />
                  ) : (
                    <em className="text-zinc-400 italic">Attachment</em>
                  )}
                </p>
              </div>
            </button>
          );
        })}

        {/* Loading More Indicator */}
        {loadingMore && (
          <div className="py-4 flex justify-center">
            <Loader2 className="w-5 h-5 animate-spin text-zinc-400" />
          </div>
        )}
      </div>
    </div>
  );
};

UhmMessageSearchPanel.displayName = 'UhmMessageSearchPanel';
