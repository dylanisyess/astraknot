import { terrainProblem } from "./horizon";
import type { Dataset, Manifest, Sample, SiteData } from "./types";

export class DataError extends Error {}

const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export function parseUtc(s: string): number {
  if (!ISO_Z.test(s)) throw new DataError(`not an ISO 8601 UTC timestamp: ${s}`);
  return Date.parse(s);
}

/** Structural checks the UI relies on. Throws DataError with a readable message. */
export function checkSite(manifest: Manifest, site: SiteData): number[] {
  if (manifest.schema_version !== "1.0" || site.schema_version !== "1.0") {
    throw new DataError(`unsupported schema version ${manifest.schema_version}/${site.schema_version}`);
  }
  const s = site.samples;
  if (!Array.isArray(s) || s.length < 2) throw new DataError("site file has fewer than 2 samples");
  const times = s.map((x) => parseUtc(x.time_utc));
  const step = manifest.sample_step_seconds * 1000;
  for (let i = 1; i < times.length; i++) {
    if (!(times[i] > times[i - 1])) throw new DataError(`timestamps not strictly increasing at ${s[i].time_utc}`);
    if (times[i] - times[i - 1] !== step) throw new DataError(`unexpected sample spacing at ${s[i].time_utc}`);
  }
  if (s[0].time_utc !== manifest.coverage_start_utc || s[s.length - 1].time_utc !== manifest.coverage_end_utc) {
    throw new DataError("samples do not span the manifest coverage interval");
  }
  return times;
}

export async function loadDataset(base: string, fetchImpl: typeof fetch = fetch): Promise<Dataset> {
  const get = async <T,>(path: string): Promise<T> => {
    const r = await fetchImpl(base + path);
    if (!r.ok) throw new DataError(`could not load ${path} (HTTP ${r.status})`);
    return (await r.json()) as T;
  };
  const manifest = await get<Manifest>("data/manifest.json");
  if (!manifest.sites?.length) throw new DataError("manifest lists no sites");
  const site = await get<SiteData>(`data/${manifest.sites[0].file}`);
  const times = checkSite(manifest, site);
  // The terrain block is optional: if it is missing or fails a check, the
  // smooth-horizon workflow stays fully usable and the reason is shown.
  const problem = terrainProblem(site);
  if (problem && site.terrain_horizon) delete site.terrain_horizon;
  return { manifest, site, times, terrainProblem: problem };
}

/** Index of the sample nearest to t (ms). times must be ascending. */
export function nearestIndex(times: number[], t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  if (t <= times[lo]) return lo;
  if (t >= times[hi]) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  return t - times[lo] <= times[hi] - t ? lo : hi;
}

export type Body = "sun" | "earth";

export function elevation(s: Sample, b: Body): number | null {
  return b === "sun" ? s.sun_elevation_deg : s.earth_elevation_deg;
}
export function azimuth(s: Sample, b: Body): number | null {
  return b === "sun" ? s.sun_azimuth_deg : s.earth_azimuth_deg;
}

/** Fixed-decimal degrees with a true minus sign; null -> "unavailable". */
export function fmtDeg(v: number | null, digits = 3): string {
  if (v === null || !Number.isFinite(v)) return "unavailable";
  const s = Math.abs(v).toFixed(digits);
  const neg = v < 0 && Number(s) !== 0;
  return `${neg ? "−" : ""}${s}°`;
}

export function fmtLat(lat: number): string {
  return `${Math.abs(lat).toFixed(4)}° ${lat < 0 ? "S" : "N"}`;
}
export function fmtLonEast(lon: number): string {
  return `${lon.toFixed(4)}° E`;
}

/** "2026-12-01T12:00:00Z" -> "2026-12-01 12:00 UTC" */
export function fmtUtc(ms: number, withSeconds = false): string {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, withSeconds ? 19 : 16)} UTC`;
}

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
export function compass(az: number | null): string {
  if (az === null) return "";
  return COMPASS[Math.round(az / 22.5) % 16];
}

/** Whole-degree axis domain that contains the data and 0 (the smooth horizon). */
export function elevationDomain(values: (number | null)[], pad = 0.5): [number, number] {
  const v = values.filter((x): x is number => x !== null);
  const lo = Math.floor(Math.min(0, ...v) - pad);
  const hi = Math.ceil(Math.max(0, ...v) + pad);
  return [lo, hi];
}
