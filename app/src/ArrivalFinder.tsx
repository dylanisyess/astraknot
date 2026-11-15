// Arrival Window Finder drawer (release 7). A bounded daily search over the cached intervals of
// any site in the current dataset (finder.ts), with the scenario's horizon model. Its inputs are
// separate from the scenario: searching, filtering and previewing never change the arrival,
// duration, delay, sites or viewing time. Only "Use this arrival" does, through
// scenario.applyArrival (which adds a site that is not yet compared, under the shortlist rules).

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fmtUtc } from "./data";
import {
  type Criterion,
  type DelayPreviewRow,
  type FinderInputs,
  type FinderRow,
  type FinderSite,
  type FinderSiteOption,
  type LimitKey,
  type LimitOutcome,
  type Limits,
  type SiteBest,
  CRITERIA,
  DEFAULT_CRITERION,
  DEFAULT_SHOWN,
  LIMIT_INFO,
  LIMIT_KEYS,
  NO_LIMITS,
  SPACING_DAYS,
  activeLimits,
  arrivalLimits,
  bestPerSite,
  checkInputs,
  commonCoverage,
  criterionInfo,
  csvFileName,
  delayPreview,
  evaluate,
  finderCsv,
  limitOutcomes,
  metricReason,
  metricValue,
  resultView,
  searchKey,
  siteProblems,
  verdict,
  windowValue,
} from "./finder";
import { type Availability, type DarkRun, type Interval, type TimeWindow, type WindowMetrics, DAY_MS, fmtOutage, fmtPct, fmtSigned, parseIntervals, utcHour } from "./mission";
import type { Scenario } from "./scenario";
import { profileFor, strictIntervals } from "./sites";
import type { HorizonMode, SiteEntry } from "./types";

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;
const modeName = (m: HorizonMode) => (m === "terrain" ? "Terrain" : "Smooth (0°)");

interface Form {
  activeOnly: boolean;
  /** Sites chosen for the search, any site of the current dataset. */
  chosen: string[];
  days: string;
  fromDate: string;
  toDate: string;
  hour: number;
  /** The user accepted that chosen sites without the selected model are listed as not searched. */
  ackUnsupported: boolean;
}

interface LimitField {
  on: boolean;
  value: string;
}
type LimitForm = Record<LimitKey, LimitField>;
const LIMIT_DEFAULTS: Record<LimitKey, string> = { minSunPct: "60", minEarthPct: "60", maxSunBlockH: "48", maxEarthBlockH: "48" };
const initialLimits = (): LimitForm => Object.fromEntries(LIMIT_KEYS.map((k) => [k, { on: false, value: LIMIT_DEFAULTS[k] }])) as LimitForm;

/** The current scenario's duration and hour, over every valid date for them; by default the compared sites. */
function formFromScenario(sc: Scenario, keepSites?: Form): Form {
  const hour = utcHour(sc.arrival);
  const lim = arrivalLimits(sc.cov, sc.days * DAY_MS, hour);
  return {
    activeOnly: keepSites?.activeOnly ?? false,
    chosen: keepSites?.chosen ?? [...sc.selIds],
    days: String(sc.days),
    fromDate: lim?.earliestDate ?? "",
    toDate: lim?.latestDate ?? "",
    hour,
    ackUnsupported: false,
  };
}

interface Results {
  key: string;
  inputs: FinderInputs;
  unsupported: { id: string; reason: string }[];
  mode: HorizonMode;
  datasetId: string;
  rows: FinderRow[];
  sites: FinderSite[];
  entries: Record<string, SiteEntry>;
  cov: TimeWindow;
  ms: number;
}

type OwnLoad = { state: "loading" } | { state: "ready"; entry: SiteEntry } | { state: "error"; message: string };

function limitsFrom(f: LimitForm): { limits: Limits; problems: string[] } {
  const limits: Limits = { ...NO_LIMITS };
  const problems: string[] = [];
  for (const k of LIMIT_KEYS) {
    if (!f[k].on) continue;
    const v = Number(f[k].value);
    const info = LIMIT_INFO[k];
    const ok = f[k].value.trim() !== "" && Number.isFinite(v) && v >= 0 && (info.unit !== "%" || v <= 100);
    if (ok) limits[k] = v;
    else problems.push(`${info.label}: enter ${info.unit === "%" ? "a percentage from 0 to 100" : "a number of hours, 0 or more"}.`);
  }
  return { limits, problems };
}

function limitsText(l: Limits): string {
  const on = activeLimits(l);
  if (!on.length) return "none";
  return on.map((k) => `${LIMIT_INFO[k].short} ${l[k]}${LIMIT_INFO[k].unit === "%" ? " %" : " h"}`).join(", ");
}

export function FindWindowsButton({ onOpen, className = "" }: { onOpen: () => void; className?: string }) {
  return (
    <button type="button" className={`find-windows-btn ${className}`} onClick={onOpen} aria-haspopup="dialog" data-testid="find-windows">
      Find arrival windows
    </button>
  );
}

export function ArrivalFinder({ sc, open, onClose }: { sc: Scenario; open: boolean; onClose: () => void }) {
  const [form, setForm] = useState<Form>(() => formFromScenario(sc));
  const [limitForm, setLimitForm] = useState<LimitForm>(initialLimits);
  const [criterion, setCriterion] = useState<Criterion>(DEFAULT_CRITERION);
  const [results, setResults] = useState<Results | null>(null);
  const [running, setRunning] = useState(false);
  const [siteFilter, setSiteFilter] = useState<string>("all");
  const [shown, setShown] = useState(DEFAULT_SHOWN);
  const [showFailing, setShowFailing] = useState(false);
  const [applied, setApplied] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [own, setOwn] = useState<Record<string, OwnLoad>>({});
  const gen = useRef(0);
  const focusResults = useRef(false);
  const ref = useRef<HTMLDivElement>(null);
  const parsed = useRef(new WeakMap<SiteEntry, Map<HorizonMode, Interval[]>>());
  const catalog = sc.ds.catalog.sites;
  const mode = sc.mode;

  // ---------------------------------------------------------------- site files (any dataset site)
  // Compared sites come from the scenario; other chosen sites are loaded here with the dataset's
  // own checked loader. Loading a site for a search never adds it to the comparison.
  const entryFor = (id: string): SiteEntry | null => {
    const l = sc.loads[id];
    if (l?.state === "ready") return l.entry;
    const pre = sc.ds.sites.find((e) => e.id === id);
    if (pre) return pre;
    const o = own[id];
    return o?.state === "ready" ? o.entry : null;
  };
  const chosenIds = form.activeOnly ? [sc.active] : catalog.map((c) => c.id).filter((id) => form.chosen.includes(id));
  useEffect(() => {
    for (const id of chosenIds) {
      if (entryFor(id) || sc.loads[id] || own[id]) continue;
      if (!sc.ds.loadSite) {
        setOwn((m) => ({ ...m, [id]: { state: "error", message: "site data was not loaded" } }));
        continue;
      }
      setOwn((m) => ({ ...m, [id]: { state: "loading" } }));
      sc.ds.loadSite(id).then(
        (entry) => setOwn((m) => ({ ...m, [id]: { state: "ready", entry } })),
        (e: unknown) => setOwn((m) => ({ ...m, [id]: { state: "error", message: e instanceof Error ? e.message : String(e) } })),
      );
    }
  }, [chosenIds.join(","), open]); // eslint-disable-line react-hooks/exhaustive-deps

  const intervalsOf = (e: SiteEntry): Interval[] | null => {
    if (mode === "terrain" && !e.data.terrain_horizon) return null;
    let m = parsed.current.get(e);
    if (!m) parsed.current.set(e, (m = new Map()));
    let iv = m.get(mode);
    if (!iv) m.set(mode, (iv = parseIntervals(e.data, strictIntervals(e.data, mode))));
    return iv;
  };
  const shortOf = (id: string) => profileFor(entryFor(id)?.data ?? null, catalog.find((c) => c.id === id)).short;
  const options: FinderSiteOption[] = catalog.map((c) => {
    const short = shortOf(c.id);
    const th = c.capabilities.terrain_horizon;
    if (mode === "terrain" && !th.available) return { id: c.id, short, state: "no-model", reason: th.reason };
    const e = entryFor(c.id);
    if (!e) {
      const l = sc.loads[c.id] ?? own[c.id];
      if (l?.state === "error") return { id: c.id, short, state: "error", reason: l.message };
      return { id: c.id, short, state: "loading", reason: "loading site data" };
    }
    if (!intervalsOf(e)) return { id: c.id, short, state: "no-model", reason: e.terrainProblem ?? "no terrain horizon" };
    return { id: c.id, short, state: "ready", reason: null };
  });
  const optionOf = (id: string) => options.find((o) => o.id === id)!;

  // ---------------------------------------------------------------- inputs
  const unsupported = chosenIds.filter((id) => optionOf(id).state === "no-model").map((id) => ({ id, reason: optionOf(id).reason ?? "" }));
  const inputs: FinderInputs = {
    siteIds: chosenIds.filter((id) => optionOf(id).state !== "no-model"),
    days: Number(form.days),
    fromDate: form.fromDate,
    toDate: form.toDate,
    hour: form.hour,
  };
  const key = searchKey(sc.ds.manifest.dataset_id, mode, inputs, unsupported.map((u) => u.id));
  const sProblems = siteProblems(inputs.siteIds, options, mode);
  const readySites: FinderSite[] = inputs.siteIds.flatMap((id) => {
    const e = entryFor(id);
    const iv = e ? intervalsOf(e) : null;
    return iv ? [{ id, intervals: iv }] : [];
  });
  const cov = (sProblems.length === 0 && commonCoverage(readySites)) || sc.cov;
  const check = checkInputs(inputs, cov);
  const lim = Number.isInteger(inputs.days) && inputs.days >= 1 ? arrivalLimits(cov, inputs.days * DAY_MS, inputs.hour) : null;
  const { limits, problems: limitProblems } = limitsFrom(limitForm);
  const needsAck = unsupported.length > 0 && !form.ackUnsupported;
  const canRun = sProblems.length === 0 && check.ok && !running && !needsAck;
  const stale = results !== null && results.key !== key;

  // An input change abandons a search still in progress (its results never replace newer ones).
  useEffect(() => {
    if (running) {
      gen.current++;
      setRunning(false);
    }
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = () => {
    if (!canRun || !check.ok) return;
    const g = ++gen.current;
    const sites = readySites;
    const entries = Object.fromEntries(inputs.siteIds.map((id) => [id, entryFor(id)!]));
    const chk = check;
    const snapshot = { inputs: { ...inputs, siteIds: [...inputs.siteIds] }, unsupported, key, mode, datasetId: sc.ds.manifest.dataset_id, cov };
    setRunning(true);
    setApplied(null);
    // Yield once so "Searching…" can paint; the evaluation itself takes a few milliseconds.
    window.setTimeout(() => {
      if (g !== gen.current) return;
      const t0 = performance.now();
      const rows = evaluate(sites, chk.arrivals, chk.durationMs);
      const ms = performance.now() - t0;
      if (g !== gen.current) return;
      focusResults.current = true;
      setResults({ ...snapshot, rows, sites, entries, ms });
      setShown(DEFAULT_SHOWN);
      setSiteFilter("all");
      setShowFailing(false);
      setExpanded(null);
      setRunning(false);
    }, 0);
  };
  // After a search, move to the results (once they are rendered).
  useEffect(() => {
    if (!focusResults.current || !results) return;
    focusResults.current = false;
    const h = ref.current?.querySelector<HTMLElement>("#finder-res-h");
    h?.scrollIntoView({ block: "start" });
    h?.focus({ preventScroll: true });
  }, [results]);

  // Focus and keyboard: focus the heading on open; Escape closes (focus returns to the opener).
  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLElement>("h2")?.focus();
    const f = (e: KeyboardEvent) => {
      const a = document.activeElement;
      if (e.key === "Escape" && (ref.current?.contains(a) || a === document.body || a === null)) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const limitsKey = JSON.stringify(limits);
  const view = useMemo(() => (results ? resultView(results.rows, criterion, limits) : null), [results, criterion, limitsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const best = useMemo(() => (results ? bestPerSite(results.rows, criterion, limits, results.inputs.siteIds, results.unsupported) : []), [results, criterion, limitsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const anyLimits = activeLimits(limits).length > 0;

  const downloadCsv = () => {
    if (!results) return;
    const csv = finderCsv(results.rows, {
      datasetId: results.datasetId,
      mode: results.mode,
      inputs: results.inputs,
      sampleStepSeconds: sc.ds.manifest.sample_step_seconds,
      visibilityMethod: results.entries[results.inputs.siteIds[0]]?.data.visibility_method ?? "10-minute midpoint classification",
      criterion,
      limits,
      sites: results.inputs.siteIds.map((id) => {
        const e = results.entries[id];
        const c = catalog.find((x) => x.id === id)!;
        return {
          id,
          name: e.data.site.name,
          latitude_deg: e.data.site.latitude_deg,
          longitude_deg_east: e.data.site.longitude_deg_east,
          observer_height_above_surface_m: e.data.site.observer_height_above_surface_m,
          provisional: results.mode === "terrain" ? (profileFor(e.data, c).provisionalTerrain ?? c.capabilities.provisional) : null,
        };
      }),
    });
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = csvFileName(results.datasetId, results.mode, results.inputs);
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  /** Why a result cannot be applied right now, or null. */
  const applyBlocked = (siteId: string): string | null => {
    if (stale) return "Stale result: run Find windows again";
    if (!sc.selIds.includes(siteId)) {
      const r = sc.addBlocked(siteId);
      if (r) return `${shortOf(siteId)} cannot be added: ${r}`;
    }
    return null;
  };
  const apply = (r: FinderRow) => {
    if (!results || applyBlocked(r.siteId)) return;
    const res = sc.applyArrival({ siteId: r.siteId, arrival: r.arrival, days: results.inputs.days, entry: results.entries[r.siteId] });
    // the applied row's button is replaced by "Current baseline": keep focus in the drawer
    window.setTimeout(() => ref.current?.querySelector<HTMLElement>("[data-testid=finder-applied]")?.focus(), 0);
    setApplied(
      res.ok
        ? `Applied: ${shortOf(r.siteId)}${res.added ? " added to the comparison and" : ""} selected, arriving ${fmtUtc(r.arrival)}, ${results.inputs.days} d, delay None.`
        : `Not applied: ${res.reason}.`,
    );
  };

  const setF = (p: Partial<Form>) => setForm((f) => ({ ...f, ...p }));
  const setL = (k: LimitKey, p: Partial<LimitField>) => setLimitForm((f) => ({ ...f, [k]: { ...f[k], ...p } }));

  // ---------------------------------------------------------------- results list
  let list: FinderRow[] = [];
  let noMatch = false;
  if (view) {
    const base = anyLimits ? (showFailing ? view.ranking.ranked.filter((r) => view.meeting.includes(r) || view.failing.includes(r)) : view.meeting) : view.ranking.ranked;
    noMatch = anyLimits && view.meeting.length === 0;
    list = siteFilter === "all" ? base : base.filter((r) => r.siteId === siteFilter);
  }
  const rankOf = (r: FinderRow) => (view ? view.ranking.ranked.indexOf(r) + 1 : 0);
  const baselineComparable = results !== null && !stale && results.inputs.days === sc.days;
  const info = criterionInfo(criterion);
  const rowKey = (r: FinderRow) => `${r.siteId}|${r.arrival}`;
  const sitesText = (ids: string[]) => ids.map(shortOf).join(", ");

  const content = (
    <div className="finder-drawer" role="dialog" aria-modal="false" aria-labelledby="finder-h" ref={ref} hidden={!open} data-testid="arrival-finder" data-stale={stale ? "true" : undefined}>
      <div className="finder-head">
        <h2 id="finder-h" tabIndex={-1}>Find arrival windows</h2>
        <button type="button" className="catalog-close" onClick={onClose} aria-label="Close arrival window finder">✕</button>
      </div>
      <p className="finder-intro small">For one mission duration, which arrival dates give the most sunlight and direct-to-Earth visibility together? Searching never changes the current scenario.</p>

      <form
        className="finder-form"
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        <fieldset className="finder-sites">
          <legend>Sites to search ({sc.ds.manifest.dataset_id})</legend>
          <label className="finder-check">
            <input type="checkbox" checked={form.activeOnly} onChange={(e) => setF({ activeOnly: e.target.checked, ackUnsupported: false })} data-testid="finder-active-only" />
            Only the active site ({shortOf(sc.active)})
          </label>
          {!form.activeOnly && (
            <div className="finder-site-list">
              {options.map((o) => {
                const compared = sc.selIds.includes(o.id);
                return (
                  <label key={o.id} className="finder-check" data-finder-site={o.id}>
                    <input
                      type="checkbox"
                      checked={form.chosen.includes(o.id)}
                      onChange={(e) => setF({ chosen: e.target.checked ? [...form.chosen, o.id] : form.chosen.filter((x) => x !== o.id), ackUnsupported: false })}
                    />
                    <span>
                      {o.short}
                      <span className="muted"> · {compared ? "compared" : "not compared"}</span>
                      {o.state === "no-model" && <span className="muted"> · no {modeName(mode)} horizon</span>}
                      {o.state === "error" && <span className="muted"> · not loaded</span>}
                    </span>
                  </label>
                );
              })}
            </div>
          )}
          <p className="muted small">
            Any site of this dataset can be searched; searching does not add it to the comparison. Model: <strong>{modeName(mode)}</strong> for every site (change it in Mission setup).
          </p>
          {sProblems.length > 0 && (
            <div className="finder-problem" role="alert" data-testid="finder-site-problem">
              {sProblems.map((p) => <p key={p}>{p}</p>)}
            </div>
          )}
          {unsupported.length > 0 && (
            <div className="finder-problem" role="alert" data-testid="finder-unsupported">
              <p>
                {sitesText(unsupported.map((u) => u.id))} {unsupported.length === 1 ? "has" : "have"} no {modeName(mode)} horizon. Terrain and Smooth results are never mixed: {unsupported.length === 1 ? "it" : "they"} cannot be searched with this model.
              </p>
              {!form.ackUnsupported ? (
                <button type="button" onClick={() => setF({ ackUnsupported: true })} data-testid="finder-ack-unsupported">
                  Search the other sites and list {sitesText(unsupported.map((u) => u.id))} as not searched
                </button>
              ) : (
                <p>{sitesText(unsupported.map((u) => u.id))} will be listed as not searched.</p>
              )}
            </div>
          )}
        </fieldset>

        <div className="finder-grid">
          <label className="finder-field">
            <span>Mission duration (days)</span>
            <input type="number" min={1} max={sc.maxDays} step={1} value={form.days} onChange={(e) => setF({ days: e.target.value })} data-testid="finder-days" />
          </label>
          <label className="finder-field">
            <span>Arrival hour (UTC)</span>
            <select value={form.hour} onChange={(e) => setF({ hour: Number(e.target.value) })} data-testid="finder-hour">
              {HOURS.map((h) => <option key={h} value={h}>{hh(h)}</option>)}
            </select>
          </label>
          <label className="finder-field">
            <span>Earliest arrival (UTC date)</span>
            <input type="date" value={form.fromDate} min={lim?.earliestDate} max={lim?.latestDate} onChange={(e) => setF({ fromDate: e.target.value })} data-testid="finder-from" />
          </label>
          <label className="finder-field">
            <span>Latest arrival (UTC date)</span>
            <input type="date" value={form.toDate} min={lim?.earliestDate} max={lim?.latestDate} onChange={(e) => setF({ toDate: e.target.value })} data-testid="finder-to" />
          </label>
        </div>
        <p className="finder-spacing small" data-testid="finder-spacing">
          <strong>Candidate spacing: {SPACING_DAYS} day.</strong> Checks arrivals daily at {hh(form.hour)} UTC. Results are the best among the evaluated dates, not a continuous-time optimum.
        </p>
        {lim && (
          <p className="muted small" data-testid="finder-valid">
            Valid: {lim.earliestDate} to {lim.latestDate} (complete {inputs.days}-day missions inside the data, which ends {fmtUtc(cov.end)}).{" "}
            {(form.fromDate !== lim.earliestDate || form.toDate !== lim.latestDate) && (
              <button type="button" className="link-btn" onClick={() => setF({ fromDate: lim.earliestDate, toDate: lim.latestDate })}>Use the full valid range</button>
            )}
          </p>
        )}
        {!check.ok && sProblems.length === 0 && (
          <div className="finder-problem" role="alert" data-testid="finder-input-problem">
            {check.problems.map((p) => <p key={p}>{p}</p>)}
          </div>
        )}

        <label className="finder-field">
          <span>Rank by</span>
          <select value={criterion} onChange={(e) => setCriterion(e.target.value as Criterion)} data-testid="finder-criterion">
            {CRITERIA.map((c) => <option key={c.key} value={c.key}>{c.label}{c.key === DEFAULT_CRITERION ? " (default)" : ""}</option>)}
          </select>
        </label>

        <details className="finder-limits" open={anyLimits || undefined}>
          <summary>Screening limits (optional){anyLimits ? `: ${limitsText(limits)}` : ": off"}</summary>
          <p className="muted small">
            Limits are yours, not a safety rating. Blockage limits apply to the longest continuous blockage <strong>within the mission window</strong>; unknown data never passes.
          </p>
          {LIMIT_KEYS.map((k) => {
            const i = LIMIT_INFO[k];
            return (
              <div key={k} className="finder-limit" data-limit={k}>
                <label className="finder-check">
                  <input type="checkbox" checked={limitForm[k].on} onChange={(e) => setL(k, { on: e.target.checked })} />
                  {i.label}
                </label>
                <span className="with-unit">
                  <span aria-hidden="true">{i.op === ">=" ? "≥" : "≤"}</span>
                  <input
                    type="number"
                    min={0}
                    max={i.unit === "%" ? 100 : undefined}
                    step="any"
                    value={limitForm[k].value}
                    disabled={!limitForm[k].on}
                    onChange={(e) => setL(k, { value: e.target.value })}
                    aria-label={`${i.label} (${i.unit === "%" ? "percent" : "hours"})`}
                  />
                  <span className="unit">{i.unit === "%" ? "%" : "h"}</span>
                </span>
              </div>
            );
          })}
          {limitProblems.length > 0 && <div className="finder-problem" role="alert">{limitProblems.map((p) => <p key={p}>{p}</p>)}</div>}
        </details>

        <div className="finder-actions">
          <button type="submit" className="primary" disabled={!canRun} data-testid="finder-run">{running ? "Searching…" : "Find windows"}</button>
          <button type="button" onClick={() => setForm(formFromScenario(sc, form))}>Reset to current scenario</button>
        </div>
        <details className="finder-method small">
          <summary>How the search works</summary>
          <ul>
            <li>Every candidate is the full mission duration; candidates whose mission would leave the cached data are not generated (never shortened or extrapolated).</li>
            <li>Values come from the same calculation as Analysis: percentages of the mission duration, center of the Sun and Earth above the modeled horizon, 10-minute midpoint classification.</li>
            <li>Ranking uses unrounded values; ties go to the earlier arrival, then the site ID. All searched sites are ranked together.</li>
            <li>Ranking and limits update the list immediately. Changing sites, duration, dates, hour, dataset or the horizon model marks results stale until Find windows runs again.</li>
            <li>A blockage marked ⚠ touches the mission start or end and may continue outside the mission.</li>
            <li>Unknown data is never ranked or counted as meeting a limit.</li>
          </ul>
        </details>
      </form>

      {results && view && (
        <section className="finder-results" aria-labelledby="finder-res-h" data-testid="finder-results">
          <h3 id="finder-res-h" tabIndex={-1}>Results</h3>
          {stale && (
            <p className="finder-stale" role="status" data-testid="finder-stale">
              Stale: the dataset, horizon model, sites or search inputs changed after this search. Run Find windows again before using a result.
            </p>
          )}
          <p className="small finder-summary" data-testid="finder-summary">
            <strong>{results.mode === "terrain" ? "Terrain" : "Smooth"} horizon</strong> · {results.inputs.days} d missions · arrivals daily at {hh(results.inputs.hour)} UTC (1-day spacing), {results.inputs.fromDate} to {results.inputs.toDate} ·
            sites: {sitesText(results.inputs.siteIds)} · limits: {limitsText(limits)} · ranked by {info.label.toLowerCase()} · {results.rows.length} candidate{results.rows.length === 1 ? "" : "s"} in {results.ms < 1 ? "<1" : Math.round(results.ms)} ms
          </p>

          <BestPerSite best={best} shortOf={shortOf} criterion={criterion} onShow={(id) => { setSiteFilter(id); setShown(DEFAULT_SHOWN); }} />

          {view.ranking.unevaluable.length > 0 && (
            <p className="finder-problem small" data-testid="finder-unevaluable">
              {view.ranking.unevaluable.length} candidate{view.ranking.unevaluable.length > 1 ? "s" : ""} not ranked: unknown data ({[...new Set(view.ranking.unevaluable.map((r) => metricReason(r, criterion) ?? ""))].filter(Boolean).join("; ")}). Listed in the CSV, never as favorable.
            </p>
          )}
          {anyLimits && view.limitUnknown.length > 0 && <p className="finder-problem small">{view.limitUnknown.length} candidate(s) could not be checked against the limits (unknown data) and are not shown as meeting them.</p>}
          {noMatch && (
            <div className="finder-nomatch" role="status" data-testid="finder-nomatch">
              <p><strong>No evaluated arrival meets the selected limits.</strong> Limits were not relaxed.</p>
              <label className="finder-check">
                <input type="checkbox" checked={showFailing} onChange={(e) => setShowFailing(e.target.checked)} data-testid="finder-show-failing" />
                Show all {view.failing.length} ranked results with failed limits marked
              </label>
            </div>
          )}

          <div className="finder-tools">
            {results.inputs.siteIds.length > 1 && (
              <label className="finder-field inline">
                <span>Show</span>
                <select value={siteFilter} onChange={(e) => { setSiteFilter(e.target.value); setShown(DEFAULT_SHOWN); }} data-testid="finder-site-filter">
                  <option value="all">All sites, ranked together</option>
                  {results.inputs.siteIds.map((id) => <option key={id} value={id}>{shortOf(id)} only (global rank kept)</option>)}
                </select>
              </label>
            )}
            {anyLimits && !noMatch && (
              <label className="finder-check small">
                <input type="checkbox" checked={showFailing} onChange={(e) => setShowFailing(e.target.checked)} />
                Include {view.failing.length} failing
              </label>
            )}
            <button type="button" onClick={downloadCsv} data-testid="finder-csv">Download CSV</button>
          </div>

          <details className="finder-apply-note small" data-testid="finder-apply-details">
            <summary>What “Use this arrival” changes</summary>
            <p id="finder-apply-note">
              Pauses playback; selects the result’s site (adding it to the comparison if it is not compared); sets the baseline arrival and duration to the searched values;
              <strong> sets the delay to None</strong> (baseline mission); moves the viewing time to the arrival; clears crossing selections and tracking; and updates the link.
              The horizon model, camera and terrain overlay are kept.
            </p>
          </details>
          {applied && <p className="finder-applied small" role="status" tabIndex={-1} data-testid="finder-applied">{applied}</p>}
          {baselineComparable ? null : !stale && <p className="muted small" data-testid="finder-baseline">No comparison with the current baseline: it is {sc.days} d long and this search used {results.inputs.days} d.</p>}

          <ol className="finder-list" data-testid="finder-list" aria-label={siteFilter === "all" ? "Ranked results" : `${shortOf(siteFilter)} results with global rank`}>
            {list.slice(0, shown).map((r) => {
              const k = rowKey(r);
              const siteView = sc.views.find((v) => v.entry.id === r.siteId);
              const blocked = applyBlocked(r.siteId);
              return (
                <ResultItem
                  key={k}
                  id={k}
                  r={r}
                  rankLabel={siteFilter === "all" ? `#${rankOf(r)}` : `#${rankOf(r)} overall`}
                  short={shortOf(r.siteId)}
                  provisional={results.mode === "terrain" ? catalog.find((c) => c.id === r.siteId)?.capabilities.provisional ?? null : null}
                  criterion={criterion}
                  outcomes={anyLimits ? limitOutcomes(r, limits) : []}
                  baseline={baselineComparable && siteView ? siteView.base : null}
                  current={sc.active === r.siteId && sc.selIds.includes(r.siteId) && sc.arrival === r.arrival && sc.days === results.inputs.days && sc.effDelay === 0}
                  compared={sc.selIds.includes(r.siteId)}
                  blocked={blocked}
                  onApply={() => apply(r)}
                  expanded={expanded === k}
                  onToggle={() => setExpanded((x) => (x === k ? null : k))}
                  preview={
                    expanded === k
                      ? delayPreview(results.sites.find((s) => s.id === r.siteId)!.intervals, r.arrival, results.inputs.days * DAY_MS, results.cov, limits, r.siteId)
                      : null
                  }
                  anyLimits={anyLimits}
                  dataEnd={results.cov.end}
                />
              );
            })}
          </ol>
          {list.length === 0 && !noMatch && <p className="muted small">No results for this selection.</p>}
          {list.length > shown && (
            <div className="finder-more">
              <span className="muted small">Showing {shown} of {list.length}</span>
              <button type="button" onClick={() => setShown((n) => n + DEFAULT_SHOWN)} data-testid="finder-more">Show {Math.min(DEFAULT_SHOWN, list.length - shown)} more</button>
              <button type="button" onClick={() => setShown(list.length)}>Show all</button>
            </div>
          )}
        </section>
      )}
    </div>
  );
  return typeof document === "undefined" ? content : createPortal(content, document.body);
}

// ------------------------------------------------------------------ shared pieces

function pctOf(m: WindowMetrics, c: Criterion) {
  const v = windowValue(m, c);
  return v === null ? "unknown" : fmtPct(v);
}

function blockText(a: Availability<DarkRun | null>): { text: string; edge: string | null } {
  if (!a.ok) return { text: "unknown", edge: null };
  if (!a.value) return { text: "None in window", edge: null };
  const d = a.value;
  const edge = d.touchesStart && d.touchesEnd ? "spans the whole mission; may extend before and after it" : d.touchesStart ? "at mission start; may have begun before arrival" : d.touchesEnd ? "at mission end; may continue after it" : null;
  return { text: fmtOutage(d.durationMs), edge };
}

function outcomeText(o: LimitOutcome) {
  const i = LIMIT_INFO[o.key];
  const v = o.value === null ? "unknown" : i.unit === "%" ? fmtPct(o.value) : o.value === 0 ? "none" : fmtOutage(o.value * 3_600_000);
  return `${i.short} ${o.limit}${i.unit === "%" ? " %" : " h"} (${v})`;
}

/** Sun, Earth, both, and the two longest blockages for one mission window, in one compact line. */
function MetricLine({ m, criterion, compact = false }: { m: WindowMetrics; criterion?: Criterion; compact?: boolean }) {
  const sb = blockText(m.longestDark);
  const eb = blockText(m.longestEarthBlock);
  const hi = (c: Criterion) => (c === criterion ? "fr-metric on" : "fr-metric");
  return (
    <dl className={compact ? "fr-metrics compact small" : "fr-metrics small"}>
      <div className={hi("both")}><dt>Sun + Earth</dt><dd className="num" data-field="both">{pctOf(m, "both")}</dd></div>
      <div className={hi("sun")}><dt>Sun</dt><dd className="num" data-field="sun">{pctOf(m, "sun")}</dd></div>
      <div className={hi("earth")}><dt>Earth</dt><dd className="num" data-field="earth">{pctOf(m, "earth")}</dd></div>
      <div className={hi("sunBlock")}><dt>Longest Sun blockage</dt><dd className="num" data-field="sun-block">{sb.text}{sb.edge && " ⚠"}</dd></div>
      <div className={hi("earthBlock")}><dt>Longest Earth blockage</dt><dd className="num" data-field="earth-block">{eb.text}{eb.edge && " ⚠"}</dd></div>
    </dl>
  );
}

function EdgeNote({ m }: { m: WindowMetrics }) {
  const sb = blockText(m.longestDark);
  const eb = blockText(m.longestEarthBlock);
  if (!sb.edge && !eb.edge) return null;
  return (
    <p className="fr-edge small" data-field="edge">
      ⚠ Within the mission window only:{sb.edge ? ` Sun blockage ${sb.edge}.` : ""}{eb.edge ? ` Earth blockage ${eb.edge}.` : ""}
    </p>
  );
}

const BEST_LABEL: Record<SiteBest["state"], string> = {
  match: "",
  "no-match": "No candidate meets the selected limits",
  "unknown-data": "Missing or unknown data",
  coverage: "Search range not covered by this site’s data",
  unsupported: "Horizon model not available: not searched",
};

function BestPerSite({ best, shortOf, criterion, onShow }: { best: SiteBest[]; shortOf: (id: string) => string; criterion: Criterion; onShow: (id: string) => void }) {
  return (
    <section className="finder-best" aria-labelledby="finder-best-h" data-testid="finder-best">
      <h4 id="finder-best-h">Best matching arrival per site</h4>
      <ul>
        {best.map((b) => (
          <li key={b.siteId} className="best-item" data-site={b.siteId} data-state={b.state}>
            <div className="best-head">
              <strong>{shortOf(b.siteId)}</strong>
              {b.row ? (
                <>
                  <span className="num small" data-field="window">{fmtUtc(b.row.arrival)} → {fmtUtc(b.row.end).slice(5)}</span>
                  <span className="muted small" data-field="rank">#{b.rank} overall</span>
                </>
              ) : (
                <span className="best-why small" data-field="why">{BEST_LABEL[b.state]}</span>
              )}
            </div>
            {b.row ? <MetricLine m={b.row.m} criterion={criterion} compact /> : <p className="muted small" data-field="detail">{b.detail}</p>}
            {b.row && <EdgeNote m={b.row.m} />}
            {b.row && b.detail && <p className="muted small">{b.detail}</p>}
            {b.state !== "unsupported" && b.state !== "coverage" && (
              <button type="button" className="link-btn" onClick={() => onShow(b.siteId)} data-testid="best-show">Show {shortOf(b.siteId)} results</button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ------------------------------------------------------------------ one result

function ResultItem({ id, r, rankLabel, short, provisional, criterion, outcomes, baseline, current, compared, blocked, onApply, expanded, onToggle, preview, anyLimits, dataEnd }: {
  id: string;
  r: FinderRow;
  rankLabel: string;
  short: string;
  provisional: string | null;
  criterion: Criterion;
  outcomes: LimitOutcome[];
  baseline: WindowMetrics | null;
  current: boolean;
  compared: boolean;
  blocked: string | null;
  onApply: () => void;
  expanded: boolean;
  onToggle: () => void;
  preview: DelayPreviewRow[] | null;
  anyLimits: boolean;
  dataEnd: number;
}) {
  const v = verdict(outcomes);
  const info = criterionInfo(criterion);
  const here = metricValue(r, criterion);
  const there = baseline ? windowValue(baseline, criterion) : null;
  const delta = here !== null && there !== null ? fmtSigned(here - there, info.unit === "%" ? "pp" : "h") : null;
  const pid = `dp-${id.replace(/[^a-z0-9]/gi, "")}`;
  const days = Math.round((r.end - r.arrival) / DAY_MS);
  return (
    <li className="finder-item" data-site={r.siteId} data-arrival={new Date(r.arrival).toISOString()} data-verdict={v}>
      <div className="fr-head">
        <span className="fr-rank num" data-field="rank">{rankLabel}</span>
        <strong className="fr-site" data-field="site">{short}</strong>
        {!compared && <span className="muted small">not compared</span>}
        {provisional && <span className="chip-prov" title={provisional}>provisional</span>}
        {v === "meets" && <span className="fr-verdict ok" data-field="verdict">Meets selected limits</span>}
        {v === "fails" && <span className="fr-verdict fail" data-field="verdict">Does not meet selected limits</span>}
        {v === "unknown" && <span className="fr-verdict unk" data-field="verdict">Limits cannot be checked</span>}
      </div>
      <p className="fr-when num small" data-field="window">{fmtUtc(r.arrival)} → {fmtUtc(r.end)} ({days} d)</p>
      <MetricLine m={r.m} criterion={criterion} />
      <EdgeNote m={r.m} />
      {outcomes.some((o) => o.state !== "pass") && (
        <p className="fr-fails small" data-field="failed-limits">
          {outcomes.some((o) => o.state === "fail") && <>Fails: {outcomes.filter((o) => o.state === "fail").map(outcomeText).join("; ")}. </>}
          {outcomes.some((o) => o.state === "unknown") && <>Unknown: {outcomes.filter((o) => o.state === "unknown").map(outcomeText).join("; ")}.</>}
        </p>
      )}
      {delta !== null && <p className="muted small" data-field="vs-baseline">{delta} {info.short.toLowerCase()} vs current baseline</p>}
      <div className="fr-foot">
        <button type="button" className="fr-toggle" aria-expanded={expanded} aria-controls={pid} onClick={onToggle} data-testid="finder-delay-toggle">
          {expanded ? "Hide delay preview" : "Delay preview (+1/+3/+7 d)"}
        </button>
        {current ? (
          <span className="small fr-current">Current baseline</span>
        ) : (
          <span className="fr-apply-wrap">
            <button type="button" className="fr-apply" onClick={onApply} disabled={blocked !== null} title={blocked ?? undefined} data-testid="finder-apply">
              {compared ? "Use this arrival" : `Add ${short} and use this arrival`}
            </button>
            <span className="muted small fr-apply-sub">{blocked ?? "Sets delay to None"}</span>
          </span>
        )}
      </div>
      {expanded && preview && (
        <div className="delay-preview" id={pid} data-testid="finder-delay-preview">
          <p className="muted small">Same site, {days}-day duration, dataset and model; each slip is a complete mission from the chosen arrival plus the offset. Preview only.</p>
          <ul>
            {preview.map((p) => (
              <li key={p.days} className="dp-row" data-days={p.days} data-enabled={p.enabled ? "true" : "false"}>
                <div className="dp-head">
                  <strong>{p.days === 0 ? "Chosen arrival" : `+${p.days} d`}</strong>
                  <span className="num small">{fmtUtc(p.window.start)} → {fmtUtc(p.window.end).slice(5)}</span>
                  {p.enabled && anyLimits && (
                    <span className={`fr-verdict ${p.verdict === "meets" ? "ok" : p.verdict === "fails" ? "fail" : "unk"}`} data-field="verdict">
                      {p.verdict === "meets" ? "Meets selected limits" : p.verdict === "fails" ? "Does not meet selected limits" : "Limits cannot be checked"}
                    </span>
                  )}
                </div>
                {p.enabled && p.m ? (
                  <>
                    <MetricLine m={p.m} compact />
                    <EdgeNote m={p.m} />
                    {p.outcomes.some((o) => o.state !== "pass") && (
                      <p className="fr-fails small">{p.outcomes.filter((o) => o.state !== "pass").map((o) => `${o.state === "fail" ? "Fails" : "Unknown"}: ${outcomeText(o)}`).join("; ")}</p>
                    )}
                  </>
                ) : (
                  <p className="muted small" data-field="unavailable">Unavailable: this {days}-day mission would end after the data ends ({fmtUtc(dataEnd)}); it is not shortened.</p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}
