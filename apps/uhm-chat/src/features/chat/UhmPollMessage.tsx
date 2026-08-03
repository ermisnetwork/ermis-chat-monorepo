import React, { useState, useMemo, useCallback } from 'react';
import type { MessageRendererProps } from '@ermis-network/ermis-chat-react';
import { useChatCore, Avatar, getUserDisplayName, useChannelCapabilities } from '@ermis-network/ermis-chat-react';
import { useTranslation } from 'react-i18next';
import { Users, BarChart2, Lock } from 'lucide-react';
import { UhmPollVoteModal } from './UhmPollVoteModal';
import { UhmConfirmDialog } from './UhmConfirmDialog';
import { toast } from 'sonner';

interface PollVote {
  user_id: string;
  text: string;
}

export interface VoterInfo {
  id: string;
  name: string;
  avatar?: string;
}

/** Stacked avatar group for voters on a single option */
export const VoterAvatars: React.FC<{
  voters: VoterInfo[];
  maxVisible?: number;
  onClick: (e: React.MouseEvent) => void;
}> = ({ voters, maxVisible = 3, onClick }) => {
  if (voters.length === 0) return null;
  const visible = voters.slice(0, maxVisible);
  const remaining = voters.length - maxVisible;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClick(e as any); }}
      className="flex items-center gap-1 hover:opacity-80 transition-opacity shrink-0 cursor-pointer"
    >
      <div className="flex items-center -space-x-1.5">
        {visible.map((v) => (
          <div key={v.id} className="ring-[1.5px] ring-white dark:ring-zinc-900 rounded-full">
            <Avatar image={v.avatar} name={v.name} size={18} disableLightbox />
          </div>
        ))}
        {remaining > 0 && (
          <div className="flex items-center justify-center w-[18px] h-[18px] rounded-full bg-zinc-200 dark:bg-zinc-700 ring-[1.5px] ring-white dark:ring-zinc-900 text-[9px] font-bold text-zinc-600 dark:text-zinc-300">
            +{remaining}
          </div>
        )}
      </div>
      {remaining > 0 && (
        <span className="text-[11px] font-medium text-zinc-400 dark:text-zinc-500 tabular-nums">
          {voters.length}
        </span>
      )}
    </div>
  );
};

/** Read-only poll card displayed in the message list */
export const UhmPollMessage: React.FC<MessageRendererProps> = ({ message }) => {
  const { client, activeChannel } = useChatCore();
  const { t } = useTranslation();
  const [modalInitialViewOption, setModalInitialViewOption] = useState<string | null>(null);
  const [isVoteModalOpen, setIsVoteModalOpen] = useState(false);

  // Use JSON.stringify to detect changes when SDK mutates the message object in-place
  const choiceCountsRaw = (message as any).poll_choice_counts as Record<string, number> | undefined;
  const latestChoicesRaw = (message as any).latest_poll_choices as PollVote[] | undefined;
  const choiceCountsKey = JSON.stringify(choiceCountsRaw);
  const latestChoicesKey = JSON.stringify(latestChoicesRaw);

  const choiceCounts = useMemo(() => choiceCountsRaw || {}, [choiceCountsKey]);
  const latestChoices = useMemo(() => latestChoicesRaw || [], [latestChoicesKey]);

  const pollChoices = useMemo(() => {
    const keys = Object.keys(choiceCounts);
    if (keys.length > 0) return keys;
    return ((message as any).poll_choices as string[]) || [];
  }, [choiceCounts, (message as any).poll_choices]);

  const totalVotes = useMemo(() => {
    return Object.values(choiceCounts).reduce((a, b) => a + b, 0);
  }, [choiceCounts]);

  const totalVoters = useMemo(() => {
    const uniqueUserIds = new Set(latestChoices.map((v) => v.user_id));
    return uniqueUserIds.size;
  }, [latestChoices]);

  const userVotedOptions = useMemo(() => {
    const uid = client.userID;
    if (!uid) return new Set<string>();
    return new Set(
      latestChoices.filter((v) => v.user_id === uid).map((v) => v.text),
    );
  }, [latestChoices, client.userID]);

  const votersByOption = useMemo(() => {
    const map: Record<string, VoterInfo[]> = {};
    const members = activeChannel?.state?.members as Record<string, { user?: { name?: string; avatar?: string }; user_id?: string }> | undefined;

    for (const vote of latestChoices) {
      if (!map[vote.text]) map[vote.text] = [];
      const memberUser = members?.[vote.user_id]?.user;
      const stateUser = (client.state as any)?.users?.[vote.user_id];
      const userObj = memberUser || stateUser;
      const name = getUserDisplayName(userObj, vote.user_id);

      if (!map[vote.text].some((v) => v.id === vote.user_id)) {
        map[vote.text].push({ id: vote.user_id, name, avatar: userObj?.avatar });
      }
    }
    return map;
  }, [latestChoices, activeChannel?.state?.members, client.state]);

  const maxVoteCount = useMemo(() => {
    const values = Object.values(choiceCounts);
    return values.length > 0 ? Math.max(...values) : 0;
  }, [choiceCounts]);

  const isE2ee = activeChannel?.data?.mls_enabled === true;
  const isMultiple = (message as any).poll_type === 'multiple';
  const hasVoted = userVotedOptions.size > 0;
  const allowChangeChoice = (message as any).allow_change_choice !== false;
  const pollClosed = (message as any).poll_closed === true;

  const { isOwnerOrModerator } = useChannelCapabilities();
  const isPollCreator = message.user?.id === client.userID || message.user_id === client.userID;
  const canClosePoll = !pollClosed && (isPollCreator || isOwnerOrModerator);
  const [isClosing, setIsClosing] = useState(false);
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);

  const handleClosePoll = useCallback(async () => {
    if (!activeChannel || !message.id || isClosing) return;
    setIsClosing(true);
    try {
      await activeChannel.closePoll(message.id);
      toast.success(t('chat.poll_closed_success', 'Poll closed'));
    } catch (err: any) {
      console.error('Failed to close poll:', err);
      toast.error(t('chat.poll_close_failed', 'Failed to close poll'));
    } finally {
      setIsClosing(false);
    }
  }, [activeChannel, message.id, isClosing, t]);

  return (
    <>
      <div className="flex flex-col min-w-[280px] max-w-[400px] max-h-[480px] bg-slate-50 dark:bg-zinc-800 rounded-2xl border border-slate-200 dark:border-zinc-700 overflow-y-auto select-none shadow-sm">

        {/* Header */}
        <div className="px-4 pt-3.5 pb-2.5">
          <div className="flex items-start gap-2">
            <BarChart2 className="w-[18px] h-[18px] text-blue-500 dark:text-blue-400 shrink-0 mt-0.5" />
            <h4 className="font-semibold text-[15px] text-zinc-900 dark:text-zinc-100 leading-snug break-words flex-1 min-w-0 max-h-[140px] overflow-y-auto pr-1">
              {message.text || t('chat.poll', 'Poll')}
            </h4>
            {pollClosed && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-zinc-200 dark:bg-zinc-600 text-zinc-600 dark:text-zinc-300 shrink-0">
                <Lock className="w-3 h-3" />
                {t('chat.poll_closed', 'Closed')}
              </span>
            )}
          </div>
        </div>

        {/* E2EE Warning */}
        {/* TODO: Remove once server supports E2EE poll metadata */}
        {isE2ee && (
          <div className="mx-3 mb-2 text-[12px] text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/15 px-3 py-2 rounded-lg flex items-start gap-1.5">
            <span className="shrink-0 mt-px">⚠️</span>
            <span>{t('chat.poll_e2ee_unsupported', 'Polls are not supported in secure chats yet.')}</span>
          </div>
        )}

        {/* Read-only options list */}
        <div className="flex flex-col gap-1.5 px-3 pb-2">
          {pollChoices.slice(0, 3).map((option) => {
            const voteCount = choiceCounts[option] || 0;
            const percentage = totalVotes > 0 ? Math.round((voteCount / totalVotes) * 100) : 0;
            const isVoted = userVotedOptions.has(option);
            const isLeading = voteCount > 0 && voteCount === maxVoteCount;
            const voters = votersByOption[option] || [];

            return (
              <div key={option} className="flex flex-col">
                <div
                  className={`relative w-full rounded-xl border px-3 py-2.5 overflow-hidden transition-colors ${
                    isVoted
                      ? 'border-blue-500 dark:border-blue-400 bg-white dark:bg-zinc-900'
                      : 'border-slate-200 dark:border-zinc-600 bg-white dark:bg-zinc-900'
                  }`}
                >
                  {/* Progress bar */}
                  <div
                    className={`absolute inset-y-0 left-0 transition-[width] duration-400 ease-out rounded-xl ${
                      isVoted
                        ? 'bg-blue-500/12 dark:bg-blue-400/12'
                        : isLeading
                          ? 'bg-slate-200/60 dark:bg-zinc-600/30'
                          : 'bg-slate-100/60 dark:bg-zinc-700/20'
                    }`}
                    style={{ width: `${percentage}%` }}
                  />

                  {/* Content row */}
                  <div className="relative z-10 flex items-center gap-2.5">

                    <span className="flex-1 text-[13px] font-medium text-slate-800 dark:text-zinc-100 leading-snug break-all">
                      {option}
                    </span>

                    {/* Right side: voter avatars + percentage */}
                    <div className="flex items-center gap-2 shrink-0 ml-1">
                      <VoterAvatars
                        voters={voters}
                        maxVisible={3}
                        onClick={(e) => {
                          e.stopPropagation();
                          setModalInitialViewOption(option);
                          setIsVoteModalOpen(true);
                        }}
                      />
                      <span className={`text-[12px] font-semibold tabular-nums min-w-[28px] text-right ${
                        isVoted
                          ? 'text-blue-600 dark:text-blue-400'
                          : 'text-zinc-400 dark:text-zinc-500'
                      }`}>
                        {percentage}%
                      </span>
                    </div>
                  </div>

                </div>
              </div>
            );
          })}

          {/* Show more button — click opens vote modal */}
          {pollChoices.length > 3 && (
            <button
              type="button"
              onClick={() => setIsVoteModalOpen(true)}
              className="text-[12px] font-medium text-blue-500 dark:text-blue-400 hover:text-blue-600 dark:hover:text-blue-300 pt-2 pb-1.5 transition-colors"
            >
              {t('chat.poll_more_options', '{{count}} more options', { count: pollChoices.length - 3 })}
            </button>
          )}
        </div>

        {/* Vote / Change vote button */}
        {!isE2ee && !pollClosed && (!hasVoted || allowChangeChoice) && (
          <div className="px-3 pb-2.5">
            <button
              type="button"
              onClick={() => setIsVoteModalOpen(true)}
              className="w-full flex items-center justify-center py-2 bg-blue-500 hover:bg-blue-600 active:bg-blue-700 text-white rounded-xl text-[13px] font-semibold transition-colors cursor-pointer"
            >
              {hasVoted
                ? t('chat.change_vote', 'Change Vote')
                : t('chat.vote_now', 'Vote')}
            </button>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 px-4 py-2 border-t border-slate-200 dark:border-zinc-700">
          <div className="flex items-center gap-1.5 text-[11px] text-zinc-400 dark:text-zinc-500 min-w-0">
            <Users className="w-3 h-3 shrink-0" />
            <span className="truncate">
              {totalVoters === 1
                ? t('chat.one_vote_total', '1 voter')
                : t('chat.votes_total', '{{count}} voters', { count: totalVoters })}
            </span>
          </div>
          {canClosePoll && (
            <button
              type="button"
              onClick={() => setShowCloseConfirm(true)}
              disabled={isClosing}
              className="text-[11px] font-medium text-red-400 dark:text-red-400/80 hover:text-red-500 dark:hover:text-red-300 transition-colors cursor-pointer disabled:opacity-50 shrink-0"
            >
              {isClosing
                ? t('chat.poll_closing', 'Closing...')
                : t('chat.close_poll', 'Close Poll')}
            </button>
          )}
        </div>
      </div>

      {/* Vote modal */}
      <UhmPollVoteModal
        isOpen={isVoteModalOpen}
        onClose={() => {
          setIsVoteModalOpen(false);
          setModalInitialViewOption(null);
        }}
        message={message}
        pollChoices={pollChoices}
        isMultiple={isMultiple}
        userVotedOptions={userVotedOptions}
        votersByOption={votersByOption}
        initialViewingVotersOption={modalInitialViewOption}
      />

      <UhmConfirmDialog
        isOpen={showCloseConfirm}
        onConfirm={() => {
          setShowCloseConfirm(false);
          handleClosePoll();
        }}
        onCancel={() => setShowCloseConfirm(false)}
        title={t('chat.close_poll_confirm_title', 'Close Poll')}
        message={t(
          'chat.close_poll_confirm_message',
          'Once closed, no one will be able to vote. This action cannot be undone.'
        )}
        confirmLabel={t('chat.close_poll', 'Close Poll')}
        cancelLabel={t('common.cancel', 'Cancel')}
        isDanger
      />
    </>
  );
};
