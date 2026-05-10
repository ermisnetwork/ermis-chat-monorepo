import React from 'react';
import { useTranslation } from 'react-i18next';
import { useChannelSettings } from '@ermis-network/ermis-chat-react';
import type { ChannelSettingsPanelProps } from '@ermis-network/ermis-chat-react';
import { useChatClient } from '@ermis-network/ermis-chat-react';
import { ArrowLeft, ShieldCheck, MessageSquareWarning, FolderKanban, X, Loader2 } from 'lucide-react';
import { isGroupChannel } from '@ermis-network/ermis-chat-react';

export const UhmChannelSettingsPanel: React.FC<ChannelSettingsPanelProps> = ({
  isOpen,
  onClose,
  channel,
}) => {
  const { t } = useTranslation();
  const { client } = useChatClient();
  const currentUserId = client?.userID;
  const currentUserRole = currentUserId ? channel?.state?.members?.[currentUserId]?.channel_role : undefined;

  const {
    slowMode,
    setSlowMode,
    topicsEnabled,
    setTopicsEnabled,
    capabilities,
    toggleCapability,
    keywords,
    newKeyword,
    setNewKeyword,
    handleAddNewKeyword,
    handleRemoveKeyword,
    isSaving,
    error,
    isDirty,
    isOwner,
    handleSave,
  } = useChannelSettings({
    channel: channel as any,
    isOpen,
    onClose,
    currentUserRole,
  });

  if (!isOpen || !channel) return null;

  const slowModeOptions = [
    { label: t('channel_settings.slow_mode_off', 'Off'), value: 0 },
    { label: t('channel_settings.slow_mode_10s', '10s'), value: 10000 },
    { label: t('channel_settings.slow_mode_30s', '30s'), value: 30000 },
    { label: t('channel_settings.slow_mode_1m', '1m'), value: 60000 },
    { label: t('channel_settings.slow_mode_5m', '5m'), value: 300000 },
    { label: t('channel_settings.slow_mode_15m', '15m'), value: 900000 },
    { label: t('channel_settings.slow_mode_1h', '1h'), value: 3600000 },
  ];

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddNewKeyword();
    }
  };

  return (
    <div className="absolute inset-0 z-[100] bg-zinc-50 dark:bg-[#1a1828] flex flex-col animate-in slide-in-from-right-full duration-300">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-zinc-100 dark:border-zinc-800/50 bg-white/80 dark:bg-[#1a1828]/80 backdrop-blur-md sticky top-0 z-10">
        <button
          onClick={onClose}
          className="p-2 -ml-2 rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-500 transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h2 className="text-[16px] font-semibold text-zinc-900 dark:text-zinc-100">
          {t('channel_settings.title', 'Channel Settings')}
        </h2>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        
        {/* Section 1: Permissions */}
        <section className="bg-white dark:bg-zinc-900/50 rounded-2xl p-4 shadow-sm border border-zinc-100 dark:border-zinc-800/50">
          <div className="flex items-center gap-2 mb-4">
            <div className="p-1.5 bg-primary/10 text-primary rounded-lg">
              <ShieldCheck className="w-4 h-4" />
            </div>
            <h3 className="text-[14px] font-semibold text-zinc-900 dark:text-zinc-100">
              {t('channel_settings.permissions', 'Member Permissions')}
            </h3>
          </div>

          <div className="mb-5">
            <label className="block text-[12px] font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wider mb-2">
              {t('channel_settings.slow_mode', 'Slow Mode')}
            </label>
            <select
              value={slowMode}
              onChange={e => setSlowMode(Number(e.target.value))}
              disabled={isSaving}
              className="w-full bg-zinc-50 dark:bg-zinc-800/80 border border-zinc-200 dark:border-zinc-700 text-zinc-900 dark:text-zinc-100 text-[14px] rounded-xl px-3 py-2.5 outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed appearance-none"
            >
              {slowModeOptions.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[12px] font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wider mb-2">
              {t('channel_settings.capabilities', 'Capabilities')}
            </label>
            <div className="bg-zinc-50 dark:bg-zinc-800/40 rounded-xl border border-zinc-200 dark:border-zinc-700/50 divide-y divide-zinc-200 dark:divide-zinc-700/50">
              {Object.entries(capabilities).map(([key, value]) => (
                <div key={key} className="flex items-center justify-between px-3 py-2.5">
                  <span className="text-[13px] font-medium text-zinc-700 dark:text-zinc-300">
                    {t(`channel_settings.capability.${key}`, key.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '))}
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={value}
                    onClick={() => toggleCapability(key)}
                    disabled={isSaving}
                    className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed ${value ? 'bg-primary' : 'bg-zinc-200 dark:bg-zinc-600'}`}
                  >
                    <span
                      aria-hidden="true"
                      className={`pointer-events-none block h-4 w-4 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out ${value ? 'translate-x-4' : 'translate-x-0'}`}
                    />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Section 2: Content Moderation */}
        <section className="bg-white dark:bg-zinc-900/50 rounded-2xl p-4 shadow-sm border border-zinc-100 dark:border-zinc-800/50">
          <div className="flex items-center gap-2 mb-4">
            <div className="p-1.5 bg-red-50 dark:bg-red-500/10 text-red-500 rounded-lg">
              <MessageSquareWarning className="w-4 h-4" />
            </div>
            <h3 className="text-[14px] font-semibold text-zinc-900 dark:text-zinc-100">
              {t('channel_settings.moderation', 'Content Moderation')}
            </h3>
          </div>

          <label className="block text-[12px] font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wider mb-2">
            {t('channel_settings.keyword_filter', 'Keyword Filtering')}
          </label>
          <div className="flex gap-2 mb-3">
            <input
              type="text"
              value={newKeyword}
              onChange={e => setNewKeyword(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isSaving}
              placeholder={t('channel_settings.add_placeholder', 'Type keyword and press Enter...')}
              className="flex-1 bg-zinc-50 dark:bg-zinc-800/80 border border-zinc-200 dark:border-zinc-700 text-zinc-900 dark:text-zinc-100 text-[14px] rounded-xl px-3 py-2 outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all disabled:opacity-50"
            />
            <button
              type="button"
              onClick={handleAddNewKeyword}
              disabled={isSaving || !newKeyword.trim()}
              className="px-4 bg-primary/10 text-primary font-semibold text-[13px] rounded-xl hover:bg-primary/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {t('channel_settings.add', 'Add')}
            </button>
          </div>

          <div className="flex flex-wrap gap-2">
            {keywords.map(kw => (
              <span key={kw} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-400 text-[12px] font-medium border border-red-100 dark:border-red-500/20">
                {kw}
                <button
                  onClick={() => handleRemoveKeyword(kw)}
                  disabled={isSaving}
                  className="p-0.5 hover:bg-red-200 dark:hover:bg-red-500/30 rounded-full transition-colors disabled:opacity-50"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
            {keywords.length === 0 && (
              <span className="text-[13px] text-zinc-500 dark:text-zinc-400 italic">
                {t('channel_settings.no_keywords', 'No blacklisted keywords added.')}
              </span>
            )}
          </div>
        </section>

        {/* Section 3: Workspace Topics */}
        {isGroupChannel(channel) && (
          <section className="bg-white dark:bg-zinc-900/50 rounded-2xl p-4 shadow-sm border border-zinc-100 dark:border-zinc-800/50">
            <div className="flex items-center gap-2 mb-4">
              <div className="p-1.5 bg-purple-50 dark:bg-purple-500/10 text-purple-500 rounded-lg">
                <FolderKanban className="w-4 h-4" />
              </div>
              <h3 className="text-[14px] font-semibold text-zinc-900 dark:text-zinc-100">
                {t('channel_settings.workspace_topics', 'Workspace Topics')}
              </h3>
            </div>

            <div className="bg-zinc-50 dark:bg-zinc-800/40 rounded-xl border border-zinc-200 dark:border-zinc-700/50 p-3 flex items-center justify-between">
              <div className="flex flex-col pr-4">
                <span className="text-[13px] font-medium text-zinc-900 dark:text-zinc-100">
                  {t('channel_settings.topics_name', 'Topics')}
                </span>
                <span className="text-[12px] text-zinc-500 dark:text-zinc-400 mt-1">
                  {t('channel_settings.topics_desc', 'Allow users to reply to messages with dedicated conversation threads. Disabling this hides the reply-in-topic button for everyone.')}
                </span>
                {!isOwner && (
                  <span className="text-[11px] font-medium text-red-500 mt-2">
                    {t('channel_settings.owner_only', 'Only channel owner can change this.')}
                  </span>
                )}
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={topicsEnabled}
                onClick={() => isOwner && setTopicsEnabled(!topicsEnabled)}
                disabled={isSaving || !isOwner}
                className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed ${topicsEnabled ? 'bg-primary' : 'bg-zinc-200 dark:bg-zinc-600'}`}
              >
                <span
                  aria-hidden="true"
                  className={`pointer-events-none block h-4 w-4 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out ${topicsEnabled ? 'translate-x-4' : 'translate-x-0'}`}
                />
              </button>
            </div>
          </section>
        )}

      </div>

      {/* Footer */}
      <div className="p-4 bg-white dark:bg-zinc-900 border-t border-zinc-100 dark:border-zinc-800/50 shrink-0">
        {error && (
          <div className="mb-3 text-[13px] text-red-500 font-medium flex items-center gap-1.5">
            <X className="w-4 h-4" />
            {error}
          </div>
        )}
        <button
          onClick={handleSave}
          disabled={isSaving || !isDirty}
          className="w-full flex items-center justify-center gap-2 py-2.5 bg-primary hover:bg-primary/90 text-white text-[14px] font-semibold rounded-xl transition-all disabled:opacity-50 disabled:hover:bg-primary"
        >
          {isSaving ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              {t('channel_settings.saving', 'Saving...')}
            </>
          ) : (
            t('channel_settings.save', 'Save Updates')
          )}
        </button>
      </div>

    </div>
  );
};
