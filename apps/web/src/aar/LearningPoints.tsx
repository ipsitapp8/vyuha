import { CircleCheck, Info, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  learningTextEn,
  type AarSummary,
  type LearningPointDto,
  type TimelineItemDto,
} from '@vyuha/shared';
import type en from '@/i18n/en.json';
import { botName } from '@/lib/demoBot';
import { clock } from '@/lib/format';

type RuleKey = `aar.learning.rules.${keyof typeof en.aar.learning.rules}`;

/** The rule-based wording in the active language (falls back to the shared English text for unknown rules). */
export function learningText(t: TFunction, p: LearningPointDto): string {
  const key = `aar.learning.rules.${p.rule}` as RuleKey;
  return t(key, { ...p.params, defaultValue: learningTextEn(p) });
}

const ICON = {
  warn: { Icon: TriangleAlert, className: 'text-red-700' },
  info: { Icon: Info, className: 'text-sky-700' },
  good: { Icon: CircleCheck, className: 'text-primary' },
} as const;

export function LearningList({ summary }: { summary: AarSummary }) {
  const { t } = useTranslation();
  const names = new Map(summary.meta.players.map((p) => [p.id, botName(t, p)]));
  const points = summary.analysis.learning;
  return (
    <section
      className="rounded-lg border border-border bg-secondary p-4"
      aria-label={t('aar.learning.title')}
    >
      <h2 className="mb-2 font-semibold">{t('aar.learning.title')}</h2>
      {points.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('aar.learning.none')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {points.map((p, i) => {
            const { Icon, className } = ICON[p.severity];
            return (
              <li
                key={`${p.rule}-${p.playerId ?? p.teamId}-${i}`}
                className="flex gap-2 text-sm"
                data-severity={p.severity}
              >
                <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${className}`} aria-hidden="true" />
                <span>
                  {p.playerId ? <strong>{names.get(p.playerId) ?? p.playerId}: </strong> : null}
                  {learningText(t, p)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function timelineText(
  t: TFunction,
  item: TimelineItemDto,
  nameOf: (id: string | null) => string,
): string {
  const p = item.params;
  const s = (k: string): string => String(p[k] ?? '');
  switch (item.kind) {
    case 'INJECT':
      return t(
        p['source'] === 'LIVE' ? 'aar.timelineSection.INJECT_LIVE' : 'aar.timelineSection.INJECT',
        { title: s('title') },
      );
    case 'SPOOF':
      return t('aar.timelineSection.SPOOF', { name: nameOf(item.playerId), text: s('text') });
    case 'AUTH':
      return t('aar.timelineSection.AUTH', { name: nameOf(item.playerId), result: s('result') });
    case 'CHANNEL_SWITCH':
      return t('aar.timelineSection.CHANNEL_SWITCH', {
        name: nameOf(item.playerId),
        from: s('from'),
        to: s('to'),
      });
    case 'DECISION':
      return t('aar.timelineSection.DECISION', {
        name: nameOf(item.playerId),
        action: t(`actions.${s('action')}` as 'actions.HOLD', { defaultValue: s('action') }),
        confidence: s('confidence'),
        outcome: t(`aar.decision.outcomes.${s('outcome') as 'correct'}`, {
          defaultValue: s('outcome'),
        }),
      });
    case 'JAMMING':
      return t('aar.timelineSection.JAMMING', { channel: s('channel'), level: s('level') });
    case 'C2_DETECTED':
      return t('aar.timelineSection.C2_DETECTED', {
        name: nameOf(item.playerId),
        seconds: s('seconds'),
        channel: s('via'),
      });
    case 'UAV_SPOOF_ACTED':
      return t('aar.timelineSection.UAV_SPOOF_ACTED', {
        name: nameOf(item.playerId),
        contact: s('contact'),
      });
  }
}

export function KeyEvents({ summary }: { summary: AarSummary }) {
  const { t } = useTranslation();
  const names = new Map(summary.meta.players.map((p) => [p.id, botName(t, p)]));
  const nameOf = (id: string | null): string =>
    id ? (names.get(id) ?? id) : t('aar.timelineSection.control');
  const items = summary.analysis.timeline;
  return (
    <section
      className="rounded-lg border border-border bg-secondary p-4"
      aria-label={t('aar.timelineSection.title')}
    >
      <h2 className="mb-2 font-semibold">{t('aar.timelineSection.title')}</h2>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('aar.timelineSection.empty')}</p>
      ) : (
        <ul className="max-h-80 overflow-y-auto font-mono text-xs">
          {items.map((it, i) => (
            <li key={`${it.tick}-${it.kind}-${i}`} className="flex gap-3 py-0.5">
              <span className="w-12 shrink-0 text-muted-foreground">{clock(it.tick)}</span>
              <span>{timelineText(t, it, nameOf)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
