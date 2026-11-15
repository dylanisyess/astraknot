// Terrain hazard screening (milestone 5C): DEM-derived slope assets from pipeline/slope.py.
//
// What this module may and may not do:
// - It reads a per-site screening asset (slope of each 20 m LDEM cell within 500 m of the
//   modeled observer) and classifies cells against an illustrative threshold.
// - It never touches visibility, the observer, the Sun/Earth status or mission metrics.
//   A terrain inspection point only reads a slope value; it is not a modeled site.
// - Missing or invalid cells are reported as "no slope data", never as flat ground.

import type { SiteData } from "../types";

export const SLOPE_ASSET_VERSION = "slope-1";
export const R_REF_M = 1737400;
export const DEFAULT_THRESHOLD_DEG = 15;
export const THRESHOLD_MIN = 1;
export const THRESHOLD_MAX = 45;
/** Fixed legend range for both sites (never rescaled per site). */
export const LEGEND_MAX_DEG = 30;
/** Restrained sequential palette (light to dark violet); values above the last stop clamp. */
export const SLOPE_STOPS: { deg: number; color: string }[] = [
  { deg: 0, color: "#f2f0f7" },
  { deg: 7.5, color: "#cbc9e2" },
  { deg: 15, color: "#9e9ac8" },
  { deg: 22.5, color: "#756bb1" },
  { deg: 30, color: "#54278f" },
];
/** Strong contrasting color for threshold exceedances (not used for anything else). */
export const EXCEED_COLOR = "#ff3d8b";
/** Overlay opacity over the shaded surface; colors are applied unlit (after lighting and tone mapping). */
export const OVERLAY_ALPHA = 0.9;

export type TerrainLayer = "surface" | "slope" | "exceed";
export const LAYER_LABEL: Record<TerrainLayer, string> = { surface: "Surface", slope: "Slope", exceed: "Above threshold" };

export const SCREENING_NAME = "Terrain hazard screening";
export const SCREENING_PURPOSE = "Highlights steep terrain at the DEM’s measurement scale.";
export const THRESHOLD_NOTE = "Illustrative screening setting, not a validated lander capability or universal safety limit.";
export const SCOPE_NOTE =
  "Screens terrain steepness only. It does not identify individual boulders, unresolved small craters, bearing strength or overall landing safety.";

export interface SlopeAsset {
  asset_version: string;
  is_screening_asset: boolean;
  site: { id: string; name: string; latitude_deg: number; longitude_deg_east: number; horizons_site_altitude_km: number };
  observer: { observer_radius_m: number };
  source_dem: { product: string; sha256: string; map_scale_m: number; anchor_pixel_1based: [number, number]; counts_product: string };
  method: { name: string; neighbourhood: string; baseline_m: number; neighbourhood_extent_m: number; cell_ground_m: number; scale_note: string; percentiles: string; exceedance: string; area_weighting: string };
  footprint: { radius_m: number; cells_in_footprint: number; cells_valid: number; cells_invalid: number; valid_fraction: number | null };
  grid: {
    nx: number;
    ny: number;
    state: number[];
    slope_centideg: (number | null)[];
    local_to_cell: { a: [number, number, number]; b: [number, number, number]; max_residual_cells: number };
    check_points: { cell: [number, number]; local_xyz: [number, number, number] }[];
  };
  observer_cell: { cell: [number, number]; slope_deg: number | null };
  stats: { median_deg: number | null; p95_deg: number | null; max_deg: number | null; min_deg: number | null };
  default_threshold_deg: number;
  shot_quality: { fraction_cells_with_lola_shot: number | null; cells_with_no_shot_in_3x3: number | null };
  rings: { radius_m: number; is_analysis_boundary: boolean; points: [number, number, number][] }[];
  reproduce: string;
}

/** Why an asset cannot be used for this site, or null. */
export function slopeAssetProblem(a: unknown, site: SiteData): string | null {
  const x = a as SlopeAsset;
  if (!x || typeof x !== "object") return "not an object";
  if (x.asset_version !== SLOPE_ASSET_VERSION || x.is_screening_asset !== true) return `unexpected asset version ${String(x.asset_version)}`;
  const s = site.site;
  if (x.site?.id !== s.id) return `asset is for ${String(x.site?.id)}, not ${s.id}`;
  if (x.site.latitude_deg !== s.latitude_deg || x.site.longitude_deg_east !== s.longitude_deg_east || x.site.horizons_site_altitude_km !== s.horizons_site_altitude_km)
    return "asset coordinates or altitude differ from the site export";
  const r = site.terrain_horizon?.observer?.observer_radius_m;
  if (r !== undefined && Math.abs(x.observer.observer_radius_m - r) > 1e-6) return "asset observer differs from the site export";
  const g = x.grid;
  const n = g?.nx * g?.ny;
  if (!Number.isInteger(n) || n <= 0 || g.state.length !== n || g.slope_centideg.length !== n) return "grid size mismatch";
  for (let k = 0; k < n; k++) {
    const st = g.state[k];
    const v = g.slope_centideg[k];
    if (st !== 0 && st !== 1 && st !== 2) return "unknown cell state";
    if ((st === 1) !== (typeof v === "number" && Number.isInteger(v) && v >= 0)) return "slope values do not match cell states";
  }
  if (!(x.footprint?.radius_m > 0)) return "missing analysis radius";
  return null;
}

// ------------------------------------------------------------------ statistics

/** Threshold in the stored 0.01° units (exceedance is strictly greater; equal is not). */
export const thresholdCentideg = (deg: number) => Math.round(deg * 100);
export const clampThreshold = (deg: number) => Math.min(THRESHOLD_MAX, Math.max(THRESHOLD_MIN, Math.round(deg * 10) / 10));
/** "15°", "15.5°". */
export const fmtThreshold = (deg: number) => `${Number(deg.toFixed(1))}°`;

/** Value at rank ceil(p/100 * n) (1-based) of an ascending list: the pipeline's definition. */
export function nearestRank(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const k = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(sorted.length, k) - 1];
}

export interface SlopeSummary {
  radiusM: number;
  cellsInFootprint: number;
  cellsValid: number;
  cellsInvalid: number;
  /** Valid share of the footprint (cells, equal-area; see the asset's method.area_weighting). */
  validFraction: number | null;
  medianDeg: number | null;
  p95Deg: number | null;
  maxDeg: number | null;
  thresholdDeg: number;
  cellsAbove: number;
  /** Share of VALID analyzed cells strictly above the threshold; null without valid cells. */
  aboveFraction: number | null;
  observerCellDeg: number | null;
  baselineM: number;
  cellM: number;
}

const sortedCache = new WeakMap<SlopeAsset, number[]>();
function sortedValid(a: SlopeAsset): number[] {
  let s = sortedCache.get(a);
  if (!s) {
    s = [];
    for (let k = 0; k < a.grid.state.length; k++) if (a.grid.state[k] === 1) s.push(a.grid.slope_centideg[k] as number);
    s.sort((x, y) => x - y);
    sortedCache.set(a, s);
  }
  return s;
}

/** Number of sorted values strictly greater than t (binary search). */
function countAbove(sorted: number[], t: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (sorted[m] <= t) lo = m + 1;
    else hi = m;
  }
  return sorted.length - lo;
}

/** Statistics for one site at one threshold. The threshold changes only the classification. */
export function slopeSummary(a: SlopeAsset, thresholdDeg: number): SlopeSummary {
  const s = sortedValid(a);
  const inside = a.grid.state.reduce((n, st) => n + (st !== 0 ? 1 : 0), 0);
  const above = countAbove(s, thresholdCentideg(thresholdDeg));
  const cd = (v: number | null) => (v === null ? null : v / 100);
  const obs = a.grid.slope_centideg[a.observer_cell.cell[1] * a.grid.nx + a.observer_cell.cell[0]];
  return {
    radiusM: a.footprint.radius_m,
    cellsInFootprint: inside,
    cellsValid: s.length,
    cellsInvalid: inside - s.length,
    validFraction: inside ? s.length / inside : null,
    medianDeg: cd(nearestRank(s, 50)),
    p95Deg: cd(nearestRank(s, 95)),
    maxDeg: s.length ? s[s.length - 1] / 100 : null,
    thresholdDeg,
    cellsAbove: above,
    aboveFraction: s.length ? above / s.length : null,
    observerCellDeg: obs === null || obs === undefined ? null : obs / 100,
    baselineM: a.method.baseline_m,
    cellM: a.method.cell_ground_m,
  };
}

export function fmtPct(f: number | null): string {
  if (f === null) return "unavailable";
  if (f > 0 && f < 0.001) return "< 0.1 %";
  return `${(f * 100).toFixed(1)} %`;
}

/** The compact alert, from computed values only. Never says "safe". */
export function screeningAlert(s: SlopeSummary): { tone: "exceed" | "none" | "nodata"; text: string } {
  if (!s.cellsValid) return { tone: "nodata", text: "No valid slope data in the analysis area." };
  if (s.cellsAbove === 0) return { tone: "none", text: "No threshold exceedances detected at this DEM scale." };
  return {
    tone: "exceed",
    text: `${fmtPct(s.aboveFraction)} of analyzed terrain exceeds the ${fmtThreshold(s.thresholdDeg)} screening threshold within ${s.radiusM} m of the modeled observer.`,
  };
}

/** Prominent coverage note when the analysis area is not fully covered; null at 100 %. */
export function coverageNote(s: SlopeSummary): string | null {
  if (s.validFraction === null || s.cellsInvalid === 0) return null;
  return `Incomplete coverage: ${fmtPct(s.validFraction)} of the analysis area has valid slope data (${s.cellsInvalid} cells without data). Statistics use valid cells only.`;
}

// ------------------------------------------------------------------ mapping and inspection

/** Nearest DEM cell of a renderer-frame point (x = east, z = -north), or null outside the grid. */
export function cellOf(a: SlopeAsset, x: number, z: number): { a: number; b: number } | null {
  const m = a.grid.local_to_cell;
  const ca = Math.round(m.a[0] + m.a[1] * x + m.a[2] * z) + 0; // + 0 turns -0 into 0
  const cb = Math.round(m.b[0] + m.b[1] * x + m.b[2] * z) + 0;
  if (ca < 0 || cb < 0 || ca >= a.grid.nx || cb >= a.grid.ny) return null;
  return { a: ca, b: cb };
}

/** Great-circle ground distance on the 1737.4 km sphere from the observer's vertical (the footprint's definition). */
export function groundDistanceM(p: [number, number, number], observerRadiusM: number): number {
  return R_REF_M * Math.atan2(Math.hypot(p[0], p[2]), observerRadiusM + p[1]);
}

export type Inspection =
  | { kind: "valid"; distanceM: number; slopeDeg: number; above: boolean; cell: { a: number; b: number } }
  | { kind: "invalid"; distanceM: number; cell: { a: number; b: number } }
  | { kind: "outside"; distanceM: number };

/** Read the slope under a clicked terrain point. Pure: changes nothing else. */
export function inspect(a: SlopeAsset, p: [number, number, number], thresholdDeg: number): Inspection {
  const distanceM = groundDistanceM(p, a.observer.observer_radius_m);
  const c = cellOf(a, p[0], p[2]);
  if (!c) return { kind: "outside", distanceM };
  const k = c.b * a.grid.nx + c.a;
  const st = a.grid.state[k];
  if (st === 0) return { kind: "outside", distanceM };
  const v = a.grid.slope_centideg[k];
  if (st !== 1 || v === null) return { kind: "invalid", distanceM, cell: c };
  return { kind: "valid", distanceM, slopeDeg: v / 100, above: v > thresholdCentideg(thresholdDeg), cell: c };
}

export function fmtDistance(m: number): string {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`;
}

/** Palette lookup (sRGB hex -> [r, g, b] 0..1), clamped to the legend range. */
export function hexRgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
export function slopeColor(deg: number): [number, number, number] {
  const d = Math.min(LEGEND_MAX_DEG, Math.max(0, deg));
  for (let k = 1; k < SLOPE_STOPS.length; k++) {
    const a = SLOPE_STOPS[k - 1];
    const b = SLOPE_STOPS[k];
    if (d <= b.deg) {
      const f = (d - a.deg) / (b.deg - a.deg);
      const ca = hexRgb(a.color);
      const cb = hexRgb(b.color);
      return [ca[0] + (cb[0] - ca[0]) * f, ca[1] + (cb[1] - ca[1]) * f, ca[2] + (cb[2] - ca[2]) * f];
    }
  }
  return hexRgb(SLOPE_STOPS[SLOPE_STOPS.length - 1].color);
}

// ------------------------------------------------------------------ lazy loading (shared by Explore and Analysis)

export type SlopeState = { state: "idle" | "loading" } | { state: "ready"; asset: SlopeAsset } | { state: "error"; message: string };

const pending = new Map<string, Promise<SlopeAsset>>();
const resolved = new Map<string, SlopeAsset>();

export function slopeUrl(base: string, id: string) {
  return `${base}screening/${id}.slope.json`;
}

/** Tests: make an asset available synchronously (as after a completed load). */
export function primeSlopeAsset(base: string, asset: SlopeAsset) {
  resolved.set(slopeUrl(base, asset.site.id), asset);
}
export function cachedSlopeAsset(base: string, id: string): SlopeAsset | null {
  return resolved.get(slopeUrl(base, id)) ?? null;
}
export function clearSlopeCache() {
  pending.clear();
  resolved.clear();
}

export function loadSlopeAsset(base: string, site: SiteData): Promise<SlopeAsset> {
  const url = slopeUrl(base, site.site.id);
  const done = resolved.get(url);
  if (done) return Promise.resolve(done);
  let p = pending.get(url);
  if (!p) {
    p = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
        return r.json();
      })
      .then((j: unknown) => {
        const prob = slopeAssetProblem(j, site);
        if (prob) throw new Error(`Screening asset refused: ${prob}.`);
        resolved.set(url, j as SlopeAsset);
        return j as SlopeAsset;
      })
      .finally(() => pending.delete(url));
    pending.set(url, p);
  }
  return p;
}

// ------------------------------------------------------------------ automatic screening summary (Conditions)

export type ScreeningView =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | {
      kind: "exceed" | "none" | "nodata";
      /** Short status line ("Steep terrain nearby" / the no-exceedance sentence). */
      headline: string;
      /** The area statement, from computed values only. */
      text: string | null;
      /** The modeled observer's own cell, reported separately from the area. */
      observer: string | null;
      observerAbove: boolean;
      coverage: string | null;
      qualification: string;
      summary: SlopeSummary;
    };

/**
 * What the Conditions panel says about terrain for one site and threshold. Independent of
 * date, playback, horizon model and overlays. An asset for another site, or no asset yet, is
 * "loading": a result is never shown before this site's data is available.
 */
export function screeningView(state: SlopeState | undefined, siteId: string, thresholdDeg: number): ScreeningView {
  if (state?.state === "error") return { kind: "error", message: state.message };
  if (state?.state !== "ready" || state.asset.site.id !== siteId) return { kind: "loading" };
  const s = slopeSummary(state.asset, thresholdDeg);
  const thr = fmtThreshold(thresholdDeg);
  const qualification = `${Math.round(s.cellM)} m DEM; slope measured over approximately ${Math.round(s.baselineM)} m.`;
  const obsAbove = s.observerCellDeg !== null && thresholdCentideg(s.observerCellDeg) > thresholdCentideg(thresholdDeg);
  const observer =
    s.observerCellDeg === null
      ? "No slope value for the modeled observer’s own cell."
      : obsAbove
        ? `The modeled observer’s own cell also exceeds ${thr} (${s.observerCellDeg.toFixed(1)}°).`
        : `The modeled observer’s own cell: ${s.observerCellDeg.toFixed(1)}°, not above ${thr}.`;
  const coverage = coverageNote(s);
  if (!s.cellsValid) return { kind: "nodata", headline: "Terrain screening unavailable", text: "No valid slope data in the analysis area.", observer: null, observerAbove: false, coverage, qualification, summary: s };
  if (s.cellsAbove === 0)
    return { kind: "none", headline: `No slopes above ${thr} detected within ${s.radiusM} m at this DEM scale.`, text: null, observer, observerAbove: obsAbove, coverage, qualification, summary: s };
  return {
    kind: "exceed",
    headline: "Steep terrain nearby",
    text: `${fmtPct(s.aboveFraction)} of analyzed area exceeds ${thr} within ${s.radiusM} m.`,
    observer,
    observerAbove: obsAbove,
    coverage,
    qualification,
    summary: s,
  };
}

/**
 * Which overlay the terrain shader draws: 0 none, 1 full slope map, 2 steep areas.
 * Only in the Site overview, and only with the active site's own asset (never another
 * site's, e.g. mid-switch). The chosen layer itself is never changed here, so returning to
 * the overview restores it.
 */
export function overlayMode(layer: TerrainLayer, camera: "overview" | "eye", assetSiteId: string | null, siteId: string): 0 | 1 | 2 {
  if (camera !== "overview" || assetSiteId === null || assetSiteId !== siteId) return 0;
  return layer === "slope" ? 1 : layer === "exceed" ? 2 : 0;
}

/** DEM pixel size for display: at most one decimal (the source records full float precision). */
export const fmtPixelM = (m: number) => String(Number(m.toFixed(1)));

/** Placeholder written by pipeline/prepare_site.py: its exact command lives in the prepared bundle's complete.json. */
export const GENERIC_REPRODUCE_PLACEHOLDER = "See complete.json command";

/**
 * Command shown under "Reproduce". Coordinate-pipeline assets record only a pointer to
 * complete.json (which is not served), so the documented config command is shown instead.
 */
export function reproduceCommand(recorded: string | null | undefined, siteId: string, fallback: string): string {
  if (!recorded) return fallback;
  if (recorded === GENERIC_REPRODUCE_PLACEHOLDER) return `python pipeline/prepare_site.py --config pipeline/config.json --site ${siteId}`;
  return recorded;
}
