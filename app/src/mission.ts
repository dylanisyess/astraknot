// Mission-window logic (DATA_CONTRACT.md "Selected-window metrics").
// Pure functions: no React, no DOM. All times are epoch milliseconds, UTC.

import type { SiteData, VisibilityInterval } from "./types";

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
/** Delay options, in days, as offsets from the baseline (never cumulative). */
export const DELAY_DAYS = [0, 1, 3, 7] as const;
export const DEFAULT_DURATION_DAYS = 14;

export type Tri = boolean | null;

export interface Interval {
  start: number; // inclusive
  end: number; // exclusive
  sun: Tri;
  earth: Tri;
}

export interface TimeWindow {
  start: number; // inclusive
  end: number; // exclusive
}

export function parseIntervals(site: SiteData, list: VisibilityInterval[] = site.visibility_intervals): Interval[] {
  return list.map((iv) => ({
    start: Date.parse(iv.start_utc),
    end: Date.parse(iv.end_utc),
    sun: iv.sun_visible,
    earth: iv.earth_visible,
  }));
}

/** both = true when both true; false when either false; otherwise unknown. */
export function bothState(sun: Tri, earth: Tri): Tri {
  if (sun === true && earth === true) return true;
  if (sun === false || earth === false) return false;
  return null;
}

// ------------------------------------------------------------ scenarios

/** Earliest/latest baseline arrival so the window [a, a + duration) fits in [coverage.start, coverage.end). */
export function arrivalBounds(coverage: TimeWindow, durationMs: number): { earliest: number; latest: number } | null {
  if (!(durationMs > 0) || coverage.start + durationMs > coverage.end) return null;
  return { earliest: coverage.start, latest: coverage.end - durationMs };
}

/** Window for a delay applied to the baseline arrival. Duration is unchanged by construction. */
export function scenarioWindow(baselineArrival: number, delayDays: number, durationMs: number): TimeWindow {
  const start = baselineArrival + delayDays * DAY_MS;
  return { start, end: start + durationMs };
}

export function windowFits(w: TimeWindow, coverage: TimeWindow): boolean {
  return w.start >= coverage.start && w.end <= coverage.end;
}

export interface DelayOption {
  days: number;
  window: TimeWindow;
  enabled: boolean;
  reason: string | null;
}

/** Why a delay choice is disabled (validation unchanged: the delayed window must fit the coverage). */
export const DELAY_UNAVAILABLE = "This mission plus the selected delay exceeds cached coverage.";

export function delayOptions(baselineArrival: number, durationMs: number, coverage: TimeWindow): DelayOption[] {
  return DELAY_DAYS.map((days) => {
    const window = scenarioWindow(baselineArrival, days, durationMs);
    const enabled = windowFits(window, coverage);
    return {
      days,
      window,
      enabled,
      reason: enabled ? null : DELAY_UNAVAILABLE,
    };
  });
}

// ------------------------------------------------------------ metrics

export function clip(intervals: Interval[], w: TimeWindow): Interval[] {
  const out: Interval[] = [];
  for (const iv of intervals) {
    const start = Math.max(iv.start, w.start);
    const end = Math.min(iv.end, w.end);
    if (end > start) out.push({ ...iv, start, end });
  }
  return out;
}

export interface DarkRun {
  start: number;
  end: number;
  durationMs: number;
  touchesStart: boolean;
  touchesEnd: boolean;
  /** Full extent of this darkness in the dataset (it may continue outside the window). */
  fullStart: number;
  fullEnd: number;
  /** true when the full run reaches the edge of the data, so its true length is not known. */
  fullStartAtCoverageEdge: boolean;
  fullEndAtCoverageEdge: boolean;
}

export type Availability<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface WindowMetrics {
  window: TimeWindow;
  durationMs: number;
  sunPct: Availability<number>;
  earthPct: Availability<number>;
  bothPct: Availability<number>;
  /** value null = no modeled darkness in the window. */
  longestDark: Availability<DarkRun | null>;
  /** Longest continuous run without a modeled direct line of sight to Earth (earth_visible false);
   *  value null = none in the window. Same run rules and boundary flags as longestDark. */
  longestEarthBlock: Availability<DarkRun | null>;
}

const unavailable = (reason: string) => ({ ok: false as const, reason });

/** Contiguous runs where predicate holds, over intervals sorted by time. */
function runs(intervals: Interval[], pred: (iv: Interval) => boolean): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (const iv of intervals) {
    if (!pred(iv)) continue;
    const last = out[out.length - 1];
    if (last && last.end === iv.start) last.end = iv.end;
    else out.push({ start: iv.start, end: iv.end });
  }
  return out;
}

export function computeMetrics(all: Interval[], w: TimeWindow): WindowMetrics {
  const durationMs = w.end - w.start;
  const parts = clip(all, w);
  // Full coverage of the window by contiguous intervals?
  let covered = 0;
  let contiguous = parts.length > 0 && parts[0].start === w.start && parts[parts.length - 1].end === w.end;
  for (let i = 0; i < parts.length; i++) {
    covered += parts[i].end - parts[i].start;
    if (i > 0 && parts[i].start !== parts[i - 1].end) contiguous = false;
  }
  const full = contiguous && covered === durationMs;
  if (!full) {
    const r = "Window is not fully covered by the available data";
    return { window: w, durationMs, sunPct: unavailable(r), earthPct: unavailable(r), bothPct: unavailable(r), longestDark: unavailable(r), longestEarthBlock: unavailable(r) };
  }

  const pct = (state: (iv: Interval) => Tri, label: string): Availability<number> => {
    let visible = 0;
    for (const iv of parts) {
      const s = state(iv);
      if (s === null) return unavailable(`${label} state unknown for part of the window`);
      if (s) visible += iv.end - iv.start;
    }
    return { ok: true, value: (100 * visible) / durationMs };
  };

  const longestDark = longestBlockedRun(parts, all, w, "sun");
  const longestEarthBlock = longestBlockedRun(parts, all, w, "earth");

  return {
    window: w,
    durationMs,
    sunPct: pct((iv) => iv.sun, "Sun"),
    earthPct: pct((iv) => iv.earth, "Earth"),
    bothPct: pct((iv) => bothState(iv.sun, iv.earth), "Combined"),
    longestDark,
    longestEarthBlock,
  };
}

/**
 * Longest continuous run in the window where the body's modeled state is false (the Sun:
 * darkness; Earth: no direct line of sight), on the window-clipped intervals `parts`. Shared by
 * both bodies so they follow one rule set: a null interval breaks a run and makes the metric
 * unavailable; adjacent false intervals join even when the other body's state differs; ties go
 * to the earliest run; touching a window edge is flagged and the run's full extent in the data
 * is reported (it may continue outside the window).
 */
function longestBlockedRun(parts: Interval[], all: Interval[], w: TimeWindow, body: Body): Availability<DarkRun | null> {
  if (parts.some((iv) => iv[body] === null)) return unavailable(`${body === "sun" ? "Sun" : "Earth"} state unknown for part of the window`);
  const blocked = runs(parts, (iv) => iv[body] === false);
  let best: { start: number; end: number } | null = null;
  for (const r of blocked) if (!best || r.end - r.start > best.end - best.start) best = r; // ties: earliest
  if (!best) return { ok: true, value: null };
  const b = best;
  const fullRun = runs(all, (iv) => iv[body] === false).find((r) => r.start <= b.start && r.end >= b.end)!;
  return {
    ok: true,
    value: {
      start: b.start,
      end: b.end,
      durationMs: b.end - b.start,
      touchesStart: b.start === w.start,
      touchesEnd: b.end === w.end,
      fullStart: fullRun.start,
      fullEnd: fullRun.end,
      fullStartAtCoverageEdge: fullRun.start === all[0].start,
      fullEndAtCoverageEdge: fullRun.end === all[all.length - 1].end,
    },
  };
}

export interface Comparison {
  sunPp: number | null;
  earthPp: number | null;
  bothPp: number | null;
  darkHours: number | null;
  /** Change in the longest Earth blockage, hours. */
  earthBlockHours: number | null;
}

/** Changes of `other` relative to `base`: percentage points, and hours for darkness. */
export function compare(base: WindowMetrics, other: WindowMetrics): Comparison {
  const d = (a: Availability<number>, b: Availability<number>) => (a.ok && b.ok ? b.value - a.value : null);
  const runMs = (a: Availability<DarkRun | null>) => (a.ok ? (a.value?.durationMs ?? 0) : null);
  const h = (a: Availability<DarkRun | null>, b: Availability<DarkRun | null>) => {
    const x = runMs(a);
    const y = runMs(b);
    return x === null || y === null ? null : (y - x) / HOUR_MS;
  };
  return {
    sunPp: d(base.sunPct, other.sunPct),
    earthPp: d(base.earthPct, other.earthPct),
    bothPp: d(base.bothPct, other.bothPct),
    darkHours: h(base.longestDark, other.longestDark),
    earthBlockHours: h(base.longestEarthBlock, other.longestEarthBlock),
  };
}

// ------------------------------------------------------------ cursor queries

export function intervalAt(all: Interval[], t: number): Interval | null {
  let lo = 0;
  let hi = all.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (t < all[mid].start) hi = mid - 1;
    else if (t >= all[mid].end) lo = mid + 1;
    else return all[mid];
  }
  return null;
}

export type Body = "sun" | "earth";

export type NextChange =
  | { found: true; at: number; to: Tri }
  | { found: false; searchedUntil: number };

/** Next time after t at which the body's modeled state differs from its state at t. */
export function nextChange(all: Interval[], t: number, body: Body): NextChange {
  const cur = intervalAt(all, t);
  const end = all.length ? all[all.length - 1].end : t;
  if (!cur) return { found: false, searchedUntil: end };
  const state = cur[body];
  for (let i = all.indexOf(cur) + 1; i < all.length; i++) {
    if (all[i][body] !== state) return { found: true, at: all[i].start, to: all[i][body] };
  }
  return { found: false, searchedUntil: end };
}

// ------------------------------------------------------------ UTC date helpers

export function utcDateString(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
export function utcHour(ms: number): number {
  return new Date(ms).getUTCHours();
}
export function fromUtcDateHour(date: string, hour: number): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d, hour);
}

export function fmtDuration(ms: number): string {
  const totalMin = Math.round(ms / 60000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  return [d ? `${d} d` : "", h || d ? `${h} h` : "", m ? `${m} min` : ""].filter(Boolean).join(" ") || "0 min";
}

export function fmtHours(ms: number): string {
  return `${(ms / HOUR_MS).toFixed(1)} h`;
}

export function fmtSigned(v: number, unit: string, digits = 1): string {
  const s = Math.abs(v).toFixed(digits);
  if (Number(s) === 0) return `0.${"0".repeat(digits)} ${unit}`;
  return `${v > 0 ? "+" : "−"}${s} ${unit}`;
}

/**
 * A mission percentage at `digits` decimals. "100.0 %" and "0.0 %" are reserved for exactly
 * complete and exactly zero availability; a value that would round to them is shown bounded
 * (">99.9 %", "<0.1 %") so rounding never hides a nonzero difference. Display only: ranking,
 * limits and exports use the unrounded value.
 */
export function fmtPct(v: number, digits = 1): string {
  const s = v.toFixed(digits);
  const step = 10 ** -digits;
  if (v < 100 && Number(s) >= 100) return `>${(100 - step).toFixed(digits)} %`;
  if (v > 0 && Number(s) <= 0) return `<${step.toFixed(digits)} %`;
  return `${s} %`;
}

/** A blockage duration: minutes below one hour (always a multiple of the 10-minute grid here), else hours at one decimal. */
export function fmtOutage(ms: number): string {
  if (ms < HOUR_MS) return `${Math.round(ms / 60_000)} min`;
  return fmtHours(ms);
}
