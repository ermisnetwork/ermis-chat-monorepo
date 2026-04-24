import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { STORAGE_KEYS } from '@/utils/constants'

import viTranslations from './locales/vi.json'
import enTranslations from './locales/en.json'

const savedLocale = localStorage.getItem(STORAGE_KEYS.LOCALE) || 'vi'

i18n
  .use(initReactI18next)
  .init({
    resources: {
      vi: {
        translation: viTranslations,
      },
      en: {
        translation: enTranslations,
      },
    },
    lng: savedLocale, // Sử dụng locale đã lưu
    fallbackLng: 'en',
    interpolation: {
      escapeValue: false, // react đã bảo vệ khỏi xss
    },
  })

export default i18n
