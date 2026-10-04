import { useTranslation } from 'react-i18next';
import { APP_NAME } from '@vyuha/shared';

/** Portal footer: what this site is, where its data comes from, and that it is not an official site. */
export function AppFooter() {
  const { t } = useTranslation();
  return (
    <footer className="mt-10 border-t-4 border-saffron bg-navy text-white">
      <div className="mx-auto grid max-w-7xl gap-4 px-4 py-6 text-sm sm:grid-cols-2">
        <div>
          <p className="font-bold tracking-widest">{APP_NAME}</p>
          <p className="mt-1 text-white/85">{t('shell.footer.about')}</p>
        </div>
        <div className="text-white/85">
          <p>{t('shell.footer.data')}</p>
          <p className="mt-1">{t('shell.footer.notice')}</p>
        </div>
      </div>
    </footer>
  );
}
