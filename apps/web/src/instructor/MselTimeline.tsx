import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Inject, InjectType } from '@vyuha/shared';
import { Button } from '@/components/ui/button';
import { clock } from '@/lib/format';
import { InjectEditor, type UnitRef } from './InjectEditor';

export interface MselEntry {
  inject: Inject;
  fired: boolean;
}

const COLOURS: Record<InjectType, string> = {
  JAM_CHANNEL: '#ef4444',
  SATCOM_OUTAGE: '#f97316',
  CONFLICTING_REPORTS: '#a855f7',
  SPOOF_ORDER: '#eab308',
  RUNNER_DISPATCH: '#22c55e',
  WEATHER_CHANGE: '#0ea5e9',
  ADVERSARY_MOVE: '#ec4899',
  GPS_SPOOF: '#0d9488',
  C2_COMPROMISE: '#4f46e5',
};
const LANES = 3;

interface Props {
  entries: readonly MselEntry[];
  tick: number;
  units: readonly UnitRef[];
  anchor: { lat: number; lon: number };
  onAdd: (inject: Inject) => Promise<void>;
  onUpdate: (inject: Inject) => Promise<void>;
  onRemove: (injectId: string) => Promise<void>;
}

/** Horizontal MSEL timeline: filled = already fired, outline = still to come; edit anything not yet fired. */
export function MselTimeline({ entries, tick, units, anchor, onAdd, onUpdate, onRemove }: Props) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string | 'new' | null>(null);
  const [saved, setSaved] = useState(false);

  const maxTick = Math.max(0, ...entries.map((e) => e.inject.tick));
  const total = Math.ceil(Math.max(900, maxTick + 120, tick + 120) / 60) * 60;
  const pct = (x: number): string => `${Math.min(100, (x / total) * 100)}%`;
  const current = entries.find((e) => e.inject.id === selected);
  const axis = Array.from({ length: 7 }, (_, i) => Math.round((total / 6) * i));

  const done = async (fn: () => Promise<void>): Promise<void> => {
    await fn();
    setSelected(null);
    setSaved(true);
  };

  return (
    <section
      className="rounded-lg border border-border bg-secondary p-4"
      aria-label={t('god.timeline.title')}
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">{t('god.timeline.title')}</h2>
        <Button
          variant="outline"
          onClick={() => {
            setSaved(false);
            setSelected('new');
          }}
        >
          {t('god.timeline.add')}
        </Button>
      </div>

      <div className="overflow-x-auto pb-2">
        <div
          role="group"
          aria-label={t('god.timeline.label')}
          className="relative h-24 min-w-[640px] rounded-md bg-background"
        >
          {axis.map((x) => (
            <span
              key={x}
              className="absolute bottom-0 -translate-x-1/2 text-[10px] text-muted-foreground"
              style={{ left: pct(x) }}
            >
              {clock(x)}
            </span>
          ))}
          <div
            className="absolute inset-y-0 w-px bg-primary"
            style={{ left: pct(tick) }}
            aria-label={`${t('god.timeline.now')} ${clock(tick)}`}
          >
            <span className="absolute -top-0.5 left-1 text-[10px] font-semibold text-primary">
              {t('god.timeline.now')}
            </span>
          </div>
          {entries.map((e, i) => {
            const colour = COLOURS[e.inject.type];
            const label = `${t('god.timeline.at', { time: clock(e.inject.tick) })} · ${t(`injectEditor.types.${e.inject.type}`)} · ${e.inject.title} · ${
              e.fired ? t('god.timeline.fired') : t('god.timeline.scheduled')
            }`;
            return (
              <button
                key={e.inject.id}
                type="button"
                title={label}
                aria-label={label}
                aria-pressed={selected === e.inject.id}
                onClick={() => {
                  setSaved(false);
                  setSelected(e.inject.id);
                }}
                className="absolute h-5 w-5 -translate-x-1/2 rounded-full border-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
                style={{
                  left: pct(e.inject.tick),
                  top: 14 + (i % LANES) * 22,
                  borderColor: colour,
                  background: e.fired ? colour : 'transparent',
                  boxShadow: selected === e.inject.id ? '0 0 0 3px #fff' : undefined,
                }}
              />
            );
          })}
          {entries.length === 0 ? (
            <p className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
              {t('god.timeline.empty')}
            </p>
          ) : null}
        </div>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{t('god.timeline.legend')}</p>
      {saved ? (
        <p role="status" className="mt-2 text-sm text-primary">
          {t('god.timeline.saved')}
        </p>
      ) : null}

      {selected === 'new' ? (
        <div className="mt-3 rounded-md border border-border p-3">
          <h3 className="mb-2 font-medium">{t('god.timeline.add')}</h3>
          <InjectEditor
            withTick
            defaultTick={tick + 30}
            units={units}
            anchor={anchor}
            submitLabel={t('god.timeline.add')}
            onCancel={() => setSelected(null)}
            onSubmit={(inject) => done(() => onAdd(inject))}
          />
        </div>
      ) : null}

      {current ? (
        <div className="mt-3 rounded-md border border-border p-3">
          <h3 className="mb-2 font-medium">
            {t('god.timeline.at', { time: clock(current.inject.tick) })} · {current.inject.title}
          </h3>
          {current.fired ? (
            <>
              <p className="text-sm text-muted-foreground">{t('god.timeline.firedNote')}</p>
              <Button className="mt-2" variant="outline" onClick={() => setSelected(null)}>
                {t('common.close')}
              </Button>
            </>
          ) : (
            <>
              <InjectEditor
                key={current.inject.id}
                initial={current.inject}
                withTick
                units={units}
                anchor={anchor}
                submitLabel={t('god.timeline.save')}
                onCancel={() => setSelected(null)}
                onSubmit={(inject) => done(() => onUpdate({ ...inject, id: current.inject.id }))}
              />
              <Button
                className="mt-2"
                variant="outline"
                onClick={() => void done(() => onRemove(current.inject.id))}
              >
                {t('god.timeline.remove')}
              </Button>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
