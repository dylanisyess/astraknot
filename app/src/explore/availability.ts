// Power / communications framing for Explore, from existing data only.
// - Labels come from selectedTimeStatus (status.ts): `visible` is the exported 10-minute
//   step state. Nothing here reclassifies anything.
// - Timeline segments are the exported intervals, clipped to a window with mission.ts
//   `clip` (the same [start, end) semantics the metrics use).
// - Transitions are interval boundaries where a body's known state flips. They are
//   estimates on the 10-minute reporting grid, not sub-sample event times. The end of the
//   data and changes to/from "unknown" are not physical transitions.

import { type Interval, type TimeWindow, type Tri, clip } from "../mission";
import type { BodyStatus } from "../status";

export type AvailState = "both" | "sun" | "earth" | "neither" | "unknown" | "uncovered";

export const AVAIL_LABEL: Record<AvailState, string> = {
  both: "Sun + Earth",
  sun: "Sun only",
  earth: "Earth only",
  neither: "Neither",
  unknown: "Unknown",
  uncovered: "No data",
};

/** Four availability states; any unknown body makes the period unknown (never "neither"). */
export function availabilityState(sun: Tri, earth: Tri): AvailState {
  if (sun === null || earth === null) return "unknown";
  if (sun && earth) return "both";
  if (sun) return "sun";
  if (earth) return "earth";
  return "neither";
}

export interface Segment {
  start: number;
  end: number;
  state: AvailState;
  sun: Tri;
  earth: Tri;
}

/**
 * Availability over a window: exported intervals clipped with `clip`, adjacent equal
 * periods merged, and any part of the window not covered by an interval marked "uncovered".
 */
export function availabilitySegments(intervals: Interval[], w: TimeWindow): Segment[] {
  const out: Segment[] = [];
  const push = (s: Segment) => {
    const last = out[out.length - 1];
    if (last && last.end === s.start && last.state === s.state && last.sun === s.sun && last.earth === s.earth) last.end = s.end;
    else out.push(s);
  };
  let t = w.start;
  for (const iv of clip(intervals, w)) {
    if (iv.start > t) push({ start: t, end: iv.start, state: "uncovered", sun: null, earth: null });
    push({ start: iv.start, end: iv.end, state: availabilityState(iv.sun, iv.earth), sun: iv.sun, earth: iv.earth });
    t = iv.end;
  }
  if (t < w.end) push({ start: t, end: w.end, state: "uncovered", sun: null, earth: null });
  return out;
}

export function segmentAt(segs: Segment[], t: number): Segment | null {
  for (const s of segs) if (t >= s.start && t < s.end) return s;
  return null;
}

// ------------------------------------------------------------ user-facing status wording

export interface Framed {
  /** Main line, e.g. "Direct sunlight available". */
  label: string;
  tone: "on" | "off" | "unknown";
}

export function powerStatus(s: BodyStatus): Framed {
  if (s.visible === null) return { label: "Sunlight status unknown", tone: "unknown" };
  return s.visible ? { label: "Direct sunlight available", tone: "on" } : { label: "Direct sunlight blocked", tone: "off" };
}

export function commsStatus(s: BodyStatus): Framed {
  if (s.visible === null) return { label: "Earth visibility unknown", tone: "unknown" };
  return s.visible ? { label: "Earth visibility window open", tone: "on" } : { label: "Earth below horizon", tone: "off" };
}

export const PURPOSE_NOTE =
  "Sun visibility indicates potential for direct solar generation. Earth visibility indicates a geometric direct-to-Earth " +
  "communication window. Electrical output, battery endurance and radio-link performance are not modeled.";

// ------------------------------------------------------------ transitions

export interface Transition {
  /** Interval boundary (ms) where the body's state flips; an estimate on the 10-minute grid. */
  t: number;
  body: "sun" | "earth";
  to: boolean;
}

/** Visibility transitions strictly inside `range` (start < t < end). */
export function transitions(intervals: Interval[], body: "sun" | "earth", range: TimeWindow): Transition[] {
  const out: Transition[] = [];
  for (let i = 1; i < intervals.length; i++) {
    const a = intervals[i - 1];
    const b = intervals[i];
    if (a.end !== b.start) continue; // a gap is not a transition
    const x = a[body];
    const y = b[body];
    if (x === null || y === null || x === y) continue; // unknown on either side: not physical
    if (b.start > range.start && b.start < range.end) out.push({ t: b.start, body, to: y });
  }
  return out;
}

/** The transition after (dir = 1) or before (dir = -1) the reference time, or null. */
export function adjacentTransition(list: Transition[], ref: number, dir: 1 | -1): Transition | null {
  if (dir === 1) return list.find((x) => x.t > ref) ?? null;
  for (let i = list.length - 1; i >= 0; i--) if (list[i].t < ref) return list[i];
  return null;
}

/** How long before a transition to place the time, so playback shows the approach. */
export const EVENT_LEAD_MS = { sun: 60 * 60_000, earth: 6 * 3_600_000 } as const;

export function transitionText(x: Transition, mode: "smooth" | "terrain"): string {
  const hz = mode === "terrain" ? "modeled skyline" : "0° reference horizon";
  const name = x.body === "sun" ? "Sun" : "Earth";
  const what = x.body === "sun" ? (x.to ? "direct sunlight begins" : "direct sunlight ends") : x.to ? "Earth window opens" : "Earth window closes";
  return `${name} center crosses the ${hz} near ${new Date(x.t).toISOString().slice(0, 16).replace("T", " ")} UTC (${what}).`;
}

// ------------------------------------------------------------ crossing navigation (pure)

export interface CrossingAnchor {
  /** The transition last navigated to. */
  T: number;
  body: "sun" | "earth";
  /** The selected time that navigation produced; the anchor applies only while it is unchanged. */
  selT: number;
}

export type CrossingPlan =
  | { kind: "event"; x: Transition; targetT: number; anchor: CrossingAnchor }
  | { kind: "none"; atDataEnd: boolean };

/**
 * Plan a Previous/Next step. The reference is the anchored transition while the selected
 * time is still where the last navigation put it (so repeated presses advance from event
 * to event even though the time sits before the crossing); otherwise the selected time.
 * The target is a sample `leadMs` before the transition, never before the range start or
 * the first sample. `times` are the sample times (ms, ascending).
 */
export function planCrossing(args: {
  intervals: Interval[];
  body: "sun" | "earth";
  range: TimeWindow;
  selT: number;
  anchor: CrossingAnchor | null;
  dir: 1 | -1;
  leadMs: number;
  times: number[];
}): CrossingPlan {
  const { intervals, body, range, selT, anchor, dir, leadMs, times } = args;
  const ref = anchor && anchor.body === body && anchor.selT === selT ? anchor.T : selT;
  const x = adjacentTransition(transitions(intervals, body, range), ref, dir);
  if (!x) return { kind: "none", atDataEnd: dir === 1 && range.end >= times[times.length - 1] };
  const want = Math.max(x.t - leadMs, range.start, times[0]);
  // the last sample at or before `want` (samples are on the 10-minute grid)
  let i = 0;
  while (i + 1 < times.length && times[i + 1] <= want) i++;
  return { kind: "event", x, targetT: times[i], anchor: { T: x.t, body, selT: times[i] } };
}

/** "in 40 min", "in 5 h 20 min", "now", "20 min ago" — on the 10-minute grid. */
export function untilText(fromT: number, toT: number): string {
  const d = Math.round((toT - fromT) / 60_000);
  const fmt = (m: number) => {
    const h = Math.floor(m / 60);
    const r = m % 60;
    return h ? `${h} h${r ? ` ${r} min` : ""}` : `${r} min`;
  };
  if (d === 0) return "now";
  return d > 0 ? `in ${fmt(d)}` : `${fmt(-d)} ago`;
}

// ------------------------------------------------------------ overview body markers

export type MarkerState = "visible" | "below" | "unknown";

/** Overview marker style from the interval state (selectedTimeStatus), never from the render. */
export function markerState(s: BodyStatus): MarkerState {
  return s.visible === null ? "unknown" : s.visible ? "visible" : "below";
}

export const MARKER_TEXT: Record<MarkerState, string> = {
  visible: "Above observer horizon",
  below: "Below observer horizon",
  unknown: "Visibility unknown",
};
