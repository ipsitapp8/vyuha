import { Languages } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { LANGUAGES, setLanguage, type Language } from '@/i18n';

/** English / Hindi switch; the choice is remembered in this browser. */
export function LanguageToggle() {
  const { t, i18n } = useTranslation();
  const current: Language = i18n.language === 'hi' ? 'hi' : 'en';
  return (
    <div role="group" aria-label={t('common.language')} className="flex items-center gap-1">
      <Languages className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
      {LANGUAGES.map((lang) => (
        <button
          key={lang}
          type="button"
          lang={lang}
          aria-pressed={lang === current}
          onClick={() => setLanguage(lang)}
          className={
            lang === current
              ? 'rounded-md bg-primary px-2 py-1 text-xs font-semibold text-primary-foreground'
              : 'rounded-md border border-border px-2 py-1 text-xs hover:bg-secondary'
          }
        >
          {t(`lang.${lang}`)}
        </button>
      ))}
    </div>
  );
}
