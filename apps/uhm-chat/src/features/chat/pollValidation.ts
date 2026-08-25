export const POLL_QUESTION_MAX_LENGTH = 2000;

export type PollValidationError =
  | 'question_required'
  | 'question_too_long'
  | 'min_valid_choices'
  | 'duplicate_options';

export type PollValidationResult =
  | {
      valid: true;
      question: string;
      choices: string[];
    }
  | {
      valid: false;
      error: PollValidationError;
    };

const getChoiceComparisonKey = (choice: string) => choice.normalize('NFKC').toLowerCase();

export const validatePollDraft = (question: string, choices: string[]): PollValidationResult => {
  const normalizedQuestion = question.trim();
  if (!normalizedQuestion) return { valid: false, error: 'question_required' };
  if (normalizedQuestion.length > POLL_QUESTION_MAX_LENGTH) {
    return { valid: false, error: 'question_too_long' };
  }

  const normalizedChoices = choices.map((choice) => choice.trim()).filter(Boolean);
  if (normalizedChoices.length < 2) return { valid: false, error: 'min_valid_choices' };

  const uniqueChoiceKeys = new Set(normalizedChoices.map(getChoiceComparisonKey));
  if (uniqueChoiceKeys.size !== normalizedChoices.length) {
    return { valid: false, error: 'duplicate_options' };
  }

  return {
    valid: true,
    question: normalizedQuestion,
    choices: normalizedChoices,
  };
};