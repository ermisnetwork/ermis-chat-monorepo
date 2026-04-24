export const STORAGE_KEYS = {
  USER_ID: 'user_id',
  TOKEN: 'token',
  CALL_SESSION_ID: 'callSessionId',
} as const;

export const API_DEFAULTS = {
  API_KEY: import.meta.env.VITE_API_KEY || 'uhm-chat-dev-key',
  BASE_URL: import.meta.env.VITE_API_URL || 'https://api-trieve.ermis.network',
} as const;

export const OTP_CONFIG = {
  COUNTDOWN_SECONDS: 60,
  CODE_LENGTH: 6,
  PHONE_METHOD: 'Sms',
} as const;
