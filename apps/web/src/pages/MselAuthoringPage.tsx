import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  mselSchema,
  validateMselReferences,
  type Inject,
  type ScenarioDetail,
} from '@vyuha/shared';
import { AppHeader } from '@/components/AppHeader';
import { Button } from '@/components/ui/button';
import { InjectEditor } from '@/instructor/InjectEditor';
import { api } from '@/lib/api';
import { clock } from '@/lib/format';
import { apiErrorText } from '@/lib/messages';

const byTime = (a: Inject, b: Inject): number => a.tick - b.tick || a.id.localeCompare(b.id);
const newId = (): string => `inj-${crypto.randomUUID().slice(0, 8)}`;

/** Accepts a bare array of injects or an object `{ msel: [...] }` (what Export writes is the bare array). */
export function parseMselJson(
  text: string,
): { ok: true; msel: Inject[] } | { ok: false; reason: 'json' | string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'json' };
  }
  const candidate =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw) && 'msel' in raw
      ? (raw as { msel: unknown }).msel
      : raw;
  const parsed = mselSchema.safeParse(candidate);
  if (parsed.success) return { ok: true, msel: parsed.data };
  const first = parsed.error.issues[0];
  return {
    ok: false,
    reason: first ? `${first.path.join('.') || 'msel'}: ${first.message}` : 'invalid',
  };
}

/** Scenario-level MSEL editor: form-based, with JSON import/export validated by the shared Zod schemas. */
export function MselAuthoringPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const [detail, setDetail] = useState<ScenarioDetail | null>(null);
  const [saved, setSaved] = useState<string>('[]');
  const [list, setList] = useState<Inject[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getScenario(id)
      .then((d) => {
        if (cancelled) return;
        const sorted = [...d.msel].sort(byTime);
        setDetail(d);
        setList(sorted);
        setSaved(JSON.stringify(sorted));
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(apiErrorText(t, e, t('msel.loadFailed')));
      });
    return () => {
      cancelled = true;
    };
  }, [id, attempt, t]);

  const problems = useMemo(
    () => (detail ? validateMselReferences(list, detail.initialUnits, detail.areaBounds) : []),
    [detail, list],
  );
  const dirty = JSON.stringify(list) !== saved;

  const importFile = async (file: File): Promise<void> => {
    const result = parseMselJson(await file.text());
    if (!result.ok) {
      setMessage({
        kind: 'error',
        text:
          result.reason === 'json'
            ? t('msel.importUnreadable')
            : t('msel.importInvalid', { detail: result.reason }),
      });
      return;
    }
    setList([...result.msel].sort(byTime));
    setEditing(null);
    setMessage({ kind: 'ok', text: t('msel.imported', { count: result.msel.length }) });
  };

  const exportJson = (): void => {
    const blob = new Blob([JSON.stringify(list, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `msel-${detail?.title.replace(/\W+/g, '-').toLowerCase() ?? 'scenario'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    setMessage(null);
    try {
      const updated = await api.saveMsel(id, list);
      const sorted = [...updated.msel].sort(byTime);
      setDetail(updated);
      setList(sorted);
      setSaved(JSON.stringify(sorted));
      setMessage({ kind: 'ok', text: t('msel.saved') });
    } catch (e) {
      setMessage({ kind: 'error', text: apiErrorText(t, e) });
    } finally {
      setSaving(false);
    }
  };

  const units = detail?.initialUnits ?? [];
  const b = detail?.areaBounds;
  const anchor = b
    ? { lat: (b.south + b.north) / 2, lon: (b.west + b.east) / 2 }
    : { lat: 0, lon: 0 };
  const current = list.find((i) => i.id === editing);

  return (
    <>
      <AppHeader />
      <main className="mx-auto max-w-5xl px-4 py-6">
        <Link to="/instructor" className="text-sm text-primary underline">
          {t('msel.back')}
        </Link>

        {!detail && !loadError ? (
          <p role="status" className="mt-4">
            {t('msel.loading')}
          </p>
        ) : null}
        {loadError ? (
          <div role="alert" className="mt-4 flex items-center gap-3 text-red-700">
            <span>{loadError}</span>
            <Button
              variant="outline"
              onClick={() => {
                setLoadError(null);
                setAttempt((n) => n + 1);
              }}
            >
              {t('common.retry')}
            </Button>
          </div>
        ) : null}

        {detail && b ? (
          <>
            <h1 className="mt-2 text-2xl font-semibold">
              {t('msel.title')}: {detail.title}
            </h1>
            <p className="mb-1 text-sm text-muted-foreground">{t('msel.intro')}</p>
            <p className="mb-4 text-xs text-muted-foreground">
              {t('msel.unitsHint', {
                count: units.length,
                south: b.south,
                north: b.north,
                west: b.west,
                east: b.east,
              })}
            </p>

            <div className="mb-4 flex flex-wrap items-center gap-2">
              <Button
                onClick={() => {
                  setMessage(null);
                  setEditing('new');
                }}
              >
                {t('msel.add')}
              </Button>
              <Button variant="outline" onClick={exportJson}>
                {t('msel.export')}
              </Button>
              <Button variant="outline" onClick={() => fileRef.current?.click()}>
                {t('msel.import')}
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                className="sr-only"
                aria-label={t('msel.import')}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void importFile(file);
                }}
              />
              <p className="text-xs text-muted-foreground">{t('msel.importHelp')}</p>
            </div>

            {message ? (
              <p
                role={message.kind === 'error' ? 'alert' : 'status'}
                className={`mb-3 ${message.kind === 'error' ? 'text-red-700' : 'text-primary'}`}
              >
                {message.text}
              </p>
            ) : null}

            {editing ? (
              <section className="mb-4 rounded-lg border border-border bg-secondary p-4">
                <h2 className="mb-2 font-semibold">
                  {editing === 'new' ? t('msel.formAdd') : t('msel.formEdit')}
                </h2>
                <InjectEditor
                  key={editing}
                  initial={current ?? null}
                  withTick
                  defaultTick={Math.max(0, ...list.map((i) => i.tick)) + 60}
                  units={units}
                  anchor={anchor}
                  submitLabel={t('msel.apply')}
                  onCancel={() => setEditing(null)}
                  onSubmit={(inject) => {
                    setList((prev) =>
                      (editing === 'new'
                        ? [...prev, { ...inject, id: newId() }]
                        : prev.map((i) => (i.id === editing ? { ...inject, id: i.id } : i))
                      ).sort(byTime),
                    );
                    setEditing(null);
                  }}
                />
              </section>
            ) : null}

            {list.length === 0 ? (
              <p className="text-muted-foreground">{t('msel.empty')}</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-secondary text-left text-muted-foreground">
                    <tr>
                      <th className="p-2">{t('msel.colTime')}</th>
                      <th className="p-2">{t('msel.colType')}</th>
                      <th className="p-2">{t('msel.colTitle')}</th>
                      <th className="p-2">{t('msel.colActions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((i) => (
                      <tr key={i.id} className="border-t border-border">
                        <td className="p-2 font-mono">{clock(i.tick)}</td>
                        <td className="p-2">{t(`injectEditor.types.${i.type}`)}</td>
                        <td className="p-2">{i.title}</td>
                        <td className="flex gap-2 p-2">
                          <Button
                            variant="outline"
                            aria-label={`${t('msel.edit')}: ${i.title}`}
                            onClick={() => setEditing(i.id)}
                          >
                            {t('msel.edit')}
                          </Button>
                          <Button
                            variant="outline"
                            aria-label={`${t('msel.delete')}: ${i.title}`}
                            onClick={() => {
                              setList((prev) => prev.filter((x) => x.id !== i.id));
                              if (editing === i.id) setEditing(null);
                            }}
                          >
                            {t('msel.delete')}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {problems.length > 0 ? (
              <div role="alert" className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-800">
                <p className="font-semibold">{t('msel.problems')}</p>
                <ul className="list-disc pl-5">
                  {problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button
                disabled={saving || !dirty || problems.length > 0}
                onClick={() => void save()}
              >
                {saving ? t('msel.saving') : t('msel.save')}
              </Button>
              {dirty ? (
                <>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setList(JSON.parse(saved) as Inject[]);
                      setEditing(null);
                      setMessage(null);
                    }}
                  >
                    {t('msel.discard')}
                  </Button>
                  <span className="text-sm text-amber-700">{t('msel.unsaved')}</span>
                </>
              ) : null}
            </div>
          </>
        ) : null}
      </main>
    </>
  );
}
