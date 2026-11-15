// The shared scenario: one state for Explore (3D) and Analysis (dashboard).
// Moved out of the former Workspace component unchanged in its rules: the same arrival
// bounds, delay validation, cursor clamping, strict horizon-model selection, metrics and
// selected-time status (status.ts). Both views read this object; neither computes its
// own visibility.

import { useEffect, useMemo, useRef, useState } from "react";
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
import type { CatalogSite, Dataset, Horizon, HorizonMode, SiteData, SiteEntry } from "./types";
import { DEFAULT_THRESHOLD_DEG, clampThreshold } from "./explore/slope";
import { type ScenarioCore, applyResult } from "./finder";
import { type CamMode, type LayerKey, type MissionKey, type View, DEFAULT_VIEW, type SiteRequest, addBlockedReason, parseUrlState, resolveActive, resolveSites, withSite, withoutSite, writeUrlState } from "./urlState";

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

/** A selected site that has no view in the current model: still loading, failed, or lacking terrain. */
export interface PendingSite {
  id: string;
  short: string;
  catalog: CatalogSite;
  state: "loading" | "error" | "no-terrain";
  reason: string;
}
export type SiteLoad = { state: "loading" } | { state: "ready"; entry: SiteEntry } | { state: "error"; message: string };

export interface Scenario {
  ds: Dataset;
  times: number[];
  view: View;
  setView: (v: View) => void;
  /** Catalog site IDs (the dataset's sites), in catalog order. */
  allIds: string[];
  requested: SiteRequest;
  /** The link's arrival when it had to be moved into this dataset's coverage (link snapshot; null otherwise). */
  arrivalMoved: { from: number; to: number } | null;
  /** Selected (compared) sites, in the user's order; 1 to MAX_SITES, no duplicates. */
  selIds: string[];
  /** Add a catalog site to the comparison and make it active. False when it cannot be added. */
  addSite: (id: string) => boolean;
  /** Remove a site from the comparison (never the last one). */
  removeSite: (id: string) => void;
  /** Why a catalog site cannot be added right now, or null. */
  addBlocked: (id: string) => string | null;
  active: string;
  /** Make a site active (adds it to the compared sites if there is room). */
  setActive: (id: string) => void;
  /** Catalog entry of a site. */
  catalogSite: (id: string) => CatalogSite;
  /** Load state of each requested site file. */
  loads: Record<string, SiteLoad>;
  retrySite: (id: string) => void;
  /** Selected sites without a view in this model, in selection order. */
  pending: PendingSite[];
  avail: ModeAvailability;
  mode: HorizonMode;
  setMode: (m: HorizonMode) => void;
  /** Terrain mode while at least one selected site has no terrain horizon (those sites show no metrics). */
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
  /** Selected sites with data in the current model, in selection order. */
  views: SiteView[];
  /** Null while the active site is loading, failed, or lacks the current model. */
  activeView: SiteView | null;
  activeSite: SiteData | null;
  horizon: Horizon | null;
  /**
   * Arrival Window Finder "Use this arrival" (finder.ts applyResult): pauses playback, makes the
   * site active (adding it to the comparison under the shortlist rules when it is not compared),
   * sets the baseline arrival and duration, resets the delay to None with the baseline mission,
   * and sets the viewing time to the arrival. Model, view, camera and overlay are preserved.
   * `entry`: the finder's already-checked site file of this dataset, reused instead of loading it
   * again. Changes nothing and returns the reason when the result does not fit.
   */
  applyArrival: (r: { siteId: string; arrival: number; days: number; entry?: SiteEntry }) => { ok: true; added: boolean } | { ok: false; reason: string };
  /** Increments on every applied finder result (views drop crossing selections and tracking). */
  applyN: number;
}

/** A scenario whose active site has a view: what Explore and Analysis render. */
export type ReadyScenario = Scenario & { activeView: SiteView; activeSite: SiteData; horizon: Horizon };
export const isReady = (sc: Scenario): sc is ReadyScenario => sc.activeView !== null;

export function useScenario(ds: Dataset, search?: string): Scenario {
  const { times } = ds;
  // The link is read once: the URL is rewritten to the canonical state afterwards, and re-reading
  // it on later renders would lose what the original link asked for (e.g. unknown site IDs).
  const [init] = useState(() => parseUrlState(search ?? window.location.search));
  const allIds = ds.catalog.sites.map((s) => s.id);
  const catalogSite = (id: string) => ds.catalog.sites.find((c) => c.id === id)!;
  const [requested] = useState(() => resolveSites(init.sites, allIds));
  const [selIds, setSelIds] = useState<string[]>(requested.ids);
  const [activeRaw, setActiveRaw] = useState<string>(() => resolveActive(init.site, requested.ids));
  const active = resolveActive(activeRaw, selIds);
  // Site files: preloaded ones are ready; any other selected site is loaded on demand.
  const [loads, setLoads] = useState<Record<string, SiteLoad>>(() => Object.fromEntries(ds.sites.map((e) => [e.id, { state: "ready", entry: e } as SiteLoad])));
  const [retryN, setRetryN] = useState(0);
  const started = useRef(new Set<string>());
  useEffect(() => {
    for (const id of selIds) {
      if (loads[id] || started.current.has(id)) continue;
      started.current.add(id);
      if (!ds.loadSite) {
        setLoads((m) => ({ ...m, [id]: { state: "error", message: "site data was not loaded" } }));
        continue;
      }
      setLoads((m) => ({ ...m, [id]: { state: "loading" } }));
      ds.loadSite(id).then(
        (entry) => setLoads((m) => ({ ...m, [id]: { state: "ready", entry } })),
        (e: unknown) => setLoads((m) => ({ ...m, [id]: { state: "error", message: e instanceof Error ? e.message : String(e) } })),
      );
    }
  }, [selIds, retryN]); // eslint-disable-line react-hooks/exhaustive-deps
  const readyEntry = (id: string) => {
    const l = loads[id];
    return l && l.state === "ready" ? l.entry : null;
  };
  const entries = selIds.map(readyEntry).filter((e): e is SiteEntry => e !== null);
  const [view, setViewRaw] = useState<View>(init.view ?? DEFAULT_VIEW);
  const [playing, setPlaying] = useState(false);
  const [applyN, setApplyN] = useState(0);
  const [missionRaw, setMissionRaw] = useState<MissionKey>(() => init.mission ?? ((init.delay ?? 3) > 0 ? "delayed" : "baseline"));
  const [cam, setCam] = useState<CamMode>(init.cam ?? "overview");
  // One overlay state. Default (no explicit preference): steep-area highlights. Only the user changes it.
  const [layer, setLayer] = useState<LayerKey>(init.layer ?? "exceed");
  const [slopeThr, setSlopeThrRaw] = useState(() => (init.thr !== null && init.thr !== undefined ? clampThreshold(init.thr) : DEFAULT_THRESHOLD_DEG));

  // One horizon model for every compared site. Terrain is never mixed with Smooth: a selected site
  // without a terrain horizon shows no metrics in Terrain mode, and the user is offered an explicit
  // common Smooth comparison instead (no automatic fallback).
  const avail = modeAvailability(entries, selIds.filter((id) => !readyEntry(id)).map(catalogSite));
  const [mode, setModeRaw] = useState<HorizonMode>(() => init.horizon ?? "terrain");
  const terrainRequestedButMissing = mode === "terrain" && !avail.terrain;

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
  const [arrivalMoved] = useState(() => (init.arrival !== null && snapHour(init.arrival) !== arrival ? { from: snapHour(init.arrival), to: arrival } : null));
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
  // parsed intervals per loaded site and model (each site's own file only)
  const cache = useMemo(() => new Map<SiteEntry, Map<HorizonMode, Interval[]>>(), []);
  const intervalsFor = (e: SiteEntry): Interval[] | null => {
    if (mode === "terrain" && !e.data.terrain_horizon) return null;
    let m = cache.get(e);
    if (!m) cache.set(e, (m = new Map()));
    let iv = m.get(mode);
    if (!iv) m.set(mode, (iv = parseIntervals(e.data, strictIntervals(e.data, mode))));
    return iv;
  };
  const shortOf = (id: string) => profileFor(readyEntry(id)?.data ?? null, catalogSite(id)).short;
  const pending: PendingSite[] = [];
  const views: SiteView[] = [];
  for (const id of selIds) {
    const l = loads[id];
    const base = { id, short: shortOf(id), catalog: catalogSite(id) };
    if (!l || l.state === "loading") pending.push({ ...base, state: "loading", reason: "loading site data" });
    else if (l.state === "error") pending.push({ ...base, state: "error", reason: l.message });
    else if (!intervalsFor(l.entry)) {
      const c = catalogSite(id).capabilities.terrain_horizon;
      pending.push({ ...base, state: "no-terrain", reason: l.entry.terrainProblem ?? (c.available ? "no terrain horizon" : c.reason) });
    }
  }
  for (const entry of entries) {
    const intervals = intervalsFor(entry);
    if (!intervals) continue;
    const base = computeMetrics(intervals, baseW);
    const act = computeMetrics(intervals, actW);
    const input = { samples: entry.data.samples, times, horizon: strictHorizon(entry.data, mode), intervals, mode };
    const status = selectedTimeStatus(input, cursorT);
    const statusSel = selT === cursorT ? status : selectedTimeStatus(input, selT);
    views.push({ entry, data: entry.data, profile: profileFor(entry.data, catalogSite(entry.id)), intervals, base, act, cmp: compare(base, act), status, statusSel });
  }
  const activeView = views.find((v) => v.entry.id === active) ?? null;
  const activeSite = activeView?.data ?? null;
  const horizon = activeSite ? strictHorizon(activeSite, mode) : null;

  // URL: replaceState only (never a history entry), and not while playback is running.
  useEffect(() => {
    if (playing) return;
    const url = writeUrlState(new URL(window.location.href), {
      arrival, days, delay: effDelay, t: new Date(times[sel]).toISOString().replace(".000Z", "Z"), horizon: mode, sites: selIds, site: active, view, mission, cam, layer, thr: slopeThr,
    });
    url.searchParams.set("ds", ds.manifest.dataset_id);
    window.history.replaceState(null, "", url);
  }, [arrival, days, effDelay, sel, times, mode, selIds, active, view, playing, mission, cam, layer, slopeThr]);

  // Playback stops at the supported endpoint of the shown window.
  useEffect(() => {
    if (playing && sel >= playEnd) setPlaying(false);
  }, [playing, sel, playEnd]);

  // Changing what is shown pauses playback (the dataset or window changes underneath it).
  const pausing = <T,>(f: (v: T) => void) => (v: T) => {
    setPlaying(false);
    f(v);
  };

  const addBlocked = (id: string) => addBlockedReason(selIds, id, allIds);

  const applyArrival: Scenario["applyArrival"] = (r) => {
    const b = arrivalBounds(cov, r.days * DAY_MS);
    if (!b || !Number.isInteger(r.days) || r.days < 1 || r.days > maxDays || r.arrival < b.earliest || r.arrival > b.latest || snapHour(r.arrival) !== r.arrival) {
      return { ok: false, reason: "the mission does not fit this dataset's coverage" };
    }
    if (r.entry && (r.entry.id !== r.siteId || !ds.catalog.sites.some((c) => c.id === r.siteId))) return { ok: false, reason: "site data does not belong to this dataset" };
    let next: ScenarioCore;
    try {
      next = applyResult(
        { selIds, active, arrival, days, delay, mission, t: selT, mode, view, cam, layer, thr: slopeThr, playing },
        r,
        allIds,
      );
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
    const added = !selIds.includes(r.siteId);
    if (added) {
      const entry = r.entry;
      if (entry && !loads[r.siteId]) {
        started.current.add(r.siteId);
        setLoads((m) => ({ ...m, [r.siteId]: { state: "ready", entry } }));
      }
      setSelIds(next.selIds);
    }
    setPlaying(next.playing);
    setActiveRaw(next.active);
    setDaysRaw(next.days);
    setArrivalRaw(next.arrival);
    setDelayRaw(next.delay);
    setMissionRaw(next.mission);
    setCursorRaw(nearestIndex(times, next.t));
    setApplyN((n) => n + 1);
    return { ok: true, added };
  };

  return {
    ds,
    times,
    view,
    setView: pausing(setViewRaw),
    allIds,
    requested,
    arrivalMoved,
    selIds,
    addSite: (id: string) => {
      if (addBlocked(id)) return false;
      setPlaying(false);
      setSelIds((ids) => withSite(ids, id, allIds));
      setActiveRaw(id);
      return true;
    },
    removeSite: pausing((id: string) => {
      const r = withoutSite(selIds, id, active);
      setSelIds(r.sel);
      setActiveRaw(r.active);
    }),
    addBlocked,
    active,
    setActive: pausing((id: string) => {
      if (!allIds.includes(id)) return;
      if (!selIds.includes(id)) {
        if (addBlocked(id)) return;
        setSelIds((ids) => withSite(ids, id, allIds));
      }
      setActiveRaw(id);
    }),
    catalogSite,
    loads,
    retrySite: (id: string) => {
      if (loads[id]?.state !== "error") return;
      started.current.delete(id);
      setLoads((m) => {
        const n = { ...m };
        delete n[id];
        return n;
      });
      setRetryN((k) => k + 1);
    },
    pending,
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
    applyArrival,
    applyN,
  };
}
