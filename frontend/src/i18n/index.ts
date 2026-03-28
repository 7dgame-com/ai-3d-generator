import { createI18n } from 'vue-i18n'
import zhCN from './locales/zh-CN'
import enUS from './locales/en-US'

const SUPPORTED_LOCALES = ['zh-CN', 'en-US'] as const
type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]

function getInitialLocale(): SupportedLocale {
  const params = new URLSearchParams(window.location.search)
  const lang = params.get('lang')
  if (lang && (SUPPORTED_LOCALES as readonly string[]).includes(lang)) {
    return lang as SupportedLocale
  }
  return 'zh-CN'
}

const i18n = createI18n({
  legacy: false,
  locale: getInitialLocale(),
  fallbackLocale: 'zh-CN',
  messages: {
    'zh-CN': zhCN,
    'en-US': enUS,
  },
})

export default i18n
