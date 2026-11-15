// URL state: the shared scenario plus which sites are compared and which one drives
// the panorama/elevation chart. Older single-site links (arrival, days, delay, t,
// horizon; no sites/site) keep working: they compare all manifest sites and show the
// first (Athena) in the panorama.

import type { HorizonMode } from "./types";

export interface UrlState {
  arrival: number | null;
  days: number | null;
  delay: number | null;
  t: number | null;
  horizon: HorizonMode | null;
  sites: string[] | null;
  site: string | null;
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
  return {
    arrival: time("arrival"),
    days: num("days"),
    delay: num("delay"),
    t: time("t"),
    horizon: hz === "smooth" || hz === "terrain" ? hz : null,
    sites: sites === null ? null : sites.split(",").map((s) => s.trim()).filter(Boolean),
    site: q.get("site"),
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
  return out;
}
