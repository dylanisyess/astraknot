import { terrainProblem } from "./horizon";
import type { Dataset, Manifest, Sample, SiteData, SiteEntry } from "./types";

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

const SITE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Strict identity checks between the manifest and the loaded site files:
 * unique valid IDs, file = "<id>.json", the file's site.id and name equal the
 * manifest entry, and every site has exactly the same sample times (so one
 * cursor and one coverage interval apply to all sites).
 */
export function checkSites(manifest: Manifest, files: SiteData[]): number[] {
  const ids = manifest.sites.map((e) => e.id);
  if (!ids.length) throw new DataError("manifest lists no sites");
  if (new Set(ids).size !== ids.length) throw new DataError("manifest lists a site ID more than once");
  let shared: number[] | null = null;
  manifest.sites.forEach((e, k) => {
    if (!SITE_ID.test(e.id)) throw new DataError(`invalid site ID in manifest: ${e.id}`);
    if (e.file !== `${e.id}.json`) throw new DataError(`manifest maps ${e.id} to ${e.file}, expected ${e.id}.json`);
    const f = files[k];
    if (f.site?.id !== e.id) throw new DataError(`${e.file} contains site ${f.site?.id ?? "(none)"}, not ${e.id}`);
    if (f.site.name !== e.name) throw new DataError(`${e.file}: site name differs from the manifest entry`);
    const times = checkSite(manifest, f);
    if (shared === null) shared = times;
    else if (times.length !== shared.length || times.some((t, i) => t !== shared![i])) {
      throw new DataError(`${e.file}: sample times differ from ${manifest.sites[0].file}`);
    }
  });
  return shared!;
}

export async function loadDataset(base: string, fetchImpl: typeof fetch = fetch): Promise<Dataset> {
  const get = async <T,>(path: string): Promise<T> => {
    const r = await fetchImpl(base + path);
    if (!r.ok) throw new DataError(`could not load ${path} (HTTP ${r.status})`);
    return (await r.json()) as T;
  };
  const manifest = await get<Manifest>("data/manifest.json");
  if (!manifest.sites?.length) throw new DataError("manifest lists no sites");
  const files: SiteData[] = [];
  for (const e of manifest.sites) {
    if (!SITE_ID.test(e.id) || e.file !== `${e.id}.json`) throw new DataError(`manifest maps ${e.id} to ${e.file}, expected ${e.id}.json`);
    files.push(await get<SiteData>(`data/${e.file}`));
  }
  const times = checkSites(manifest, files);
  const sites: SiteEntry[] = files.map((data, k) => {
    // The terrain block is optional: if it is missing or fails a check, that site's
    // terrain is withheld (and Terrain mode is offered only when every compared site has it).
    const problem = terrainProblem(data);
    if (problem && data.terrain_horizon) delete data.terrain_horizon;
    return { id: manifest.sites[k].id, data, terrainProblem: problem };
  });
  return { manifest, sites, times };
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
