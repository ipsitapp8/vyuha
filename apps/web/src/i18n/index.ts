import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en.json';
import hi from './hi.json';

export const LANGUAGES = ['en', 'hi'] as const;
export type Language = (typeof LANGUAGES)[number];
const STORAGE_KEY = 'vyuha.lang';

export const isLanguage = (v: unknown): v is Language => LANGUAGES.some((l) => l === v);

function savedLanguage(): Language | null {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return isLanguage(v) ? v : null;
  } catch {
    return null; // storage can be blocked; the toggle still works for this visit
  }
}

export function initialLanguage(): Language {
  const saved = savedLanguage();
  if (saved) return saved;
  return typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('hi')
    ? 'hi'
    : 'en';
}

export function setLanguage(lang: Language): void {
  void i18n.changeLanguage(lang);
  document.documentElement.lang = lang;
  try {
    window.localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* ignore: preference just will not persist */
  }
}

export async function initI18n(lang: Language = initialLanguage()): Promise<void> {
  if (!i18n.isInitialized) {
    await i18n.use(initReactI18next).init({
      resources: { en: { translation: en }, hi: { translation: hi } },
      lng: lang,
      fallbackLng: 'en',
      interpolation: { escapeValue: false }, // React already escapes
      returnNull: false,
    });
  } else {
    await i18n.changeLanguage(lang);
  }
  document.documentElement.lang = lang;
}

export { i18n };
