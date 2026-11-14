import { useMemo, useState } from "react";
import type { Sample } from "./types";
import { type Body, elevation, elevationDomain, fmtDeg, fmtUtc, nearestIndex } from "./data";
import { type TimeScale, timeTicks, useTimePointer } from "./axis";

interface Props {
  samples: Sample[];
  times: number[];
  /** Inclusive sample-index range shown. */
  i0: number;
  i1: number;
  selected: number;
  onSelect: (index: number) => void;
  scale: TimeScale;
}

const BODIES: { key: Body; label: string }[] = [
  { key: "sun", label: "Sun" },
  { key: "earth", label: "Earth" },
];

export function ElevationChart({ samples, times, i0, i1, selected, onSelect, scale }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const narrow = scale.width < 560;
  const height = narrow ? 230 : 280;
  const top = 12;
  const bottom = 28;
  const ph = height - top - bottom;

  const [yLo, yHi] = useMemo(() => {
    const v: (number | null)[] = [];
    for (let i = i0; i <= i1; i++) v.push(samples[i].sun_elevation_deg, samples[i].earth_elevation_deg);
    return elevationDomain(v);
  }, [samples, i0, i1]);
  const y = (v: number) => top + ((yHi - v) / (yHi - yLo)) * ph;
  const x = scale.x;

  const paths: Record<Body, string> = { sun: "", earth: "" };
  for (const { key } of BODIES) {
    let pen = false;
    for (let i = i0; i <= i1; i++) {
      const v = elevation(samples[i], key);
      if (v === null) {
        pen = false; // gaps stay gaps; never drawn as zero
        continue;
      }
      paths[key] += `${pen ? "L" : "M"}${x(times[i]).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    }
  }

  const span = yHi - yLo;
  const yStep = span > 16 ? 4 : span > 8 ? 2 : 1;
  const yTicks: number[] = [];
  for (let v = Math.ceil(yLo / yStep) * yStep; v <= yHi; v += yStep) yTicks.push(v);

  const snap = (t: number) => Math.min(i1, Math.max(i0, nearestIndex(times, t)));
  const pointer = useTimePointer(scale, (t) => onSelect(snap(t)), (t) => setHover(t === null ? null : snap(t)));

  const sel = samples[selected];
  const hov = hover === null ? null : samples[hover];
  const hx = hover === null ? 0 : x(times[hover]);
  const plotRight = scale.left + scale.plotWidth;

  return (
    <div className="chart-wrap">
      <svg
        width={scale.width}
        height={height}
        viewBox={`0 0 ${scale.width} ${height}`}
        className="chart"
        role="img"
        aria-label={`Sun and Earth elevation, ${fmtUtc(times[i0])} to ${fmtUtc(times[i1])}. At ${fmtUtc(times[selected])}: Sun ${fmtDeg(sel.sun_elevation_deg)}, Earth ${fmtDeg(sel.earth_elevation_deg)}.`}
        {...pointer}
      >
        {yTicks.map((v) => (
          <g key={v}>
            <line className={v === 0 ? "horizon-line" : "grid"} x1={scale.left} x2={plotRight} y1={y(v)} y2={y(v)} />
            <text className="tick" x={scale.left - 8} y={y(v)} dy="0.32em" textAnchor="end">
              {fmtDeg(v, 0)}
            </text>
          </g>
        ))}
        <text className="horizon-label" x={scale.left + 6} y={y(0) - 5}>
          0° smooth horizon (terrain not included)
        </text>
        {timeTicks(scale).map((tk) => (
          <g key={tk.t}>
            {tk.major && <line className="grid grid-v" x1={x(tk.t)} x2={x(tk.t)} y1={top} y2={top + ph} />}
            <line className="axis-tick" x1={x(tk.t)} x2={x(tk.t)} y1={top + ph} y2={top + ph + (tk.label ? 5 : 3)} />
            {tk.label && (
              <text className="tick" x={x(tk.t)} y={top + ph + 18} textAnchor="middle">
                {tk.label}
              </text>
            )}
          </g>
        ))}
        <line className="axis" x1={scale.left} x2={plotRight} y1={top + ph} y2={top + ph} />
        {!narrow && (
          <text className="axis-title" x={12} y={top + ph / 2} dy="0.32em">
            Elevation
          </text>
        )}
        {hover !== null && hover !== selected && (
          <line className="crosshair" x1={hx} x2={hx} y1={top} y2={top + ph} />
        )}
        {BODIES.map(({ key }) => (
          <path key={key} className={`series series-${key}`} d={paths[key]} />
        ))}
        <line className="cursor" x1={x(times[selected])} x2={x(times[selected])} y1={top} y2={top + ph} />
        {BODIES.map(({ key }) => {
          const v = elevation(sel, key);
          return v === null ? null : <circle key={key} className={`dot dot-${key}`} cx={x(times[selected])} cy={y(v)} r={4.5} />;
        })}
      </svg>
      {hov && hover !== null && (
        <div
          className="tooltip"
          aria-hidden="true"
          style={hx > scale.width - 200 ? { left: hx - 12, top, transform: "translateX(-100%)" } : { left: hx + 12, top }}
        >
          <div className="tooltip-time">{fmtUtc(times[hover])}</div>
          {BODIES.map(({ key, label }) => (
            <div key={key} className="tooltip-row">
              <span className={`swatch swatch-${key}`} />
              {label}
              <span className="num">{fmtDeg(elevation(hov, key))}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
