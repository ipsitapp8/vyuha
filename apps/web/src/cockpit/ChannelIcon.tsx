import { Footprints, Radio, RadioTower, Satellite, Waypoints } from 'lucide-react';
import type { Channel } from '@vyuha/shared';

const ICONS = {
  VHF: Radio,
  HF: RadioTower,
  SATCOM: Satellite,
  DATALINK: Waypoints,
  RUNNER: Footprints,
};

export function ChannelIcon({ channel, className }: { channel: Channel; className?: string }) {
  const Icon = ICONS[channel];
  return <Icon className={className ?? 'h-4 w-4'} aria-hidden="true" />;
}

/** Four-bar signal meter for a measured link quality (0..1). */
export function SignalBars({ value, label }: { value: number; label: string }) {
  const filled = value <= 0 ? 0 : Math.max(1, Math.ceil(value * 4));
  const colour = value < 0.25 ? 'bg-red-400' : value < 0.55 ? 'bg-amber-400' : 'bg-primary';
  return (
    <span
      role="img"
      aria-label={`${label}: ${Math.round(value * 100)}%`}
      className="flex h-4 items-end gap-0.5"
    >
      {[1, 2, 3, 4].map((bar) => (
        <span
          key={bar}
          className={`w-1.5 rounded-sm ${bar <= filled ? colour : 'bg-border'}`}
          style={{ height: `${bar * 25}%` }}
        />
      ))}
    </span>
  );
}
