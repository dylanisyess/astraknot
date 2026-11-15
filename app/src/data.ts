import { terrainProblem } from "./horizon";
import type { Catalog, CatalogSite, Dataset, Manifest, Sample, SiteData, SiteEntry } from "./types";

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

/** Sample times implied by the manifest (coverage start to end inclusive at its step). */
export function manifestTimes(manifest: Manifest): number[] {
  const a = parseUtc(manifest.coverage_start_utc);
  const b = parseUtc(manifest.coverage_end_utc);
  const step = manifest.sample_step_seconds * 1000;
  if (!(step > 0) || !(b > a) || (b - a) % step !== 0) throw new DataError("manifest coverage is not a whole number of sample steps");
  const out: number[] = [];
  for (let t = a; t <= b; t += step) out.push(t);
  return out;
}

const LOCATION_TYPES = ["actual_landing_point", "intended_landing_target", "study_location", "user_defined_study_point"];

/** The catalog must describe exactly the manifest's sites, in the same order and coverage. */
export function checkCatalog(manifest: Manifest, catalog: Catalog): void {
  if (catalog.catalog_version !== "1") throw new DataError(`unsupported catalog version ${catalog.catalog_version}`);
  if (catalog.dataset_id !== manifest.dataset_id) throw new DataError(`catalog is for ${catalog.dataset_id}, manifest is ${manifest.dataset_id}`);
  const m = manifest.sites.map((e) => e.id).join(",");
  const c = catalog.sites.map((e) => e.id).join(",");
  if (m !== c) throw new DataError(`catalog sites (${c}) differ from the manifest (${m})`);
  catalog.sites.forEach((cs, k) => {
    const e = manifest.sites[k];
    if (cs.name !== e.name || cs.file !== e.file) throw new DataError(`catalog entry ${cs.id} differs from its manifest entry`);
    if (!LOCATION_TYPES.includes(cs.location_type)) throw new DataError(`catalog entry ${cs.id}: unknown location type ${cs.location_type}`);
    const p = cs.capabilities.positions;
    if (p.coverage_start_utc !== manifest.coverage_start_utc || p.coverage_end_utc !== manifest.coverage_end_utc || p.sample_step_seconds !== manifest.sample_step_seconds) {
      throw new DataError(`catalog entry ${cs.id}: position coverage differs from the dataset's common coverage`);
    }
  });
}

/**
 * One site file against its manifest entry, its catalog entry and the dataset's sample times.
 * Anything that disagrees is refused (the site is not shown), never patched.
 */
export function checkSiteFile(manifest: Manifest, cs: CatalogSite, data: SiteData, times: number[]): SiteEntry {
  const e = manifest.sites.find((x) => x.id === cs.id);
  if (!e) throw new DataError(`${cs.id} is not in the manifest`);
  if (data.site?.id !== e.id) throw new DataError(`${e.file} contains site ${data.site?.id ?? "(none)"}, not ${e.id}`);
  if (data.site.name !== e.name) throw new DataError(`${e.file}: site name differs from the manifest entry`);
  if (data.site.latitude_deg !== cs.latitude_deg || data.site.longitude_deg_east !== cs.longitude_deg_east) {
    throw new DataError(`${e.file}: coordinates differ from the catalog entry`);
  }
  const t = checkSite(manifest, data);
  if (t.length !== times.length || t.some((x, i) => x !== times[i])) throw new DataError(`${e.file}: sample times differ from the dataset's common times`);
  const claims = cs.capabilities.terrain_horizon.available;
  if (claims !== !!data.terrain_horizon) throw new DataError(`${e.file}: terrain horizon ${claims ? "missing although the catalog lists it" : "present although the catalog says none"}`);
  // The terrain block is optional: if it fails a check, that site's terrain is withheld with the reason.
  // A site without a terrain block reports the catalog's stated reason.
  const th = cs.capabilities.terrain_horizon;
  const problem = th.available ? terrainProblem(data) : th.reason;
  if (problem && data.terrain_horizon) delete data.terrain_horizon;
  return { id: e.id, data, terrainProblem: problem };
}

type FetchLike = typeof fetch;
const getJson = async <T,>(fetchImpl: FetchLike, url: string, signal?: AbortSignal): Promise<T> => {
  const r = await fetchImpl(url, signal ? { signal } : undefined);
  if (!r.ok) throw new DataError(`could not load ${url} (HTTP ${r.status})`);
  return (await r.json()) as T;
};

/**
 * Manifest + catalog of one dataset folder, with a lazy, checked site loader. `preload`
 * site IDs (default: all) are loaded before returning, in parallel.
 */
export async function loadDataset(base: string, fetchImpl: FetchLike = fetch, opts: { dir?: string; expectedId?: string; preload?: string[] | ((ids: string[]) => string[]) } = {}): Promise<Dataset> {
  const dir = `${base}${opts.dir ?? "data/"}`;
  const manifest = await getJson<Manifest>(fetchImpl, `${dir}manifest.json`);
  if (opts.expectedId && manifest.dataset_id !== opts.expectedId) throw new DataError(`Requested dataset ${opts.expectedId}, received ${manifest.dataset_id}`);
  if (!manifest.sites?.length) throw new DataError("manifest lists no sites");
  for (const e of manifest.sites) {
    if (!SITE_ID.test(e.id) || e.file !== `${e.id}.json`) throw new DataError(`manifest maps ${e.id} to ${e.file}, expected ${e.id}.json`);
  }
  if (new Set(manifest.sites.map((e) => e.id)).size !== manifest.sites.length) throw new DataError("manifest lists a site ID more than once");
  const catalog = await getJson<Catalog>(fetchImpl, `${dir}catalog.json`);
  checkCatalog(manifest, catalog);
  const times = manifestTimes(manifest);
  const loadSite = async (id: string): Promise<SiteEntry> => {
    const cs = catalog.sites.find((x) => x.id === id);
    if (!cs) throw new DataError(`unknown site ${id}`);
    const data = await getJson<SiteData>(fetchImpl, `${dir}${cs.file}`);
    return checkSiteFile(manifest, cs, data, times);
  };
  const ids = catalog.sites.map((c) => c.id);
  const pre = typeof opts.preload === "function" ? opts.preload(ids) : (opts.preload ?? ids);
  const want = pre.filter((id) => ids.includes(id));
  const sites = await Promise.all(want.map(loadSite));
  return { manifest, catalog, sites, times, loadSite };
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
