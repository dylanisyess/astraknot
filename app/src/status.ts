// Selected-time status: the ONE place that says whether the Sun / Earth is visible at a
// given UTC time. Used by the site cards, the readouts and the panorama labels, and
// intended for the future 3D Explore view. Pure functions: no React, no DOM.
//
// Two quantities are kept separate on purpose:
// - `visible`: the modeled state of the 10-minute step containing t, classified at the
//   step's midpoint (DATA_CONTRACT.md "Visibility intervals"). It is read from the
//   exported intervals, so it is the same value every metric, timeline and table uses.
//   Nothing here re-classifies or overrides it.
// - `geometry`: the instantaneous position of the body's center at t and its clearance
//   above the horizon at that azimuth. Exact at sample times; linear between samples
//   (the reviewer measured < 0.00002 deg error over a 20-minute chord). Never moved to
//   agree with `visible`.
// Within a step the two can disagree when the center crosses the horizon between t and
// the step midpoint. That case is flagged `nearCrossing` and explained with one shared
// sentence ("Near estimated crossing") instead of showing two contradictory words.
// Visibility refers to the body's CENTER: part of the disk can be above the horizon while
// the center is hidden (and vice versa).

import { fmtDeg, fmtUtc } from "./data";
import { horizonAt, interpAzimuth } from "./horizon";
import { type Body, type Interval, type Tri, bothState, intervalAt } from "./mission";
import type { Horizon, HorizonMode, Sample } from "./types";

export const NEAR_CROSSING = "Near estimated crossing";

export interface BodyGeometry {
  azimuthDeg: number | null;
  elevationDeg: number | null;
  /** Horizon elevation at the center's azimuth (0 in smooth mode), or null when unknown. */
  horizonDeg: number | null;
  /** elevation - horizon; positive = center above the horizon. */
  clearanceDeg: number | null;
  /** Strictly above (same rule as the classification), below, or null when unknown. */
  side: "above" | "below" | null;
}

export type UnknownReason =
  | "outside-coverage" // t is before the first or after the last sample: nothing is extrapolated
  | "end-of-data" // t is the final sample: no 10-minute step starts there
  | "position-unavailable"
  | "horizon-unknown"
  | "state-unknown";

export interface BodyStatus {
  body: Body;
  t: number;
  visible: Tri;
  /** The 10-minute step containing t ([start, end) ms) whose midpoint classification gives `visible`. */
  step: { start: number; end: number } | null;
  /** The merged run of equal states containing t (as in the interval tables). */
  interval: { start: number; end: number } | null;
  geometry: BodyGeometry;
  /** `visible` and `geometry.side` are both known and disagree. */
  nearCrossing: boolean;
  /** Why `visible` is null; null when it is known. */
  unknownReason: UnknownReason | null;
}

export interface SelectedStatus {
  t: number;
  mode: HorizonMode;
  inCoverage: boolean;
  sun: BodyStatus;
  earth: BodyStatus;
  /** Both centers visible (interval states); nearCrossing when the instantaneous "both" differs. */
  both: { visible: Tri; nearCrossing: boolean };
}

export interface StatusInput {
  samples: Sample[];
  /** Sample times, epoch ms, ascending (Dataset.times). */
  times: number[];
  /** Horizon of the mode shown (strictHorizon). */
  horizon: Horizon;
  /** Parsed intervals of the same mode (strictIntervals + parseIntervals). */
  intervals: Interval[];
  mode: HorizonMode;
}

const NO_GEOMETRY: BodyGeometry = { azimuthDeg: null, elevationDeg: null, horizonDeg: null, clearanceDeg: null, side: null };

/** Index k with times[k] <= t < times[k + 1] (k = last index when t equals the final time); -1 outside. */
function stepIndex(times: number[], t: number): number {
  const n = times.length;
  if (!(n > 0) || !(t >= times[0]) || !(t <= times[n - 1])) return -1;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Instantaneous geometry of a body's center at t. No extrapolation outside the samples. */
export function geometryAt(input: Pick<StatusInput, "samples" | "times" | "horizon">, body: Body, t: number): BodyGeometry {
  const { samples, times, horizon } = input;
  const k = stepIndex(times, t);
  if (k < 0) return NO_GEOMETRY;
  const azKey = body === "sun" ? "sun_azimuth_deg" : "earth_azimuth_deg";
  const elKey = body === "sun" ? "sun_elevation_deg" : "earth_elevation_deg";
  const a0 = samples[k][azKey];
  const e0 = samples[k][elKey];
  let az: number | null = a0;
  let el: number | null = e0;
  if (t !== times[k]) {
    const a1 = samples[k + 1][azKey];
    const e1 = samples[k + 1][elKey];
    const f = (t - times[k]) / (times[k + 1] - times[k]);
    // Same formulas as the midpoint classification (classifySteps / visibility.py), so at a
    // step midpoint the geometry reproduces the exported state exactly.
    az = a0 === null || a1 === null ? null : interpAzimuth(a0, a1, f);
    el = e0 === null || e1 === null ? null : e0 + f * (e1 - e0);
  }
  if (az === null || el === null) return { ...NO_GEOMETRY, azimuthDeg: az, elevationDeg: el };
  const hz = horizonAt(horizon, az);
  if (hz === null) return { azimuthDeg: az, elevationDeg: el, horizonDeg: null, clearanceDeg: null, side: null };
  return { azimuthDeg: az, elevationDeg: el, horizonDeg: hz, clearanceDeg: el - hz, side: el > hz ? "above" : "below" };
}

function bodyStatus(input: StatusInput, body: Body, t: number): BodyStatus {
  const { times, intervals } = input;
  const geometry = geometryAt(input, body, t);
  const k = stepIndex(times, t);
  const step = k >= 0 && k + 1 < times.length ? { start: times[k], end: times[k + 1] } : null;
  const iv = step ? intervalAt(intervals, t) : null; // no state outside the steps (including NaN and the final sample)
  const visible: Tri = iv ? iv[body] : null;
  let unknownReason: UnknownReason | null = null;
  if (k < 0) unknownReason = "outside-coverage";
  else if (!step) unknownReason = "end-of-data";
  else if (!iv) unknownReason = "state-unknown";
  else if (visible === null) {
    // explain from the step midpoint, where the state is decided
    const g = geometryAt(input, body, (step.start + step.end) / 2);
    unknownReason = g.azimuthDeg === null || g.elevationDeg === null ? "position-unavailable" : g.side === null ? "horizon-unknown" : "state-unknown";
  }
  return {
    body,
    t,
    visible,
    step,
    interval: iv ? { start: iv.start, end: iv.end } : null,
    geometry,
    nearCrossing: visible !== null && geometry.side !== null && visible !== (geometry.side === "above"),
    unknownReason,
  };
}

/** Status of both bodies at UTC time t (ms) for one site and horizon mode. */
export function selectedTimeStatus(input: StatusInput, t: number): SelectedStatus {
  const sun = bodyStatus(input, "sun", t);
  const earth = bodyStatus(input, "earth", t);
  const side = (g: BodyGeometry): Tri => (g.side === null ? null : g.side === "above");
  const visible = bothState(sun.visible, earth.visible);
  const geomBoth = bothState(side(sun.geometry), side(earth.geometry));
  return {
    t,
    mode: input.mode,
    inCoverage: stepIndex(input.times, t) >= 0,
    sun,
    earth,
    both: { visible, nearCrossing: visible !== null && geomBoth !== null && visible !== geomBoth },
  };
}

// ------------------------------------------------------------ shared wording

export function stateLabel(v: Tri): "Visible" | "Not visible" | "Unknown" {
  return v === null ? "Unknown" : v ? "Visible" : "Not visible";
}

export function horizonName(mode: HorizonMode): string {
  return mode === "terrain" ? "skyline" : "0° horizon";
}

/** Precision that does not round a near-crossing clearance to zero. */
function clearanceDigits(c: number): number {
  const a = Math.abs(c);
  return a < 0.001 ? 5 : a < 0.01 ? 4 : a < 0.1 ? 3 : 2; // the exported profile is rounded to 1e-5 deg
}

/** "0.12° above the skyline" (null when the geometry is unknown). */
export function clearancePhrase(g: BodyGeometry, mode: HorizonMode): string | null {
  if (g.clearanceDeg === null || g.side === null) return null;
  return `${fmtDeg(Math.abs(g.clearanceDeg), clearanceDigits(g.clearanceDeg))} ${g.side} the ${horizonName(mode)}`;
}

/** "center 0.12° above the skyline" (null when the geometry is unknown). */
export function clearanceText(g: BodyGeometry, mode: HorizonMode): string | null {
  const p = clearancePhrase(g, mode);
  return p === null ? null : `center ${p}`;
}

/** Signed clearance for compact places ("+0.120°", "−0.00012°"). */
export function signedClearance(g: BodyGeometry): string {
  if (g.clearanceDeg === null) return "unavailable";
  const c = g.clearanceDeg;
  return `${c > 0 ? "+" : ""}${fmtDeg(c, clearanceDigits(c))}`;
}

export function unknownText(r: UnknownReason): string {
  switch (r) {
    case "outside-coverage":
      return "outside the available data (nothing is extrapolated)";
    case "end-of-data":
      return "final sample of the data (no 10-minute step starts here)";
    case "position-unavailable":
      return "position unavailable";
    case "horizon-unknown":
      return "horizon unknown in this direction";
    case "state-unknown":
      return "state unknown";
  }
}

const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);

/** The one explanation shown wherever a near-crossing status appears. */
export function nearCrossingExplanation(s: BodyStatus, name: string, mode: HorizonMode): string | null {
  if (!s.nearCrossing || !s.step) return null;
  const word = s.visible ? "visible" : "not visible";
  return (
    `${NEAR_CROSSING}: the 10-minute step ${fmtUtc(s.step.start)}–${hhmm(s.step.end)} is classified ${word} at its midpoint ` +
    `(${hhmm((s.step.start + s.step.end) / 2)} UTC), but at ${hhmm(s.t)} UTC the ${name}’s center is ${clearancePhrase(s.geometry, mode)}. ` +
    "The modeled crossing lies inside this step; its time is not resolved more finely than the 10-minute sampling."
  );
}
