import { useMemo } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { en, TranslationKey } from './locales/en';
import { ru } from './locales/ru';

export type Language = 'en' | 'ru';

export const LANGUAGE_LABELS: Record<Language, string> = {
  en: 'English',
  ru: 'Русский',
};

const translations: Record<Language, Record<TranslationKey, string>> = {
  en,
  ru,
};

interface LanguageStore {
  language: Language;
  setLanguage: (lang: Language) => void;
}

export const useLanguageStore = create<LanguageStore>()(
  persist(
    (set) => ({
      language: 'en',
      setLanguage: (language) => set({ language }),
    }),
    { name: 'app-language' }
  )
);

export function useTranslation() {
  const language = useLanguageStore((s) => s.language);

  // Memoize `t` by language so it keeps a stable identity across renders and
  // doesn't break the memoization of callbacks/children that depend on it.
  const t = useMemo(() => {
    const table = translations[language];
    return (key: TranslationKey, params?: Record<string, string>) => {
      let value = table[key] || en[key] || key;
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          value = value.replace(`{${k}}`, v);
        }
      }
      return value;
    };
  }, [language]);

  return { t, language };
}

export type { TranslationKey };
