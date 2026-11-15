// Site locator (release 6): generalized from the south-polar-only map.
// - Any catalog site outside the south-polar region (latitude above -75 deg): a whole-Moon
//   simple cylindrical map is shown, with the polar map kept as a detail view for polar sites.
// - Only south-polar sites (the 60-day release): the polar stereographic map alone, as before.
// Positions are projected coordinates only; no terrain, albedo or imagery is drawn.

import { fmtLat, fmtLonEast } from "./data";
import { polarXY, surfaceDistanceKm } from "./sites";

export interface LocatorPoint {
  id: string;
  short: string;
  latitude_deg: number;
  longitude_deg_east: number;
  selected: boolean;
  active: boolean;
}

/** South-polar region for the map: the LOLA 75S polar products' extent. */
export const isSouthPolar = (lat: number) => lat <= -75;

/** East longitude in (-180, 180] for a map centred on the near side (0 deg E). */
export const lon180 = (lonEast: number) => {
  const l = ((lonEast % 360) + 360) % 360;
  return l > 180 ? l - 360 : l;
};

/** Approximate label box for 11 px semibold text (no DOM measurement in static rendering). */
const labelBox = (x: number, y: number, text: string, anchor: "start" | "end") => {
  const w = text.length * 6.4 + 2;
  return { x0: anchor === "start" ? x : x - w, x1: anchor === "start" ? x + w : x, y0: y - 9, y1: y + 2 };
};
type Box = ReturnType<typeof labelBox>;
const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

type Cand = { x: number; y: number; anchor: "start" | "end" };
type LabelPoint = { id: string; short: string; px: number; py: number; active: boolean; selected: boolean };

/**
 * Label placement for nearby points: every combination of four candidate positions is scored
 * (overlaps with other labels and fixed map text, leaving the map, then preference order), and
 * the best is kept. If labels still collide, lower-priority ones (catalog-only, then compared,
 * never the active site) are omitted; the point stays named in the map's accessible label.
 */
export function placeLabels(pts: LabelPoint[], W: number, obstacles: Box[] = []) {
  const order = [...pts].sort((a, b) => Number(b.active) - Number(a.active) || Number(b.selected) - Number(a.selected));
  const cands = (p: LabelPoint): Cand[] => {
    const right = p.px < W * 0.8;
    const s = right ? 1 : -1;
    const a = (k: number) => ((k > 0) === right ? "start" : "end") as Cand["anchor"];
    return [
      { x: p.px + 6 * s, y: p.py - 6, anchor: a(1) },
      { x: p.px - 6 * s, y: p.py - 6, anchor: a(-1) },
      { x: p.px + 6 * s, y: p.py + 13, anchor: a(1) },
      { x: p.px - 6 * s, y: p.py + 13, anchor: a(-1) },
    ];
  };
  const all = order.map(cands);
  const boxOf = (i: number, c: Cand) => labelBox(c.x, c.y, order[i].short, c.anchor);
  const cost = (pick: number[], use: boolean[]) => {
    let hits = 0, out = 0, pref = 0;
    const boxes = pick.map((k, i) => (use[i] ? boxOf(i, all[i][k]) : null));
    boxes.forEach((b, i) => {
      if (!b) return;
      pref += pick[i];
      if (b.x0 < 0 || b.x1 > W) out++;
      for (const o of obstacles) if (overlaps(b, o)) hits++;
      for (let j = 0; j < i; j++) if (boxes[j] && overlaps(b, boxes[j]!)) hits++;
    });
    return hits * 1000 + out * 100 + pref;
  };
  const use = order.map(() => true);
  let best: number[] = order.map(() => 0);
  const search = () => {
    const n = order.length;
    if (n > 6) return; // keep the preferred positions; collisions are resolved by omission below
    let bestCost = Infinity;
    const pick = new Array<number>(n).fill(0);
    const total = 4 ** n;
    for (let m = 0; m < total; m++) {
      for (let i = 0, r = m; i < n; i++, r = Math.floor(r / 4)) pick[i] = r % 4;
      const c = cost(pick, use);
      if (c < bestCost) { bestCost = c; best = [...pick]; }
    }
  };
  search();
  // still colliding: drop the lowest-priority colliding label and re-place the rest
  for (let i = order.length - 1; i > 0 && cost(best, use) >= 1000; i--) { use[i] = false; search(); }
  const out = new Map<string, Cand>();
  order.forEach((p, i) => { if (use[i]) out.set(p.id, all[i][best[i]]); });
  return out;
}

export function Locator({ points }: { points: LocatorPoint[] }) {
  const global = points.some((p) => !isSouthPolar(p.latitude_deg));
  const polar = points.filter((p) => isSouthPolar(p.latitude_deg));
  const active = points.find((p) => p.active);
  const others = points.filter((p) => p.selected && !p.active);
  return (
    <div className="locator-wrap" data-testid="locator" data-map={global ? "global" : "polar"}>
      {global && <GlobalMap points={points} />}
      {polar.length > 0 && <PolarMap points={polar} detail={global} />}
      {active && others.length > 0 && (
        <p className="muted small loc-dist" data-testid="distances">
          Surface distance from {active.short}:{" "}
          {others.map((o, k) => (
            <span key={o.id} className="num">{k ? "; " : ""}{o.short} ≈ {surfaceDistanceKm(active, o).toFixed(0)} km</span>
          ))}{" "}
          (great circle on the 1737.4 km sphere).
        </p>
      )}
    </div>
  );
}

function GlobalMap({ points }: { points: LocatorPoint[] }) {
  const W = 320;
  const H = 160;
  const pad = 14;
  const x = (lon: number) => pad + ((lon180(lon) + 180) / 360) * (W - 2 * pad);
  const y = (lat: number) => pad + ((90 - lat) / 180) * (H - 2 * pad);
  const mid = (W - 2 * pad) / 4;
  const gutter = 22; // room left of the map for the latitude labels
  // fixed map text the labels must not cover: the side captions and the longitude ticks
  const tick = (cx: number, cy: number, text: string): Box => ({ x0: cx - text.length * 2.7 - 1, x1: cx + text.length * 2.7 + 1, y0: cy - 8, y1: cy + 2 });
  const fixed = [
    tick(pad + 2 * mid, pad + 10, "near side (faces Earth)"),
    tick(pad + mid / 2, pad + 10, "far side"),
    tick(W - pad - mid / 2, pad + 10, "far side"),
    ...[-90, 0, 90].map((lon) => tick(x(lon), H - pad + 10, lon === 0 ? "0°" : "90°E")),
  ];
  const labels = placeLabels(points.map((p) => ({ ...p, px: x(p.longitude_deg_east), py: y(p.latitude_deg) })), W, fixed);
  return (
    <figure className="locator">
      <svg width={W + gutter} height={H + 14} viewBox={`${-gutter} 0 ${W + gutter} ${H + 14}`} role="img"
        aria-label={`Whole-Moon map: ${points.map((p) => `${p.short} at ${fmtLat(p.latitude_deg)}, ${fmtLonEast(p.longitude_deg_east)}`).join("; ")}`}>
        <rect x={pad} y={pad} width={W - 2 * pad} height={H - 2 * pad} className="loc-edge" />
        <rect x={pad + mid} y={pad} width={2 * mid} height={H - 2 * pad} className="loc-near" />
        {[-60, -30, 0, 30, 60].map((lat) => (
          <line key={lat} x1={pad} x2={W - pad} y1={y(lat)} y2={y(lat)} className={lat === 0 ? "loc-ring loc-eq" : "loc-ring"} />
        ))}
        {[-120, -60, 0, 60, 120].map((lon) => (
          <line key={lon} y1={pad} y2={H - pad} x1={x(lon)} x2={x(lon)} className="loc-ring" />
        ))}
        {[-60, 0, 60].map((lat) => (
          <text key={lat} x={pad - 3} y={y(lat)} dy="0.32em" textAnchor="end" className="loc-tick">{lat === 0 ? "0°" : `${Math.abs(lat)}°${lat > 0 ? "N" : "S"}`}</text>
        ))}
        {[-90, 0, 90].map((lon) => (
          <text key={lon} x={x(lon)} y={H - pad + 10} textAnchor="middle" className="loc-tick">{lon === 0 ? "0°" : lon > 0 ? `${lon}°E` : `${-lon}°W`}</text>
        ))}
        <text x={pad + 2 * mid} y={pad + 10} textAnchor="middle" className="loc-tick">near side (faces Earth)</text>
        <text x={pad + mid / 2} y={pad + 10} textAnchor="middle" className="loc-tick">far side</text>
        <text x={W - pad - mid / 2} y={pad + 10} textAnchor="middle" className="loc-tick">far side</text>
        {points.map((p) => {
          const l = labels.get(p.id);
          return (
            <g key={p.id} className={`loc-site${p.selected ? "" : " loc-off"}${p.active ? " loc-active" : ""}`} data-site={p.id}>
              <circle cx={x(p.longitude_deg_east)} cy={y(p.latitude_deg)} r={p.active ? 4.5 : 3.5} />
              {l && <text x={l.x} y={l.y} textAnchor={l.anchor}>{p.short}</text>}
            </g>
          );
        })}
      </svg>
      <figcaption className="muted small">
        Whole Moon, simple cylindrical projection: east longitude −180° to 180° (0° at the centre of the near side), latitude −90° to 90°.
        Positions only; no terrain is drawn. Faded points are in the catalog but not compared.
      </figcaption>
    </figure>
  );
}

function PolarMap({ points, detail }: { points: LocatorPoint[]; detail: boolean }) {
  const pts = points.map((p) => ({ ...p, ...polarXY(p.latitude_deg, p.longitude_deg_east) }));
  const maxR = Math.max(60, ...pts.map((p) => Math.hypot(p.x, p.y)));
  const extent = Math.ceil((maxR * 1.25) / 30) * 30; // km from the pole to the plot edge
  const size = detail ? 210 : 260;
  const c = size / 2;
  const k = (c - 30) / extent; // leave room outside the circle for longitude labels
  const ringsLat = [89, 88, 86, 84, 82, 80, 78].filter((lat) => 2 * 1737.4 * Math.tan(((90 - lat) * Math.PI) / 360) <= extent);
  return (
    <figure className="locator">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img"
        aria-label={`South polar map: ${pts.map((p) => `${p.short} at ${fmtLat(p.latitude_deg)}, ${fmtLonEast(p.longitude_deg_east)}`).join("; ")}`}>
        <circle cx={c} cy={c} r={extent * k} className="loc-edge" />
        {ringsLat.map((lat) => {
          const r = 2 * 1737.4 * Math.tan(((90 - lat) * Math.PI) / 360) * k;
          return (
            <g key={lat}>
              <circle cx={c} cy={c} r={r} className="loc-ring" />
              <text x={c + r * Math.SQRT1_2 + 2} y={c + r * Math.SQRT1_2 + 9} className="loc-tick">{lat}° S</text>
            </g>
          );
        })}
        {[0, 90, 180, 270].map((lon) => {
          const l = (lon * Math.PI) / 180;
          const r = extent * k;
          return (
            <g key={lon}>
              <line x1={c} y1={c} x2={c + r * Math.sin(l)} y2={c - r * Math.cos(l)} className="loc-ring" />
              <text x={c + (r + 14) * Math.sin(l)} y={c - (r + 10) * Math.cos(l)} className="loc-tick" textAnchor="middle" dy="0.32em">
                {lon === 0 ? "0°" : lon === 180 ? "180°" : `${lon}° E`}
              </text>
            </g>
          );
        })}
        <path d={`M${c - 4},${c}H${c + 4}M${c},${c - 4}V${c + 4}`} className="loc-pole" />
        {pts.map((p) => (
          <g key={p.id} className={`loc-site${p.selected ? "" : " loc-off"}${p.active ? " loc-active" : ""}`} data-site={p.id}>
            <circle cx={c + p.x * k} cy={c - p.y * k} r={4} />
            <text x={c + p.x * k + (p.x >= 0 ? 7 : -7)} y={c - p.y * k} dy="0.32em" textAnchor={p.x >= 0 ? "start" : "end"}>{p.short}</text>
          </g>
        ))}
      </svg>
      <figcaption className="muted small">
        {detail ? "South-polar detail: " : ""}south polar stereographic projection (sphere 1737.4 km, true scale at the pole; 0° longitude up, 90° E right), {extent} km
        from the pole to the edge. Positions are projected; labels are not to scale and no terrain is drawn.
      </figcaption>
    </figure>
  );
}
