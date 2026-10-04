import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

/** Marks a scripted demo trainee (created by `pnpm demo:history`) wherever the name is shown. */
export function DemoBotBadge() {
  const { t } = useTranslation();
  return (
    <span className="ml-2 inline-block rounded border border-amber-700/60 px-1.5 py-0.5 align-middle text-[10px] font-semibold uppercase tracking-wide text-amber-700">
      {t('demoBot.label')}
    </span>
  );
}

/** Plain-text name for places that cannot hold a badge (select options, sentences). */
export function botName(t: TFunction, p: { name: string; isDemoBot?: boolean }): string {
  return p.isDemoBot ? `${p.name} (${t('demoBot.label')})` : p.name;
}
