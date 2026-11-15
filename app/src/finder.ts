// Arrival Window Finder (release 7): a bounded daily search over the cached visibility intervals.
//
// For one mission duration, evaluate candidate arrivals once per UTC day at a fixed UTC hour and
// rank them by the existing selected-window metrics (mission.ts computeMetrics). Rules:
// - Every candidate is the full requested duration; a candidate whose window is not fully
//   covered by every searched site's data is never generated (no shortening, no extrapolation).
// - One horizon model for every searched site (the scenario's model; never mixed).
// - Metrics come only from computeMetrics, so they equal the Analysis cards for the same window.
// - Unknown data is never favorable: a metric that is unavailable cannot rank and cannot pass a
//   limit; such candidates are reported separately.
// - Blockage limits apply to the longest blockage WITHIN the mission window. A run touching a
//   window edge keeps its boundary flags: it may extend outside the mission.
// - Deterministic order: selected metric, then earlier arrival, then site ID.
// Pure functions: no React, no DOM. Times are epoch milliseconds, UTC.

import { type Availability, type DarkRun, type Interval, type TimeWindow, type WindowMetrics, DAY_MS, HOUR_MS, computeMetrics, delayOptions, utcDateString } from "./mission";
import type { HorizonMode } from "./types";
import { type CamMode, type LayerKey, type MissionKey, type View, addBlockedReason, withSite } from "./urlState";

/** Candidate spacing: one arrival per UTC day (fixed in this release). */
export const SPACING_DAYS = 1;
export const DEFAULT_SHOWN = 10;

export type Criterion = "both" | "sun" | "earth" | "sunBlock" | "earthBlock";

export interface CriterionInfo {
  key: Criterion;
  label: string;
  /** Column / short label. */
  short: string;
  /** "desc": larger is better (percentages); "asc": smaller is better (blockage hours). */
  dir: "desc" | "asc";
  unit: "%" | "h";
}

export const CRITERIA: CriterionInfo[] = [
  { key: "both", label: "Most simultaneous Sun + Earth availability", short: "Sun + Earth", dir: "desc", unit: "%" },
  { key: "sun", label: "Most sunlight", short: "Sun", dir: "desc", unit: "%" },
  { key: "earth", label: "Most Earth visibility", short: "Earth", dir: "desc", unit: "%" },
  { key: "sunBlock", label: "Shortest longest sunlight blockage", short: "Longest Sun blockage", dir: "asc", unit: "h" },
  { key: "earthBlock", label: "Shortest longest Earth blockage", short: "Longest Earth blockage", dir: "asc", unit: "h" },
];
export const DEFAULT_CRITERION: Criterion = "both";
export const criterionInfo = (c: Criterion) => CRITERIA.find((x) => x.key === c)!;

// ------------------------------------------------------------ inputs and the candidate grid

export interface FinderInputs {
  /** Searched sites (a subset of the compared sites), in comparison order. */
  siteIds: string[];
  /** Mission duration, whole Earth days. */
  days: number;
  /** Earliest and latest candidate arrival dates, "YYYY-MM-DD" (UTC). */
  fromDate: string;
  toDate: string;
  /** Candidate arrival hour, UTC (0-23). */
  hour: number;
}

export interface ArrivalLimits {
  earliest: number;
  latest: number;
  earliestDate: string;
  latestDate: string;
}

const dateAt = (date: string, hour: number) => {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d, hour);
};

/** A real calendar date in "YYYY-MM-DD" form. */
export function isDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return utcDateString(dateAt(s, 0)) === s;
}

/**
 * Earliest and latest arrivals at `hour` UTC whose full mission [a, a + duration) lies inside the
 * coverage [start, end) (end-exclusive analysis coverage), or null when no such day exists.
 */
export function arrivalLimits(cov: TimeWindow, durationMs: number, hour: number): ArrivalLimits | null {
  if (!(durationMs > 0)) return null;
  let earliest = dateAt(utcDateString(cov.start), hour);
  if (earliest < cov.start) earliest += DAY_MS;
  const lastStart = cov.end - durationMs;
  let latest = dateAt(utcDateString(lastStart), hour);
  if (latest > lastStart) latest -= DAY_MS;
  if (earliest > latest) return null;
  return { earliest, latest, earliestDate: utcDateString(earliest), latestDate: utcDateString(latest) };
}

/** Candidate arrivals: once per UTC day at `hour`, from `fromDate` to `toDate` inclusive. */
export function candidateArrivals(fromDate: string, toDate: string, hour: number): number[] {
  const out: number[] = [];
  const end = dateAt(toDate, hour);
  for (let t = dateAt(fromDate, hour); t <= end; t += SPACING_DAYS * DAY_MS) out.push(t);
  return out;
}

/** Common supported coverage of the searched sites: the intersection of their interval spans. */
export function commonCoverage(sites: { intervals: Interval[] }[]): TimeWindow | null {
  if (!sites.length || sites.some((s) => !s.intervals.length)) return null;
  const start = Math.max(...sites.map((s) => s.intervals[0].start));
  const end = Math.min(...sites.map((s) => s.intervals[s.intervals.length - 1].end));
  return end > start ? { start, end } : null;
}

export type InputCheck =
  | { ok: true; arrivals: number[]; durationMs: number; limits: ArrivalLimits }
  | { ok: false; problems: string[]; limits: ArrivalLimits | null };

const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;

/** Validates the search inputs against the common coverage; explains problems with the valid limits. Never clamps. */
export function checkInputs(inp: FinderInputs, cov: TimeWindow): InputCheck {
  const problems: string[] = [];
  const maxDays = Math.floor((cov.end - cov.start) / DAY_MS);
  if (!inp.siteIds.length) problems.push("Choose at least one site to search.");
  const daysOk = Number.isInteger(inp.days) && inp.days >= 1 && inp.days <= maxDays;
  if (!daysOk) problems.push(`Mission duration must be a whole number of days from 1 to ${maxDays} (the common data coverage).`);
  const hourOk = Number.isInteger(inp.hour) && inp.hour >= 0 && inp.hour <= 23;
  if (!hourOk) problems.push("Arrival hour must be 00:00–23:00 UTC.");
  const durationMs = inp.days * DAY_MS;
  const limits = daysOk && hourOk ? arrivalLimits(cov, durationMs, inp.hour) : null;
  if (daysOk && hourOk && !limits) problems.push(`No ${inp.days}-day mission arriving at ${hh(inp.hour)} UTC fits the common data coverage.`);
  const fromOk = isDate(inp.fromDate);
  const toOk = isDate(inp.toDate);
  if (!fromOk) problems.push("Enter a valid earliest arrival date.");
  if (!toOk) problems.push("Enter a valid latest arrival date.");
  if (limits && fromOk && toOk) {
    const range = `Valid arrival dates for a ${inp.days}-day mission arriving at ${hh(inp.hour)} UTC: ${limits.earliestDate} to ${limits.latestDate}.`;
    if (inp.fromDate > inp.toDate) problems.push(`The earliest arrival date is after the latest. ${range}`);
    else {
      if (dateAt(inp.fromDate, inp.hour) < limits.earliest) problems.push(`The earliest arrival ${inp.fromDate} ${hh(inp.hour)} UTC is before the data begins. ${range}`);
      if (dateAt(inp.toDate, inp.hour) > limits.latest) {
        problems.push(`A mission arriving ${inp.toDate} ${hh(inp.hour)} UTC would end after the data ends (${new Date(cov.end).toISOString().slice(0, 16).replace("T", " ")} UTC). ${range}`);
      }
    }
  }
  if (problems.length) return { ok: false, problems, limits };
  return { ok: true, arrivals: candidateArrivals(inp.fromDate, inp.toDate, inp.hour), durationMs, limits: limits! };
}

// ------------------------------------------------------------ sites and the horizon model

export interface FinderSiteOption {
  id: string;
  short: string;
  /** ready: intervals for the selected model are loaded; otherwise the reason it cannot be searched. */
  state: "ready" | "loading" | "error" | "no-model";
  reason: string | null;
}

/** Problems with the chosen sites under the selected model (never substitutes another model). */
export function siteProblems(chosen: string[], options: FinderSiteOption[], mode: HorizonMode): string[] {
  const out: string[] = [];
  for (const id of chosen) {
    const o = options.find((x) => x.id === id);
    if (!o) out.push(`${id} is not in the comparison.`);
    else if (o.state === "no-model") out.push(`${o.short} has no ${mode === "terrain" ? "Terrain" : "Smooth"} horizon (${o.reason}). Terrain and Smooth results are never mixed: remove ${o.short} from this search, or switch every site to Smooth in Mission setup.`);
    else if (o.state === "loading") out.push(`${o.short} is still loading.`);
    else if (o.state === "error") out.push(`${o.short} could not be loaded (${o.reason}).`);
  }
  return out;
}

// ------------------------------------------------------------ evaluation

export interface FinderSite {
  id: string;
  intervals: Interval[];
}

export interface FinderRow {
  siteId: string;
  arrival: number;
  end: number;
  /** The shared selected-window metrics for [arrival, end). */
  m: WindowMetrics;
}

/** Evaluates every site at every candidate arrival over the full duration (computeMetrics only). */
export function evaluate(sites: FinderSite[], arrivals: number[], durationMs: number): FinderRow[] {
  const rows: FinderRow[] = [];
  for (const s of sites) {
    for (const a of arrivals) rows.push({ siteId: s.id, arrival: a, end: a + durationMs, m: computeMetrics(s.intervals, { start: a, end: a + durationMs }) });
  }
  return rows;
}

const runHours = (a: Availability<DarkRun | null>): number | null => (a.ok ? (a.value?.durationMs ?? 0) / HOUR_MS : null);

/** The value of a metric for a row, or null when it is unavailable (unknown data or coverage). */
export function metricValue(row: FinderRow, c: Criterion): number | null {
  return windowValue(row.m, c);
}

/** The same value for any selected-window metrics (e.g. the current baseline mission). */
export function windowValue(m: WindowMetrics, c: Criterion): number | null {
  switch (c) {
    case "both": return m.bothPct.ok ? m.bothPct.value : null;
    case "sun": return m.sunPct.ok ? m.sunPct.value : null;
    case "earth": return m.earthPct.ok ? m.earthPct.value : null;
    case "sunBlock": return runHours(m.longestDark);
    case "earthBlock": return runHours(m.longestEarthBlock);
  }
}

/** Why a metric is unavailable for a row, or null. */
export function metricReason(row: FinderRow, c: Criterion): string | null {
  const m = row.m;
  const a = c === "both" ? m.bothPct : c === "sun" ? m.sunPct : c === "earth" ? m.earthPct : c === "sunBlock" ? m.longestDark : m.longestEarthBlock;
  return a.ok ? null : a.reason;
}

/** Deterministic order: metric (best first), then earlier arrival, then site ID. */
export function compareRows(a: FinderRow, b: FinderRow, c: Criterion): number {
  const va = metricValue(a, c)!;
  const vb = metricValue(b, c)!;
  if (va !== vb) return criterionInfo(c).dir === "desc" ? vb - va : va - vb;
  if (a.arrival !== b.arrival) return a.arrival - b.arrival;
  return a.siteId < b.siteId ? -1 : a.siteId > b.siteId ? 1 : 0;
}

export interface Ranking {
  /** Rows with an available value for the criterion, best first. */
  ranked: FinderRow[];
  /** Rows whose criterion is unavailable (unknown data): never ranked, reported separately. */
  unevaluable: FinderRow[];
}

export function rank(rows: FinderRow[], c: Criterion): Ranking {
  const ranked = rows.filter((r) => metricValue(r, c) !== null).sort((a, b) => compareRows(a, b, c));
  return { ranked, unevaluable: rows.filter((r) => metricValue(r, c) === null) };
}

// ------------------------------------------------------------ optional limits

export interface Limits {
  minSunPct: number | null;
  minEarthPct: number | null;
  /** Longest continuous Sun blockage WITHIN the mission window, hours. */
  maxSunBlockH: number | null;
  /** Longest continuous Earth blockage WITHIN the mission window, hours. */
  maxEarthBlockH: number | null;
}
export const NO_LIMITS: Limits = { minSunPct: null, minEarthPct: null, maxSunBlockH: null, maxEarthBlockH: null };
export const LIMIT_KEYS = ["minSunPct", "minEarthPct", "maxSunBlockH", "maxEarthBlockH"] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];
export const LIMIT_INFO: Record<LimitKey, { label: string; short: string; criterion: Criterion; op: ">=" | "<="; unit: "%" | "h" }> = {
  minSunPct: { label: "Minimum sunlight", short: "Sun ≥", criterion: "sun", op: ">=", unit: "%" },
  minEarthPct: { label: "Minimum Earth visibility", short: "Earth ≥", criterion: "earth", op: ">=", unit: "%" },
  maxSunBlockH: { label: "Maximum continuous Sun blockage within the mission", short: "Sun blockage ≤", criterion: "sunBlock", op: "<=", unit: "h" },
  maxEarthBlockH: { label: "Maximum continuous Earth blockage within the mission", short: "Earth blockage ≤", criterion: "earthBlock", op: "<=", unit: "h" },
};

export const activeLimits = (l: Limits) => LIMIT_KEYS.filter((k) => l[k] !== null);

export interface LimitOutcome {
  key: LimitKey;
  limit: number;
  value: number | null;
  /** unknown: the metric is unavailable, so the limit cannot pass. */
  state: "pass" | "fail" | "unknown";
}

export function limitOutcomes(row: FinderRow, l: Limits): LimitOutcome[] {
  return activeLimits(l).map((key) => {
    const info = LIMIT_INFO[key];
    const limit = l[key]!;
    const value = metricValue(row, info.criterion);
    const state = value === null ? "unknown" : (info.op === ">=" ? value >= limit : value <= limit) ? "pass" : "fail";
    return { key, limit, value, state };
  });
}

/** none: no limits set; meets: every limit passes; fails: at least one fails; unknown: none fails but one cannot be checked. */
export type LimitVerdict = "none" | "meets" | "fails" | "unknown";
export function verdict(outcomes: LimitOutcome[]): LimitVerdict {
  if (!outcomes.length) return "none";
  if (outcomes.some((o) => o.state === "fail")) return "fails";
  if (outcomes.some((o) => o.state === "unknown")) return "unknown";
  return "meets";
}

export interface ResultView {
  ranking: Ranking;
  /** Ranked rows that meet every selected limit (all ranked rows when no limits are set). */
  meeting: FinderRow[];
  /** Ranked rows that fail at least one limit. */
  failing: FinderRow[];
  /** Ranked rows that could not be checked against a limit (unknown data). */
  limitUnknown: FinderRow[];
}

export function resultView(rows: FinderRow[], c: Criterion, l: Limits): ResultView {
  const ranking = rank(rows, c);
  const v = (r: FinderRow) => verdict(limitOutcomes(r, l));
  return {
    ranking,
    meeting: ranking.ranked.filter((r) => ["none", "meets"].includes(v(r))),
    failing: ranking.ranked.filter((r) => v(r) === "fails"),
    limitUnknown: ranking.ranked.filter((r) => v(r) === "unknown"),
  };
}

// ------------------------------------------------------------ staleness

/** Everything a result set depends on. Results whose key differs from the current one are stale. */
export function searchKey(datasetId: string, mode: HorizonMode, inp: FinderInputs, unsupported: string[] = []): string {
  return JSON.stringify([datasetId, mode, inp.siteIds, unsupported, inp.days, inp.fromDate, inp.toDate, inp.hour, SPACING_DAYS]);
}

// ------------------------------------------------------------ best arrival per site

/**
 * match: the site's best candidate under the criterion that meets every selected limit.
 * no-match: ranked candidates exist but none meets the limits (nothing is relaxed).
 * unknown-data: no candidate can be ranked or checked because of unknown states.
 * coverage: no candidate window is fully covered by the site's data.
 * unsupported: the site has no visibility for the selected horizon model (not searched).
 */
export type SiteBestState = "match" | "no-match" | "unknown-data" | "coverage" | "unsupported";

export interface SiteBest {
  siteId: string;
  state: SiteBestState;
  row: FinderRow | null;
  /** Global rank (all searched sites ranked together) of the best row. */
  rank: number | null;
  /** Explanation for a site without a match, or notes for a match. */
  detail: string;
}

const COVERAGE_REASON = "not fully covered";

export function bestPerSite(rows: FinderRow[], c: Criterion, l: Limits, siteIds: string[], unsupported: { id: string; reason: string }[] = []): SiteBest[] {
  const v = resultView(rows, c, l);
  const anyLimits = activeLimits(l).length > 0;
  const out: SiteBest[] = siteIds.map((siteId): SiteBest => {
    const mine = (list: FinderRow[]) => list.filter((r) => r.siteId === siteId);
    const ranked = mine(v.ranking.ranked);
    const meeting = mine(v.meeting);
    const unev = mine(v.ranking.unevaluable);
    const unevNote = unev.length ? `${unev.length} candidate${unev.length === 1 ? "" : "s"} with unknown data not ranked.` : "";
    if (meeting.length) {
      const row = meeting[0];
      return { siteId, state: "match", row, rank: v.ranking.ranked.indexOf(row) + 1, detail: unevNote };
    }
    const all = mine(rows);
    if (!ranked.length) {
      const coverage = all.length === 0 || all.every((r) => (metricReason(r, c) ?? "").includes(COVERAGE_REASON));
      return coverage
        ? { siteId, state: "coverage", row: null, rank: null, detail: "No candidate mission is fully covered by this site\u2019s data; missions are never shortened." }
        : { siteId, state: "unknown-data", row: null, rank: null, detail: `All ${all.length} candidates have unknown data for ${criterionInfo(c).short.toLowerCase()}; unknown data never counts as favorable.` };
    }
    const failing = mine(v.failing).length;
    const unknown = mine(v.limitUnknown).length;
    if (anyLimits && failing === 0 && unknown > 0) {
      return { siteId, state: "unknown-data", row: null, rank: null, detail: `The selected limits cannot be checked for any of ${unknown} candidates: part of each mission has unknown data.` };
    }
    return {
      siteId,
      state: "no-match",
      row: null,
      rank: null,
      detail: `None of ${ranked.length} ranked candidates meets the selected limits${unknown ? ` (${unknown} could not be checked: unknown data)` : ""}. Limits were not relaxed.`,
    };
  });
  for (const u of unsupported) out.push({ siteId: u.id, state: "unsupported", row: null, rank: null, detail: u.reason });
  return out;
}

// ------------------------------------------------------------ arrival-delay preview

export interface DelayPreviewRow {
  days: number;
  window: TimeWindow;
  /** false: the full-duration mission with this offset exceeds the coverage (never shortened). */
  enabled: boolean;
  reason: string | null;
  m: WindowMetrics | null;
  outcomes: LimitOutcome[];
  verdict: LimitVerdict;
}

/**
 * The chosen arrival and the +1/+3/+7-day slips (mission.ts delayOptions: offsets from the
 * chosen arrival, duration unchanged), each evaluated with computeMetrics on the same site's
 * intervals and checked against the selected limits. Pure: changes nothing.
 */
export function delayPreview(intervals: Interval[], arrival: number, durationMs: number, cov: TimeWindow, l: Limits, siteId = ""): DelayPreviewRow[] {
  return delayOptions(arrival, durationMs, cov).map((o): DelayPreviewRow => {
    if (!o.enabled) return { days: o.days, window: o.window, enabled: false, reason: o.reason, m: null, outcomes: [], verdict: "none" };
    const m = computeMetrics(intervals, o.window);
    const outcomes = limitOutcomes({ siteId, arrival: o.window.start, end: o.window.end, m }, l);
    return { days: o.days, window: o.window, enabled: true, reason: null, m, outcomes, verdict: verdict(outcomes) };
  });
}

// ------------------------------------------------------------ applying a result

/** The scenario fields an applied result may touch (and the ones it must preserve). */
export interface ScenarioCore {
  selIds: string[];
  active: string;
  arrival: number;
  days: number;
  delay: number;
  mission: MissionKey;
  /** Selected viewing time. */
  t: number;
  mode: HorizonMode;
  view: View;
  cam: CamMode;
  layer: LayerKey;
  thr: number;
  playing: boolean;
}

/**
 * The scenario after "Use this arrival": playback paused, the result's site active, baseline
 * arrival and duration set to the searched values, delay None with the baseline mission, and the
 * viewing time at the new arrival. A site not yet compared is added (catalog order, at most
 * MAX_SITES; otherwise the apply is refused). Other sites, model, view, camera and overlay are preserved.
 */
export function applyResult(cur: ScenarioCore, r: { siteId: string; arrival: number; days: number }, allIds: string[] = cur.selIds): ScenarioCore {
  let selIds = cur.selIds;
  if (!selIds.includes(r.siteId)) {
    // a site outside the comparison is added under the existing shortlist rules, or not at all
    const blocked = addBlockedReason(selIds, r.siteId, allIds);
    if (blocked) throw new Error(`${r.siteId} cannot be added: ${blocked}`);
    selIds = withSite(selIds, r.siteId, allIds);
  }
  return { ...cur, selIds, playing: false, active: r.siteId, arrival: r.arrival, days: r.days, delay: 0, mission: "baseline", t: r.arrival };
}

// ------------------------------------------------------------ CSV export

export interface CsvSite {
  id: string;
  name: string;
  latitude_deg: number;
  longitude_deg_east: number;
  observer_height_above_surface_m: number;
  /** Provisional designation for this model, or null. */
  provisional: string | null;
}

export interface CsvContext {
  datasetId: string;
  mode: HorizonMode;
  inputs: FinderInputs;
  sampleStepSeconds: number;
  visibilityMethod: string;
  criterion: Criterion;
  limits: Limits;
  sites: CsvSite[];
}

const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
const num = (v: number | null, d: number) => (v === null ? "" : v.toFixed(d));
const yn = (b: boolean) => (b ? "yes" : "no");
const minutes = (h: number | null) => (h === null ? "" : String(Math.round(h * 60)));
function cell(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export const CSV_COLUMNS = [
  "dataset_id",
  "search_earliest_arrival_utc",
  "search_latest_arrival_utc",
  "candidate_spacing_days",
  "candidate_arrival_hour_utc",
  "ranking_criterion",
  "rank",
  "site_id",
  "site_name",
  "latitude_deg_north",
  "longitude_deg_east",
  "modeled_observer_height_above_surface_m",
  "horizon_model",
  "temporal_sampling",
  "arrival_utc",
  "mission_end_utc",
  "mission_duration_days",
  "sun_visible_pct",
  "earth_visible_pct",
  "sun_and_earth_visible_pct",
  "longest_sun_blockage_within_mission_h",
  "longest_sun_blockage_within_mission_min",
  "sun_blockage_touches_mission_start",
  "sun_blockage_touches_mission_end",
  "longest_earth_blockage_within_mission_h",
  "longest_earth_blockage_within_mission_min",
  "earth_blockage_touches_mission_start",
  "earth_blockage_touches_mission_end",
  "data_coverage",
  ...LIMIT_KEYS.flatMap((k) => [`limit_${snake(k)}`, `limit_${snake(k)}_outcome`]),
  "meets_selected_limits",
  "provisional_designation",
] as const;

function snake(k: LimitKey): string {
  return { minSunPct: "min_sun_visible_pct", minEarthPct: "min_earth_visible_pct", maxSunBlockH: "max_sun_blockage_within_mission_h", maxEarthBlockH: "max_earth_blockage_within_mission_h" }[k];
}

const VERDICT_TEXT: Record<LimitVerdict, string> = { none: "no limits selected", meets: "meets selected limits", fails: "does not meet selected limits", unknown: "cannot be checked (unknown data)" };

/** CSV of every evaluated row: ranked rows in rank order, then unevaluable rows. Same values as the interface. */
export function finderCsv(rows: FinderRow[], ctx: CsvContext): string {
  const { ranked, unevaluable } = rank(rows, ctx.criterion);
  const lines = [CSV_COLUMNS.join(",")];
  const inp = ctx.inputs;
  const flags = (a: Availability<DarkRun | null>) => (a.ok ? (a.value ? [yn(a.value.touchesStart), yn(a.value.touchesEnd)] : ["no", "no"]) : ["", ""]);
  const emit = (r: FinderRow, rankNo: number | null) => {
    const s = ctx.sites.find((x) => x.id === r.siteId)!;
    const out = limitOutcomes(r, ctx.limits);
    const reasons = [...new Set((["sun", "earth", "both", "sunBlock", "earthBlock"] as Criterion[]).map((c) => metricReason(r, c)).filter((x): x is string => x !== null))];
    const vals: string[] = [
      ctx.datasetId,
      iso(Date.UTC(+inp.fromDate.slice(0, 4), +inp.fromDate.slice(5, 7) - 1, +inp.fromDate.slice(8, 10), inp.hour)),
      iso(Date.UTC(+inp.toDate.slice(0, 4), +inp.toDate.slice(5, 7) - 1, +inp.toDate.slice(8, 10), inp.hour)),
      String(SPACING_DAYS),
      hh(inp.hour),
      criterionInfo(ctx.criterion).label,
      rankNo === null ? "" : String(rankNo),
      s.id,
      s.name,
      String(s.latitude_deg),
      String(s.longitude_deg_east),
      String(s.observer_height_above_surface_m),
      ctx.mode === "terrain" ? "Terrain horizon" : "Smooth horizon (0 deg plane)",
      `${ctx.sampleStepSeconds} s samples; ${ctx.visibilityMethod}; body centers`,
      iso(r.arrival),
      iso(r.end),
      String((r.end - r.arrival) / DAY_MS),
      num(metricValue(r, "sun"), 6),
      num(metricValue(r, "earth"), 6),
      num(metricValue(r, "both"), 6),
      num(metricValue(r, "sunBlock"), 4),
      minutes(metricValue(r, "sunBlock")),
      ...flags(r.m.longestDark),
      num(metricValue(r, "earthBlock"), 4),
      minutes(metricValue(r, "earthBlock")),
      ...flags(r.m.longestEarthBlock),
      reasons.length ? `incomplete: ${reasons.join("; ")}` : "complete",
      ...LIMIT_KEYS.flatMap((k) => {
        const o = out.find((x) => x.key === k);
        return o ? [String(o.limit), o.state] : ["", "not set"];
      }),
      VERDICT_TEXT[verdict(out)],
      s.provisional ?? "",
    ];
    lines.push(vals.map(cell).join(","));
  };
  ranked.forEach((r, i) => emit(r, i + 1));
  unevaluable.forEach((r) => emit(r, null));
  return lines.join("\r\n") + "\r\n";
}

/** File name for the CSV export. */
export function csvFileName(datasetId: string, mode: HorizonMode, inp: FinderInputs): string {
  return `arrival-windows_${datasetId}_${mode}_${inp.days}d_${inp.fromDate}_to_${inp.toDate}_${String(inp.hour).padStart(2, "0")}Z.csv`;
}
