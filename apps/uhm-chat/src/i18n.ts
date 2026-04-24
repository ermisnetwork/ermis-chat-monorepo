import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import viTranslations from './locales/vi.json'
import enTranslations from './locales/en.json'

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
    lng: 'vi', // Mặc định là Tiếng Việt
    fallbackLng: 'en',
    interpolation: {
      escapeValue: false, // react đã bảo vệ khỏi xss
    },
  })

export default i18n
