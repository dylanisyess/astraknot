// Per-site presentation and the strict horizon-model rules for comparing sites.
// Text that is not derived from a site's own data file lives in PROFILES, keyed by
// site ID, so nothing written for one site can appear for another. A site without a
// profile gets neutral, data-derived wording only.

import { horizonAt } from "./horizon";
import type { CatalogSite, Horizon, HorizonMode, SiteData, SiteEntry, VisibilityInterval } from "./types";

export interface SiteProfile {
  /** Display label (required wording for CR1). */
  label: string;
  /** Short name for compact places (selector, timeline). */
  short: string;
  /** What kind of point this is. */
  kind: string;
  /** Where the coordinate comes from: a cited source (curated sites) or user input (catalog location type). */
  pointSource: "published" | "user-defined";
  /** Shown next to the metrics in Terrain mode when the terrain result is provisional. */
  provisionalTerrain: string | null;
  /** Measured effect of the 0.1 m surface rounding on the observer and skyline (from the pipeline evidence). */
  roundingEffect: string | null;
  /** "Not the actual conditions" statement for this point. */
  realityNote: string;
  /** Extra site-specific limitations. */
  limitations: string[];
  /** Middle of the panorama (multiple of 45 deg), chosen near the site's Earth direction. */
  panoramaCenterAz: number;
  /** Key into assessment.ts, if a separate terrain-product assessment exists. */
  assessment: "cr1-5m" | null;
}

export const PROFILES: Record<string, SiteProfile> = {
  "im2-athena": {
    label: "IM-2 Athena landing point",
    short: "Athena",
    kind: "Published landing point of Intuitive Machines’ IM-2 Athena lander (Mons Mouton region)",
    pointSource: "published",
    provisionalTerrain: null,
    roundingEffect:
      "The submitted point is 0.0196 m higher than an exact 1 m eye: at most 0.0034° on the skyline and one 10-minute Sun step (the 2026-12-30 sunset); no demo-window metric changes.",
    realityNote: "DEM-based visibility for the published coordinate, not a reconstruction of Athena’s actual operating conditions.",
    limitations: [],
    panoramaCenterAz: 0,
    assessment: null,
  },
  "connecting-ridge-cr1": {
    label: "Connecting Ridge CR1 — NASA notional study point",
    short: "CR1",
    kind:
      "Assumed landing point in a notional NASA traverse study (Lunar Surface Data Book ACD-50044 Rev A, §7.3.3); not an actual or approved landing site",
    pointSource: "published",
    provisionalTerrain: "Provisional: sensitive to terrain model",
    roundingEffect:
      "The submitted point is 0.0206 m lower than an exact 1 m eye: up to 0.0235° on the skyline, 13 Sun and 3 Earth 10-minute steps over 60 days, at most +0.25 pp Sun share and −0.83 h longest darkness in the demo windows.",
    realityNote: "DEM-based visibility for a notional study coordinate; no lander has operated there.",
    limitations: [
      "The source does not state the coordinate’s frame, latitude type or accuracy; the lunar ME/DE421 frame is assumed.",
      "The nearest terrain pixel to the point has no LOLA laser shot (its height is interpolated).",
    ],
    panoramaCenterAz: 135,
    assessment: "cr1-5m",
  },
};

/** The deployment's capability statement for user-defined study points (docs/CUSTOM_COORDINATES.md). */
export const CUSTOM_CAPABILITY_NOTE =
  "Custom coordinates can be processed with the offline Python pipeline. This site demonstrates one generated result. Live coordinate processing is not available on this deployment.";

/** Limitations that follow from the point being user-defined (catalog location type), not from one site ID. */
export const USER_DEFINED_LIMITATIONS = [
  "User-defined study point: an entered coordinate with no published source. It is not a documented landing site or an approved landing target.",
  CUSTOM_CAPABILITY_NOTE,
  "Not reviewed: no site-specific sensitivity checks (observer position, observer height or terrain product) were made for this point.",
  "No LOLA laser-shot consistency check was made at the point, and shot counts at the skyline points are not assessed (unknown, not zero).",
];

/** True for a site whose coordinate was entered by a user rather than taken from a cited source. */
export const isUserDefined = (cat?: Pick<CatalogSite, "location_type">) => cat?.location_type === "user_defined_study_point";

/** Presentation for a site: its PROFILES entry, else neutral wording from its catalog entry or file. */
export function profileFor(site: SiteData | null, cat?: CatalogSite): SiteProfile {
  const id = site?.site.id ?? cat?.id ?? "";
  const p = PROFILES[id];
  if (p) return p;
  const user = isUserDefined(cat);
  return {
    label: cat?.name ?? site?.site.name ?? id,
    short: cat?.short_name ?? id,
    kind: cat?.location_label ?? "Documented lunar surface point",
    pointSource: user ? "user-defined" : "published",
    provisionalTerrain: cat?.capabilities.provisional ?? null,
    roundingEffect: null,
    realityNote: user
      ? "DEM-based visibility for a user-defined study point (an entered coordinate), not actual operating conditions; not a documented landing site or an approved landing target."
      : "DEM-based visibility for the published coordinate, not actual operating conditions.",
    limitations: user ? USER_DEFINED_LIMITATIONS : [],
    panoramaCenterAz: 0,
    assessment: null,
  };
}

/** What the shown coordinates are, for banners: never calls a user-defined point "published". */
export function coordinateBasis(profiles: Pick<SiteProfile, "pointSource">[]): string {
  const user = profiles.filter((p) => p.pointSource === "user-defined").length;
  const published = profiles.length - user;
  const userText = user === 1 ? "a user-defined study point (an entered coordinate)" : "user-defined study points (entered coordinates)";
  if (!user) return "published coordinates";
  if (!published) return userText;
  return `published coordinates and ${userText}`;
}

/** A source URL that may be shown as a link (http/https only); user-defined points have none. */
export const linkableUrl = (url: string | undefined) => (url && /^https?:\/\//.test(url) ? url : null);

/** Name of the terrain model actually displayed, from the file's own metadata. */
export function terrainModelLabel(site: SiteData): string | null {
  const t = site.terrain_horizon;
  if (!t) return null;
  const pix = t.horizon.resolution.dem_pixel_m;
  const names = Object.keys(pix);
  const near = names[0];
  // "LOLA" only for the LOLA LDEM products; any other source is named by its product name alone
  const family = names.every((n) => /^LDEM_/.test(n)) ? "LOLA " : "";
  return `${Math.round(pix[near])} m ${family}model (${near}${names.length > 1 ? `; ${names.slice(1).join(", ")} beyond its edge` : ""})`;
}

/**
 * Compact form of terrainModelLabel for one-line chips: "20 m LOLA model", or the near product by
 * name for other sources ("59 m SLDEM2015 model"). The full label stays in Geometry and Details.
 */
export function terrainModelShortLabel(site: SiteData): string | null {
  const t = site.terrain_horizon;
  if (!t) return null;
  const pix = t.horizon.resolution.dem_pixel_m;
  const names = Object.keys(pix);
  const near = names[0];
  // other sources by their product family ("sldem2015_512_00n_30n_000_045" -> "SLDEM2015")
  return `${Math.round(pix[near])} m ${names.every((n) => /^LDEM_/.test(n)) ? "LOLA" : near.split("_")[0].toUpperCase()} model`;
}

// ------------------------------------------------------------ strict model selection

export interface ModeAvailability {
  terrain: boolean;
  /** Sites without a usable terrain horizon, with reasons. */
  missing: { id: string; reason: string }[];
}

/**
 * Terrain mode only when EVERY compared site has a usable terrain horizon. Loaded sites are
 * judged by their checked file; sites still loading by their catalog capability.
 */
export function modeAvailability(entries: SiteEntry[], notLoaded: CatalogSite[] = []): ModeAvailability {
  const missing = [
    ...entries.filter((e) => !e.data.terrain_horizon).map((e) => ({ id: e.id, reason: e.terrainProblem ?? "no terrain horizon" })),
    ...notLoaded.filter((c) => !c.capabilities.terrain_horizon.available).map((c) => {
      const t = c.capabilities.terrain_horizon;
      return { id: c.id, reason: t.available ? "" : t.reason };
    }),
  ];
  return { terrain: entries.length + notLoaded.length > 0 && missing.length === 0, missing };
}

/** Horizon for a mode, or an error: never falls back to the smooth model for a terrain request. */
export function strictHorizon(site: SiteData, mode: HorizonMode): Horizon {
  if (mode === "smooth") return site.horizon;
  const h = site.terrain_horizon?.horizon;
  if (!h) throw new Error(`${site.site.id}: terrain horizon requested but not available`);
  return h;
}

export function strictIntervals(site: SiteData, mode: HorizonMode): VisibilityInterval[] {
  if (mode === "smooth") return site.visibility_intervals;
  const iv = site.terrain_horizon?.visibility_intervals;
  if (!iv) throw new Error(`${site.site.id}: terrain intervals requested but not available`);
  return iv;
}

// ------------------------------------------------------------ data-derived facts

export interface TerrainFacts {
  settingDistanceM: [number, number, number];
  zeroShot: number;
  known: number;
  elevationRange: [number, number];
  sunElevationRange: [number, number];
  /** Every skyline point is within 2 km (the pipeline's "not robust" rule). */
  nearFieldDominated: boolean;
}

export function terrainFacts(site: SiteData): TerrainFacts | null {
  const t = site.terrain_horizon;
  if (!t) return null;
  const d = t.setting_points.distance_km.filter((v): v is number => v !== null).sort((a, b) => a - b);
  const el = t.horizon.elevation_deg.filter((v): v is number => v !== null);
  const sun = site.samples.map((s) => s.sun_elevation_deg).filter((v): v is number => v !== null);
  const known = t.setting_points.shot_count.filter((c) => c !== null).length;
  return {
    settingDistanceM: [d[0] * 1000, d[Math.floor(d.length / 2)] * 1000, d[d.length - 1] * 1000],
    zeroShot: t.setting_points.shot_count.filter((c) => c === 0).length,
    known,
    elevationRange: [Math.min(...el), Math.max(...el)],
    sunElevationRange: [Math.min(...sun), Math.max(...sun)],
    nearFieldDominated: d[d.length - 1] < 2,
  };
}

/** Horizon elevation under each body at every sample (terrain mode). */
export function horizonUnderBodies(site: SiteData, h: Horizon) {
  return {
    sun: site.samples.map((x) => (x.sun_azimuth_deg === null ? null : horizonAt(h, x.sun_azimuth_deg))),
    earth: site.samples.map((x) => (x.earth_azimuth_deg === null ? null : horizonAt(h, x.earth_azimuth_deg))),
  };
}

/** Great-circle distance on the 1737.4 km reference sphere, km. */
export function surfaceDistanceKm(a: { latitude_deg: number; longitude_deg_east: number }, b: typeof a): number {
  const r = Math.PI / 180;
  const p1 = a.latitude_deg * r;
  const p2 = b.latitude_deg * r;
  const dl = (b.longitude_deg_east - a.longitude_deg_east) * r;
  const c = Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos(dl);
  return 1737.4 * Math.acos(Math.max(-1, Math.min(1, c)));
}

/** South polar stereographic map coordinates (km) as used by the LOLA polar products:
 *  X = rho sin(lon) (90 deg E to the right), Y = rho cos(lon) (0 deg up), rho = 2R tan(colatitude / 2). */
export function polarXY(latDeg: number, lonEastDeg: number): { x: number; y: number } {
  const rho = 2 * 1737.4 * Math.tan(((90 - Math.abs(latDeg)) * Math.PI) / 360);
  const l = (lonEastDeg * Math.PI) / 180;
  return { x: rho * Math.sin(l), y: rho * Math.cos(l) };
}
