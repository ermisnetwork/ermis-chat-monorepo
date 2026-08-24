import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useChatCore } from '@ermis-network/ermis-chat-react';
import { UhmModal } from '@/components/custom/UhmModal';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

export type UhmCreatePollModalProps = {
  isOpen: boolean;
  onClose: () => void;
};

export const UhmCreatePollModal: React.FC<UhmCreatePollModalProps> = ({ isOpen, onClose }) => {
  const { t } = useTranslation();
  const { activeChannel } = useChatCore();
  const [question, setQuestion] = useState('');
  const [choices, setChoices] = useState(['', '']);
  const [pollType, setPollType] = useState<'single' | 'multiple'>('single');
  const [allowChangeChoice, setAllowChangeChoice] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isE2ee = activeChannel?.data?.mls_enabled === true;

  const handleAddChoice = () => {
    if (choices.length >= 10) {
      toast.error(t('chat.poll_max_choices', 'Maximum 10 options allowed.'));
      return;
    }
    setChoices([...choices, '']);
  };

  const handleRemoveChoice = (index: number) => {
    if (choices.length <= 2) {
      toast.error(t('chat.poll_min_choices', 'At least 2 options are required.'));
      return;
    }
    setChoices(choices.filter((_, i) => i !== index));
  };

  const handleChoiceChange = (index: number, value: string) => {
    const newChoices = [...choices];
    newChoices[index] = value;
    setChoices(newChoices);
  };

  const handleCreate = async () => {
    if (!activeChannel) return;
    
    if (isE2ee) {
      toast.error(t('chat.poll_e2ee_unsupported', 'Polls are not supported in secure chats yet.'));
      return;
    }

    if (!question.trim()) {
      toast.error(t('chat.poll_question_required', 'Question is required.'));
      return;
    }

    const validChoices = choices.map(c => c.trim()).filter(c => c !== '');
    if (validChoices.length < 2) {
      toast.error(t('chat.poll_min_valid_choices', 'Please enter at least 2 options.'));
      return;
    }

    setIsSubmitting(true);
    try {
      await activeChannel.createPoll({
        text: question.trim(),
        poll_type: pollType,
        poll_choices: validChoices,
        allow_change_choice: allowChangeChoice,
      });
      toast.success(t('chat.poll_created', 'Poll created successfully!'));
      // Reset form
      setQuestion('');
      setChoices(['', '']);
      setPollType('single');
      setAllowChangeChoice(true);
      onClose();
    } catch (err: any) {
      console.error('Failed to create poll:', err);
      toast.error(t('chat.poll_create_failed', 'Failed to create poll. Please try again.'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <UhmModal
      isOpen={isOpen}
      onClose={onClose}
      title={t('chat.create_poll_title', 'Create Poll')}
      centerTitle
      footer={
        <div className="flex justify-end gap-2 w-full">
          <button
            onClick={onClose}
            className="px-4 py-2 border border-zinc-200 dark:border-zinc-800 rounded-xl hover:bg-zinc-50 dark:hover:bg-zinc-800 text-[14px] font-medium text-zinc-700 dark:text-zinc-300 transition-colors"
          >
            {t('chat.create_channel_cancel', 'Cancel')}
          </button>
          <button
            onClick={handleCreate}
            disabled={isSubmitting || isE2ee}
            className="px-4 py-2 bg-blue-500 hover:bg-blue-600 disabled:opacity-50 text-[14px] font-medium text-white rounded-xl transition-colors"
          >
            {isSubmitting ? t('chat.creating', 'Creating...') : t('chat.create_channel_create', 'Create')}
          </button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {isE2ee && (
          <div className="text-[12px] text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/20 px-3 py-2 rounded-lg border border-amber-200/50 dark:border-amber-900/20 flex items-start gap-1">
            <span className="shrink-0">⚠️</span>
            <span>{t('chat.poll_e2ee_unsupported', 'Polls are not supported in secure chats yet.')}</span>
          </div>
        )}

        {/* Question */}
        <div className="flex flex-col gap-1.5">
          <label className="text-[14px] font-semibold text-zinc-700 dark:text-zinc-300">
            {t('chat.poll_question_label', 'Question')}
          </label>
          <input
            type="text"
            disabled={isE2ee || isSubmitting}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={t('chat.poll_question_placeholder', 'Ask a question...')}
            className="w-full px-3 py-2 bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-700/50 rounded-xl text-[14px] outline-none focus:border-blue-500 transition-colors"
          />
        </div>

        {/* Options */}
        <div className="flex flex-col gap-1.5">
          <label className="text-[14px] font-semibold text-zinc-700 dark:text-zinc-300">
            {t('chat.poll_options_label', 'Options')}
          </label>
          <div className="flex flex-col gap-2 max-h-[220px] overflow-y-auto pr-1">
            {choices.map((choice, index) => (
              <div key={index} className="flex items-center gap-2">
                <input
                  type="text"
                  disabled={isE2ee || isSubmitting}
                  value={choice}
                  onChange={(e) => handleChoiceChange(index, e.target.value)}
                  placeholder={t('chat.poll_option_placeholder', 'Option {{number}}', { number: index + 1 })}
                  className="flex-1 px-3 py-2 bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-700/50 rounded-xl text-[14px] outline-none focus:border-blue-500 transition-colors"
                />
                <button
                  type="button"
                  disabled={isE2ee || isSubmitting || choices.length <= 2}
                  onClick={() => handleRemoveChoice(index)}
                  className="p-2 text-zinc-400 hover:text-red-500 disabled:opacity-30 disabled:hover:text-zinc-400 rounded-lg transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>

          <button
            type="button"
            disabled={isE2ee || isSubmitting || choices.length >= 10}
            onClick={handleAddChoice}
            className="flex items-center justify-center gap-1.5 py-2 border border-dashed border-zinc-200 dark:border-zinc-800 rounded-xl hover:bg-zinc-50 dark:hover:bg-zinc-800 text-[13px] font-medium text-zinc-600 dark:text-zinc-400 transition-colors mt-1"
          >
            <Plus className="w-4 h-4" />
            {t('chat.poll_add_option', 'Add Option')}
          </button>
        </div>

        {/* Toggle Multiple Choice */}
        <div className="flex items-center justify-between border-t border-zinc-100 dark:border-zinc-800 pt-3 mt-1">
          <span className="text-[14px] font-semibold text-zinc-700 dark:text-zinc-300">
            {t('chat.poll_multiple_choice_toggle', 'Allow multiple choices')}
          </span>
          <button
            type="button"
            disabled={isE2ee || isSubmitting}
            onClick={() => setPollType(pollType === 'single' ? 'multiple' : 'single')}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
              pollType === 'multiple' ? 'bg-blue-500' : 'bg-zinc-200 dark:bg-zinc-800'
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                pollType === 'multiple' ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>

        {/* Toggle Allow Change Choice */}
        <div className="flex items-center justify-between border-t border-zinc-100 dark:border-zinc-800 pt-3 mt-1">
          <span className="text-[14px] font-semibold text-zinc-700 dark:text-zinc-300">
            {t('chat.poll_allow_change_toggle', 'Allow changing vote')}
          </span>
          <button
            type="button"
            disabled={isE2ee || isSubmitting}
            onClick={() => setAllowChangeChoice(!allowChangeChoice)}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
              allowChangeChoice ? 'bg-blue-500' : 'bg-zinc-200 dark:bg-zinc-800'
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                allowChangeChoice ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>
      </div>
    </UhmModal>
  );
};
