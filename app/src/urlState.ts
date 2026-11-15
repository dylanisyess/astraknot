// URL state: the shared scenario plus which sites are compared and which one drives
// the panorama/elevation chart (and the 3D Explore view). Older single-site links
// (arrival, days, delay, t, horizon; no sites/site/view) keep working: they compare the
// first two catalog sites (Athena and CR1, i.e. every site of the 60-day release), show the
// first (Athena), and open the default view (Explore). Existing two-site links keep their
// selection; a comparison holds at most MAX_SITES sites, in catalog order.

import type { HorizonMode } from "./types";

export type View = "explore" | "analysis";
/** Explore: active mission window and camera mode (shareable view state). */
export type MissionKey = "baseline" | "delayed";
export type CamMode = "overview" | "horizon";
/** Explore (5C): terrain layer drawn in the Site overview. */
export type LayerKey = "surface" | "slope" | "exceed";
export const DEFAULT_VIEW: View = "explore";

export interface UrlState {
  arrival: number | null;
  days: number | null;
  delay: number | null;
  t: number | null;
  horizon: HorizonMode | null;
  sites: string[] | null;
  site: string | null;
  /** Explore (3D, default) or Analysis (dashboard). Absent or malformed = default. */
  view: View | null;
  /** Explore: active mission ("delayed" applies only with a delay). */
  mission?: MissionKey | null;
  /** Explore: camera mode. */
  cam?: CamMode | null;
  /** Explore (5C): terrain overlay. Absent = the default (steep areas); "hide" = hidden. */
  layer?: LayerKey | null;
  /** 5C: illustrative slope screening threshold (deg), shared by Explore and Analysis. */
  thr?: number | null;
}

export function parseUrlState(search: string): UrlState {
  const q = new URLSearchParams(search);
  const num = (k: string) => {
    const v = q.get(k);
    if (v === null || v.trim() === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const time = (k: string) => {
    const v = q.get(k);
    const ms = v ? Date.parse(v) : NaN;
    return Number.isFinite(ms) ? ms : null;
  };
  const hz = q.get("horizon");
  const sites = q.get("sites");
  const view = q.get("view");
  const mission = q.get("mission");
  const cam = q.get("cam");
  const layer = q.get("layer");
  return {
    arrival: time("arrival"),
    days: num("days"),
    delay: num("delay"),
    t: time("t"),
    horizon: hz === "smooth" || hz === "terrain" ? hz : null,
    sites: sites === null ? null : sites.split(",").map((s) => s.trim()).filter(Boolean),
    site: q.get("site"),
    view: view === "explore" || view === "analysis" ? view : null,
    mission: mission === "baseline" || mission === "delayed" ? mission : null,
    cam: cam === "overview" || cam === "horizon" ? cam : null,
    // "hide" (written since the 5C UX correction) and the older "surface"/"off" all mean hidden
    layer: layer === "hide" || layer === "surface" || layer === "off" ? "surface" : layer === "slope" || layer === "exceed" ? layer : null,
    thr: num("thr"),
  };
}

/** Largest comparison shortlist in this release. */
export const MAX_SITES = 4;
/** Sites compared when a link names none: the first two catalog sites (all sites of the 60-day release). */
export const DEFAULT_SITE_COUNT = 2;

export interface SiteRequest {
  /** Sites to compare: requested ones that exist, deduplicated, in catalog order, at most MAX_SITES. */
  ids: string[];
  /** Requested IDs that are not in the dataset (reported, never used). */
  unknown: string[];
  /** IDs named more than once (used once). */
  duplicates: string[];
  /** Valid IDs beyond MAX_SITES (not compared; reported). */
  dropped: string[];
}

/** Requested site IDs that exist, in catalog order; unknown, duplicate and excess IDs are reported. Empty/none -> default. */
export function resolveSites(requested: string[] | null, available: string[]): SiteRequest {
  const fallback = available.slice(0, DEFAULT_SITE_COUNT);
  if (!requested) return { ids: fallback, unknown: [], duplicates: [], dropped: [] };
  const unknown = [...new Set(requested.filter((id) => !available.includes(id)))];
  const duplicates = [...new Set(requested.filter((id, k) => requested.indexOf(id) !== k))];
  const valid = available.filter((id) => requested.includes(id));
  const ids = valid.slice(0, MAX_SITES);
  return { ids: ids.length ? ids : fallback, unknown, duplicates, dropped: valid.slice(MAX_SITES) };
}

/** Active (panorama) site: the requested one if it is compared, otherwise the first compared site. */
export function resolveActive(requested: string | null, ids: string[]): string {
  return requested && ids.includes(requested) ? requested : ids[0];
}

export interface WritableState {
  arrival: number;
  days: number;
  delay: number;
  t: string;
  horizon: HorizonMode;
  sites: string[];
  site: string;
  view?: View;
  mission?: MissionKey;
  cam?: CamMode;
  layer?: LayerKey;
  thr?: number;
}

export function writeUrlState(url: URL, s: WritableState): URL {
  const out = new URL(url.toString());
  out.searchParams.set("arrival", new Date(s.arrival).toISOString().replace(":00.000Z", "Z"));
  out.searchParams.set("days", String(s.days));
  out.searchParams.set("delay", String(s.delay));
  out.searchParams.set("t", s.t);
  out.searchParams.set("horizon", s.horizon);
  out.searchParams.set("sites", s.sites.join(","));
  out.searchParams.set("site", s.site);
  if (s.view) out.searchParams.set("view", s.view);
  if (s.mission) out.searchParams.set("mission", s.mission);
  if (s.cam) out.searchParams.set("cam", s.cam);
  // written explicitly so a user's Hide survives a reload (absent = the default, steep areas)
  if (s.layer) out.searchParams.set("layer", s.layer === "surface" ? "hide" : s.layer);
  if (s.thr !== undefined) out.searchParams.set("thr", String(s.thr));
  return out;
}

// ------------------------------------------------------------ shortlist rules (pure; used by scenario.ts)

/** Why `id` cannot be added to the selection `sel` (catalog `all`), or null. */
export function addBlockedReason(sel: string[], id: string, all: string[]): string | null {
  if (!all.includes(id)) return "not in this dataset";
  if (sel.includes(id)) return "already in the comparison";
  if (sel.length >= MAX_SITES) return `the comparison is full (${MAX_SITES} sites); remove one first`;
  return null;
}

/** Selection after adding `id` (catalog order, no duplicates, at most MAX_SITES). */
export function withSite(sel: string[], id: string, all: string[]): string[] {
  if (addBlockedReason(sel, id, all)) return sel;
  return all.filter((x) => x === id || sel.includes(x));
}

/** Selection and active site after removing `id`; the last site is never removed. */
export function withoutSite(sel: string[], id: string, active: string): { sel: string[]; active: string } {
  if (!sel.includes(id) || sel.length <= 1) return { sel, active };
  const rest = sel.filter((x) => x !== id);
  return { sel: rest, active: active === id ? rest[0] : active };
}
