import React, { useState, useEffect, useCallback } from 'react';
import { useChatCore, Avatar } from '@ermis-network/ermis-chat-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Check, BarChart2, ArrowLeft } from 'lucide-react';
import { UhmModal } from '@/components/custom/UhmModal';
import { UhmConfirmDialog } from './UhmConfirmDialog';
import { VoterAvatars } from './UhmPollMessage';
import type { VoterInfo } from './UhmPollMessage';

interface UhmPollVoteModalProps {
  isOpen: boolean;
  onClose: () => void;
  message: any;
  pollChoices: string[];
  isMultiple: boolean;
  userVotedOptions: Set<string>;
  votersByOption: Record<string, VoterInfo[]>;
  initialViewingVotersOption?: string | null;
}

export const UhmPollVoteModal: React.FC<UhmPollVoteModalProps> = ({
  isOpen,
  onClose,
  message,
  pollChoices,
  isMultiple,
  userVotedOptions,
  votersByOption,
  initialViewingVotersOption = null,
}) => {
  const { activeChannel, syncMessages } = useChatCore();
  const { t } = useTranslation();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [viewingVotersOption, setViewingVotersOption] = useState<string | null>(null);
  const [showConfirmNoChange, setShowConfirmNoChange] = useState(false);

  const hasVoted = userVotedOptions.size > 0;
  const allowChangeChoice = message.allow_change_choice !== false;
  const isReadOnly = hasVoted && !allowChangeChoice;

  // Sync selected state and initial view option when modal opens
  useEffect(() => {
    if (isOpen) {
      setSelected(new Set(userVotedOptions));
      setViewingVotersOption(initialViewingVotersOption);
    }
  }, [isOpen, userVotedOptions, initialViewingVotersOption]);

  const handleToggle = useCallback((option: string) => {
    if (isMultiple) {
      setSelected((prev) => {
        const next = new Set(prev);
        next.has(option) ? next.delete(option) : next.add(option);
        return next;
      });
    } else {
      // Single choice: toggle off if already selected, otherwise replace
      setSelected((prev) => prev.has(option) ? new Set() : new Set([option]));
    }
  }, [isMultiple]);

  const hasChanges = (() => {
    if (selected.size !== userVotedOptions.size) return true;
    for (const item of selected) {
      if (!userVotedOptions.has(item)) return true;
    }
    return false;
  })();

  const submitChoices = useCallback(async (choices: string[]) => {
    if (!activeChannel || !message.id || isSubmitting) return;
    setIsSubmitting(true);
    try {
      await activeChannel.votePollChoices(message.id, choices);
      syncMessages?.();
      toast.success(
        choices.length === 0
          ? t('chat.vote_removed', 'Vote removed')
          : t('chat.vote_submitted', 'Vote submitted successfully!'),
      );
      onClose();
    } catch (err: any) {
      console.error('Failed to submit vote:', err);
      toast.error(t('chat.vote_failed', 'Failed to submit vote. Please try again.'));
    } finally {
      setIsSubmitting(false);
    }
  }, [activeChannel, message.id, isSubmitting, t, onClose, syncMessages]);

  const handleSubmit = useCallback(() => {
    if (!allowChangeChoice) {
      setShowConfirmNoChange(true);
    } else {
      submitChoices(Array.from(selected));
    }
  }, [allowChangeChoice, selected, submitChoices]);

  const handleConfirmNoChange = useCallback(() => {
    setShowConfirmNoChange(false);
    submitChoices(Array.from(selected));
  }, [selected, submitChoices]);

  const handleCancelNoChange = useCallback(() => {
    setShowConfirmNoChange(false);
  }, []);

  // Header and Footer definition based on whether we are viewing voters details list
  const isViewingDetails = viewingVotersOption !== null;

  const modalTitle = isViewingDetails ? (
    <div className="flex items-center gap-2 min-w-0 w-full">
      <button
        type="button"
        onClick={() => setViewingVotersOption(null)}
        className="p-1 -ml-1 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-600 dark:text-zinc-300 transition-colors shrink-0"
      >
        <ArrowLeft className="w-5 h-5" />
      </button>
      <span className="break-all font-semibold text-[15px] truncate flex-1 min-w-0 leading-normal py-0.5">
        {votersByOption[viewingVotersOption]?.length === 1
          ? t('chat.one_voter_for_option', '1 voter for {{option}}', { option: viewingVotersOption })
          : t('chat.voters_for_option', '{{count}} voters for {{option}}', {
              count: votersByOption[viewingVotersOption]?.length || 0,
              option: viewingVotersOption,
            })}
      </span>
    </div>
  ) : (
    <div className="flex items-start gap-2 min-w-0">
      <BarChart2 className="w-5 h-5 text-blue-500 shrink-0 mt-0.5" />
      <span className="break-all min-w-0 leading-normal py-0.5">{message.text || t('chat.poll', 'Poll')}</span>
    </div>
  );

  const modalFooter = isViewingDetails ? null : isReadOnly ? (
    <div className="flex gap-2 w-full">
      <button
        type="button"
        onClick={onClose}
        className="flex-1 py-2.5 text-[13px] font-semibold text-zinc-600 dark:text-zinc-300 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 rounded-xl transition-colors"
      >
        {t('chat.close', 'Close')}
      </button>
    </div>
  ) : (
    <div className="flex gap-2 w-full">
      <button
        type="button"
        onClick={onClose}
        className="flex-1 py-2.5 text-[13px] font-semibold text-zinc-600 dark:text-zinc-300 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 rounded-xl transition-colors"
      >
        {t('common.cancel', 'Cancel')}
      </button>
      <button
        type="button"
        disabled={isSubmitting || !hasChanges}
        onClick={handleSubmit}
        className={`flex-1 py-2.5 text-[13px] font-semibold rounded-xl transition-colors disabled:opacity-50 ${
          selected.size === 0 && hasVoted
            ? 'text-white bg-red-500 hover:bg-red-600 active:bg-red-700'
            : 'text-white bg-blue-500 hover:bg-blue-600 active:bg-blue-700'
        }`}
      >
        {isSubmitting
          ? t('chat.submitting_vote', 'Submitting...')
          : selected.size === 0 && hasVoted
            ? t('chat.remove_vote', 'Remove vote')
            : t('chat.submit_vote', 'Confirm Vote')}
      </button>
    </div>
  );

  return (
    <>
      <UhmModal
        isOpen={isOpen}
        onClose={onClose}
      title={modalTitle}
      maxWidth="420px"
      footer={modalFooter}
    >
      {isViewingDetails ? (
        <div className="flex flex-col max-h-[350px] overflow-y-auto divide-y divide-slate-100 dark:divide-zinc-800/50">
          {(votersByOption[viewingVotersOption] || []).length === 0 ? (
            <p className="text-[13px] text-zinc-400 dark:text-zinc-500 text-center py-6">
              {t('chat.no_voters', 'No voters yet')}
            </p>
          ) : (
            (votersByOption[viewingVotersOption] || []).map((v) => (
              <div key={v.id} className="flex items-center gap-3 py-2.5">
                <Avatar image={v.avatar} name={v.name} size={32} disableLightbox />
                <span className="text-[13px] font-semibold text-zinc-800 dark:text-zinc-200 truncate">
                  {v.name}
                </span>
              </div>
            ))
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {/* Poll type hint */}
          <p className="text-[12px] text-zinc-400 dark:text-zinc-500 mb-1">
            {isMultiple
              ? t('chat.poll_vote_hint_multiple', 'Select one or more options')
              : t('chat.poll_vote_hint_single', 'Select one option')}
          </p>

          {/* Options */}
          {pollChoices.map((option) => {
            const isSelected = selected.has(option);
            const voters = votersByOption[option] || [];

            return (
              <button
                key={option}
                type="button"
                onClick={() => {
                  if (!isReadOnly) {
                    handleToggle(option);
                  }
                }}
                className={`flex items-start gap-3 w-full text-left px-4 py-3 rounded-xl border transition-all duration-150 min-w-0 ${
                  isSelected
                    ? 'border-blue-500 dark:border-blue-400 bg-blue-50 dark:bg-blue-950/20'
                    : isReadOnly
                      ? 'border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900'
                      : 'border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 hover:border-slate-300 dark:hover:border-zinc-600 active:scale-[0.99] cursor-pointer'
                }`}
              >
                {/* Checkbox / Radio indicator */}
                <div
                  className={`shrink-0 flex items-center justify-center w-5 h-5 mt-0.5 transition-colors ${
                    isMultiple
                      ? `rounded-[5px] border-[1.5px] ${
                          isSelected
                            ? 'border-blue-500 bg-blue-500'
                            : 'border-slate-300 dark:border-zinc-500'
                        }`
                      : `rounded-full border-[1.5px] ${
                          isSelected
                            ? 'border-blue-500 bg-blue-500'
                            : 'border-slate-300 dark:border-zinc-500'
                        }`
                  }`}
                >
                  {isSelected && <Check className="w-3 h-3 text-white" strokeWidth={3} />}
                </div>

                {/* Option text */}
                <span className={`flex-1 text-[14px] leading-snug break-all ${
                  isSelected
                    ? 'font-semibold text-blue-700 dark:text-blue-300'
                    : 'font-medium text-zinc-800 dark:text-zinc-200'
                }`}>
                  {option}
                </span>

                {/* Voter avatars inside the option button */}
                {voters.length > 0 && (
                  <div className="shrink-0 self-center ml-1">
                    <VoterAvatars
                      voters={voters}
                      maxVisible={3}
                      onClick={(e) => {
                        e.stopPropagation(); // Prevent toggling selection when clicking avatars
                        setViewingVotersOption(option);
                      }}
                    />
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </UhmModal>

      <UhmConfirmDialog
        isOpen={showConfirmNoChange}
        onConfirm={handleConfirmNoChange}
        onCancel={handleCancelNoChange}
        title={t('chat.poll_confirm_vote_title', 'Confirm Your Vote')}
        message={t(
          'chat.poll_confirm_no_change_message',
          'This poll does not allow changing your vote after submission. Are you sure you want to proceed?'
        )}
        confirmLabel={t('chat.poll_confirm_vote_ok', 'Vote')}
        cancelLabel={t('common.cancel', 'Cancel')}
        isDanger={false}
      />
    </>
  );
};
