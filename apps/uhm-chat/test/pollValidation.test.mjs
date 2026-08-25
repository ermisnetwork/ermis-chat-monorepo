import test from 'node:test';
import assert from 'node:assert/strict';

import {
  POLL_QUESTION_MAX_LENGTH,
  validatePollDraft,
} from '../src/features/chat/pollValidation.ts';

test('trims the question and options before returning the payload', () => {
  assert.deepEqual(validatePollDraft('  Lunch?  ', ['  Pizza ', ' Salad  ']), {
    valid: true,
    question: 'Lunch?',
    choices: ['Pizza', 'Salad'],
  });
});

test('rejects duplicate options after trimming and case normalization', () => {
  assert.deepEqual(validatePollDraft('Lunch?', [' Pizza ', 'pizza']), {
    valid: false,
    error: 'duplicate_options',
  });
});

test('rejects a question longer than 2,000 characters', () => {
  assert.deepEqual(
    validatePollDraft('q'.repeat(POLL_QUESTION_MAX_LENGTH + 1), ['Yes', 'No']),
    {
      valid: false,
      error: 'question_too_long',
    },
  );
});

test('accepts a question with exactly 2,000 characters', () => {
  assert.equal(
    validatePollDraft('q'.repeat(POLL_QUESTION_MAX_LENGTH), ['Yes', 'No']).valid,
    true,
  );
});