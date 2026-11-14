import { useEffect, useMemo, useRef, useState } from "react";
import type { Sample } from "./types";
import { type Body, elevation, elevationDomain, fmtDeg, fmtUtc, nearestIndex } from "./data";

interface Props {
  samples: Sample[];
  times: number[];
  selected: number;
  onSelect: (i: number) => void;
}

const BODIES: { key: Body; label: string }[] = [
  { key: "sun", label: "Sun" },
  { key: "earth", label: "Earth" },
];
const HOUR = 3_600_000;

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(720);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export function ElevationChart({ samples, times, selected, onSelect }: Props) {
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const dragging = useRef(false);

  const narrow = width < 560;
  const height = narrow ? 260 : 320;
  const m = { top: 14, right: narrow ? 52 : 64, bottom: 34, left: 44 };
  const pw = width - m.left - m.right;
  const ph = height - m.top - m.bottom;

  const t0 = times[0];
  const t1 = times[times.length - 1];
  const [yLo, yHi] = useMemo(
    () => elevationDomain(samples.flatMap((s) => [s.sun_elevation_deg, s.earth_elevation_deg])),
    [samples],
  );
  const x = (t: number) => m.left + ((t - t0) / (t1 - t0)) * pw;
  const y = (v: number) => m.top + ((yHi - v) / (yHi - yLo)) * ph;

  // 145 points per series: cheap enough to rebuild on every render.
  const paths: Record<Body, string> = { sun: "", earth: "" };
  for (const { key } of BODIES) {
    let pen = false;
    samples.forEach((s, i) => {
      const v = elevation(s, key);
      if (v === null) {
        pen = false; // gaps stay gaps; never drawn as zero
        return;
      }
      paths[key] += `${pen ? "L" : "M"}${x(times[i]).toFixed(2)},${y(v).toFixed(2)}`;
      pen = true;
    });
  }

  const yStep = yHi - yLo > 8 ? 2 : 1;
  const yTicks: number[] = [];
  for (let v = yLo; v <= yHi; v += yStep) yTicks.push(v);
  const xStep = (narrow ? 6 : 3) * HOUR;
  const xTicks: number[] = [];
  for (let t = t0; t <= t1; t += xStep) xTicks.push(t);

  // Direct labels at the right end, nudged apart if they would collide.
  const last = samples[samples.length - 1];
  const ends = BODIES.map((b) => ({ ...b, v: elevation(last, b.key) }))
    .filter((e): e is { key: Body; label: string; v: number } => e.v !== null)
    .map((e) => ({ ...e, py: y(e.v) }))
    .sort((a, b) => a.py - b.py);
  for (let i = 1; i < ends.length; i++) {
    if (ends[i].py - ends[i - 1].py < 14) ends[i].py = ends[i - 1].py + 14;
  }

  const indexAt = (clientX: number, el: Element) => {
    const r = el.getBoundingClientRect();
    const px = ((clientX - r.left) / r.width) * width;
    const t = t0 + ((px - m.left) / pw) * (t1 - t0);
    return nearestIndex(times, t);
  };

  const sel = samples[selected];
  const hov = hover === null ? null : samples[hover];
  const hoverLeft = hover === null ? 0 : x(times[hover]);

  return (
    <div className="chart-wrap" ref={wrapRef}>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Sun and Earth elevation from ${fmtUtc(t0)} to ${fmtUtc(t1)}. Selected ${fmtUtc(times[selected])}: Sun ${fmtDeg(sel.sun_elevation_deg)}, Earth ${fmtDeg(sel.earth_elevation_deg)}.`}
        className="chart"
        onPointerDown={(e) => {
          dragging.current = true;
          (e.currentTarget as Element).setPointerCapture(e.pointerId);
          onSelect(indexAt(e.clientX, e.currentTarget));
        }}
        onPointerMove={(e) => {
          const i = indexAt(e.clientX, e.currentTarget);
          setHover(i);
          if (dragging.current) onSelect(i);
        }}
        onPointerUp={() => (dragging.current = false)}
        onPointerCancel={() => (dragging.current = false)}
        onPointerLeave={() => setHover(null)}
      >
        {/* grid + y axis */}
        {yTicks.map((v) => (
          <g key={v}>
            <line className={v === 0 ? "horizon-line" : "grid"} x1={m.left} x2={m.left + pw} y1={y(v)} y2={y(v)} />
            <text className="tick" x={m.left - 8} y={y(v)} dy="0.32em" textAnchor="end">
              {fmtDeg(v, 0)}
            </text>
          </g>
        ))}
        <text className="horizon-label" x={m.left + 6} y={y(0) - 6}>
          0° smooth horizon (terrain not modeled)
        </text>
        {/* x axis */}
        {xTicks.map((t) => (
          <g key={t}>
            <line className="axis-tick" x1={x(t)} x2={x(t)} y1={m.top + ph} y2={m.top + ph + 4} />
            <text className="tick" x={x(t)} y={m.top + ph + 18} textAnchor="middle">
              {new Date(t).toISOString().slice(11, 16)}
            </text>
          </g>
        ))}
        <line className="axis" x1={m.left} x2={m.left + pw} y1={m.top + ph} y2={m.top + ph} />

        {/* hover crosshair (behind data) */}
        {hover !== null && hover !== selected && (
          <line className="crosshair" x1={hoverLeft} x2={hoverLeft} y1={m.top} y2={m.top + ph} />
        )}

        {/* series */}
        {BODIES.map(({ key }) => (
          <path key={key} className={`series series-${key}`} d={paths[key]} />
        ))}

        {/* selected-time cursor */}
        <line className="cursor" x1={x(times[selected])} x2={x(times[selected])} y1={m.top} y2={m.top + ph} />
        {BODIES.map(({ key }) => {
          const v = elevation(sel, key);
          return v === null ? null : (
            <circle key={key} className={`dot dot-${key}`} cx={x(times[selected])} cy={y(v)} r={5} />
          );
        })}

        {/* direct labels */}
        {ends.map((e) => (
          <text key={e.key} className="direct-label" x={m.left + pw + 8} y={e.py} dy="0.32em">
            {e.label}
          </text>
        ))}
      </svg>

      {hov && hover !== null && (
        <div
          className="tooltip"
          // Beside the crosshair (never centred on it) so the hovered points stay visible.
          style={
            hoverLeft > width - 190
              ? { left: hoverLeft - 12, top: m.top, transform: "translateX(-100%)" }
              : { left: hoverLeft + 12, top: m.top }
          }
          aria-hidden="true"
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
