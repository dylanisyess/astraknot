// Horizon profiles (DATA_CONTRACT.md "Horizon"): linear periodic interpolation,
// unknown sectors stay unknown. Mirrors pipeline/visibility.py horizon_elevation.

import type { Horizon, HorizonMode, Sample, SiteData } from "./types";

export const norm360 = (a: number) => {
  const r = a % 360;
  return r < 0 ? r + 360 : r;
};

/**
 * Horizon elevation at azimuth `az` (degrees). Linear between neighbouring
 * profile azimuths, wrapping 359.9 -> 0. Returns null if either bracketing
 * value is unknown. Exactly on a profile azimuth, that sample's own value is
 * returned (same rule as the pipeline).
 */
export function horizonAt(h: Pick<Horizon, "azimuth_deg" | "elevation_deg">, az: number): number | null {
  const A = h.azimuth_deg;
  const E = h.elevation_deg;
  const n = A.length;
  if (n === 0) return null;
  if (n === 1) return E[0];
  const a = norm360(az);
  // last index with A[i] <= a (bisect_right - 1); -1 wraps to the last sample
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (A[mid] <= a) lo = mid + 1;
    else hi = mid;
  }
  const i = lo - 1 < 0 ? n - 1 : lo - 1;
  const j = (i + 1) % n;
  const e0 = E[i];
  const e1 = E[j];
  const off = norm360(a - A[i]);
  if (off === 0) return e0; // exactly on a profile sample: its own value (null if unknown)
  if (e0 === null || e1 === null) return null;
  const span = norm360(A[j] - A[i]) || 360;
  return e0 + (e1 - e0) * (off / span);
}

/** Shortest-path azimuth interpolation (359 -> 1 passes through 0). */
export function interpAzimuth(a0: number, a1: number, f: number): number {
  const d = norm360(a1 - a0 + 180) - 180;
  return norm360(a0 + f * d);
}

/** The horizon profile for a mode, or null when that mode is not available. */
export function horizonFor(site: SiteData, mode: HorizonMode): Horizon | null {
  if (mode === "smooth") return site.horizon;
  return site.terrain_horizon?.horizon ?? null;
}

export function intervalsFor(site: SiteData, mode: HorizonMode) {
  return mode === "terrain" && site.terrain_horizon ? site.terrain_horizon.visibility_intervals : site.visibility_intervals;
}

/**
 * Visibility of each 10-minute step from samples + horizon, by the contract's
 * midpoint rule. Used only to cross-check the pipeline's intervals in tests.
 */
export function classifySteps(samples: Sample[], h: Horizon): { sun: boolean | null; earth: boolean | null }[] {
  const out: { sun: boolean | null; earth: boolean | null }[] = [];
  const vis = (a0: number | null, e0: number | null, a1: number | null, e1: number | null) => {
    if (a0 === null || e0 === null || a1 === null || e1 === null) return null;
    const el = e0 + 0.5 * (e1 - e0);
    const hz = horizonAt(h, interpAzimuth(a0, a1, 0.5));
    return hz === null ? null : el > hz;
  };
  for (let k = 0; k + 1 < samples.length; k++) {
    const a = samples[k];
    const b = samples[k + 1];
    out.push({
      sun: vis(a.sun_azimuth_deg, a.sun_elevation_deg, b.sun_azimuth_deg, b.sun_elevation_deg),
      earth: vis(a.earth_azimuth_deg, a.earth_elevation_deg, b.earth_azimuth_deg, b.earth_elevation_deg),
    });
  }
  return out;
}

/** Loader check for the optional terrain block; returns a reason or null when usable. */
export function terrainProblem(site: SiteData): string | null {
  const t = site.terrain_horizon;
  if (!t) return "this dataset has no terrain horizon";
  const h = t.horizon;
  if (h.model !== "terrain") return "terrain block is not labeled model = terrain";
  const A = h.azimuth_deg;
  if (A.length < 2 || A.length !== h.elevation_deg.length) return "terrain horizon arrays are inconsistent";
  for (let i = 0; i < A.length; i++) {
    if (!(A[i] >= 0 && A[i] < 360) || (i > 0 && !(A[i] > A[i - 1]))) return "terrain azimuths are not ascending in [0, 360)";
  }
  const sp = t.setting_points;
  for (const k of ["distance_km", "height_m", "shot_count", "product_index"] as const) {
    if (sp[k].length !== A.length) return "terrain setting points do not match the profile";
  }
  const iv = t.visibility_intervals;
  if (!iv.length || iv[0].start_utc !== site.samples[0].time_utc || iv[iv.length - 1].end_utc !== site.samples[site.samples.length - 1].time_utc) {
    return "terrain intervals do not cover the data range";
  }
  for (let i = 1; i < iv.length; i++) if (iv[i].start_utc !== iv[i - 1].end_utc) return "terrain intervals are not contiguous";
  return null;
}
