import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { injectSchema, type Inject, type InjectType } from '@vyuha/shared';
import { Select } from '@/components/Select';
import { Button } from '@/components/ui/button';

export interface UnitRef {
  id: string;
  name: string;
  side: 'BLUE' | 'RED' | 'NEUTRAL';
}

export const INJECT_TYPES: readonly InjectType[] = [
  'JAM_CHANNEL',
  'SATCOM_OUTAGE',
  'CONFLICTING_REPORTS',
  'SPOOF_ORDER',
  'RUNNER_DISPATCH',
  'WEATHER_CHANGE',
  'ADVERSARY_MOVE',
];
const JAMMABLE = ['VHF', 'HF', 'SATCOM', 'DATALINK'] as const;
const HOSTILE_TYPES = [
  'RECCE',
  'MECH_INFANTRY_COMPANY',
  'MECH_INFANTRY_SECTION',
  'EW_JAMMER',
  'DRONE',
  'INFANTRY_SECTION',
  'CIVILIAN_CONVOY',
  'CIVILIAN_AIRCRAFT',
];

interface Props {
  /** Editing an existing inject; omit to create. */
  initial?: Inject | null;
  /** Scenario units (the editor offers hostile units for adversary injects and friendly ones for orders). */
  units: readonly UnitRef[];
  /** Show the time field (MSEL entries). Live injects fire immediately and have no time. */
  withTick: boolean;
  defaultTick?: number;
  /** Lock the inject type (quick-inject buttons). */
  fixedType?: InjectType;
  /** Where new position fields start (e.g. the centre of the exercise area). */
  anchor: { lat: number; lon: number };
  submitLabel: string;
  onSubmit: (inject: Inject) => Promise<void> | void;
  onCancel?: () => void;
}

interface Form {
  type: InjectType;
  title: string;
  tick: string;
  channel: (typeof JAMMABLE)[number];
  intensity: number;
  duration: string;
  unitId: string;
  altLat: string;
  altLon: string;
  altType: string;
  sender: string;
  targetUnitId: string;
  orderText: string;
  fromUnitId: string;
  toUnitId: string;
  messageText: string;
  visibility: string;
  precip: string;
  wind: string;
  destLat: string;
  destLon: string;
}

function initialForm(p: Props, firstHostile: string, firstBlue: string): Form {
  const base: Form = {
    type: p.fixedType ?? 'JAM_CHANNEL',
    title: '',
    tick: String(p.defaultTick ?? 60),
    channel: 'VHF',
    intensity: 60,
    duration: '120',
    unitId: firstHostile,
    altLat: p.anchor.lat.toFixed(4),
    altLon: p.anchor.lon.toFixed(4),
    altType: 'MECH_INFANTRY_SECTION',
    sender: 'Battalion HQ',
    targetUnitId: firstBlue,
    orderText: '',
    fromUnitId: firstBlue,
    toUnitId: firstBlue,
    messageText: '',
    visibility: '5000',
    precip: '0',
    wind: '10',
    destLat: p.anchor.lat.toFixed(4),
    destLon: p.anchor.lon.toFixed(4),
  };
  const i = p.initial;
  if (!i) return base;
  const common = { ...base, type: i.type, title: i.title, tick: String(i.tick) };
  switch (i.type) {
    case 'JAM_CHANNEL':
      return {
        ...common,
        channel: i.channel,
        intensity: Math.round(i.intensity * 100),
        duration: String(i.durationTicks),
      };
    case 'SATCOM_OUTAGE':
      return { ...common, duration: String(i.durationTicks) };
    case 'CONFLICTING_REPORTS':
      return {
        ...common,
        unitId: i.unitId,
        altLat: String(i.altPosition.lat),
        altLon: String(i.altPosition.lon),
        altType: i.altType,
      };
    case 'SPOOF_ORDER':
      return {
        ...common,
        sender: i.purportedSender,
        targetUnitId: i.targetUnitId,
        orderText: i.orderText,
      };
    case 'RUNNER_DISPATCH':
      return {
        ...common,
        fromUnitId: i.fromUnitId,
        toUnitId: i.toUnitId,
        messageText: i.messageText,
      };
    case 'WEATHER_CHANGE':
      return {
        ...common,
        visibility: String(i.visibilityM),
        precip: String(i.precipitationMm),
        wind: String(i.windKph),
      };
    case 'ADVERSARY_MOVE':
      return {
        ...common,
        unitId: i.unitId,
        destLat: String(i.destination.lat),
        destLon: String(i.destination.lon),
      };
  }
}

/** Builds the candidate inject (numbers parsed from the text fields) for Zod to validate. */
function candidate(f: Form, id: string, title: string, withTick: boolean): unknown {
  const head = { id, title, tick: withTick ? Number(f.tick) : 0 };
  switch (f.type) {
    case 'JAM_CHANNEL':
      return {
        ...head,
        type: f.type,
        channel: f.channel,
        intensity: f.intensity / 100,
        durationTicks: Number(f.duration),
      };
    case 'SATCOM_OUTAGE':
      return { ...head, type: f.type, durationTicks: Number(f.duration) };
    case 'CONFLICTING_REPORTS':
      return {
        ...head,
        type: f.type,
        unitId: f.unitId,
        altPosition: { lat: Number(f.altLat), lon: Number(f.altLon) },
        altType: f.altType,
      };
    case 'SPOOF_ORDER':
      return {
        ...head,
        type: f.type,
        purportedSender: f.sender,
        targetUnitId: f.targetUnitId,
        orderText: f.orderText,
      };
    case 'RUNNER_DISPATCH':
      return {
        ...head,
        type: f.type,
        fromUnitId: f.fromUnitId,
        toUnitId: f.toUnitId,
        messageText: f.messageText,
      };
    case 'WEATHER_CHANGE':
      return {
        ...head,
        type: f.type,
        visibilityM: Number(f.visibility),
        precipitationMm: Number(f.precip),
        windKph: Number(f.wind),
      };
    case 'ADVERSARY_MOVE':
      return {
        ...head,
        type: f.type,
        unitId: f.unitId,
        destination: { lat: Number(f.destLat), lon: Number(f.destLon) },
      };
  }
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  list,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: 'text' | 'number';
  list?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-left text-sm font-medium">
      {label}
      <input
        value={value}
        type={type}
        step={type === 'number' ? 'any' : undefined}
        list={list}
        onChange={(e) => onChange(e.target.value)}
        className="h-10 rounded-md border border-border bg-background px-3 text-sm font-normal"
      />
    </label>
  );
}

/** One form for every inject type: live injects, MSEL entries on a running exercise, and scenario authoring. */
export function InjectEditor(props: Props) {
  const { t } = useTranslation();
  const { units, withTick, fixedType, submitLabel, onSubmit, onCancel } = props;
  const hostile = units.filter((u) => u.side !== 'BLUE');
  const blue = units.filter((u) => u.side === 'BLUE');
  const [f, setF] = useState<Form>(() =>
    initialForm(props, hostile[0]?.id ?? '', blue[0]?.id ?? ''),
  );
  const [issues, setIssues] = useState<string[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Form>(key: K, value: Form[K]): void =>
    setF((prev) => ({ ...prev, [key]: value }));

  const unitOptions = (list: readonly UnitRef[]) =>
    list.map((u) => ({ value: u.id, label: `${u.name} (${u.id})` }));

  const submit = async (): Promise<void> => {
    const title =
      f.title.trim() ||
      t(`injectEditor.defaultTitles.${f.type}`, {
        channel: f.type === 'JAM_CHANNEL' ? f.channel : '',
      });
    const parsed = injectSchema.safeParse(
      candidate(f, props.initial?.id ?? 'new', title, withTick),
    );
    if (!parsed.success) {
      setIssues(parsed.error.issues.map((i) => `${i.path.join('.') || f.type}: ${i.message}`));
      return;
    }
    setIssues([]);
    setFailure(null);
    setBusy(true);
    try {
      await onSubmit(parsed.data);
    } catch (e) {
      setFailure(e instanceof Error ? e.message : t('common.genericError'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {fixedType ? null : (
        <Select
          label={t('injectEditor.type')}
          value={f.type}
          options={INJECT_TYPES.map((x) => ({ value: x, label: t(`injectEditor.types.${x}`) }))}
          onChange={(v) => set('type', v as InjectType)}
        />
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('injectEditor.title')} value={f.title} onChange={(v) => set('title', v)} />
        {withTick ? (
          <Field
            label={t('injectEditor.tick')}
            type="number"
            value={f.tick}
            onChange={(v) => set('tick', v)}
          />
        ) : null}
      </div>

      {f.type === 'JAM_CHANNEL' ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <Select
            label={t('injectEditor.channel')}
            value={f.channel}
            options={JAMMABLE.map((c) => ({ value: c, label: t(`channels.${c}`) }))}
            onChange={(v) => set('channel', v as Form['channel'])}
          />
          <label className="flex flex-col gap-1 text-sm font-medium">
            {t('injectEditor.intensity', { value: f.intensity })}
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={f.intensity}
              onChange={(e) => set('intensity', Number(e.target.value))}
            />
          </label>
          <Field
            label={t('injectEditor.duration')}
            type="number"
            value={f.duration}
            onChange={(v) => set('duration', v)}
          />
        </div>
      ) : null}

      {f.type === 'SATCOM_OUTAGE' ? (
        <Field
          label={t('injectEditor.duration')}
          type="number"
          value={f.duration}
          onChange={(v) => set('duration', v)}
        />
      ) : null}

      {f.type === 'CONFLICTING_REPORTS' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Select
            label={t('injectEditor.unit')}
            value={f.unitId}
            options={unitOptions(hostile)}
            onChange={(v) => set('unitId', v)}
          />
          <Field
            label={t('injectEditor.altType')}
            value={f.altType}
            list="vy-unit-types"
            onChange={(v) => set('altType', v)}
          />
          <Field
            label={t('injectEditor.altLat')}
            type="number"
            value={f.altLat}
            onChange={(v) => set('altLat', v)}
          />
          <Field
            label={t('injectEditor.altLon')}
            type="number"
            value={f.altLon}
            onChange={(v) => set('altLon', v)}
          />
          <datalist id="vy-unit-types">
            {HOSTILE_TYPES.map((x) => (
              <option key={x} value={x} />
            ))}
          </datalist>
        </div>
      ) : null}

      {f.type === 'SPOOF_ORDER' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label={t('injectEditor.sender')}
            value={f.sender}
            onChange={(v) => set('sender', v)}
          />
          <Select
            label={t('injectEditor.target')}
            value={f.targetUnitId}
            options={unitOptions(blue)}
            onChange={(v) => set('targetUnitId', v)}
          />
          <div className="sm:col-span-2">
            <Field
              label={t('injectEditor.orderText')}
              value={f.orderText}
              onChange={(v) => set('orderText', v)}
            />
          </div>
        </div>
      ) : null}

      {f.type === 'RUNNER_DISPATCH' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Select
            label={t('injectEditor.from')}
            value={f.fromUnitId}
            options={unitOptions(blue)}
            onChange={(v) => set('fromUnitId', v)}
          />
          <Select
            label={t('injectEditor.to')}
            value={f.toUnitId}
            options={unitOptions(blue)}
            onChange={(v) => set('toUnitId', v)}
          />
          <div className="sm:col-span-2">
            <Field
              label={t('injectEditor.messageText')}
              value={f.messageText}
              onChange={(v) => set('messageText', v)}
            />
          </div>
        </div>
      ) : null}

      {f.type === 'WEATHER_CHANGE' ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field
            label={t('injectEditor.visibility')}
            type="number"
            value={f.visibility}
            onChange={(v) => set('visibility', v)}
          />
          <Field
            label={t('injectEditor.precipitation')}
            type="number"
            value={f.precip}
            onChange={(v) => set('precip', v)}
          />
          <Field
            label={t('injectEditor.wind')}
            type="number"
            value={f.wind}
            onChange={(v) => set('wind', v)}
          />
        </div>
      ) : null}

      {f.type === 'ADVERSARY_MOVE' ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <Select
            label={t('injectEditor.unit')}
            value={f.unitId}
            options={unitOptions(hostile)}
            onChange={(v) => set('unitId', v)}
          />
          <Field
            label={t('injectEditor.destLat')}
            type="number"
            value={f.destLat}
            onChange={(v) => set('destLat', v)}
          />
          <Field
            label={t('injectEditor.destLon')}
            type="number"
            value={f.destLon}
            onChange={(v) => set('destLon', v)}
          />
        </div>
      ) : null}

      {issues.length > 0 ? (
        <div role="alert" className="rounded-md bg-red-950 p-2 text-sm text-red-300">
          <p className="font-semibold">{t('injectEditor.invalid')}</p>
          <ul className="list-disc pl-5">
            {issues.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {failure ? (
        <p role="alert" className="text-sm text-red-400">
          {failure}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          {submitLabel}
        </Button>
        {onCancel ? (
          <Button type="button" variant="outline" onClick={onCancel}>
            {t('god.inject.cancel')}
          </Button>
        ) : null}
      </div>
    </form>
  );
}
