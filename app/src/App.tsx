import { useEffect, useMemo, useState } from "react";
import { ElevationChart } from "./ElevationChart";
import { Panorama } from "./Panorama";
import { Timeline, type TimelineGroup } from "./Timeline";
import { horizonAt, horizonFor, intervalsFor } from "./horizon";
import { timeScale, useWidth } from "./axis";
import { azimuth, compass, elevation, fmtDeg, fmtLat, fmtLonEast, fmtUtc, loadDataset, nearestIndex } from "./data";
import {
  type Availability,
  type DarkRun,
  type Interval,
  type NextChange,
  type Tri,
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
  intervalAt,
  nextChange,
  parseIntervals,
  scenarioWindow,
  utcDateString,
  utcHour,
} from "./mission";
import type { Dataset, HorizonMode, SiteData, TerrainHorizonBlock } from "./types";

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

// ------------------------------------------------------------------ URL state

function readUrlState() {
  const q = new URLSearchParams(window.location.search);
  const num = (k: string) => (q.get(k) === null ? null : Number(q.get(k)));
  const time = (k: string) => {
    const v = q.get(k);
    const ms = v ? Date.parse(v) : NaN;
    return Number.isFinite(ms) ? ms : null;
  };
  const hz = q.get("horizon");
  return {
    arrival: time("arrival"),
    days: num("days"),
    delay: num("delay"),
    t: time("t"),
    horizon: hz === "smooth" || hz === "terrain" ? (hz as HorizonMode) : null,
  };
}

const clampNum = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const HOURS = Array.from({ length: 24 }, (_, h) => h);

// ------------------------------------------------------------------ workspace

function Workspace({ ds }: { ds: Dataset }) {
  const { manifest, site, times } = ds;
  const init = useMemo(readUrlState, []);
  const terrainAvailable = !!site.terrain_horizon;
  // Default: terrain when it passed the loader checks; smooth stays available for comparison.
  const [mode, setMode] = useState<HorizonMode>(() =>
    terrainAvailable ? (init.horizon ?? "terrain") : "smooth",
  );
  const terrainRequestedButMissing = init.horizon === "terrain" && !terrainAvailable;
  const horizon = horizonFor(site, mode)!;
  const intervals = useMemo(() => parseIntervals(site, intervalsFor(site, mode)), [site, mode]);
  // Horizon elevation under each body at every sample (terrain mode, for the chart and readouts).
  const horizonAtBody = useMemo(() => {
    if (mode !== "terrain") return null;
    const sun = site.samples.map((x) => (x.sun_azimuth_deg === null ? null : horizonAt(horizon, x.sun_azimuth_deg)));
    const earth = site.samples.map((x) => (x.earth_azimuth_deg === null ? null : horizonAt(horizon, x.earth_azimuth_deg)));
    return { sun, earth };
  }, [site, mode, horizon]);
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

  // Keep the arrival valid when the duration changes.
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

  // Default cursor: start of the slipped window (or the baseline window), inside the plot.
  const [cursorRaw, setCursor] = useState(() => nearestIndex(times, init.t ?? actW.start));
  const cursor = clampNum(cursorRaw, i0, i1);
  const cursorT = times[cursor];

  const baseM = useMemo(() => computeMetrics(intervals, baseW), [intervals, baseW.start, baseW.end]);
  const actM = useMemo(() => computeMetrics(intervals, actW), [intervals, actW.start, actW.end]);
  const cmp = compare(baseM, actM);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("arrival", new Date(arrival).toISOString().replace(":00.000Z", "Z"));
    url.searchParams.set("days", String(days));
    url.searchParams.set("delay", String(effDelay));
    url.searchParams.set("t", site.samples[cursor].time_utc);
    url.searchParams.set("horizon", mode);
    window.history.replaceState(null, "", url);
  }, [arrival, days, effDelay, cursor, site.samples, mode]);

  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const [panoRef, panoWidth] = useWidth<HTMLDivElement>();
  const scale = timeScale(domain.start, domain.end, width);
  const dark = (m: typeof baseM) => (m.longestDark.ok ? m.longestDark.value : null);
  const groups: TimelineGroup[] = [{ key: "baseline", label: "Baseline", window: baseW, longestDark: dark(baseM) }];
  if (effDelay) groups.push({ key: "delayed", label: `Delay +${effDelay} d`, window: actW, longestDark: dark(actM) });

  const meta = site.site;
  const terrainEye = site.terrain_horizon?.observer ? site.terrain_horizon.observer.eye_above_dem_surface_m.toFixed(2) : null;
  const synthetic = manifest.is_synthetic || meta.is_synthetic;
  const arrivalDate = utcDateString(arrival);
  const latestDate = utcDateString(bounds.latest);
  const earliestDate = utcDateString(bounds.earliest);
  const delayedLabel = effDelay ? `Delay +${effDelay} d` : null;
  const querySources = site.sources.filter((x) => /^horizons-(sun|earth)-\d+$/.test(x.id));

  return (
    <main className="page">
      <header className="masthead">
        <div>
          <p className="eyebrow">Lunar Visibility Navigator · Mission windows · {mode === "terrain" ? "Terrain horizon" : "Smooth horizon"}</p>
          <h1>Sun and Earth visibility at the IM-2 Athena site</h1>
        </div>
        <div className="badges">
          {synthetic ? (
            <span className="badge badge-warn">⚠ Synthetic data</span>
          ) : (
            <span className="badge">Real data · JPL Horizons</span>
          )}
          <span className="badge">All times UTC</span>
        </div>
      </header>

      {mode === "terrain" ? (
        <div className="banner banner-terrain" role="note" data-mode="terrain">
          <strong>Terrain horizon (regional LOLA elevation model).</strong> “Visible” means the body’s center is above
          the skyline computed from the LOLA terrain model (20 m pixel spacing; 60 m beyond ~165 km) for an observer
          1 m above the modeled surface. This is regional DEM-based visibility, not a reconstruction of Athena’s actual
          conditions: rocks, the lander itself and features narrower than about one to two pixels are not resolved.
          Earth visible is a geometric opportunity, not a guaranteed radio link. Sun visible is not electrical power
          output.
        </div>
      ) : (
        <div className="banner" role="note" data-mode="smooth">
          <strong>⚠ Smooth horizon: terrain ignored (comparison mode).</strong> “Visible” means the body’s center is
          above the local horizontal plane (0°). Real crater walls and massifs can hide the Sun or Earth when this view
          says visible{terrainAvailable ? "; switch to Terrain to include them" : ""}. Earth visible is a geometric
          opportunity, not a guaranteed radio link. Sun visible is not electrical power output.
        </div>
      )}
      {terrainRequestedButMissing && (
        <div className="notice notice-error" role="alert">
          Terrain horizon requested but not available: {ds.terrainProblem}. Showing the smooth horizon.
        </div>
      )}

      <section className="card site-card" aria-labelledby="site-h">
        <p className="label">Site</p>
        <h2 id="site-h">{meta.name}</h2>
        <p className="coords num">
          {fmtLat(meta.latitude_deg)}, {fmtLonEast(meta.longitude_deg_east)}
        </p>
        <dl className="facts">
          <dt>Surface elevation</dt>
          <dd className="num">{meta.surface_elevation_m?.toFixed(1)} m above the 1737.4 km sphere (LOLA)</dd>
          <dt>Observer</dt>
          <dd className="num">
            {meta.observer_height_above_surface_m} m above the modeled surface (nominal; {terrainEye ? `${terrainEye} m after rounding the surface to 0.1 m` : "surface rounded to 0.1 m"})
          </dd>
          <dt>Horizons altitude</dt>
          <dd className="num">{meta.horizons_site_altitude_km} km above the 1737.4 km sphere</dd>
          <dt>Data coverage</dt>
          <dd className="num">
            {fmtUtc(cov.start)} – {fmtUtc(cov.end)}
          </dd>
        </dl>
      </section>

      <section className="card controls-card" aria-labelledby="ctl-h">
        <h2 id="ctl-h">Mission window</h2>
        <fieldset className="delays horizon-mode">
          <legend>Horizon model</legend>
          <div className="segmented" role="radiogroup" aria-label="Horizon model">
            {(["smooth", "terrain"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                className={mode === m ? "seg-btn active" : "seg-btn"}
                disabled={m === "terrain" && !terrainAvailable}
                title={m === "terrain" && !terrainAvailable ? `Unavailable: ${ds.terrainProblem}` : undefined}
                onClick={() => setMode(m)}
                data-mode={m}
              >
                {m === "smooth" ? "Smooth (0°)" : "Terrain (LOLA)"}
              </button>
            ))}
          </div>
          <p className="muted small">
            {mode === "terrain"
              ? "Skyline from the LOLA terrain model (20 m pixels). Switch to Smooth to compare with the flat 0° horizon; arrival, delay, duration and selected time stay the same."
              : "Flat 0° horizon, terrain ignored. Kept for comparison; arrival, delay, duration and selected time stay the same."}
            {!terrainAvailable && ` Terrain unavailable: ${ds.terrainProblem}.`}
          </p>
        </fieldset>
        <div className="controls">
          <label className="field">
            <span>Baseline arrival date (UTC)</span>
            <input
              type="date"
              value={arrivalDate}
              min={earliestDate}
              max={latestDate}
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
          <button type="button" onClick={() => setArrival(bounds.earliest)} disabled={arrival === bounds.earliest}>
            Earliest arrival
          </button>
          <button type="button" onClick={() => setArrival(bounds.latest)} disabled={arrival === bounds.latest}>
            Latest arrival without delay
          </button>
          <span className="small">
            Baseline arrival: <strong className="num">{fmtUtc(arrival)}</strong>
          </span>
          <span className="muted small">
            Allowed: {fmtUtc(bounds.earliest)} – {fmtUtc(bounds.latest)}
          </span>
        </div>

        <fieldset className="delays">
          <legend>Arrival slip (offset from the baseline, not cumulative)</legend>
          <div className="segmented" role="radiogroup">
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
            <p className="note small" role="status">
              +{delay} d no longer fits the data with this arrival; showing the baseline only.
            </p>
          )}
        </fieldset>
      </section>

      <section className="card compare-card" aria-labelledby="cmp-h">
        <h2 id="cmp-h">Comparison</h2>
        <div className="table-scroll plain">
          <table className="compare">
            <thead>
              <tr>
                <th scope="col">Metric</th>
                <th scope="col">Baseline</th>
                {delayedLabel && <th scope="col">{delayedLabel}</th>}
                {delayedLabel && <th scope="col">Change vs baseline</th>}
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Window (UTC)</th>
                <td className="num small" data-label="Baseline">{fmtUtc(baseW.start)} → {fmtUtc(baseW.end)}</td>
                {delayedLabel && <td className="num small" data-label={delayedLabel}>{fmtUtc(actW.start)} → {fmtUtc(actW.end)}</td>}
                {delayedLabel && <td className="num small" data-label="Change">+{effDelay} d shift</td>}
              </tr>
              <tr>
                <th scope="row">Duration</th>
                <td className="num" data-label="Baseline">{fmtDuration(baseM.durationMs)}</td>
                {delayedLabel && <td className="num" data-label={delayedLabel}>{fmtDuration(actM.durationMs)}</td>}
                {delayedLabel && <td className="num" data-label="Change">{actM.durationMs === baseM.durationMs ? "unchanged" : "CHANGED"}</td>}
              </tr>
              <MetricRow label="Sun center visible" col={delayedLabel} base={baseM.sunPct} act={delayedLabel ? actM.sunPct : null} delta={cmp.sunPp} />
              <MetricRow label="Earth center visible" col={delayedLabel} base={baseM.earthPct} act={delayedLabel ? actM.earthPct : null} delta={cmp.earthPp} />
              <MetricRow label="Both visible" col={delayedLabel} base={baseM.bothPct} act={delayedLabel ? actM.bothPct : null} delta={cmp.bothPp} />
              <tr>
                <th scope="row">Longest darkness</th>
                <td data-label="Baseline"><DarkCell m={baseM.longestDark} /></td>
                {delayedLabel && <td data-label={delayedLabel}><DarkCell m={actM.longestDark} /></td>}
                {delayedLabel && <td className="num" data-label="Change">{cmp.darkHours === null ? "unavailable" : fmtSigned(cmp.darkHours, "h")}</td>}
              </tr>
            </tbody>
          </table>
        </div>
        <DarkNotes label="Baseline" m={baseM.longestDark} />
        {delayedLabel && <DarkNotes label={delayedLabel} m={actM.longestDark} />}
        <p className="muted small">
          Percentages are shares of elapsed window time, for the{" "}
          <strong>{mode === "terrain" ? "terrain" : "smooth 0°"} horizon</strong>. Darkness means the Sun’s center is
          below that horizon. Boundaries are estimates at the modeled 10-minute resolution ({site.visibility_method}).
        </p>
      </section>

      <section className="card viz-card" aria-labelledby="viz-h">
        <div className="chart-head">
          <h2 id="viz-h">Selected time, horizon panorama and timeline</h2>
          <ul className="legend" aria-label="Legend">
            <li><span className="chip chip-sun" />Sun visible</li>
            <li><span className="chip chip-earth" />Earth visible</li>
            <li><span className="chip chip-both" />Both visible</li>
            <li><span className="chip chip-off" />Not visible</li>
            <li><span className="chip chip-unknown" />Unknown</li>
            <li><span className="chip chip-dark" />Longest darkness</li>
          </ul>
        </div>

        <Readouts ds={ds} intervals={intervals} index={cursor} mode={mode} horizonAtBody={horizonAtBody} />

        <div className="chart-head sub">
          <h3 id="pano-h">Horizon panorama at the selected time</h3>
          <ul className="legend" aria-label="Panorama legend">
            <li><span className={`chip chip-terrain chip-terrain-${mode}`} />{mode === "terrain" ? "Terrain (below skyline)" : "Below 0° horizon"}</li>
            <li><span className="marker-key marker-key-sun" />Sun</li>
            <li><span className="marker-key marker-key-earth" />Earth</li>
            <li><span className="marker-key marker-key-hidden" />Hidden (below horizon)</li>
          </ul>
        </div>
        <div ref={panoRef} className="plots">
          <Panorama
            width={panoWidth}
            mode={mode}
            horizon={horizon}
            terrain={site.terrain_horizon ?? null}
            samples={site.samples}
            i0={i0}
            i1={i1}
            selected={cursor}
            selectedTime={cursorT}
          />
        </div>
        {mode === "terrain" && site.terrain_horizon && <SiteShiftNote t={site.terrain_horizon} />}
        <HorizonFacts site={site} mode={mode} />

        <div ref={wrapRef} className="plots">
          <Timeline scale={scale} intervals={intervals} groups={groups} cursor={cursorT} onSelect={(t) => setCursor(clampNum(nearestIndex(times, t), i0, i1))} />
          <div className="chart-head sub">
            <h3>Elevation of body centers</h3>
            <ul className="legend" aria-label="Elevation legend">
              <li><span className="swatch swatch-sun" />Sun</li>
              <li><span className="swatch swatch-earth" />Earth</li>
              <li><span className="swatch swatch-horizon" />0° {mode === "terrain" ? "(smooth comparison)" : "smooth horizon"}</li>
              {mode === "terrain" && <li><span className="swatch swatch-h-sun" />Skyline under the Sun</li>}
              {mode === "terrain" && <li><span className="swatch swatch-h-earth" />Skyline under the Earth</li>}
            </ul>
          </div>
          <ElevationChart
            samples={site.samples}
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
          Drag on the timeline or chart, or use the slider (arrow keys step 10 minutes). The cursor, readouts,
          panorama, timeline and chart always show the same UTC time.
        </p>

        <IntervalTables groups={groups} intervals={intervals} />
      </section>

      <section className="card sources-card" aria-labelledby="src-h">
        <h2 id="src-h">Method, sources and limitations</h2>
        <div className="two-col">
          <div>
            <h3>Method</h3>
            <ul>
              <li>Sun and Earth positions: JPL Horizons airless apparent azimuth/elevation of each body’s center, every 10 minutes, seen from {meta.horizons_site_altitude_km} km above the 1737.4 km lunar reference sphere.</li>
              <li>Observer: LOLA surface elevation {meta.surface_elevation_m?.toFixed(1)} m + {meta.observer_height_above_surface_m} m observer height.</li>
              <li>Each 10-minute interval is classified at its midpoint: visible when the center’s elevation is strictly above the horizon at the center’s azimuth ({mode === "terrain" ? "terrain skyline" : "0° in smooth mode"}). Event times are estimates at that resolution.</li>
              <li>Terrain horizon: for every 0.1° of azimuth, the highest apparent elevation of LOLA terrain along a great-circle ray from the observer, using exact sphere geometry (lunar curvature counted once). Rays continue until even the highest lunar terrain could not rise above the skyline found so far (62–190 km here). Directions the data cannot reach would be shown as unknown, never as clear.</li>
              <li>Delays shift the whole window by +1, +3 or +7 days from the baseline arrival; the duration is unchanged.</li>
              <li>Unknown data is never counted as darkness or as visible; a metric is shown as unavailable instead.</li>
            </ul>
            <h3>Sources</h3>
            <ul className="sources">
              <li>
                Site coordinates: <a href={meta.coordinate_source_url} target="_blank" rel="noreferrer">LROC, “IM-2 Athena Seen Obliquely” (10 Mar 2025)</a>
              </li>
              <li>
                Positions: {querySources.length} exact JPL Horizons queries (10-day chunks):{" "}
                {querySources.map((x, k) => (
                  <span key={x.id}>
                    {k ? ", " : ""}
                    <a href={x.url} target="_blank" rel="noreferrer">{x.id.replace("horizons-", "")}</a>
                  </span>
                ))}
              </li>
              <li>Surface elevation: LOLA LDEM_80S_20M (PDS Geosciences Node), checked against individual LOLA laser shots.</li>
              {site.sources
                .filter((x) => x.id.startsWith("lola-"))
                .map((x) => (
                  <li key={x.id}>
                    <a href={x.url} target="_blank" rel="noreferrer">{x.title}</a>
                  </li>
                ))}
              {site.sources
                .filter((x) => x.id === "horizons-api-doc" || x.id === "horizons-manual")
                .map((x) => (
                  <li key={x.id}><a href={x.url} target="_blank" rel="noreferrer">{x.title}</a></li>
                ))}
            </ul>
            <p className="muted small">Dataset <code>{manifest.dataset_id}</code>, generated {manifest.generated_at_utc}.</p>
          </div>
          <div>
            <h3>Limitations</h3>
            <ul>
              {mode === "smooth" ? (
                <li><strong>Smooth mode ignores terrain.</strong> The 0° line is the local horizontal plane, not the real horizon.</li>
              ) : (
                <>
                  <li><strong>Regional terrain, not the lander’s actual view.</strong> LOLA terrain pixels are 20 m apart (60 m beyond ~165 km); the skyline rays sample that surface every 5–10 m, but sampling finer than a pixel adds no terrain detail. Boulders, small craters, the lander and its tilt are not resolved.</li>
                  <li>Where no LOLA shot fell in a pixel, its height is interpolated between ground tracks; about a quarter of the skyline points are such pixels. Shot counts indicate data density, not accuracy.</li>
                  <li>The published coordinate’s accuracy is not stated. Sensitivity scenarios that move the observer 100 m north, east, south or west change the skyline by up to 2° in one direction; these are test scenarios, not a measured uncertainty.</li>
                  <li>Comparisons with LOLA laser shots are consistency checks: the terrain model was built from those shots, so they do not validate it independently.</li>
                </>
              )}
              <li>Body centers only: no partial-disk Sun, no refraction (the Moon has no atmosphere).</li>
              <li>Earth visible is a geometric opportunity, not a guaranteed communications link.</li>
              <li>Sun visible is not electrical power output.</li>
              <li>Results outside {fmtUtc(cov.start)} – {fmtUtc(cov.end)} are not available; events beyond that range are reported as “not found in available data”, never as “never”.</li>
              <li>Educational planning prototype, not a flight-qualified analysis tool.</li>
            </ul>
          </div>
        </div>
      </section>
    </main>
  );
}

// ------------------------------------------------------------------ pieces

function pctText(a: Availability<number>) {
  return a.ok ? `${a.value.toFixed(1)} %` : "unavailable";
}

function MetricRow({ label, col, base, act, delta }: { label: string; col: string | null; base: Availability<number>; act: Availability<number> | null; delta: number | null }) {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td className="num" data-label="Baseline" title={base.ok ? undefined : base.reason}>{pctText(base)}</td>
      {act && <td className="num" data-label={col ?? ""} title={act.ok ? undefined : act.reason}>{pctText(act)}</td>}
      {act && <td className="num" data-label="Change">{delta === null ? "unavailable" : fmtSigned(delta, "pp")}</td>}
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
      <summary>
        ⚠ {label}: longest darkness touches {where}; its full length may be longer than shown.
      </summary>
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

const WINDOW_LABEL: Record<string, string> = { "+0d": "baseline", "+1d": "+1 d", "+3d": "+3 d", "+7d": "+7 d" };
const pp = (v: number | null) => (v === null ? "n/a" : fmtSigned(v, "pp", 2));

function SiteShiftNote({ t }: { t: TerrainHorizonBlock }) {
  const sc = t.checks.site_shift_scenarios;
  if (!sc || !sc.rows.length) return null;
  const rows = sc.rows;
  const maxSky = Math.max(...rows.map((r) => r.skyline_max_abs_change_deg));
  const worst = rows.reduce((a, r) => (Math.min(...r.earth_pct_change_pp) < Math.min(...a.earth_pct_change_pp) ? r : a));
  const earthWorst = Math.min(...worst.earth_pct_change_pp);
  return (
    <div className="site-shift small" data-testid="site-shift">
      <p>
        <strong>Site-position sensitivity (test scenarios, not an uncertainty range):</strong> moving the observer 100 m
        due north, east, south or west of the published point changed the skyline by up to {maxSky.toFixed(1)}° (in one
        direction; typically under 0.1°) and the demo-window Earth-visible share by up to {pp(earthWorst)} relative to the
        nominal point ({worst.direction} scenario).
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
                  <td className="num">
                    {r.skyline_max_abs_change_deg.toFixed(2)}° at az {r.skyline_max_change_at_azimuth_deg.toFixed(1)}°
                  </td>
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
          Windows: 14 days from 2026-12-05 00:00 UTC with the four demo delays, not the window selected above. Four directions
          only; other directions and distances were not tested. The surface heights at the moved points are in the scenario
          descriptions of <code>data/terrain/im2-athena_terrain_horizon.json</code>.
        </p>
      </details>
    </div>
  );
}

function HorizonFacts({ site, mode }: { site: SiteData; mode: HorizonMode }) {
  const t = site.terrain_horizon;
  const obsH = site.site.observer_height_above_surface_m;
  if (mode === "smooth" || !t) {
    return (
      <details className="facts-box small">
        <summary>About this horizon: smooth 0° model</summary>
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
  const el = h.elevation_deg.filter((v): v is number => v !== null);
  const sp = t.setting_points;
  const zero = sp.shot_count.filter((c) => c === 0).length;
  const known = sp.shot_count.filter((c) => c !== null).length;
  const pix = Object.entries(rs.dem_pixel_m).map(([k, v]) => `${k} ${v} m`).join(", then ");
  const nf = t.checks.near_field;
  const obsEye = t.observer ? t.observer.eye_above_dem_surface_m.toFixed(2) : String(obsH);
  return (
    <details className="facts-box small" open>
      <summary>About this horizon: terrain model, source and limits</summary>
      <dl className="facts">
        <dt>Source</dt>
        <dd>LOLA gridded terrain, PDS LRO-L-LOLA-4-GDR-V1.0 V2.0 (LDEM_80S_20M, LDEM_75S_60M beyond its edge)</dd>
        <dt>Observer</dt>
        <dd>
          {obsH} m (nominal) above the LOLA surface at {fmtLat(site.site.latitude_deg)}, {fmtLonEast(site.site.longitude_deg_east)}. The
          Horizons altitude was formed from the surface rounded to 0.1 m, so the eye is {obsEye} m above the interpolated surface; Sun,
          Earth and skyline all use that same point. Effect of the extra {t.observer ? (t.observer.eye_above_dem_surface_m - obsH).toFixed(4) : "0.02"} m: at most 0.0034° on the skyline and one 10-minute step at the 2026-12-30 sunset.
        </dd>
        <dt>Terrain pixels</dt>
        <dd className="num">{pix} (the terrain detail the model can represent)</dd>
        <dt>Ray sampling</dt>
        <dd className="num">
          {rs.azimuth_step_deg}° in azimuth; along each ray the terrain surface is interpolated every {rs.radial_step_m[0]} m to {rs.radial_step_change_km} km, then every {rs.radial_step_m[1]} m. Finer sampling than the pixel spacing does not add detail.
        </dd>
        <dt>Near the observer</dt>
        <dd className="num">
          The observer stands on the same interpolated surface that is sampled (eye {obsEye} m above it); sampling starts at {rs.first_sample_m} m.
          {nf ? ` The nearest skyline point is ${nf.min_setting_distance_m} m away, and ignoring all terrain within 20–300 m changes the skyline by ${nf.max_change_ignoring_terrain_within_20_to_300m_deg.toFixed(3)}°.` : ""}{" "}
          This concerns the modeled surface only; rocks or relief smaller than a pixel next to the lander could still block low directions.
        </dd>
        <dt>Search</dt>
        <dd className="num">
          {se.stop_distance_km_min_median_max[0].toFixed(0)}–{se.stop_distance_km_min_median_max[2].toFixed(0)} km per ray (stops when even {se.h_max_m.toFixed(0)} m terrain could not appear higher); unknown directions: {se.unknown_azimuths}
        </dd>
        <dt>Skyline</dt>
        <dd className="num">
          {fmtDeg(Math.min(...el), 2)} to {fmtDeg(Math.max(...el), 2)}; negative values are real (the ground falls away and the Moon curves)
        </dd>
        <dt>Data density</dt>
        <dd className="num">
          {zero} of {known} skyline points lie in pixels without a LOLA shot (interpolated). Shot counts are quality indicators, not accuracy guarantees.
        </dd>
        <dt>Checks</dt>
        <dd>
          Synthetic geometry tests; numerical sensitivity runs; an independently implemented pixel-by-pixel check on the same terrain
          model; consistency checks against the LOLA laser shots the model was built from (not independent validation); and an
          azimuth-convention sanity check against the mean Earth direction, which can only catch gross (tens of degrees) errors.
        </dd>
        <dt>Limits</dt>
        <dd>Regional DEM-based visibility for the published coordinate, not Athena’s actual operating conditions. Features narrower than about one to two pixels, rocks and the lander are not resolved. See the site-position scenarios above.</dd>
      </dl>
    </details>
  );
}

function stateText(s: Tri) {
  return s === null ? "Unknown" : s ? "Visible" : "Not visible";
}

function changeText(body: string, c: NextChange, mode: HorizonMode) {
  if (!c.found) return `Next change: not found in available data (searched through ${fmtUtc(c.searchedUntil)})`;
  const hz = mode === "terrain" ? "terrain horizon" : "smooth horizon";
  const verb = c.to === null ? "becomes unknown" : c.to ? `rises above the ${hz}` : `drops below the ${hz}`;
  return `${body} ${verb} ≈ ${fmtUtc(c.at)} (estimate at 10-minute resolution)`;
}

function Readouts({
  ds,
  intervals,
  index,
  mode,
  horizonAtBody,
}: {
  ds: Dataset;
  intervals: Interval[];
  index: number;
  mode: HorizonMode;
  horizonAtBody: Record<"sun" | "earth", (number | null)[]> | null;
}) {
  const s = ds.site.samples[index];
  const t = ds.times[index];
  const iv = intervalAt(intervals, t);
  const sun = iv ? iv.sun : null;
  const earth = iv ? iv.earth : null;
  const tiles: { key: "sun" | "earth"; label: string; state: Tri }[] = [
    { key: "sun", label: "Sun", state: sun },
    { key: "earth", label: "Earth", state: earth },
  ];
  return (
    <div className="readouts-wrap">
      <p className="selected-time num" aria-live="polite">{fmtUtc(t)}</p>
      <div className="readouts">
        {tiles.map(({ key, label, state }) => {
          const el = elevation(s, key);
          const az = azimuth(s, key);
          return (
            <div className="readout" key={key} data-body={key}>
              <p className="readout-title">
                <span className={`swatch swatch-${key}`} aria-hidden="true" />
                {label}
                <span className={`state state-${state === null ? "unknown" : state ? "on" : "off"}`} data-field="state">{stateText(state)}</span>
              </p>
              <dl>
                <dt>Elevation</dt>
                <dd className="num" data-field="elevation">{fmtDeg(el)}</dd>
                <dt>Azimuth</dt>
                <dd className="num" data-field="azimuth">{fmtDeg(az)} <span className="muted">{compass(az)}</span></dd>
                <dt>{mode === "terrain" ? "Skyline there" : "Horizon"}</dt>
                <dd className="num" data-field="horizon">{mode === "terrain" ? fmtDeg(horizonAtBody ? horizonAtBody[key][index] : null) : fmtDeg(0, 3)}</dd>
              </dl>
              <p className="readout-note" data-field="next">{changeText(label, nextChange(intervals, t, key), mode)}</p>
            </div>
          );
        })}
        <div className="readout" data-body="both">
          <p className="readout-title">
            <span className="chip chip-both" aria-hidden="true" />
            Both
            <span className={`state state-${bothState(sun, earth) === null ? "unknown" : bothState(sun, earth) ? "on" : "off"}`} data-field="state">{stateText(bothState(sun, earth))}</span>
          </p>
          <p className="readout-note">State of the 10-minute interval starting at this time ({mode === "terrain" ? "terrain" : "smooth"} horizon).</p>
        </div>
      </div>
    </div>
  );
}

function IntervalTables({ groups, intervals }: { groups: TimelineGroup[]; intervals: Interval[] }) {
  return (
    <details className="table-view">
      <summary>Visibility intervals table</summary>
      {groups.map((g) => {
        const parts = clip(intervals, g.window);
        return (
          <div key={g.key} className="table-scroll">
            <table>
              <caption>{g.label}: {fmtUtc(g.window.start)} → {fmtUtc(g.window.end)} (boundaries are estimates at 10-minute resolution)</caption>
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
                {parts.map((iv) => (
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
        );
      })}
    </details>
  );
}
