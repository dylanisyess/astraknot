import { useEffect, useMemo, useState } from "react";
import { ElevationChart } from "./ElevationChart";
import { Timeline, type TimelineGroup } from "./Timeline";
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
import type { Dataset } from "./types";

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
  return { arrival: time("arrival"), days: num("days"), delay: num("delay"), t: time("t") };
}

const clampNum = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const HOURS = Array.from({ length: 24 }, (_, h) => h);

// ------------------------------------------------------------------ workspace

function Workspace({ ds }: { ds: Dataset }) {
  const { manifest, site, times } = ds;
  const intervals = useMemo(() => parseIntervals(site), [site]);
  const cov = { start: times[0], end: times[times.length - 1] };
  const maxDays = Math.floor((cov.end - cov.start) / DAY_MS);
  const init = useMemo(readUrlState, []);

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
    window.history.replaceState(null, "", url);
  }, [arrival, days, effDelay, cursor, site.samples]);

  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const scale = timeScale(domain.start, domain.end, width);
  const dark = (m: typeof baseM) => (m.longestDark.ok ? m.longestDark.value : null);
  const groups: TimelineGroup[] = [{ key: "baseline", label: "Baseline", window: baseW, longestDark: dark(baseM) }];
  if (effDelay) groups.push({ key: "delayed", label: `Delay +${effDelay} d`, window: actW, longestDark: dark(actM) });

  const meta = site.site;
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
          <p className="eyebrow">Lunar Visibility Navigator · Smooth-horizon mission windows</p>
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

      <div className="banner" role="note">
        <strong>⚠ Smooth horizon: terrain not yet included.</strong> “Visible” means the body’s center is above the
        local horizontal plane (0°). Real crater walls and massifs can hide the Sun or Earth when this view says
        visible. Earth visible is a geometric opportunity, not a guaranteed radio link. Sun visible is not
        electrical power output.
      </div>

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
          <dd className="num">{meta.observer_height_above_surface_m} m above the modeled surface</dd>
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
            Latest arrival
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
          Percentages are shares of elapsed window time. Darkness means the Sun’s center is below the 0° smooth
          horizon. Boundaries are estimates at the modeled 10-minute resolution ({site.visibility_method}).
        </p>
      </section>

      <section className="card viz-card" aria-labelledby="viz-h">
        <div className="chart-head">
          <h2 id="viz-h">Timeline</h2>
          <ul className="legend" aria-label="Legend">
            <li><span className="chip chip-sun" />Sun visible</li>
            <li><span className="chip chip-earth" />Earth visible</li>
            <li><span className="chip chip-both" />Both visible</li>
            <li><span className="chip chip-off" />Not visible</li>
            <li><span className="chip chip-unknown" />Unknown</li>
            <li><span className="chip chip-dark" />Longest darkness</li>
          </ul>
        </div>

        <Readouts ds={ds} intervals={intervals} index={cursor} />

        <div ref={wrapRef} className="plots">
          <Timeline scale={scale} intervals={intervals} groups={groups} cursor={cursorT} onSelect={(t) => setCursor(clampNum(nearestIndex(times, t), i0, i1))} />
          <div className="chart-head sub">
            <h3>Elevation of body centers</h3>
            <ul className="legend" aria-label="Elevation legend">
              <li><span className="swatch swatch-sun" />Sun</li>
              <li><span className="swatch swatch-earth" />Earth</li>
              <li><span className="swatch swatch-horizon" />0° smooth horizon</li>
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
          timeline and chart always show the same UTC time.
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
              <li>Each 10-minute interval is classified at its midpoint: visible when the center’s elevation is strictly above 0°. Event times are estimates at that resolution.</li>
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
              <li><strong>Terrain not yet included.</strong> The 0° line is the local horizontal plane, not the real horizon.</li>
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
  return (
    <p className="note small">
      ⚠ {label}: the longest darkness ({fmtUtc(d.start)} → {fmtUtc(d.end)})
      {d.touchesStart && (
        <>
          {" "}touches the window start, so it may have begun before arrival (in the data it began{" "}
          {d.fullStartAtCoverageEdge ? `at or before the start of available data, ${fmtUtc(d.fullStart)}` : `at ${fmtUtc(d.fullStart)}`})
        </>
      )}
      {d.touchesStart && d.touchesEnd && " and"}
      {d.touchesEnd && (
        <>
          {" "}touches the window end, so it may continue after departure (in the data it lasts until{" "}
          {d.fullEndAtCoverageEdge ? `at least the end of available data, ${fmtUtc(d.fullEnd)}` : fmtUtc(d.fullEnd)})
        </>
      )}
      . Its full length may exceed the value shown.
    </p>
  );
}

function stateText(s: Tri) {
  return s === null ? "Unknown" : s ? "Visible" : "Not visible";
}

function changeText(body: string, c: NextChange) {
  if (!c.found) return `Next change: not found in available data (searched through ${fmtUtc(c.searchedUntil)})`;
  const verb = c.to === null ? "becomes unknown" : c.to ? "rises above the smooth horizon" : "drops below the smooth horizon";
  return `${body} ${verb} ≈ ${fmtUtc(c.at)} (estimate at 10-minute resolution)`;
}

function Readouts({ ds, intervals, index }: { ds: Dataset; intervals: Interval[]; index: number }) {
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
              </dl>
              <p className="readout-note" data-field="next">{changeText(label, nextChange(intervals, t, key))}</p>
            </div>
          );
        })}
        <div className="readout" data-body="both">
          <p className="readout-title">
            <span className="chip chip-both" aria-hidden="true" />
            Both
            <span className={`state state-${bothState(sun, earth) === null ? "unknown" : bothState(sun, earth) ? "on" : "off"}`} data-field="state">{stateText(bothState(sun, earth))}</span>
          </p>
          <p className="readout-note">State of the 10-minute interval starting at this time (smooth horizon).</p>
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
