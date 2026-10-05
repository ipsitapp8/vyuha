import { useState } from 'react';
import { Crosshair, Mountain, Move, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AreaBounds, LatLon, PerceivedStateDto, PlayerAction } from '@vyuha/shared';
import { Select } from '@/components/Select';
import { Button } from '@/components/ui/button';
import { clock } from '@/lib/format';
import { readTerrain3dPref, saveTerrain3dPref } from '@/lib/terrain3d';
import { CockpitMap } from './CockpitMap';
import type { Degradation } from './logic';
import type { ProbeMarker } from './probe';

export type Tool = 'move' | 'isr' | null;

interface Props {
  bounds: AreaBounds;
  scenarioId: string;
  perceived: PerceivedStateDto;
  picture: PerceivedStateDto;
  degradation: Degradation;
  frozen: boolean;
  paused: boolean;
  selectedContactId: string | null;
  onSelectContact: (id: string) => void;
  send: (a: PlayerAction) => Promise<boolean>;
  /** Set while a situation-awareness probe is being answered: map clicks place the answer's markers. */
  probe?: { markers: readonly ProbeMarker[]; hint: string; onPick: (p: LatLon) => void } | null;
  children?: React.ReactNode;
}

/** The map plus its tools (move / ISR), legend and the jamming / frozen-picture effects. */
export function MapStage({
  bounds,
  scenarioId,
  perceived,
  picture,
  degradation,
  frozen,
  paused,
  selectedContactId,
  onSelectContact,
  send,
  probe = null,
  children,
}: Props) {
  const { t } = useTranslation();
  const [tool, setTool] = useState<Tool>(null);
  const [unitId, setUnitId] = useState(perceived.self.unitId);
  const [offline, setOffline] = useState(false);
  const [terrain3d, setTerrain3d] = useState(readTerrain3dPref);
  const canCommandOthers = perceived.role === 'PL_CDR';
  const movable = [
    { value: perceived.self.unitId, label: perceived.self.name },
    ...(canCommandOthers
      ? picture.friendlies.map((f) => ({ value: f.unitId, label: f.name }))
      : []),
  ];
  const targetUnit = movable.find((m) => m.value === unitId) ?? movable[0];

  const onPick = (point: LatLon): void => {
    if (probe) return probe.onPick(point);
    const current = tool;
    setTool(null);
    if (current === 'move' && targetUnit) {
      void send({ type: 'MOVE_UNIT', unitId: targetUnit.value, destination: point });
    } else if (current === 'isr') {
      void send({ type: 'REQUEST_ISR', target: point });
    }
  };

  return (
    <div className={`relative h-full w-full ${frozen ? 'vy-frozen' : ''}`}>
      <CockpitMap
        bounds={bounds}
        scenarioId={scenarioId}
        perceived={perceived}
        picture={picture}
        selectedContactId={selectedContactId}
        onSelectContact={onSelectContact}
        pickMode={probe !== null || (tool !== null && !paused)}
        onPick={onPick}
        probeMarkers={probe?.markers ?? []}
        terrain3d={terrain3d}
        onTilesOffline={() => setOffline(true)}
      />

      {degradation.jamLevel > 0.05 ? (
        <div
          aria-hidden="true"
          className="vy-static pointer-events-none absolute inset-0"
          style={{ opacity: Math.min(0.45, degradation.jamLevel * 0.45) }}
        />
      ) : null}

      <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-col gap-2 p-2">
        <div className="pointer-events-auto flex flex-wrap items-center gap-2">
          {probe ? (
            <p role="status" className="rounded-md bg-black/75 px-2 py-1 text-sm text-white">
              {probe.hint}
            </p>
          ) : tool === null ? (
            <>
              <Button variant="secondary" disabled={paused} onClick={() => setTool('move')}>
                <Move className="mr-1 h-4 w-4" aria-hidden="true" />
                {t('cockpit.map.moveTool')}
              </Button>
              <Button variant="secondary" disabled={paused} onClick={() => setTool('isr')}>
                <Crosshair className="mr-1 h-4 w-4" aria-hidden="true" />
                {t('cockpit.map.isrTool')}
              </Button>
            </>
          ) : (
            <>
              {tool === 'move' && movable.length > 1 ? (
                <Select
                  label={t('cockpit.map.unitToMove')}
                  value={targetUnit?.value ?? ''}
                  options={movable}
                  onChange={setUnitId}
                />
              ) : null}
              <p role="status" className="rounded-md bg-black/75 px-2 py-1 text-sm">
                {tool === 'move'
                  ? t('cockpit.map.moveHint', { unit: targetUnit?.label ?? '' })
                  : t('cockpit.map.isrHint')}
              </p>
              <Button variant="secondary" onClick={() => setTool(null)}>
                <X className="mr-1 h-4 w-4" aria-hidden="true" />
                {t('cockpit.map.cancelTool')}
              </Button>
            </>
          )}
        </div>

        <div className="pointer-events-none flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            className="pointer-events-auto"
            aria-pressed={terrain3d}
            onClick={() => {
              saveTerrain3dPref(!terrain3d);
              setTerrain3d(!terrain3d);
            }}
          >
            <Mountain className="mr-1 h-4 w-4" aria-hidden="true" />
            {t('map.terrain3d')}
          </Button>
          {degradation.jammed ? (
            <span
              role="status"
              className="rounded bg-red-600 px-2 py-0.5 text-xs font-bold tracking-widest"
            >
              {t('cockpit.degradation.jammed')}
            </span>
          ) : null}
          {frozen ? (
            <span
              role="status"
              className="rounded bg-amber-500 px-2 py-1 text-xs font-bold text-black"
            >
              {t('cockpit.map.frozen', { time: clock(picture.tick) })}
            </span>
          ) : null}
          {offline ? (
            <span role="status" className="rounded bg-black/75 px-2 py-0.5 text-xs">
              {t('cockpit.map.tilesOffline')}
            </span>
          ) : null}
        </div>
        <div className="pointer-events-auto max-w-md">{children}</div>
      </div>

      <ul className="pointer-events-none absolute bottom-6 left-2 hidden gap-x-3 rounded bg-black/70 p-2 text-xs sm:flex sm:flex-col">
        <li className="flex items-center gap-2">
          <span
            className="inline-block h-3 w-3 rounded-full border-2 border-white bg-sky-400"
            aria-hidden="true"
          />
          {t('cockpit.map.legendYou')}
        </li>
        <li className="flex items-center gap-2">
          <span
            className="inline-block h-3 w-3 rounded-full border-2 border-blue-400"
            aria-hidden="true"
          />
          {t('cockpit.map.legendFriendly')}
        </li>
        <li className="flex items-center gap-2">
          <span
            className="inline-block h-3 w-3 rotate-45 border-2 border-red-700 bg-red-500/50"
            aria-hidden="true"
          />
          {t('cockpit.map.legendContact')}
        </li>
        <li className="flex items-center gap-2">
          <span
            className="inline-block h-3 w-3 rotate-45 border-2 border-dashed border-red-700"
            aria-hidden="true"
          />
          {t('cockpit.map.legendLow')}
        </li>
      </ul>
    </div>
  );
}
