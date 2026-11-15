// The shared scenario: one state for Explore (3D) and Analysis (dashboard).
// Moved out of the former Workspace component unchanged in its rules: the same arrival
// bounds, delay validation, cursor clamping, strict horizon-model selection, metrics and
// selected-time status (status.ts). Both views read this object; neither computes its
// own visibility.

import { useEffect, useMemo, useState } from "react";
import { nearestIndex } from "./data";
import {
  type Comparison,
  type DelayOption,
  type Interval,
  type TimeWindow,
  type WindowMetrics,
  DAY_MS,
  DEFAULT_DURATION_DAYS,
  arrivalBounds,
  compare,
  computeMetrics,
  delayOptions,
  parseIntervals,
  scenarioWindow,
} from "./mission";
import { type ModeAvailability, type SiteProfile, modeAvailability, profileFor, strictHorizon, strictIntervals } from "./sites";
import { type SelectedStatus, selectedTimeStatus } from "./status";
import type { Dataset, Horizon, HorizonMode, SiteData, SiteEntry } from "./types";
import { DEFAULT_THRESHOLD_DEG, clampThreshold } from "./explore/slope";
import { type CamMode, type LayerKey, type MissionKey, type View, DEFAULT_VIEW, parseUrlState, resolveActive, resolveSites, writeUrlState } from "./urlState";

export const DEFAULT_ARRIVAL = "2026-12-05T00:00:00Z";
export const clampNum = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export interface SiteView {
  entry: SiteEntry;
  data: SiteData;
  profile: SiteProfile;
  intervals: Interval[];
  base: WindowMetrics;
  act: WindowMetrics;
  cmp: Comparison;
  /** Status at the Analysis cursor (selected time clamped to the shown windows): cards, readouts, panorama. */
  status: SelectedStatus;
  /** Status at the selected viewing time itself (Explore; may lie outside the mission windows). */
  statusSel: SelectedStatus;
}

export interface Scenario {
  ds: Dataset;
  times: number[];
  view: View;
  setView: (v: View) => void;
  allIds: string[];
  requested: { ids: string[]; unknown: string[] };
  selIds: string[];
  toggleSite: (id: string) => void;
  active: string;
  /** Make a site active (adds it to the compared sites if needed). */
  setActive: (id: string) => void;
  avail: ModeAvailability;
  mode: HorizonMode;
  setMode: (m: HorizonMode) => void;
  terrainRequestedButMissing: boolean;
  cov: TimeWindow;
  maxDays: number;
  days: number;
  setDays: (d: number) => void;
  durationMs: number;
  bounds: { earliest: number; latest: number };
  arrival: number;
  setArrival: (ms: number) => void;
  delay: number;
  setDelay: (d: number) => void;
  options: DelayOption[];
  chosen: DelayOption;
  effDelay: number;
  baseW: TimeWindow;
  actW: TimeWindow;
  domain: TimeWindow;
  i0: number;
  i1: number;
  /** Analysis cursor: the selected time clamped to the shown windows [i0, i1] (unchanged behavior). */
  cursor: number;
  cursorT: number;
  /** Selected viewing time as a sample index anywhere in the coverage (Explore). */
  sel: number;
  selT: number;
  /** Set the selected viewing time anywhere in the coverage (never changes arrival, duration or delay). */
  setSel: (i: number) => void;
  /** Step the selected viewing time by n samples, clamped to the coverage. */
  stepSel: (n: number) => void;
  /** Explore: which mission window is active (delayed only when a delay applies). */
  mission: MissionKey;
  setMission: (m: MissionKey) => void;
  /** Explore camera mode. */
  cam: CamMode;
  setCam: (c: CamMode) => void;
  /** 5C: terrain layer in the Site overview (display only; never changes visibility). */
  layer: LayerKey;
  setLayer: (l: LayerKey) => void;
  /** 5C: illustrative slope screening threshold (deg); changes only screening classifications. */
  slopeThr: number;
  setSlopeThr: (deg: number) => void;
  setCursor: (i: number) => void;
  /** Step the cursor by n samples (10 minutes each), clamped to [i0, i1]. */
  step: (n: number) => void;
  playing: boolean;
  setPlaying: (p: boolean) => void;
  views: SiteView[];
  activeView: SiteView;
  activeSite: SiteData;
  horizon: Horizon;
}

export function useScenario(ds: Dataset, search?: string): Scenario {
  const { times } = ds;
  // The link is read once: the URL is rewritten to the canonical state afterwards, and re-reading
  // it on later renders would lose what the original link asked for (e.g. unknown site IDs).
  const [init] = useState(() => parseUrlState(search ?? window.location.search));
  const allIds = ds.sites.map((s) => s.id);
  const [requested] = useState(() => resolveSites(init.sites, allIds));
  const [selIds, setSelIds] = useState<string[]>(requested.ids);
  const entries = ds.sites.filter((e) => selIds.includes(e.id));
  const [activeRaw, setActiveRaw] = useState<string>(() => resolveActive(init.site, requested.ids));
  const active = resolveActive(activeRaw, selIds);
  const [view, setViewRaw] = useState<View>(init.view ?? DEFAULT_VIEW);
  const [playing, setPlaying] = useState(false);
  const [missionRaw, setMissionRaw] = useState<MissionKey>(() => init.mission ?? ((init.delay ?? 3) > 0 ? "delayed" : "baseline"));
  const [cam, setCam] = useState<CamMode>(init.cam ?? "overview");
  // One overlay state. Default (no explicit preference): steep-area highlights. Only the user changes it.
  const [layer, setLayer] = useState<LayerKey>(init.layer ?? "exceed");
  const [slopeThr, setSlopeThrRaw] = useState(() => (init.thr !== null && init.thr !== undefined ? clampThreshold(init.thr) : DEFAULT_THRESHOLD_DEG));

  // One horizon model for every compared site; Terrain only when all of them have it.
  const avail = modeAvailability(entries);
  const [modeRaw, setModeRaw] = useState<HorizonMode>(() => init.horizon ?? "terrain");
  const mode: HorizonMode = modeRaw === "terrain" && !avail.terrain ? "smooth" : modeRaw;
  const terrainRequestedButMissing = modeRaw === "terrain" && !avail.terrain;

  // Coverage: every site shares the same sample times (checked by the loader), so this is the common coverage.
  const cov = { start: times[0], end: times[times.length - 1] };
  const maxDays = Math.floor((cov.end - cov.start) / DAY_MS);
  const [days, setDaysRaw] = useState(() => clampNum(Math.round(init.days ?? DEFAULT_DURATION_DAYS), 1, maxDays));
  const durationMs = days * DAY_MS;
  const bounds = arrivalBounds(cov, durationMs)!; // days <= maxDays guarantees a valid range
  const snapHour = (ms: number) => Math.round(ms / 3_600_000) * 3_600_000;
  const [arrival, setArrivalRaw] = useState(() =>
    clampNum(snapHour(init.arrival ?? Date.parse(DEFAULT_ARRIVAL)), bounds.earliest, bounds.latest),
  );
  const [delay, setDelayRaw] = useState(() => ([0, 1, 3, 7].includes(init.delay ?? -1) ? init.delay! : 3));
  useEffect(() => {
    setArrivalRaw((a) => clampNum(a, bounds.earliest, bounds.latest));
  }, [bounds.earliest, bounds.latest]);

  const options = delayOptions(arrival, durationMs, cov);
  const chosen = options.find((o) => o.days === delay)!;
  const effDelay = chosen.enabled ? delay : 0;
  const baseW = options[0].window;
  const actW = scenarioWindow(arrival, effDelay, durationMs);
  const domain = { start: baseW.start, end: Math.max(baseW.end, actW.end) };
  const i0 = nearestIndex(times, domain.start);
  const i1 = nearestIndex(times, domain.end);
  // One selected time. Explore may view it anywhere in the coverage; Analysis keeps its
  // established behavior of showing it clamped to the scenario windows.
  const last = times.length - 1;
  const [cursorRaw, setCursorRaw] = useState(() => nearestIndex(times, init.t ?? actW.start));
  const sel = clampNum(cursorRaw, 0, last);
  const selT = times[sel];
  const cursor = clampNum(cursorRaw, i0, i1);
  const cursorT = times[cursor];
  const mission: MissionKey = missionRaw === "delayed" && effDelay > 0 ? "delayed" : "baseline";
  // playback runs to the end of the shown windows, or (when already past them) to the end of the data
  const playEnd = sel < i1 ? i1 : last;

  // Per-site results for the shared model and the identical windows.
  const intervalsBySite = useMemo(() => {
    const m = new Map<string, Interval[]>();
    for (const e of ds.sites) {
      if (mode === "terrain" && !e.data.terrain_horizon) continue;
      m.set(e.id, parseIntervals(e.data, strictIntervals(e.data, mode)));
    }
    return m;
  }, [ds, mode]);
  const views: SiteView[] = entries.map((entry) => {
    const intervals = intervalsBySite.get(entry.id)!;
    const base = computeMetrics(intervals, baseW);
    const act = computeMetrics(intervals, actW);
    const input = { samples: entry.data.samples, times, horizon: strictHorizon(entry.data, mode), intervals, mode };
    const status = selectedTimeStatus(input, cursorT);
    const statusSel = selT === cursorT ? status : selectedTimeStatus(input, selT);
    return { entry, data: entry.data, profile: profileFor(entry.data), intervals, base, act, cmp: compare(base, act), status, statusSel };
  });
  const activeView = views.find((v) => v.entry.id === active)!;
  const activeSite = activeView.data;
  const horizon = strictHorizon(activeSite, mode);

  // URL: replaceState only (never a history entry), and not while playback is running.
  useEffect(() => {
    if (playing) return;
    const url = writeUrlState(new URL(window.location.href), {
      arrival, days, delay: effDelay, t: activeSite.samples[sel].time_utc, horizon: mode, sites: selIds, site: active, view, mission, cam, layer, thr: slopeThr,
    });
    window.history.replaceState(null, "", url);
  }, [arrival, days, effDelay, sel, activeSite, mode, selIds, active, view, playing, mission, cam, layer, slopeThr]);

  // Playback stops at the supported endpoint of the shown window.
  useEffect(() => {
    if (playing && sel >= playEnd) setPlaying(false);
  }, [playing, sel, playEnd]);

  // Changing what is shown pauses playback (the dataset or window changes underneath it).
  const pausing = <T,>(f: (v: T) => void) => (v: T) => {
    setPlaying(false);
    f(v);
  };

  return {
    ds,
    times,
    view,
    setView: pausing(setViewRaw),
    allIds,
    requested,
    selIds,
    toggleSite: pausing((id: string) =>
      setSelIds((ids) => (ids.includes(id) ? (ids.length > 1 ? ids.filter((x) => x !== id) : ids) : allIds.filter((x) => x === id || ids.includes(x)))),
    ),
    active,
    setActive: pausing((id: string) => {
      if (!allIds.includes(id)) return;
      setSelIds((ids) => (ids.includes(id) ? ids : allIds.filter((x) => x === id || ids.includes(x))));
      setActiveRaw(id);
    }),
    avail,
    mode,
    setMode: pausing(setModeRaw),
    terrainRequestedButMissing,
    cov,
    maxDays,
    days,
    setDays: pausing((d: number) => setDaysRaw(clampNum(Math.round(d), 1, maxDays))),
    durationMs,
    bounds,
    arrival,
    setArrival: pausing((ms: number) => setArrivalRaw(clampNum(snapHour(ms), bounds.earliest, bounds.latest))),
    delay,
    setDelay: pausing(setDelayRaw),
    options,
    chosen,
    effDelay,
    baseW,
    actW,
    domain,
    i0,
    i1,
    cursor,
    cursorT,
    setCursor: (i: number) => setCursorRaw(clampNum(i, i0, i1)),
    step: (n: number) => setCursorRaw((c) => clampNum(clampNum(c, i0, i1) + n, i0, i1)),
    playing,
    sel,
    selT,
    setSel: (i: number) => setCursorRaw(clampNum(i, 0, last)),
    stepSel: (n: number) => setCursorRaw((c) => clampNum(clampNum(c, 0, last) + n, 0, last)),
    mission,
    setMission: setMissionRaw,
    cam,
    setCam,
    layer,
    setLayer,
    slopeThr,
    setSlopeThr: (deg: number) => {
      if (Number.isFinite(deg)) setSlopeThrRaw(clampThreshold(deg));
    },
    setPlaying: (p: boolean) => setPlaying(p && sel < playEnd),
    views,
    activeView,
    activeSite,
    horizon,
  };
}
