import { Circle, Line, Polyline, Rect, Svg, Text, View } from '@react-pdf/renderer';

export interface Series {
  label: string;
  color: string;
  points: { x: number; y: number }[];
  /** Draw a dot at each point (calibration curve). */
  dots?: boolean;
  dashed?: boolean;
}

interface FrameProps {
  title: string;
  width?: number;
  height?: number;
  xLabel: string;
  yLabel: string;
  /** Fixed axis ranges; otherwise derived from the data. */
  xMax?: number;
  yMax?: number;
  empty: string;
}

const M = { left: 38, right: 10, top: 14, bottom: 26 };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  const n = v / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

function Frame({
  title,
  width = 500,
  height = 96,
  xLabel,
  yLabel,
  xMax,
  yMax,
  empty,
  series,
  bars,
}: FrameProps & { series?: Series[]; bars?: { x: number; value: number; color: string }[] }) {
  const all = [
    ...(series ?? []).flatMap((s) => s.points),
    ...(bars ?? []).map((b) => ({ x: b.x, y: b.value })),
  ];
  const xHi = xMax ?? Math.max(1, ...all.map((p) => p.x));
  const yHi = yMax ?? niceMax(Math.max(0, ...all.map((p) => p.y)));
  const w = width - M.left - M.right;
  const h = height - M.top - M.bottom;
  const px = (x: number): number => M.left + (x / xHi) * w;
  const py = (y: number): number => M.top + h - (y / yHi) * h;
  const ticks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <View style={{ marginBottom: 10 }} wrap={false}>
      <Text style={{ fontSize: 9, fontWeight: 700, marginBottom: 2 }}>{title}</Text>
      <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        {ticks.map((t) => (
          <Line
            key={t}
            x1={M.left}
            x2={M.left + w}
            y1={py(yHi * t)}
            y2={py(yHi * t)}
            stroke="#d4d4d8"
            strokeWidth={0.5}
          />
        ))}
        {ticks.map((t) => (
          <Text
            key={`y${t}`}
            x={M.left - 4}
            y={py(yHi * t) + 2}
            style={{ fontSize: 6 }}
            textAnchor="end"
            fill="#52525b"
          >
            {String(Math.round(yHi * t * 10) / 10)}
          </Text>
        ))}
        {ticks
          .filter((t, i) => i === 0 || Math.round(xHi * t) !== Math.round(xHi * ticks[i - 1]!))
          .map((t) => (
            <Text
              key={`x${t}`}
              x={px(xHi * t)}
              y={M.top + h + 9}
              style={{ fontSize: 6 }}
              textAnchor="middle"
              fill="#52525b"
            >
              {String(Math.round(xHi * t))}
            </Text>
          ))}
        <Line
          x1={M.left}
          x2={M.left}
          y1={M.top}
          y2={M.top + h}
          stroke="#52525b"
          strokeWidth={0.8}
        />
        <Line
          x1={M.left}
          x2={M.left + w}
          y1={M.top + h}
          y2={M.top + h}
          stroke="#52525b"
          strokeWidth={0.8}
        />
        <Text
          x={M.left + w / 2}
          y={height - 3}
          style={{ fontSize: 7 }}
          textAnchor="middle"
          fill="#27272a"
        >
          {xLabel}
        </Text>
        <Text x={M.left} y={8} style={{ fontSize: 7 }} fill="#27272a">
          {yLabel}
        </Text>
        {(bars ?? []).map((b, i) => {
          const bw = Math.max(1, Math.min(14, w / Math.max(1, (bars ?? []).length) - 2));
          return (
            <Rect
              key={i}
              x={px(b.x) - bw / 2}
              y={py(b.value)}
              width={bw}
              height={Math.max(0, M.top + h - py(b.value))}
              fill={b.color}
            />
          );
        })}
        {(series ?? []).map((s) => (
          <View key={s.label}>
            {s.points.length > 1 ? (
              <Polyline
                points={s.points.map((p) => `${px(p.x)},${py(p.y)}`).join(' ')}
                stroke={s.color}
                strokeWidth={1.2}
                fill="none"
                strokeDasharray={s.dashed ? '3 2' : undefined}
              />
            ) : null}
            {s.dots
              ? s.points.map((p, i) => (
                  <Circle key={i} cx={px(p.x)} cy={py(p.y)} r={2.2} fill={s.color} />
                ))
              : null}
          </View>
        ))}
        {all.length === 0 ? (
          <Text
            x={M.left + w / 2}
            y={M.top + h / 2}
            style={{ fontSize: 8 }}
            textAnchor="middle"
            fill="#71717a"
          >
            {empty}
          </Text>
        ) : null}
      </Svg>
      {(series ?? []).length > 0 ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 2 }}>
          {(series ?? []).map((s) => (
            <View key={s.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
              <View style={{ width: 8, height: 3, backgroundColor: s.color }} />
              <Text style={{ fontSize: 7 }}>{s.label}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

export function LineChartPdf(props: FrameProps & { series: Series[] }) {
  return <Frame {...props} />;
}

export function BarChartPdf(
  props: FrameProps & {
    bars: { x: number; value: number; color: string }[];
    legend?: { label: string; color: string }[];
  },
) {
  return (
    <View>
      <Frame {...props} />
      {props.legend && props.legend.length > 0 ? (
        <View
          style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: -6, marginBottom: 8 }}
        >
          {props.legend.map((l) => (
            <View key={l.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
              <View style={{ width: 6, height: 6, backgroundColor: l.color }} />
              <Text style={{ fontSize: 7 }}>{l.label}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}
