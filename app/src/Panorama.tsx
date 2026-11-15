import { useMemo, useState } from "react";
import { compass, fmtDeg, fmtUtc } from "./data";
import { horizonAt, norm360 } from "./horizon";
import type { Horizon, HorizonMode, Sample, TerrainHorizonBlock } from "./types";

interface Props {
  width: number;
  mode: HorizonMode;
  horizon: Horizon;
  terrain: TerrainHorizonBlock | null;
  samples: Sample[];
  /** Inclusive index range for the faint Sun/Earth tracks (the plotted mission windows). */
  i0: number;
  i1: number;
  selected: number;
  selectedTime: number;
  /** Azimuth shown in the middle of the panorama (multiple of 45; default 0 = north). */
  centerAz?: number;
}

type Body = "sun" | "earth";
const BODIES: { key: Body; label: string }[] = [
  { key: "sun", label: "Sun" },
  { key: "earth", label: "Earth" },
];

// The x axis runs 360 degrees with centerAz in the middle (default north: S -> W -> N -> E -> S).
// Sites choose a centre near their Earth direction so Earth is not split at the panorama's edges.
const TICK_NAMES: Record<number, string> = { 0: "N", 45: "NE", 90: "E", 135: "SE", 180: "S", 225: "SW", 270: "W", 315: "NW" };

export function Panorama({ width, mode, horizon, terrain, samples, i0, i1, selected, selectedTime, centerAz = 0 }: Props) {
  const toU = (az: number) => norm360(az - centerAz + 180); // 0..360, 180 = centerAz
  const fromU = (u: number) => norm360(u + centerAz - 180);
  const TICKS = Array.from({ length: 9 }, (_, k) => norm360(centerAz + 180 + 45 * k));
  const [hoverU, setHoverU] = useState<number | null>(null);
  const narrow = width < 560;
  const left = narrow ? 40 : 52;
  const right = 14;
  const top = 14;
  const bottom = 40;
  const height = narrow ? 230 : 280;
  const pw = Math.max(1, width - left - right);
  const ph = height - top - bottom;

  // Fixed vertical domain for the dataset so the view does not jump as time moves.
  const [yLo, yHi] = useMemo(() => {
    let hiV = 0;
    for (const s of samples) {
      for (const v of [s.sun_elevation_deg, s.earth_elevation_deg]) if (v !== null && v > hiV) hiV = v;
    }
    const hv = horizon.elevation_deg.filter((v): v is number => v !== null);
    const lo = Math.floor(Math.min(-2, ...hv) - 1);
    const hi = Math.ceil(Math.max(hiV, ...hv) + 0.5);
    return [lo, hi];
  }, [samples, horizon]);
  const x = (u: number) => left + (u / 360) * pw;
  const y = (v: number) => top + ((yHi - v) / (yHi - yLo)) * ph;
  const yBase = top + ph;

  // Silhouette: one closed fill per run of known values, starting at u = 0 (south).
  const { fills, ridge, unknown } = useMemo(() => {
    const pts = horizon.azimuth_deg.map((a, k) => ({ u: toU(a), e: horizon.elevation_deg[k] })).sort((p, q) => p.u - q.u);
    if (pts.length) pts.push({ u: pts[0].u + 360, e: pts[0].e }); // close the seam at the right edge
    if (pts.length && pts[0].u > 0) pts.unshift({ u: 0, e: horizonAt(horizon, fromU(0)) });
    const runs: { u: number; e: number }[][] = [];
    const gaps: [number, number][] = [];
    let cur: { u: number; e: number }[] = [];
    let gapStart: number | null = null;
    for (const p of pts) {
      if (p.e === null) {
        if (cur.length) runs.push(cur);
        cur = [];
        if (gapStart === null) gapStart = p.u;
      } else {
        if (gapStart !== null) {
          gaps.push([gapStart, p.u]);
          gapStart = null;
        }
        cur.push({ u: p.u, e: p.e });
      }
    }
    if (cur.length) runs.push(cur);
    if (gapStart !== null) gaps.push([gapStart, 360]);
    const line = (r: { u: number; e: number }[]) => r.map((p, k) => `${k ? "L" : "M"}${x(p.u).toFixed(1)},${y(p.e).toFixed(1)}`).join("");
    return {
      fills: runs.map((r) => `${line(r)}L${x(r[r.length - 1].u).toFixed(1)},${yBase}L${x(r[0].u).toFixed(1)},${yBase}Z`),
      ridge: runs.map(line),
      unknown: gaps,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [horizon, width, yLo, yHi, centerAz]);

  // Faint tracks of each body over the plotted windows (broken at the S seam).
  const tracks = useMemo(() => {
    const out: Record<Body, string> = { sun: "", earth: "" };
    const stride = Math.max(1, Math.floor((i1 - i0) / 1500));
    for (const { key } of BODIES) {
      let prevU: number | null = null;
      for (let i = i0; i <= i1; i += stride) {
        const s = samples[i];
        const az = key === "sun" ? s.sun_azimuth_deg : s.earth_azimuth_deg;
        const el = key === "sun" ? s.sun_elevation_deg : s.earth_elevation_deg;
        if (az === null || el === null) {
          prevU = null;
          continue;
        }
        const u = toU(az);
        const jump = prevU === null || Math.abs(u - prevU) > 180;
        const ey = Math.min(yBase, Math.max(top, y(el)));
        out[key] += `${jump ? "M" : "L"}${x(u).toFixed(1)},${ey.toFixed(1)}`;
        prevU = u;
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [samples, i0, i1, width, yLo, yHi, centerAz]);

  const s = samples[selected];
  const markers = BODIES.map(({ key, label }) => {
    const az = key === "sun" ? s.sun_azimuth_deg : s.earth_azimuth_deg;
    const el = key === "sun" ? s.sun_elevation_deg : s.earth_elevation_deg;
    if (az === null || el === null) return { key, label, az, el, hz: null, state: "unknown" as const };
    const hz = horizonAt(horizon, az);
    const state = hz === null ? ("unknown" as const) : el > hz ? ("above" as const) : ("below" as const);
    return { key, label, az, el, hz, state };
  });

  const blockedWord = mode === "terrain" ? "hidden by terrain" : "below the 0° horizon";
  const markerText = (m: (typeof markers)[number]) => {
    if (m.az === null || m.el === null) return `${m.label}: position unavailable`;
    if (m.state === "unknown") return `${m.label}: horizon unknown in this direction`;
    const d = m.el - (m.hz as number);
    return m.state === "above"
      ? `${m.label} visible, ${fmtDeg(Math.abs(d), 2)} above the ${mode === "terrain" ? "skyline" : "0° line"}`
      : `${m.label} ${blockedWord}, ${fmtDeg(Math.abs(d), 2)} below the ${mode === "terrain" ? "skyline" : "0° line"}`;
  };

  // Label placement: right of the marker unless near the right edge; separate overlapping labels.
  const placed = markers.map((m) => {
    if (m.az === null || m.el === null) return null;
    const mx = x(toU(m.az));
    const below = m.el < yLo;
    const above = m.el > yHi;
    const my = below ? yBase - 6 : above ? top + 6 : y(m.el);
    const toLeft = mx > left + pw - 150;
    return { m, mx, my, below, above, lx: toLeft ? mx - 10 : mx + 10, ly: my - 8, anchor: toLeft ? "end" : "start" };
  });
  // Two-line labels (~26 px tall) must stay inside the plot, clear of the axis labels.
  const lyMin = top + 12;
  const lyMax = yBase - 20;
  for (const p of placed) if (p) p.ly = Math.min(lyMax, Math.max(lyMin, p.ly));
  if (placed[0] && placed[1] && Math.abs(placed[0].ly - placed[1].ly) < 28 && Math.abs(placed[0].mx - placed[1].mx) < 170) {
    const up = placed[0].ly - 30;
    placed[1].ly = up >= lyMin ? up : Math.min(lyMax, placed[0].ly + 30);
    if (Math.abs(placed[0].ly - placed[1].ly) < 28) placed[0].ly = Math.max(lyMin, placed[1].ly - 30);
  }

  // Hover readout for the skyline
  const hov = (() => {
    if (hoverU === null) return null;
    const az = fromU(hoverU);
    const hz = horizonAt(horizon, az);
    let detail: string | null = null;
    if (terrain && mode === "terrain") {
      const step = 360 / horizon.azimuth_deg.length;
      const k = Math.round(az / step) % horizon.azimuth_deg.length;
      const sp = terrain.setting_points;
      const d = sp.distance_km[k];
      const pi = sp.product_index[k];
      const shots = sp.shot_count[k];
      if (d !== null) {
        detail = `set by terrain ${d < 10 ? d.toFixed(2) : d.toFixed(1)} km away (${pi === null ? "?" : sp.products[pi]}; ${
          shots === null ? "shot count n/a" : shots === 0 ? "0 LOLA shots in that pixel: interpolated" : `${shots} LOLA shot${shots === 1 ? "" : "s"} in that pixel`
        })`;
      }
    }
    return { az, hz, detail };
  })();

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * width;
    const u = ((px - left) / pw) * 360;
    setHoverU(u >= 0 && u <= 360 ? u : null);
  };

  const yStep = yHi - yLo > 10 ? 2 : 1;
  const yTicks: number[] = [];
  for (let v = Math.ceil(yLo / yStep) * yStep; v <= yHi; v += yStep) yTicks.push(v);
  // pixels per degree vertically / horizontally
  const exaggeration = ph / (yHi - yLo) / (pw / 360);

  return (
    <div className="panorama-wrap">
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="panorama"
        role="img"
        aria-label={`Horizon panorama (${mode} horizon) at ${fmtUtc(selectedTime)}. ${markers.map(markerText).join(". ")}.`}
        onPointerMove={onMove}
        onPointerLeave={() => setHoverU(null)}
      >
        <defs>
          <pattern id="pano-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" className="hatch-bg" />
            <line x1="0" y1="0" x2="0" y2="6" className="hatch-line" />
          </pattern>
        </defs>
        {yTicks.map((v) => (
          <g key={v}>
            <line className="grid" x1={left} x2={left + pw} y1={y(v)} y2={y(v)} />
            <text className="tick" x={left - 6} y={y(v)} dy="0.32em" textAnchor="end">
              {fmtDeg(v, 0)}
            </text>
          </g>
        ))}
        {TICKS.map((a, k) => {
          const u = k === TICKS.length - 1 ? 360 : toU(a);
          return (
            <g key={k}>
              <line className="grid grid-v" x1={x(u)} x2={x(u)} y1={top} y2={yBase} />
              <text className={`tick${a % 90 === 0 ? " tick-major" : ""}`} x={x(u)} y={yBase + 15} textAnchor="middle">
                {narrow && a % 90 !== 0 ? "" : TICK_NAMES[a]}
              </text>
              {!narrow && (
                <text className="tick tick-sub" x={x(u)} y={yBase + 28} textAnchor="middle">
                  {a}°
                </text>
              )}
            </g>
          );
        })}
        {fills.map((d, k) => (
          <path key={k} className={`terrain-fill terrain-${mode}`} d={d} />
        ))}
        {unknown.map(([u0, u1], k) => (
          <rect key={k} className="terrain-unknown" x={x(u0)} y={top} width={Math.max(1, x(u1) - x(u0))} height={ph}>
            <title>Horizon unknown here (terrain data does not reach far enough). Not treated as clear.</title>
          </rect>
        ))}
        {ridge.map((d, k) => (
          <path key={k} className={`terrain-ridge terrain-${mode}`} d={d} />
        ))}
        {mode === "terrain" && <line className="zero-line" x1={left} x2={left + pw} y1={y(0)} y2={y(0)} />}
        {mode === "terrain" && !narrow && (
          <text className="zero-label" x={left + 4} y={y(0) - 4}>
            0° (smooth-horizon comparison)
          </text>
        )}
        {BODIES.map(({ key }) => (
          <path key={key} className={`track track-${key}`} d={tracks[key]} />
        ))}
        {hoverU !== null && <line className="crosshair" x1={x(hoverU)} x2={x(hoverU)} y1={top} y2={yBase} />}
        {placed.map((p) => {
          if (!p) return null;
          const { m, mx, my, below, above } = p;
          const cls = `marker marker-${m.key} marker-${m.state}`;
          return (
            <g key={m.key} className={cls}>
              {below || above ? (
                <path
                  d={below ? `M${mx - 6},${my - 5}L${mx + 6},${my - 5}L${mx},${my + 4}Z` : `M${mx - 6},${my + 5}L${mx + 6},${my + 5}L${mx},${my - 4}Z`}
                  className="marker-shape"
                />
              ) : (
                <circle cx={mx} cy={my} r={m.key === "sun" ? 6 : 5.5} className="marker-shape" />
              )}
            </g>
          );
        })}
        {placed.map((p) => {
          if (!p) return null;
          const { m, lx, ly, anchor, below, above } = p;
          const d = m.hz === null || m.el === null ? null : m.el - m.hz;
          const line2 =
            m.state === "unknown"
              ? "horizon unknown here"
              : m.state === "above"
                ? `visible · ${fmtDeg(d, 2)} vs skyline`
                : `${mode === "terrain" ? "hidden by terrain" : "below horizon"} · ${fmtDeg(d, 2)}`;
          return (
            <text key={m.key} className="marker-label" x={lx} y={ly} textAnchor={anchor as "start" | "end"}>
              <tspan className="marker-name">
                {m.label} {fmtDeg(m.el, 2)}
                {below ? " ▼ below view" : above ? " ▲ above view" : ""}
              </tspan>
              <tspan x={lx} dy="1.25em" className="marker-sub">
                {line2}
              </tspan>
            </text>
          );
        })}
        <line className="axis" x1={left} x2={left + pw} y1={yBase} y2={yBase} />
      </svg>
      {hov && (
        <div
          className="tooltip"
          aria-hidden="true"
          style={x(hoverU as number) > width - 260 ? { left: x(hoverU as number) - 12, top, transform: "translateX(-100%)" } : { left: x(hoverU as number) + 12, top }}
        >
          <div className="tooltip-time">
            Azimuth {fmtDeg(hov.az, 1)} {compass(hov.az)}
          </div>
          <div>
            {mode === "terrain" ? "Terrain horizon" : "Smooth horizon"}: <span className="num">{hov.hz === null ? "unknown" : fmtDeg(hov.hz, 2)}</span>
          </div>
          {hov.detail && <div className="muted">{hov.detail}</div>}
        </div>
      )}
      <ul className="pano-summary" aria-live="polite">
        {markers.map((m) => (
          <li key={m.key} data-body={m.key} data-state={m.state}>
            <span className={`swatch swatch-${m.key}`} aria-hidden="true" /> {markerText(m)}
            {m.az !== null && m.el !== null && (
              <span className="muted">
                {" "}
                (az {fmtDeg(m.az, 1)} {compass(m.az)}, elevation {fmtDeg(m.el, 2)}, {mode} horizon there {fmtDeg(m.hz, 2)})
              </span>
            )}
          </li>
        ))}
      </ul>
      <p className="muted small">
        Horizontal axis: azimuth ({TICK_NAMES[norm360(centerAz + 180)]} at both edges, {TICK_NAMES[norm360(centerAz)]} in the middle). Vertical axis: elevation angle, stretched about{" "}
        {Math.round(exaggeration)}× relative to azimuth. Markers are the body centers at the selected time; hollow markers are
        below the {mode === "terrain" ? "skyline" : "0° line"}, and arrows mark bodies outside the view. Faint lines are each
        body’s path through the plotted windows. Timeline states use the 10-minute midpoint rule, so near a crossing the
        marker and the timeline may differ by one step.
      </p>
    </div>
  );
}
