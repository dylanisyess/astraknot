// Continuous body tracking in the Horizon view (release 6, checkpoint 1).
//
// Tracking keeps the chosen body's MODELED direction (the shared selected-time status,
// status.ts) at the centre of the observer view as the selected time changes. Rules:
// - The modeled observer never moves; only the view direction changes (yaw/pitch).
// - The field of view is never changed by tracking (the user's zoom is kept).
// - Each update snaps to the direction at the current selected time. Between samples the
//   camera does not glide, so its motion never suggests event timing finer than the
//   10-minute grid. Only engaging (or switching body) is animated, and not under reduced motion.
// - A missing direction is an explicit state: the camera holds still and the indicator
//   says it is not pointing at the body. It never keeps aiming at a stale target.
// - Status words come only from selectedTimeStatus; tracking never derives visibility.
// Pure functions: no React, no three.js.

import { fmtDeg } from "../data";
import type { BodyStatus } from "../status";
import type { HorizonMode } from "../types";
import { azDelta } from "./geometry";

export type TrackBody = "sun" | "earth";
/** The eye view tilts at most this far up or down (same limit as manual looking). */
export const MAX_PITCH_DEG = 85;
/** Duration of the engage / switch transition (ms); 0 under reduced motion. */
export const TRACK_ENGAGE_MS = 650;

export interface ViewPose {
  yaw: number;
  pitch: number;
}

export type TrackTarget =
  | { kind: "aim"; yaw: number; pitch: number; /** the body is higher/lower than the view can tilt */ clamped: boolean }
  | { kind: "missing" };

/** Where the view must point to center the body's modeled direction, or "missing". */
export function trackTarget(g: { azimuthDeg: number | null; elevationDeg: number | null }): TrackTarget {
  if (g.azimuthDeg === null || g.elevationDeg === null || !Number.isFinite(g.azimuthDeg) || !Number.isFinite(g.elevationDeg)) {
    return { kind: "missing" };
  }
  const a = g.azimuthDeg;
  const yaw = a >= 0 && a < 360 ? a : ((a % 360) + 360) % 360;
  const pitch = Math.max(-MAX_PITCH_DEG, Math.min(MAX_PITCH_DEG, g.elevationDeg));
  return { kind: "aim", yaw, pitch, clamped: pitch !== g.elevationDeg };
}

/**
 * Blend from one pose toward another along the shortest azimuth path (359° -> 1° passes
 * through 0°, never the long way round). f in [0, 1]. Yaw is normalized to [0, 360).
 */
export function blendPose(from: ViewPose, to: ViewPose, f: number): ViewPose {
  const k = Math.max(0, Math.min(1, f));
  const yaw = from.yaw + azDelta(from.yaw, to.yaw) * k;
  return { yaw: ((yaw % 360) + 360) % 360, pitch: from.pitch + (to.pitch - from.pitch) * k };
}

/** Largest yaw change (deg) a sequence of tracked poses makes between consecutive updates. */
export function maxYawStep(poses: ViewPose[]): number {
  let m = 0;
  for (let i = 1; i < poses.length; i++) m = Math.max(m, Math.abs(azDelta(poses[i - 1].yaw, poses[i].yaw)));
  return m;
}

export type TrackState = "visible" | "hidden" | "unknown" | "missing";

export interface TrackSummary {
  state: TrackState;
  /** Main line, e.g. "Sun center 2.31° above the terrain skyline". */
  line: string;
  /** Explanation when the body is hidden, unknown or has no direction; null otherwise. */
  note: string | null;
}

/** Indicator text for the tracked body, from the shared selected-time status only. */
export function trackSummary(s: BodyStatus, body: TrackBody, mode: HorizonMode): TrackSummary {
  const name = body === "sun" ? "Sun" : "Earth";
  const hz = mode === "terrain" ? "terrain skyline" : "0° reference horizon";
  const g = s.geometry;
  const target = trackTarget(g);
  if (target.kind === "missing") {
    return {
      state: "missing",
      line: `${name} direction unavailable at this time`,
      note: `No modeled ${name} position for this time, so the view is not pointing at the ${name}. It holds still and follows again when a direction is available.`,
    };
  }
  const clamp = target.clamped ? ` The ${name} is ${fmtDeg(g.elevationDeg, 1)} high; the view tilts at most ${MAX_PITCH_DEG}°, so it sits off-centre.` : "";
  const clr = g.clearanceDeg === null ? null : Math.abs(g.clearanceDeg);
  const rel = g.side === null || clr === null ? `${name} center, horizon there unknown` : `${name} center ${clr.toFixed(2)}° ${g.side} the ${hz}`;
  if (s.visible === null) {
    return {
      state: "unknown",
      line: rel,
      note: `Visibility is unknown for this 10-minute step; the view still points at the modeled direction.${clamp}`,
    };
  }
  if (!s.visible) {
    const near = s.nearCrossing ? " Near an estimated crossing: its center is already above the horizon at this instant, but this 10-minute step is classified as hidden." : "";
    return {
      state: "hidden",
      line: rel,
      note: `Hidden by the ${hz}: the view points at the ${name}'s modeled direction, and the ${mode === "terrain" ? "skyline" : "horizon"} covers it.${near}${clamp}`,
    };
  }
  const near = s.nearCrossing ? " Near an estimated crossing: its center is already below the horizon at this instant, but this 10-minute step is classified as visible." : "";
  return { state: "visible", line: rel, note: near || clamp ? `${near}${clamp}`.trim() : null };
}
