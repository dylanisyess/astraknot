// Where the terrain skyline hides a body, for the Site overview.
// Status comes only from the exported intervals (status.ts). This only locates the terrain
// point that sets the exported skyline at the body's azimuth (the pipeline's
// `setting_points`), so the overview can show what blocks the view from the observer's eye.
// The point lies exactly on the eye's line of sight at the skyline elevation.

import type { BodyStatus } from "../status";
import type { HorizonMode, SiteData } from "../types";
import { type Vec3, directionFromAzEl } from "./geometry";

export interface BlockingPoint {
  /** Observer-frame position (x east, y up, z -north; origin at the eye), metres. */
  position: Vec3;
  /** Ground distance from the observer to the skyline-setting terrain, metres. */
  distanceM: number;
  /** Exported skyline elevation at the body's azimuth (degrees). */
  skylineDeg: number;
  /** Body center elevation (degrees). */
  bodyDeg: number;
  /** Profile azimuth used (degrees). */
  azimuthDeg: number;
}

/**
 * The skyline-setting terrain point hiding a body, or null when the body is not hidden by
 * terrain (Smooth model, visible, unknown, near an estimated crossing, or no setting point).
 */
export function blockingPoint(site: SiteData, s: BodyStatus, mode: HorizonMode): BlockingPoint | null {
  const th = site.terrain_horizon;
  const g = s.geometry;
  if (mode !== "terrain" || !th || s.visible !== false || s.nearCrossing) return null;
  if (g.azimuthDeg === null || g.elevationDeg === null || g.horizonDeg === null || g.clearanceDeg === null || g.clearanceDeg >= 0) return null;
  const az = th.horizon.azimuth_deg;
  const n = az.length;
  const step = 360 / n;
  const k = ((Math.round(g.azimuthDeg / step) % n) + n) % n;
  const dKm = th.setting_points.distance_km[k];
  const el = th.horizon.elevation_deg[k];
  if (dKm === null || dKm === undefined || el === null || el === undefined) return null;
  // Horizontal range taken as the ground distance (differs by d³/6R²: 6 cm at 10 km, 7 m at
  // 50 km, i.e. under 0.01° of direction), then along the line of sight at the skyline elevation.
  const horiz = dKm * 1000;
  const slant = horiz / Math.cos((el * Math.PI) / 180);
  const d = directionFromAzEl(az[k], el);
  return { position: [d[0] * slant, d[1] * slant, d[2] * slant], distanceM: horiz, skylineDeg: el, bodyDeg: g.elevationDeg, azimuthDeg: az[k] };
}

export const fmtRange = (m: number) =>
  m < 100 ? `${Math.max(1, Math.round(m))} m` : m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`;

/** Overview label text for a blocking point. */
export function blockingText(name: string, b: BlockingPoint): { title: string; sub: string } {
  return {
    title: `${name} blocked here`,
    sub: `terrain ${fmtRange(b.distanceM)} away rises to ${b.skylineDeg.toFixed(2)}°; ${name} center ${b.bodyDeg.toFixed(2)}°`,
  };
}
