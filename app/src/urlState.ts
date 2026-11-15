// URL state: the shared scenario plus which sites are compared and which one drives
// the panorama/elevation chart (and the 3D Explore view). Older single-site links
// (arrival, days, delay, t, horizon; no sites/site/view) keep working: they compare all
// manifest sites, show the first (Athena), and open the default view (Explore).

import type { HorizonMode } from "./types";

export type View = "explore" | "analysis";
/** Explore: active mission window and camera mode (shareable view state). */
export type MissionKey = "baseline" | "delayed";
export type CamMode = "overview" | "horizon";
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
  };
}

/** Requested site IDs that exist, in manifest order; unknown IDs are reported. Empty/none -> all. */
export function resolveSites(requested: string[] | null, available: string[]): { ids: string[]; unknown: string[] } {
  if (!requested) return { ids: [...available], unknown: [] };
  const unknown = requested.filter((id) => !available.includes(id));
  const ids = available.filter((id) => requested.includes(id));
  return { ids: ids.length ? ids : [...available], unknown };
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
  return out;
}
