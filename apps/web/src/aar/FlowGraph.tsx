import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AarSummary } from '@vyuha/shared';
import { Select } from '@/components/Select';
import { CHANNEL_COLORS, flowGraph, lossColor } from './chartData';

const SIZE = 380;

/** Who talked to whom, on which channel, and how much of it was lost on the way. */
export function FlowGraph({ summary }: { summary: AarSummary }) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<'TEXT' | 'ALL'>('TEXT');
  const graph = flowGraph(summary, kind, SIZE, (id) => t('aar.flow.unmanned', { id }));
  const pos = new Map(graph.nodes.map((n) => [n.id, n]));
  const edges = summary.analysis.flow.filter((e) => kind === 'ALL' || e.kind === 'TEXT');
  const label = (id: string): string => pos.get(id)?.label ?? id;

  return (
    <section
      className="rounded-lg border border-border bg-secondary p-4"
      aria-label={t('aar.flow.title')}
    >
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <h2 className="font-semibold">{t('aar.flow.title')}</h2>
        <Select
          label={t('aar.flow.kind')}
          value={kind}
          options={[
            { value: 'TEXT', label: t('aar.flow.text') },
            { value: 'ALL', label: t('aar.flow.all') },
          ]}
          onChange={(v) => setKind(v === 'ALL' ? 'ALL' : 'TEXT')}
        />
      </div>

      {graph.links.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{t('aar.flow.empty')}</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[auto_1fr]">
          <svg
            role="img"
            aria-label={t('aar.flow.graph')}
            viewBox={`0 0 ${SIZE} ${SIZE}`}
            className="mx-auto w-full max-w-[380px]"
          >
            <defs>
              <marker
                id="arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8" />
              </marker>
            </defs>
            {graph.links.map((l) => {
              const a = pos.get(l.from);
              const b = pos.get(l.to);
              if (!a || !b) return null;
              // Curve each direction to its own side so A->B and B->A do not overlap.
              const mx = (a.x + b.x) / 2;
              const my = (a.y + b.y) / 2;
              const dx = b.x - a.x;
              const dy = b.y - a.y;
              const len = Math.max(1, Math.hypot(dx, dy));
              const bend = 18;
              const cx = mx + (-dy / len) * bend;
              const cy = my + (dx / len) * bend;
              return (
                <g key={l.key} data-testid="flow-link">
                  <path
                    d={`M ${a.x} ${a.y} Q ${cx} ${cy} ${b.x} ${b.y}`}
                    fill="none"
                    stroke={lossColor(l.lostShare)}
                    strokeWidth={Math.min(8, 1 + Math.log2(l.total + 1))}
                    strokeOpacity={0.85}
                    markerEnd="url(#arrow)"
                  />
                  <text
                    x={cx}
                    y={cy - 3}
                    textAnchor="middle"
                    fontSize="9"
                    fill={CHANNEL_COLORS[l.channel as keyof typeof CHANNEL_COLORS] ?? '#0f172a'}
                  >
                    {l.channel} {l.total}
                  </text>
                </g>
              );
            })}
            {graph.nodes.map((n) => (
              <g key={n.id}>
                <circle
                  cx={n.x}
                  cy={n.y}
                  r={9}
                  fill={n.unmanned ? '#475569' : '#0369a1'}
                  stroke="#ffffff"
                  strokeWidth={1.5}
                />
                <text
                  x={n.x}
                  y={n.y + (n.y < SIZE / 2 ? -14 : 22)}
                  textAnchor="middle"
                  fontSize="10"
                  fill="#0f172a"
                >
                  {n.label}
                </text>
              </g>
            ))}
          </svg>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="p-1">{t('aar.flow.from')}</th>
                  <th className="p-1">{t('aar.flow.to')}</th>
                  <th className="p-1">{t('aar.flow.channel')}</th>
                  <th className="p-1 text-right">{t('aar.flow.sent')}</th>
                  <th className="p-1 text-right">{t('aar.flow.delivered')}</th>
                  <th className="p-1 text-right">{t('aar.flow.delayed')}</th>
                  <th className="p-1 text-right">{t('aar.flow.garbled')}</th>
                  <th className="p-1 text-right">{t('aar.flow.dropped')}</th>
                  <th className="p-1 text-right">{t('aar.flow.lost')}</th>
                </tr>
              </thead>
              <tbody>
                {edges.slice(0, 40).map((e) => {
                  const lost = e.outcomes.DROPPED + e.outcomes.CORRUPTED;
                  return (
                    <tr
                      key={`${e.kind}|${e.from}|${e.to}|${e.channel}`}
                      className="border-t border-border"
                    >
                      <td className="p-1">{label(e.from)}</td>
                      <td className="p-1">{label(e.to)}</td>
                      <td className="p-1">{t(`channels.${e.channel}`)}</td>
                      <td className="p-1 text-right">{e.total}</td>
                      <td className="p-1 text-right">{e.outcomes.DELIVERED}</td>
                      <td className="p-1 text-right">{e.outcomes.DELAYED}</td>
                      <td className="p-1 text-right">{e.outcomes.CORRUPTED}</td>
                      <td className="p-1 text-right">{e.outcomes.DROPPED}</td>
                      <td
                        className="p-1 text-right"
                        style={{ color: lossColor(lost / Math.max(1, e.total)) }}
                      >
                        {Math.round((lost / Math.max(1, e.total)) * 100)}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <p className="mt-2 text-xs text-muted-foreground">{t('aar.flow.legend')}</p>
    </section>
  );
}
