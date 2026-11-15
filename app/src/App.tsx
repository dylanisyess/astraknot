import { useEffect, useMemo, useState } from "react";
import { CR1_5M } from "./assessment";
import { ElevationChart } from "./ElevationChart";
import { Panorama } from "./Panorama";
import { Timeline, type TimelineGroup, type TimelineTrack } from "./Timeline";
import { timeScale, useWidth } from "./axis";
import { compass, fmtDeg, fmtLat, fmtLonEast, fmtUtc, loadDataset, nearestIndex } from "./data";
import {
  type Availability,
  type Comparison,
  type DarkRun,
  type Interval,
  type NextChange,
  type Tri,
  type WindowMetrics,
  DAY_MS,
  DEFAULT_DURATION_DAYS,
  arrivalBounds,
  bothState,
  clip,
  compare,
  computeMetrics,
  delayOptions,
  fmtDuration,
  fmtHours,
  fmtSigned,
  fromUtcDateHour,
  nextChange,
  parseIntervals,
  scenarioWindow,
  utcDateString,
  utcHour,
} from "./mission";
import {
  type SiteProfile,
  horizonUnderBodies,
  modeAvailability,
  polarXY,
  profileFor,
  strictHorizon,
  strictIntervals,
  surfaceDistanceKm,
  terrainFacts,
  terrainModelLabel,
} from "./sites";
import {
  type BodyStatus,
  type SelectedStatus,
  NEAR_CROSSING,
  horizonName,
  nearCrossingExplanation,
  selectedTimeStatus,
  signedClearance,
  stateLabel,
  unknownText,
} from "./status";
import type { Dataset, HorizonMode, SiteData, SiteEntry, TerrainHorizonBlock } from "./types";
import { parseUrlState, resolveActive, resolveSites, writeUrlState } from "./urlState";

const DEFAULT_ARRIVAL = "2026-12-05T00:00:00Z";

export function App() {
  const [ds, setDs] = useState<Dataset | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    loadDataset(import.meta.env.BASE_URL)
      .then(setDs)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  if (error) {
    return (
      <main className="page">
        <div className="notice notice-error" role="alert">
          <strong>Data could not be loaded.</strong> {error}
          <p>No substitute data is shown. Run the pipeline (see README) and reload.</p>
        </div>
      </main>
    );
  }
  if (!ds) return <main className="page"><p className="muted">Loading data…</p></main>;
  return <Workspace ds={ds} />;
}

const clampNum = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const HOURS = Array.from({ length: 24 }, (_, h) => h);

interface SiteView {
  entry: SiteEntry;
  data: SiteData;
  profile: SiteProfile;
  intervals: Interval[];
  base: WindowMetrics;
  act: WindowMetrics;
  cmp: Comparison;
  /** Status at the shared selected time (status.ts): the single source for cards, readouts and panorama. */
  status: SelectedStatus;
}

// ------------------------------------------------------------------ workspace

export function Workspace({ ds, search }: { ds: Dataset; search?: string }) {
  const { manifest, times } = ds;
  // The link is read once: the URL is rewritten to the canonical state afterwards, and re-reading
  // it on later renders would lose what the original link asked for (e.g. unknown site IDs).
  const [init] = useState(() => parseUrlState(search ?? window.location.search));
  const allIds = ds.sites.map((s) => s.id);
  const [requested] = useState(() => resolveSites(init.sites, allIds));
  const [selIds, setSelIds] = useState<string[]>(requested.ids);
  const entries = ds.sites.filter((e) => selIds.includes(e.id));
  const [activeRaw, setActive] = useState<string>(() => resolveActive(init.site, requested.ids));
  const active = resolveActive(activeRaw, selIds);

  // One horizon model for every compared site; Terrain only when all of them have it.
  const avail = modeAvailability(entries);
  const [modeRaw, setMode] = useState<HorizonMode>(() => init.horizon ?? "terrain");
  const mode: HorizonMode = modeRaw === "terrain" && !avail.terrain ? "smooth" : modeRaw;
  const terrainRequestedButMissing = modeRaw === "terrain" && !avail.terrain;

  // Coverage: every site shares the same sample times (checked by the loader), so this is the common coverage.
  const cov = { start: times[0], end: times[times.length - 1] };
  const maxDays = Math.floor((cov.end - cov.start) / DAY_MS);
  const [days, setDays] = useState(() => clampNum(Math.round(init.days ?? DEFAULT_DURATION_DAYS), 1, maxDays));
  const durationMs = days * DAY_MS;
  const bounds = arrivalBounds(cov, durationMs)!; // days <= maxDays guarantees a valid range
  const snapHour = (ms: number) => Math.round(ms / 3_600_000) * 3_600_000;
  const [arrival, setArrivalRaw] = useState(() =>
    clampNum(snapHour(init.arrival ?? Date.parse(DEFAULT_ARRIVAL)), bounds.earliest, bounds.latest),
  );
  const setArrival = (ms: number) => setArrivalRaw(clampNum(snapHour(ms), bounds.earliest, bounds.latest));
  const [delay, setDelay] = useState(() => ([0, 1, 3, 7].includes(init.delay ?? -1) ? init.delay! : 3));
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
  const [cursorRaw, setCursor] = useState(() => nearestIndex(times, init.t ?? actW.start));
  const cursor = clampNum(cursorRaw, i0, i1);
  const cursorT = times[cursor];

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
    const status = selectedTimeStatus(
      { samples: entry.data.samples, times, horizon: strictHorizon(entry.data, mode), intervals, mode },
      cursorT,
    );
    return { entry, data: entry.data, profile: profileFor(entry.data), intervals, base, act, cmp: compare(base, act), status };
  });
  const activeView = views.find((v) => v.entry.id === active)!;
  const activeSite = activeView.data;
  const horizon = strictHorizon(activeSite, mode);
  const horizonAtBody = useMemo(
    () => (mode === "terrain" ? horizonUnderBodies(activeSite, horizon) : null),
    [activeSite, mode, horizon],
  );

  useEffect(() => {
    const url = writeUrlState(new URL(window.location.href), {
      arrival, days, delay: effDelay, t: activeSite.samples[cursor].time_utc, horizon: mode, sites: selIds, site: active,
    });
    window.history.replaceState(null, "", url);
  }, [arrival, days, effDelay, cursor, activeSite, mode, selIds, active]);

  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const [panoRef, panoWidth] = useWidth<HTMLDivElement>();
  const scale = timeScale(domain.start, domain.end, width);
  const dark = (m: WindowMetrics) => (m.longestDark.ok ? m.longestDark.value : null);
  const delayedLabel = effDelay ? `Delay +${effDelay} d` : null;
  const tracks: TimelineTrack[] = views.map((v) => {
    const groups: TimelineGroup[] = [{ key: "baseline", label: "Baseline", window: baseW, longestDark: dark(v.base) }];
    if (effDelay) groups.push({ key: "delayed", label: `Delay +${effDelay} d`, window: actW, longestDark: dark(v.act) });
    return {
      key: v.entry.id,
      label: v.profile.short,
      note: mode === "terrain" && v.profile.provisionalTerrain ? "(provisional terrain result)" : undefined,
      intervals: v.intervals,
      groups,
    };
  });
  const synthetic = manifest.is_synthetic || ds.sites.some((s) => s.data.site.is_synthetic);
  const arrivalDate = utcDateString(arrival);
  const toggleSite = (id: string) =>
    setSelIds((ids) => (ids.includes(id) ? (ids.length > 1 ? ids.filter((x) => x !== id) : ids) : allIds.filter((x) => x === id || ids.includes(x))));

  return (
    <main className="page">
      <header className="masthead">
        <div>
          <p className="eyebrow">Lunar Visibility Navigator · Two-site comparison · {mode === "terrain" ? "Terrain horizon" : "Smooth horizon"}</p>
          <h1>Sun and Earth visibility: {views.map((v) => v.profile.short).join(" and ")}</h1>
        </div>
        <div className="badges">
          {synthetic ? <span className="badge badge-warn">⚠ Synthetic data</span> : <span className="badge">Real data · JPL Horizons</span>}
          <span className="badge">All times UTC</span>
        </div>
      </header>

      {mode === "terrain" ? (
        <div className="banner banner-terrain" role="note" data-mode="terrain">
          <strong>Terrain horizon for every site shown.</strong> “Visible” means the body’s center is above the skyline
          computed from LOLA terrain for an observer 1 m above the modeled surface. This applies to both the Sun and Earth:
          part of either disk can still be above the skyline when its center is hidden. These are terrain-model results for
          published coordinates, not the conditions of an actual lander. Earth visible is a geometric opportunity, not a
          guaranteed radio link. Sun visible is not electrical power output.
        </div>
      ) : (
        <div className="banner" role="note" data-mode="smooth">
          <strong>⚠ Smooth horizon for every site shown: terrain ignored (comparison mode).</strong> “Visible” means the
          body’s center is above the local horizontal plane (0°), for both the Sun and Earth; part of either disk can still
          be above 0° when its center is not. Real terrain can hide the Sun or Earth when this view says visible. Earth visible is a geometric opportunity, not a guaranteed radio link. Sun visible is not
          electrical power output.
        </div>
      )}
      {terrainRequestedButMissing && (
        <div className="notice notice-error" role="alert">
          Terrain horizon requested but not available for {avail.missing.map((m) => `${m.id} (${m.reason})`).join(", ")}.
          Showing the smooth horizon for all sites, so results are never mixed.
        </div>
      )}
      {requested.unknown.length > 0 && (
        <div className="notice notice-error" role="alert">
          Unknown site ID in the link: {requested.unknown.join(", ")}. Showing the sites listed in the manifest instead.
        </div>
      )}

      <section className="card locator-card" aria-labelledby="loc-h">
        <h2 id="loc-h">Sites</h2>
        <Locator views={ds.sites.map((e) => ({ entry: e, profile: profileFor(e.data), selected: selIds.includes(e.id) }))} />
        <fieldset className="site-toggles">
          <legend className="small">Compared sites</legend>
          {ds.sites.map((e) => (
            <label key={e.id} className="small">
              <input
                type="checkbox"
                checked={selIds.includes(e.id)}
                disabled={selIds.includes(e.id) && selIds.length === 1}
                onChange={() => toggleSite(e.id)}
              />{" "}
              {profileFor(e.data).label}
            </label>
          ))}
        </fieldset>
      </section>

      <section className="card controls-card" aria-labelledby="ctl-h">
        <h2 id="ctl-h">Shared mission scenario</h2>
        <p className="muted small">Every compared site uses the same arrival, duration, delay, horizon model and selected time.</p>
        <fieldset className="delays horizon-mode">
          <legend>Horizon model (all sites)</legend>
          <div className="segmented" role="radiogroup" aria-label="Horizon model">
            {(["smooth", "terrain"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                className={mode === m ? "seg-btn active" : "seg-btn"}
                disabled={m === "terrain" && !avail.terrain}
                title={m === "terrain" && !avail.terrain ? `Unavailable for ${avail.missing.map((x) => x.id).join(", ")}` : undefined}
                onClick={() => setMode(m)}
                data-mode={m}
              >
                {m === "smooth" ? "Smooth (0°)" : "Terrain (LOLA)"}
              </button>
            ))}
          </div>
        </fieldset>
        <div className="controls">
          <label className="field">
            <span>Baseline arrival date (UTC)</span>
            <input
              type="date"
              value={arrivalDate}
              min={utcDateString(bounds.earliest)}
              max={utcDateString(bounds.latest)}
              onChange={(e) => e.target.value && setArrival(fromUtcDateHour(e.target.value, utcHour(arrival)))}
            />
          </label>
          <label className="field">
            <span>Hour (UTC)</span>
            <select value={utcHour(arrival)} onChange={(e) => setArrival(fromUtcDateHour(arrivalDate, Number(e.target.value)))}>
              {HOURS.map((h) => {
                const t = fromUtcDateHour(arrivalDate, h);
                return (
                  <option key={h} value={h} disabled={t < bounds.earliest || t > bounds.latest}>
                    {String(h).padStart(2, "0")}:00
                  </option>
                );
              })}
            </select>
          </label>
          <label className="field">
            <span>Duration (Earth days)</span>
            <input
              type="number"
              min={1}
              max={maxDays}
              step={1}
              value={days}
              onChange={(e) => {
                const v = Math.round(Number(e.target.value));
                if (Number.isFinite(v)) setDays(clampNum(v, 1, maxDays));
              }}
            />
          </label>
        </div>
        <div className="quick">
          <button type="button" onClick={() => setArrival(bounds.earliest)} disabled={arrival === bounds.earliest}>Earliest arrival</button>
          <button type="button" onClick={() => setArrival(bounds.latest)} disabled={arrival === bounds.latest}>Latest arrival without delay</button>
          <span className="muted small">
            Allowed: {fmtUtc(bounds.earliest)} – {fmtUtc(bounds.latest)} (data common to all sites: {fmtUtc(cov.start)} – {fmtUtc(cov.end)})
          </span>
        </div>
        <fieldset className="delays">
          <legend>Arrival slip (offset from the baseline, not cumulative)</legend>
          <div className="segmented" role="radiogroup" aria-label="Arrival slip">
            {options.map((o) => (
              <button
                key={o.days}
                type="button"
                role="radio"
                aria-checked={effDelay === o.days}
                className={effDelay === o.days ? "seg-btn active" : "seg-btn"}
                disabled={!o.enabled}
                title={o.reason ?? `${fmtUtc(o.window.start)} → ${fmtUtc(o.window.end)}`}
                onClick={() => setDelay(o.days)}
              >
                {o.days === 0 ? "Baseline" : `+${o.days} d`}
              </button>
            ))}
          </div>
          {options.some((o) => !o.enabled) && (
            <p className="muted small">
              Unavailable: {options.filter((o) => !o.enabled).map((o) => `+${o.days} d`).join(", ")} would end after the
              available data ({fmtUtc(cov.end)}).
            </p>
          )}
          {!chosen.enabled && (
            <p className="note small" role="status">+{delay} d no longer fits the data with this arrival; showing the baseline only.</p>
          )}
        </fieldset>
        <p className="small window-line">
          Baseline <strong className="num">{fmtUtc(baseW.start)} → {fmtUtc(baseW.end)}</strong>
          {delayedLabel && (
            <>
              {" · "}{delayedLabel} <strong className="num">{fmtUtc(actW.start)} → {fmtUtc(actW.end)}</strong>
            </>
          )}
          {" · "}duration {fmtDuration(durationMs)} for every site
        </p>
      </section>

      <section className="compare-grid" aria-label="Site comparison">
        {views.map((v) => (
          <SiteCard
            key={v.entry.id}
            v={v}
            mode={mode}
            delayedLabel={delayedLabel}
            effDelay={effDelay}
            cursorT={cursorT}
            isActive={v.entry.id === active}
            onShow={() => setActive(v.entry.id)}
          />
        ))}
        <p className="muted small compare-foot">
          Shares of elapsed window time; darkness means the Sun’s center is below the horizon of the model shown. These cards
          compare modeled visibility for the same windows only; they do not rank the sites, and neither point is presented as a
          better landing site overall. Percentages use body centers. Boundaries are estimates on the 10-minute reporting grid, not event times of guaranteed accuracy.
        </p>
      </section>

      <section className="card viz-card" aria-labelledby="viz-h">
        <div className="chart-head">
          <h2 id="viz-h">Selected time, panorama and timelines</h2>
          <ul className="legend" aria-label="Legend">
            <li><span className="chip chip-sun" />Sun visible</li>
            <li><span className="chip chip-earth" />Earth visible</li>
            <li><span className="chip chip-both" />Both visible</li>
            <li><span className="chip chip-off" />Not visible</li>
            <li><span className="chip chip-unknown" />Unknown</li>
            <li><span className="chip chip-dark" />Longest darkness</li>
          </ul>
        </div>
        <fieldset className="delays site-select">
          <legend>Site shown in the readouts, panorama and elevation chart</legend>
          <div className="segmented" role="radiogroup" aria-label="Panorama site">
            {views.map((v) => (
              <button
                key={v.entry.id}
                type="button"
                role="radio"
                aria-checked={v.entry.id === active}
                className={v.entry.id === active ? "seg-btn active" : "seg-btn"}
                onClick={() => setActive(v.entry.id)}
                data-site={v.entry.id}
              >
                {v.profile.short}
              </button>
            ))}
          </div>
        </fieldset>

        <Readouts view={activeView} mode={mode} />

        <div className="chart-head sub">
          <h3 id="pano-h">Horizon panorama at the selected time: {activeView.profile.label}</h3>
          <ul className="legend" aria-label="Panorama legend">
            <li><span className={`chip chip-terrain chip-terrain-${mode}`} />{mode === "terrain" ? "Terrain (below skyline)" : "Below 0° horizon"}</li>
            <li><span className="marker-key marker-key-sun" />Sun</li>
            <li><span className="marker-key marker-key-earth" />Earth</li>
            <li><span className="marker-key marker-key-hidden" />Hidden (below horizon)</li>
          </ul>
        </div>
        {mode === "terrain" && activeView.profile.provisionalTerrain && (
          <p className="provisional small" role="note">⚠ {activeView.profile.provisionalTerrain}. Showing the {terrainModelLabel(activeSite)}.</p>
        )}
        <div ref={panoRef} className="plots" data-site={active}>
          <Panorama
            key={active}
            width={panoWidth}
            mode={mode}
            horizon={horizon}
            terrain={mode === "terrain" ? (activeSite.terrain_horizon ?? null) : null}
            samples={activeSite.samples}
            i0={i0}
            i1={i1}
            status={activeView.status}
            selectedTime={cursorT}
            centerAz={activeView.profile.panoramaCenterAz}
          />
        </div>
        {mode === "terrain" && activeSite.terrain_horizon && <SiteShiftNote site={activeSite} t={activeSite.terrain_horizon} />}
        <HorizonFacts site={activeSite} profile={activeView.profile} mode={mode} />

        <div ref={wrapRef} className="plots">
          <div className="chart-head sub">
            <h3>Visibility timelines (all compared sites, one UTC axis)</h3>
          </div>
          <Timeline scale={scale} tracks={tracks} cursor={cursorT} onSelect={(t) => setCursor(clampNum(nearestIndex(times, t), i0, i1))} />
          <div className="chart-head sub">
            <h3>Elevation of body centers: {activeView.profile.label}</h3>
            <ul className="legend" aria-label="Elevation legend">
              <li><span className="swatch swatch-sun" />Sun</li>
              <li><span className="swatch swatch-earth" />Earth</li>
              <li><span className="swatch swatch-horizon" />0° {mode === "terrain" ? "(smooth comparison)" : "smooth horizon"}</li>
              {mode === "terrain" && <li><span className="swatch swatch-h-sun" />Skyline under the Sun</li>}
              {mode === "terrain" && <li><span className="swatch swatch-h-earth" />Skyline under the Earth</li>}
            </ul>
          </div>
          <ElevationChart
            key={active}
            samples={activeSite.samples}
            times={times}
            i0={i0}
            i1={i1}
            selected={cursor}
            onSelect={setCursor}
            scale={scale}
            horizonAtBody={horizonAtBody}
            zeroLabel={mode === "terrain" ? "0° (smooth-horizon comparison; terrain skyline dashed in color)" : "0° smooth horizon (terrain ignored)"}
          />
        </div>
        <div className="slider-row">
          <button type="button" onClick={() => setCursor(cursor - 1)} disabled={cursor <= i0} aria-label="Back 10 minutes">‹</button>
          <input
            type="range"
            min={i0}
            max={i1}
            step={1}
            value={cursor}
            onChange={(e) => setCursor(Number(e.target.value))}
            aria-label="Selected time"
            aria-valuetext={fmtUtc(cursorT)}
          />
          <button type="button" onClick={() => setCursor(cursor + 1)} disabled={cursor >= i1} aria-label="Forward 10 minutes">›</button>
        </div>
        <p className="muted small">
          Drag on the timeline or chart, or use the slider (arrow keys step 10 minutes, Page Up/Down larger steps, Home/End
          the window edges). One UTC time is shared by every site, the cards, the readouts, the panorama and the charts.
        </p>
        {views.map((v) => (
          <IntervalTables key={v.entry.id} label={v.profile.label} intervals={v.intervals} baseW={baseW} actW={effDelay ? actW : null} delayedLabel={delayedLabel} />
        ))}
      </section>

      <section className="card sources-card" aria-labelledby="src-h">
        <h2 id="src-h">Method, sources and limitations</h2>
        <h3>Method (all sites)</h3>
        <ul>
          <li>Sun and Earth positions: JPL Horizons airless apparent azimuth/elevation of each body’s center, every 10 minutes, for each site’s own observer point (altitude above the 1737.4 km lunar reference sphere, listed per site below).</li>
          <li>Each 10-minute step is classified at its midpoint: visible when the center’s elevation is strictly above the horizon at the center’s azimuth ({mode === "terrain" ? "terrain skyline" : "0° in smooth mode"}). This uses the center of both the Sun and Earth, not their disks.</li>
          <li>10 minutes is the sampling and reporting resolution, not a guaranteed accuracy of event times. Rises, sets and darkness boundaries are placed on the 10-minute grid as estimates, and a crossing can fall anywhere within its step. At a selected time near a crossing, the body center can already be on the other side of the horizon while its step is still classified the other way; the app then says “Near estimated crossing” rather than changing either value.</li>
          <li>Terrain horizon: for every 0.1° of azimuth, the highest apparent elevation of LOLA terrain along a great-circle ray from the observer, with exact sphere geometry (lunar curvature counted once); rays continue until even the highest lunar terrain could not rise above the skyline found so far. Directions the data cannot reach would be shown as unknown, never as clear.</li>
          <li>Both sites always use the same horizon model, the same mission windows and the same UTC time. Delays shift the windows by +1, +3 or +7 days from the baseline arrival; the duration is unchanged.</li>
          <li>Unknown data is never counted as darkness or as visible; a metric is shown as unavailable instead.</li>
        </ul>
        <div className="two-col">
          {views.map((v) => (
            <SiteSources key={v.entry.id} v={v} mode={mode} />
          ))}
        </div>
        <h3 className="common-limits">Limitations common to all sites</h3>
        <ul>
          <li>Visibility uses the center of both the Sun and Earth. Part of either disk may remain visible when its center is hidden, and part may already be hidden when its center is visible. The Sun appears about 0.5° across and Earth about 1.9° (nominal sizes; the dataset holds no angular diameters), so this matters most for Earth. No refraction (the Moon has no atmosphere).</li>
          <li>Earth visible is a geometric opportunity, not a guaranteed communications link. Sun visible is not electrical power output.</li>
          <li>Results outside {fmtUtc(cov.start)} – {fmtUtc(cov.end)} are not available; events beyond that range are reported as “not found in available data”, never as “never”.</li>
          <li>No overall ranking: this tool compares modeled visibility and does not judge which site is a better landing site.</li>
          <li>Educational planning prototype, not a flight-qualified analysis tool.</li>
        </ul>
        <p className="muted small">Dataset <code>{manifest.dataset_id}</code>, generated {manifest.generated_at_utc}.</p>
      </section>
    </main>
  );
}

// ------------------------------------------------------------------ site card

function pctText(a: Availability<number>) {
  return a.ok ? `${a.value.toFixed(1)} %` : "unavailable";
}

function modelLine(site: SiteData, mode: HorizonMode) {
  return mode === "terrain" ? `Terrain: ${terrainModelLabel(site)}` : "Smooth 0° horizon (terrain ignored)";
}

function SiteCard({ v, mode, delayedLabel, effDelay, cursorT, isActive, onShow }: {
  v: SiteView; mode: HorizonMode; delayedLabel: string | null; effDelay: number; cursorT: number; isActive: boolean; onShow: () => void;
}) {
  const meta = v.data.site;
  const st = v.status;
  const changeHead = delayedLabel ? `Change: +${effDelay} d vs baseline` : null;
  return (
    <article className={isActive ? "card site-compare active-site" : "card site-compare"} data-site={v.entry.id} aria-labelledby={`card-${v.entry.id}`}>
      <p className="label">{v.profile.short}</p>
      <h2 id={`card-${v.entry.id}`}>{v.profile.label}</h2>
      <p className="coords num">{fmtLat(meta.latitude_deg)}, {fmtLonEast(meta.longitude_deg_east)}</p>
      <p className="muted small">{v.profile.kind}.</p>
      <p className="small model-line" data-field="model">Model shown: <strong>{modelLine(v.data, mode)}</strong></p>
      {mode === "terrain" && v.profile.provisionalTerrain && (
        <p className="provisional" role="note" data-field="provisional">
          ⚠ {v.profile.provisionalTerrain}
          <span className="small"> — applies to the model shown above{v.profile.assessment ? "; see the 5 m assessment below" : ""}.</span>
        </p>
      )}
      <div className="table-scroll plain">
        <table className="compare">
          <thead>
            <tr>
              <th scope="col">Metric</th>
              <th scope="col">Baseline</th>
              {delayedLabel && <th scope="col">{delayedLabel}</th>}
              {changeHead && <th scope="col">{changeHead}</th>}
            </tr>
          </thead>
          <tbody>
            <MetricRow label="Sun center visible" col={delayedLabel} change={changeHead} base={v.base.sunPct} act={delayedLabel ? v.act.sunPct : null} delta={v.cmp.sunPp} field="sun" />
            <MetricRow label="Earth center visible" col={delayedLabel} change={changeHead} base={v.base.earthPct} act={delayedLabel ? v.act.earthPct : null} delta={v.cmp.earthPp} field="earth" />
            <MetricRow label="Both visible" col={delayedLabel} change={changeHead} base={v.base.bothPct} act={delayedLabel ? v.act.bothPct : null} delta={v.cmp.bothPp} field="both" />
            <tr data-field="dark">
              <th scope="row">Longest darkness</th>
              <td data-label="Baseline"><DarkCell m={v.base.longestDark} /></td>
              {delayedLabel && <td data-label={delayedLabel}><DarkCell m={v.act.longestDark} /></td>}
              {changeHead && <td className="num" data-label={changeHead}>{v.cmp.darkHours === null ? "unavailable" : fmtSigned(v.cmp.darkHours, "h")}</td>}
            </tr>
          </tbody>
        </table>
      </div>
      <DarkNotes label="Baseline" m={v.base.longestDark} />
      {delayedLabel && <DarkNotes label={delayedLabel} m={v.act.longestDark} />}
      <p className="small at-time" data-field="at-time">
        At {fmtUtc(cursorT)}: Sun <AtState s={st.sun} />, Earth <AtState s={st.earth} />
      </p>
      <button type="button" className="show-btn" aria-pressed={isActive} onClick={onShow} disabled={isActive}>
        {isActive ? "Shown in panorama" : "Show in panorama"}
      </button>
      {v.profile.assessment === "cr1-5m" && <AssessmentPanel />}
    </article>
  );
}

/** State word for the card's "At <time>" line, with the shared near-crossing qualifier. */
function AtState({ s }: { s: BodyStatus }) {
  return (
    <>
      <strong>{stateLabel(s.visible)}</strong>
      {s.nearCrossing && <span className="near-flag" title="The center is on the other side of the horizon at this exact time; see the readouts"> ({NEAR_CROSSING.toLowerCase()})</span>}
    </>
  );
}

function MetricRow({ label, col, change, base, act, delta, field }: {
  label: string; col: string | null; change: string | null; base: Availability<number>; act: Availability<number> | null; delta: number | null; field: string;
}) {
  return (
    <tr data-field={field}>
      <th scope="row">{label}</th>
      <td className="num" data-label="Baseline" title={base.ok ? undefined : base.reason}>{pctText(base)}</td>
      {act && <td className="num" data-label={col ?? ""} title={act.ok ? undefined : act.reason}>{pctText(act)}</td>}
      {act && <td className="num" data-label={change ?? "Change"}>{delta === null ? "unavailable" : fmtSigned(delta, "pp")}</td>}
    </tr>
  );
}

function DarkCell({ m }: { m: Availability<DarkRun | null> }) {
  if (!m.ok) return <span title={m.reason}>unavailable</span>;
  if (!m.value) return <span>None in window</span>;
  const d = m.value;
  return (
    <span className="num">
      {fmtHours(d.durationMs)}
      {(d.touchesStart || d.touchesEnd) && <span className="flag" title="Touches a window boundary"> ⚠</span>}
    </span>
  );
}

function DarkNotes({ label, m }: { label: string; m: Availability<DarkRun | null> }) {
  if (!m.ok || !m.value || !(m.value.touchesStart || m.value.touchesEnd)) return null;
  const d = m.value;
  const where = d.touchesStart && d.touchesEnd ? "both window edges" : d.touchesStart ? "the window start" : "the window end";
  return (
    <details className="note small dark-note">
      <summary>⚠ {label}: longest darkness touches {where}; its full length may be longer than shown.</summary>
      <p>
        In the window: {fmtUtc(d.start)} → {fmtUtc(d.end)}.{" "}
        {d.touchesStart && (
          <>
            It may have begun before arrival: in the data it began{" "}
            {d.fullStartAtCoverageEdge ? `at or before the start of available data, ${fmtUtc(d.fullStart)}` : `at ${fmtUtc(d.fullStart)}`}.{" "}
          </>
        )}
        {d.touchesEnd && (
          <>
            It may continue after departure: in the data it lasts until{" "}
            {d.fullEndAtCoverageEdge ? `at least the end of available data, ${fmtUtc(d.fullEnd)}` : fmtUtc(d.fullEnd)}.
          </>
        )}
      </p>
    </details>
  );
}

// ------------------------------------------------------------------ CR1 5 m assessment

const WINDOW_LABEL: Record<string, string> = { "+0d": "baseline", "+1d": "+1 d", "+3d": "+3 d", "+7d": "+7 d" };

export function AssessmentPanel() {
  const a = CR1_5M;
  const f = (x: [number, number]) => `${x[0].toFixed(1)} % / ${x[1].toFixed(1)} h`;
  return (
    <details className="assessment small" data-testid="assessment">
      <summary>5 m terrain assessment (comparison only; not the displayed model)</summary>
      <p>
        The displayed CR1 result uses the 20 m LOLA model. It was compared with the <a href={a.product.url} target="_blank" rel="noreferrer">{a.product.title}</a> ({a.product.citation}).
        The 5 m variants are <strong>not offered as selectable models</strong>: their Sun and Earth positions were either computed for the 20 m
        observer point or never fetched, and they were not exported or validated like the displayed result.
      </p>
      <h4>Observer-height conventions</h4>
      <ul>
        <li>
          <strong>Fixed observer point</strong> (same point in space as the fetched positions, Horizons altitude {a.observer.fixedRadiusAltitudeKm} km):
          the eye is {a.observer.fixedEyeAbove20m.toFixed(3)} m above the 20 m surface but only {a.observer.fixedEyeAbove5m.toFixed(3)} m above the 5 m
          surface, which is {(a.surfaceM.pgda5 - a.surfaceM.ldem20).toFixed(2)} m higher at the point.
        </li>
        <li>
          <strong>Same nominal height above the 5 m surface</strong> (eye {a.observer.nominalEyeAbove5m.toFixed(3)} m, altitude {a.observer.nominalAltitudeKm} km):
          skyline only; publishing it would require new Horizons positions at that altitude.
        </li>
      </ul>
      <h4>Pairwise comparisons (not additive; not uncertainties)</h4>
      <div className="table-scroll plain">
        <table className="shift-table">
          <thead><tr><th scope="col">Comparison</th><th scope="col">Largest skyline change</th><th scope="col">Sun 10-min steps changed (of 8 640)</th></tr></thead>
          <tbody>
            {a.comparisons.map((c) => (
              <tr key={c.label}><th scope="row">{c.label}</th><td className="num">up to {c.maxDeg.toFixed(2)}°</td><td className="num">up to {c.sunSteps}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <h4>Demo windows ({a.demoWindows}): Sun % / longest darkness</h4>
      <div className="table-scroll plain">
        <table className="shift-table">
          <thead>
            <tr><th scope="col">Window</th><th scope="col">20 m (displayed)</th><th scope="col">5 m, fixed point</th><th scope="col">5 m, nominal eye</th><th scope="col">5 m all-up / all-down illustration</th></tr>
          </thead>
          <tbody>
            {a.demo.map((r) => (
              <tr key={r.window}>
                <th scope="row">{WINDOW_LABEL[r.window]}</th>
                <td className="num">{f(r.displayed20m)}</td>
                <td className="num">{f(r.fixed5m)}</td>
                <td className="num">{f(r.nominal5m)}</td>
                <td className="num">{f(r.allUp)} · {f(r.allDown)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h4>Limitations of this assessment</h4>
      <ul>
        <li>The “all-up / all-down” column moves every skyline point by its own 1σ height error at once. It is a <strong>non-statistical illustration</strong>: not a confidence interval, not a bound, and it has no stated probability.</li>
        <li>The height error was converted to an angle as atan(σ/distance) (median {a.sigmaAngleDeg.median.toFixed(2)}°, 95th percentile {a.sigmaAngleDeg.p95.toFixed(1)}°). This omits the observer’s own surface error, horizontal position error, correlations between pixels, the coordinate’s unknown accuracy, rocks and sub-pixel relief.</li>
        <li>Alignment: zero shift was the best fit among the tested shifts ({a.alignment.tested}); smaller or untested offsets are not ruled out. Vertical offset near the point: +{a.alignment.verticalWithin1kmM.toFixed(2)} m.</li>
        <li>Finer pixels do not guarantee accuracy: about 90 % of the 5 m pixels near the point are interpolated between laser tracks.</li>
        <li>Conclusion: the change between models is comparable to the 5 m model’s own stated error; eye height and position matter as much or more. CR1’s terrain result therefore stays provisional.</li>
      </ul>
    </details>
  );
}

// ------------------------------------------------------------------ locator

function Locator({ views }: { views: { entry: SiteEntry; profile: SiteProfile; selected: boolean }[] }) {
  const pts = views.map((v) => ({ ...v, ...polarXY(v.entry.data.site.latitude_deg, v.entry.data.site.longitude_deg_east) }));
  const maxR = Math.max(60, ...pts.map((p) => Math.hypot(p.x, p.y)));
  const extent = Math.ceil((maxR * 1.25) / 30) * 30; // km from the pole to the plot edge
  const size = 260;
  const c = size / 2;
  const k = (c - 30) / extent; // leave room outside the circle for longitude labels
  const ringsLat = [89, 88, 86, 84, 82].filter((lat) => 2 * 1737.4 * Math.tan(((90 - lat) * Math.PI) / 360) <= extent);
  const pair = views.length >= 2 ? surfaceDistanceKm(views[0].entry.data.site, views[1].entry.data.site) : null;
  return (
    <figure className="locator">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img"
        aria-label={`South polar map: ${pts.map((p) => `${p.profile.short} at ${fmtLat(p.entry.data.site.latitude_deg)}, ${fmtLonEast(p.entry.data.site.longitude_deg_east)}`).join("; ")}`}>
        <circle cx={c} cy={c} r={extent * k} className="loc-edge" />
        {ringsLat.map((lat) => {
          const r = 2 * 1737.4 * Math.tan(((90 - lat) * Math.PI) / 360) * k;
          return (
            <g key={lat}>
              <circle cx={c} cy={c} r={r} className="loc-ring" />
              <text x={c + r * Math.SQRT1_2 + 2} y={c + r * Math.SQRT1_2 + 9} className="loc-tick">{lat}° S</text>
            </g>
          );
        })}
        {[0, 90, 180, 270].map((lon) => {
          const l = (lon * Math.PI) / 180;
          const r = extent * k;
          return (
            <g key={lon}>
              <line x1={c} y1={c} x2={c + r * Math.sin(l)} y2={c - r * Math.cos(l)} className="loc-ring" />
              <text x={c + (r + 14) * Math.sin(l)} y={c - (r + 10) * Math.cos(l)} className="loc-tick" textAnchor="middle" dy="0.32em">
                {lon === 0 ? "0°" : lon === 180 ? "180°" : `${lon}° E`}
              </text>
            </g>
          );
        })}
        <path d={`M${c - 4},${c}H${c + 4}M${c},${c - 4}V${c + 4}`} className="loc-pole" />
        {pts.map((p) => (
          <g key={p.entry.id} className={p.selected ? "loc-site" : "loc-site loc-off"} data-site={p.entry.id}>
            <circle cx={c + p.x * k} cy={c - p.y * k} r={4} />
            <text x={c + p.x * k + (p.x >= 0 ? 7 : -7)} y={c - p.y * k} dy="0.32em" textAnchor={p.x >= 0 ? "start" : "end"}>{p.profile.short}</text>
          </g>
        ))}
      </svg>
      <figcaption className="muted small">
        South polar stereographic projection (sphere 1737.4 km, true scale at the pole; 0° longitude up, 90° E right), {extent} km
        from the pole to the edge. Positions are projected; labels are not to scale and no terrain is drawn.
        {pair !== null && ` Distance between the two points: about ${pair.toFixed(0)} km over the surface.`}
      </figcaption>
    </figure>
  );
}

// ------------------------------------------------------------------ sources and limitations per site

function SiteSources({ v, mode }: { v: SiteView; mode: HorizonMode }) {
  const site = v.data;
  const meta = site.site;
  const coord = site.sources.find((x) => x.id === "site-coordinates");
  const querySources = site.sources.filter((x) => /^horizons-(sun|earth)-\d+$/.test(x.id));
  const facts = terrainFacts(site);
  const shifts = site.terrain_horizon?.checks.site_shift_scenarios?.rows ?? [];
  const maxShift = shifts.length ? Math.max(...shifts.map((r) => r.skyline_max_abs_change_deg)) : null;
  return (
    <div data-site={meta.id} className="site-sources">
      <h3>{v.profile.label}</h3>
      <dl className="facts">
        <dt>Coordinates</dt>
        <dd className="num">{fmtLat(meta.latitude_deg)}, {fmtLonEast(meta.longitude_deg_east)}</dd>
        <dt>Surface</dt>
        <dd className="num">{meta.surface_elevation_m?.toFixed(1)} m above the 1737.4 km sphere (LOLA, rounded to 0.1 m)</dd>
        <dt>Observer</dt>
        <dd className="num">{meta.observer_height_above_surface_m} m nominal; Horizons altitude {meta.horizons_site_altitude_km} km
          {site.terrain_horizon?.observer ? `; eye ${site.terrain_horizon.observer.eye_above_dem_surface_m.toFixed(3)} m above the interpolated surface` : ""}</dd>
      </dl>
      <h4>Sources</h4>
      <ul className="sources">
        {coord && <li>Coordinates: <a href={coord.url} target="_blank" rel="noreferrer">{coord.title}</a></li>}
        <li>
          Positions: {querySources.length} exact JPL Horizons queries:{" "}
          {querySources.map((x, k) => (
            <span key={x.id}>{k ? ", " : ""}<a href={x.url} target="_blank" rel="noreferrer">{x.id.replace("horizons-", "")}</a></span>
          ))}
        </li>
        {site.sources.filter((x) => x.id.startsWith("lola-")).map((x) => (
          <li key={x.id}><a href={x.url} target="_blank" rel="noreferrer">{x.title}</a></li>
        ))}
        {site.sources.filter((x) => x.id === "horizons-api-doc" || x.id === "horizons-manual").map((x) => (
          <li key={x.id}><a href={x.url} target="_blank" rel="noreferrer">{x.title}</a></li>
        ))}
        {v.profile.assessment === "cr1-5m" && (
          <li>Assessment only (not displayed): <a href={CR1_5M.product.url} target="_blank" rel="noreferrer">{CR1_5M.product.title}</a></li>
        )}
      </ul>
      <h4>Limitations for this site</h4>
      <ul>
        <li>{v.profile.realityNote}</li>
        {mode === "smooth" && <li><strong>Smooth mode ignores terrain.</strong> The 0° line is the local horizontal plane, not the real horizon.</li>}
        {mode === "terrain" && facts && (
          <>
            {v.profile.provisionalTerrain && (
              <li><strong>{v.profile.provisionalTerrain}.</strong> The displayed result is the {terrainModelLabel(site)}; a 5 m model, the observer height and the exact position all change it noticeably (see the assessment in the site card).</li>
            )}
            {facts.nearFieldDominated && (
              <li>The whole skyline is set by modeled relief {facts.settingDistanceM[0].toFixed(0)}–{facts.settingDistanceM[2].toFixed(0)} m from the point, while the Sun’s center stays only {facts.sunElevationRange[0].toFixed(2)}–{facts.sunElevationRange[1].toFixed(2)}° above the horizontal plane, so small terrain differences decide whole sunlit periods.</li>
            )}
            <li>Regional terrain, not the lander’s view: terrain pixels are {Object.values(site.terrain_horizon!.horizon.resolution.dem_pixel_m).join(" m, then ")} m apart; rocks, small craters and any lander are not resolved.</li>
            <li>{facts.zeroShot} of {facts.known} skyline points lie in pixels without a LOLA shot (interpolated heights). Shot counts indicate data density, not accuracy.</li>
            {maxShift !== null && <li>Moving the observer 100 m north, east, south or west changes the skyline by up to {maxShift.toFixed(1)}° (test scenarios, not a measured uncertainty).</li>}
            <li>Comparisons with LOLA laser shots are consistency checks: the terrain model was built from those shots.</li>
          </>
        )}
        {v.profile.limitations.map((x) => <li key={x}>{x}</li>)}
      </ul>
    </div>
  );
}

// ------------------------------------------------------------------ active-site panorama notes

const pp = (v: number | null) => (v === null ? "n/a" : fmtSigned(v, "pp", 2));

function SiteShiftNote({ site, t }: { site: SiteData; t: TerrainHorizonBlock }) {
  const sc = t.checks.site_shift_scenarios;
  if (!sc || !sc.rows.length) return null;
  const rows = sc.rows;
  const maxSky = Math.max(...rows.map((r) => r.skyline_max_abs_change_deg));
  const byAbs = (xs: (number | null)[]) => xs.reduce<number>((m, x) => (x !== null && Math.abs(x) > Math.abs(m) ? x : m), 0);
  const sunWorst = rows.map((r) => byAbs(r.sun_pct_change_pp)).reduce((m, x) => (Math.abs(x) > Math.abs(m) ? x : m), 0);
  const earthWorst = rows.map((r) => byAbs(r.earth_pct_change_pp)).reduce((m, x) => (Math.abs(x) > Math.abs(m) ? x : m), 0);
  return (
    <div className="site-shift small" data-testid="site-shift" data-site={site.site.id}>
      <p>
        <strong>Site-position sensitivity (test scenarios, not an uncertainty range):</strong> moving the observer 100 m due north,
        east, south or west of the published point changed this skyline by up to {maxSky.toFixed(1)}° and the demo-window Sun-visible
        share by up to {pp(sunWorst)} and Earth-visible share by up to {pp(earthWorst)}, relative to the nominal point.
      </p>
      <details>
        <summary>Scenario details</summary>
        <p className="muted">{sc.note}</p>
        <div className="table-scroll plain">
          <table className="shift-table">
            <thead>
              <tr>
                <th scope="col">Observer moved 100 m</th>
                <th scope="col">Largest skyline change</th>
                <th scope="col">Median change</th>
                <th scope="col">Sun % change ({rows[0].demo_windows.map((w) => WINDOW_LABEL[w] ?? w).join(" / ")})</th>
                <th scope="col">Earth % change</th>
                <th scope="col">Longest darkness change</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.direction}>
                  <th scope="row">{r.direction}</th>
                  <td className="num">{r.skyline_max_abs_change_deg.toFixed(2)}° at az {r.skyline_max_change_at_azimuth_deg.toFixed(1)}°</td>
                  <td className="num">{r.skyline_median_abs_change_deg.toFixed(2)}°</td>
                  <td className="num">{r.sun_pct_change_pp.map(pp).join(" / ")}</td>
                  <td className="num">{r.earth_pct_change_pp.map(pp).join(" / ")}</td>
                  <td className="num">{r.longest_dark_change_h.map((h) => (h === null ? "n/a" : fmtSigned(h, "h", 2))).join(" / ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted">
          Windows: 14 days from 2026-12-05 00:00 UTC with the four demo delays, not the window selected above. Four directions only;
          other directions and distances were not tested. Details: <code>data/terrain/{site.site.id}_terrain_horizon.json</code>.
        </p>
      </details>
    </div>
  );
}

function HorizonFacts({ site, profile, mode }: { site: SiteData; profile: SiteProfile; mode: HorizonMode }) {
  const t = site.terrain_horizon;
  const obsH = site.site.observer_height_above_surface_m;
  if (mode === "smooth" || !t) {
    return (
      <details className="facts-box small" data-site={site.site.id}>
        <summary>About this horizon ({profile.short}): smooth 0° model</summary>
        <dl className="facts">
          <dt>Model</dt>
          <dd>0° at every azimuth (the local horizontal plane); terrain ignored</dd>
          <dt>Observer</dt>
          <dd>{obsH} m above the surface (the ~0.06° dip of a smooth sphere is also ignored)</dd>
          <dt>Use</dt>
          <dd>Comparison with the terrain horizon; not a prediction of real visibility</dd>
        </dl>
      </details>
    );
  }
  const h = t.horizon;
  const se = h.search_extent;
  const rs = h.resolution;
  const facts = terrainFacts(site)!;
  const pix = Object.entries(rs.dem_pixel_m).map(([k, v]) => `${k} ${v} m`).join(", then ");
  const nf = t.checks.near_field;
  const obsEye = t.observer ? t.observer.eye_above_dem_surface_m.toFixed(3) : String(obsH);
  return (
    <details className="facts-box small" open data-site={site.site.id}>
      <summary>About this horizon ({profile.short}): terrain model, source and limits</summary>
      <dl className="facts">
        <dt>Model shown</dt>
        <dd>{terrainModelLabel(site)}{profile.provisionalTerrain ? ` — ${profile.provisionalTerrain.toLowerCase()}` : ""}</dd>
        <dt>Observer</dt>
        <dd>
          {obsH} m (nominal) above the LOLA surface at {fmtLat(site.site.latitude_deg)}, {fmtLonEast(site.site.longitude_deg_east)}. The Horizons
          altitude was formed from the surface rounded to 0.1 m, so the eye is {obsEye} m above the interpolated surface; Sun, Earth and skyline
          all use that same point.{profile.roundingEffect ? ` ${profile.roundingEffect}` : ""}
        </dd>
        <dt>Terrain pixels</dt>
        <dd className="num">{pix} (the terrain detail the model can represent)</dd>
        <dt>Ray sampling</dt>
        <dd className="num">
          {rs.azimuth_step_deg}° in azimuth; along each ray the terrain surface is interpolated every {rs.radial_step_m[0]} m to {rs.radial_step_change_km} km, then every {rs.radial_step_m[1]} m. Finer sampling than the pixel spacing does not add detail.
        </dd>
        <dt>Near the observer</dt>
        <dd className="num">
          Skyline points are {facts.settingDistanceM[0].toFixed(0)}–{facts.settingDistanceM[2].toFixed(0)} m away (median {facts.settingDistanceM[1].toFixed(0)} m).
          {nf ? ` Ignoring all terrain within 20–300 m changes the skyline by up to ${nf.max_change_ignoring_terrain_within_20_to_300m_deg.toFixed(2)}°.` : ""}{" "}
          This concerns the modeled surface only; rocks or relief smaller than a pixel could still block low directions.
        </dd>
        <dt>Search</dt>
        <dd className="num">
          {se.stop_distance_km_min_median_max[0].toFixed(0)}–{se.stop_distance_km_min_median_max[2].toFixed(0)} km per ray (stops when even {se.h_max_m.toFixed(0)} m terrain could not appear higher); unknown directions: {se.unknown_azimuths}
        </dd>
        <dt>Skyline</dt>
        <dd className="num">{fmtDeg(facts.elevationRange[0], 2)} to {fmtDeg(facts.elevationRange[1], 2)}; negative values are real (the ground falls away and the Moon curves)</dd>
        <dt>Data density</dt>
        <dd className="num">{facts.zeroShot} of {facts.known} skyline points lie in pixels without a LOLA shot (interpolated).</dd>
        <dt>Limits</dt>
        <dd>{profile.realityNote} See the site-position scenarios above.</dd>
      </dl>
    </details>
  );
}

// ------------------------------------------------------------------ readouts and tables

function stateText(s: Tri) {
  return s === null ? "Unknown" : s ? "Visible" : "Not visible";
}

function changeText(body: string, c: NextChange, mode: HorizonMode) {
  if (!c.found) return `Next change: not found in available data (searched through ${fmtUtc(c.searchedUntil)})`;
  const hz = mode === "terrain" ? "terrain horizon" : "smooth horizon";
  const what = c.to === null ? `${body} state becomes unknown` : `${body} center ${c.to ? `rises above the ${hz}` : `drops below the ${hz}`}`;
  return `${what} ≈ ${fmtUtc(c.at)} (estimate on the 10-minute reporting grid)`;
}

const stateClass = (s: Tri) => `state state-${s === null ? "unknown" : s ? "on" : "off"}`;

function Readouts({ view, mode }: { view: SiteView; mode: HorizonMode }) {
  const st = view.status;
  const t = st.t;
  const tiles: { key: "sun" | "earth"; label: string; s: BodyStatus }[] = [
    { key: "sun", label: "Sun", s: st.sun },
    { key: "earth", label: "Earth", s: st.earth },
  ];
  return (
    <div className="readouts-wrap" data-site={view.entry.id}>
      <p className="selected-time num" aria-live="polite">{fmtUtc(t)} <span className="muted small">at {view.profile.label}</span></p>
      <div className="readouts">
        {tiles.map(({ key, label, s }) => {
          const g = s.geometry;
          const why = nearCrossingExplanation(s, label, mode);
          return (
            <div className="readout" key={key} data-body={key} data-near={s.nearCrossing ? "true" : undefined}>
              <p className="readout-title">
                <span className={`swatch swatch-${key}`} aria-hidden="true" />
                {label}
                {s.nearCrossing && <span className="state state-near" data-field="near">{NEAR_CROSSING}</span>}
                <span className={stateClass(s.visible)} data-field="state">{stateLabel(s.visible)}</span>
              </p>
              <dl>
                <dt>Elevation</dt>
                <dd className="num" data-field="elevation">{fmtDeg(g.elevationDeg)}</dd>
                <dt>Azimuth</dt>
                <dd className="num" data-field="azimuth">{fmtDeg(g.azimuthDeg)} <span className="muted">{compass(g.azimuthDeg)}</span></dd>
                <dt>{mode === "terrain" ? "Skyline there" : "Horizon"}</dt>
                <dd className="num" data-field="horizon">{fmtDeg(g.horizonDeg)}</dd>
                <dt>Center vs {horizonName(mode)}</dt>
                <dd className="num" data-field="clearance">{signedClearance(g)}</dd>
              </dl>
              {why && <p className="readout-note near-note" data-field="near-note">{why}</p>}
              {s.visible === null && s.unknownReason && <p className="readout-note" data-field="unknown">Unknown: {unknownText(s.unknownReason)}.</p>}
              <p className="readout-note" data-field="next">{changeText(label, nextChange(view.intervals, t, key), mode)}</p>
            </div>
          );
        })}
        <div className="readout" data-body="both" data-near={st.both.nearCrossing ? "true" : undefined}>
          <p className="readout-title">
            <span className="chip chip-both" aria-hidden="true" />
            Both
            {st.both.nearCrossing && <span className="state state-near" data-field="near">{NEAR_CROSSING}</span>}
            <span className={stateClass(st.both.visible)} data-field="state">{stateLabel(st.both.visible)}</span>
          </p>
          <p className="readout-note">
            Modeled state of the 10-minute step starting at this time, classified at its midpoint ({mode === "terrain" ? "terrain" : "smooth"} horizon).
            Elevation, azimuth and clearance are the body centers at this exact time.
          </p>
        </div>
      </div>
    </div>
  );
}

function IntervalTables({ label, intervals, baseW, actW, delayedLabel }: {
  label: string; intervals: Interval[]; baseW: { start: number; end: number }; actW: { start: number; end: number } | null; delayedLabel: string | null;
}) {
  const groups = [{ key: "baseline", label: "Baseline", window: baseW }, ...(actW ? [{ key: "delayed", label: delayedLabel!, window: actW }] : [])];
  return (
    <details className="table-view">
      <summary>Visibility intervals table: {label}</summary>
      {groups.map((g) => (
        <div key={g.key} className="table-scroll">
          <table>
            <caption>{label}, {g.label}: {fmtUtc(g.window.start)} → {fmtUtc(g.window.end)} (body centers; boundaries are estimates on the 10-minute reporting grid)</caption>
            <thead>
              <tr>
                <th scope="col">Start (UTC)</th>
                <th scope="col">End (UTC)</th>
                <th scope="col">Duration</th>
                <th scope="col">Sun</th>
                <th scope="col">Earth</th>
                <th scope="col">Both</th>
              </tr>
            </thead>
            <tbody>
              {clip(intervals, g.window).map((iv) => (
                <tr key={iv.start}>
                  <td className="num">{fmtUtc(iv.start)}</td>
                  <td className="num">{fmtUtc(iv.end)}</td>
                  <td className="num">{fmtDuration(iv.end - iv.start)}</td>
                  <td>{stateText(iv.sun)}</td>
                  <td>{stateText(iv.earth)}</td>
                  <td>{stateText(bothState(iv.sun, iv.earth))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </details>
  );
}
