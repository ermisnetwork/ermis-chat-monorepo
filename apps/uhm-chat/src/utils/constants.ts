export const STORAGE_KEYS = {
  USER_ID: 'user_id',
  TOKEN: 'token',
  REFRESH_TOKEN: 'refresh_token',
  CALL_SESSION_ID: 'call_session_id',
  LOCALE: 'locale',
  THEME: 'theme',
  NOTIFICATION_SOUND_ENABLED: 'notification_sound_enabled',
  RECOVERY_GATE_ACKNOWLEDGED_CIDS: 'recovery_gate_acknowledged_cids',
} as const;

export const NOTIFICATION_CONFIG = {
  SOUND_THROTTLE_MS: 2000,
} as const;

const SELF_HOSTED = import.meta.env.VITE_ERMIS_SELF_HOSTED !== 'false';
const configuredEndUserApiMode = import.meta.env.VITE_END_USER_API_MODE;
const END_USER_API_MODE =
  configuredEndUserApiMode === 'legacy' || configuredEndUserApiMode === 'v1'
    ? configuredEndUserApiMode
    : 'legacy';

export const API_DEFAULTS = {
  SELF_HOSTED,
  END_USER_API_MODE,
  API_KEY: import.meta.env.VITE_API_KEY || '',
  PROJECT_ID: import.meta.env.VITE_CHAT_PROJECT_ID || '',
  BASE_URL: import.meta.env.VITE_API_URL || 'https://api-trieve.ermis.network',
  USS_BASE_URL: import.meta.env.VITE_USS_API_URL || undefined,
} as const;

export const OTP_CONFIG = {
  COUNTDOWN_SECONDS: 60,
  CODE_LENGTH: 6,
  PHONE_METHOD: 'Sms',
} as const;

export const RECOVERY_PIN_CONFIG = {
  MIN_DIGITS: 8,
  RESTORE_PREVIEW_LIMIT: 8,
} as const;
