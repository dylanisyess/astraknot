// Terrain hazard screening UI (milestone 5C):
// - ScreeningRow: the automatic summary in the Conditions panel (no overlay needed);
// - TerrainDetails: the one expandable detail area (overlay choice, threshold, stats,
//   legend, inspection, method);
// - TerrainToggle: the primary "Highlight steep terrain" toggle on the stage;
// - TerrainComparison: the matched two-site table in Analysis.
// Every number comes from the screening asset (pipeline/slope.py) through slope.ts.
// Nothing here touches the observer, the Sun/Earth status or mission metrics.

import { useEffect, useRef, useState } from "react";
import type { CameraMode } from "./TerrainScene";
import {
  EXCEED_COLOR,
  type Inspection,
  LEGEND_MAX_DEG,
  OVERLAY_ALPHA,
  SCOPE_NOTE,
  SCREENING_NAME,
  SCREENING_PURPOSE,
  SLOPE_STOPS,
  type ScreeningView,
  type SlopeAsset,
  type SlopeState,
  THRESHOLD_MAX,
  THRESHOLD_MIN,
  THRESHOLD_NOTE,
  type TerrainLayer,
  fmtDistance,
  fmtPct,
  fmtPixelM,
  fmtThreshold,
  reproduceCommand,
  slopeSummary,
} from "./slope";

const deg = (x: number | null) => (x === null ? "unavailable" : `${x.toFixed(1)}°`);
const gradient = `linear-gradient(90deg, ${SLOPE_STOPS.map((s) => `${s.color} ${((s.deg / LEGEND_MAX_DEG) * 100).toFixed(1)}%`).join(", ")})`;

const TerrainIcon = (
  <svg viewBox="0 0 20 20" aria-hidden="true" className="ic ic-lg"><path d="M2 16 7.5 7l3.2 5 2.3-3L18 16z" /><path d="M7.5 7 9 9.4" /></svg>
);

/** One-line key for the overlay currently drawn (full legend in Terrain details). */
function RowKey({ layer, thresholdDeg }: { layer: TerrainLayer; thresholdDeg: number }) {
  if (layer === "surface") return <p className="muted small ts-key" data-testid="row-key">Overlay hidden · screening stays on</p>;
  if (layer === "exceed")
    return (
      <p className="small ts-key" data-testid="row-key">
        <i className="sl-sw" style={{ background: EXCEED_COLOR }} aria-hidden="true" /> Slope &gt;{fmtThreshold(thresholdDeg)} highlighted · ring = 500 m assessed area; outside not assessed
      </p>
    );
  return (
    <div className="small ts-key" data-testid="row-key">
      <span className="ts-mini-bar" style={{ background: gradient }} aria-hidden="true" />
      <span className="num">0°</span><span className="muted">to</span><span className="num">30°+</span>
      <span className="muted">· same color scale at every site</span>
    </div>
  );
}

/**
 * The automatic terrain-screening summary in the Conditions panel: the one place for terrain
 * screening. "Full slope map" switches the overlay and frames the 500 m assessed area;
 * everything else (overlay choice, threshold, legend, statistics) is in Terrain details.
 */
export function ScreeningRow({ view, siteShort, layer, thresholdDeg, detailsOpen, onDetails, onSlopeMap, onSteep, onRetry }: {
  view: ScreeningView;
  siteShort: string;
  layer: TerrainLayer;
  thresholdDeg: number;
  detailsOpen: boolean;
  onDetails: () => void;
  /** Full slope map + Site overview framed on the 500 m area (time and mission unchanged). */
  onSlopeMap: () => void;
  /** Back to the steep-area highlight (no camera change). */
  onSteep: () => void;
  onRetry: () => void;
}) {
  const ready = view.kind !== "loading" && view.kind !== "error";
  return (
    <div className="status-group group-terrain" data-testid="screening-row" data-kind={view.kind} data-site-short={siteShort} data-layer={layer}>
      <p className="group-title">{TerrainIcon}<span>Terrain screening</span></p>
      {view.kind === "loading" && <p className="muted small" role="status" data-field="screening">Loading terrain screening…</p>}
      {view.kind === "error" && (
        <p className="note-err small" role="alert" data-field="screening">
          Terrain screening unavailable ({view.message}).{" "}
          <button type="button" className="tool-btn compact-text" onClick={onRetry} data-testid="screening-retry">Retry</button>
        </p>
      )}
      {ready && (
        <>
          <div className="group-main">
            <span className={view.kind === "exceed" ? "avail avail-caution" : "avail avail-neutral"} data-field="screening">{view.headline}</span>
          </div>
          {view.text && <p className="small ts-line" data-field="screening-text">{view.text}</p>}
          {view.observer && <p className={view.observerAbove ? "small ts-line ts-obs-above" : "small ts-line muted"} data-field="screening-observer">{view.observer}</p>}
          {view.coverage && <p className="note small" role="alert" data-testid="coverage-note">⚠ {view.coverage}</p>}
          <p className="muted small ts-qual">{view.qualification}</p>
          <RowKey layer={layer} thresholdDeg={thresholdDeg} />
          <div className="ts-actions">
            {layer === "slope" ? (
              <button type="button" className="tool-btn compact-text" onClick={onSteep} data-testid="steep-btn">
                <i className="tt-sw" aria-hidden="true" /> Steep areas only
              </button>
            ) : (
              <button type="button" className="tool-btn compact-text" onClick={onSlopeMap} data-testid="slope-map-btn" title="Show the full slope map in Site overview, framed on the 500 m assessed area (time and mission unchanged)">
                <i className="tt-sw tt-ramp" aria-hidden="true" /> Full slope map
              </button>
            )}
            <button type="button" className="tool-btn compact-text ghost" aria-expanded={detailsOpen} aria-controls="terrain-details" onClick={onDetails} data-testid="terrain-details-toggle">
              {detailsOpen ? "Hide terrain details" : "Terrain details"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** Legend for the active overlay: fixed 0–30° scale, threshold mark, boundary, no-data and unassessed keys. */
export function SlopeLegend({ layer, thresholdDeg, cellM }: { layer: TerrainLayer; thresholdDeg: number; /** DEM cell size (m) of the shown asset */ cellM?: number }) {
  const t = Math.min(100, (thresholdDeg / LEGEND_MAX_DEG) * 100);
  return (
    <div className="slope-legend small" data-testid="slope-legend" data-layer={layer}>
      {layer === "exceed" ? (
        <div className="sl-keys">
          <span><i className="sl-sw" style={{ background: EXCEED_COLOR }} />Slope &gt;{fmtThreshold(thresholdDeg)}</span>
          <span className="muted">Unhighlighted: not above it (not a safety rating)</span>
        </div>
      ) : (
        <>
          <div className="sl-bar" style={{ background: gradient }} aria-hidden="true">
            {thresholdDeg <= LEGEND_MAX_DEG && <span className="sl-thr" style={{ left: `${t}%` }} title={`Threshold ${fmtThreshold(thresholdDeg)}`} />}
          </div>
          <div className="sl-ticks num" aria-hidden="true">
            {[0, 10, 20, 30].map((d) => <span key={d} style={{ left: `${(d / LEGEND_MAX_DEG) * 100}%` }}>{d === LEGEND_MAX_DEG ? `${d}°+` : `${d}°`}</span>)}
          </div>
          <p className="sr-only">Slope color scale from 0° (light) to {LEGEND_MAX_DEG}° and above (dark violet); the same color scale at every site.</p>
        </>
      )}
      <div className="sl-keys">
        <span><i className="sl-ring" />500 m assessed area</span>
        <span><i className="sl-sw sl-out" />Outside: not assessed</span>
      </div>
      <p className="muted sl-note">One flat color per {cellM ? `${Math.round(cellM)} m ` : ""}DEM cell, unlit, {Math.round(OVERLAY_ALPHA * 100)} % opacity; the same color scale at every site (the DEM scale can differ between sites).</p>
    </div>
  );
}

export function ThresholdInput({ value, onChange, id }: { value: number; onChange: (v: number) => void; id: string }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <span className="with-unit thr-input">
      <input
        id={id}
        type="number"
        min={THRESHOLD_MIN}
        max={THRESHOLD_MAX}
        step={0.5}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value.trim() !== "" && Number.isFinite(n)) onChange(n);
        }}
        onBlur={() => setText(String(value))}
        aria-describedby={`${id}-note`}
        data-testid="threshold"
      />
      <span className="unit" aria-hidden="true">°</span>
    </span>
  );
}

function inspectionText(x: Inspection, thr: number, baseline: number, cell: number) {
  const dist = `${fmtDistance(x.distanceM)} from the modeled observer`;
  if (x.kind === "outside") return { tone: "nodata", main: "No slope data at this point", sub: `${dist}, outside the analysis area (not assessed).` };
  if (x.kind === "invalid") return { tone: "nodata", main: "No slope data at this point", sub: `${dist}; the DEM cell has no valid slope.` };
  return {
    tone: x.above ? "exceed" : "below",
    main: `Slope ${x.slopeDeg.toFixed(1)}° · ${x.above ? "above" : "not above"} the ${fmtThreshold(thr)} threshold`,
    sub: `${dist} · valid DEM cell · ${Math.round(cell)} m cell, measured across ${Math.round(baseline)} m`,
  };
}

/** Secondary terrain information (a bounded drawer in the Conditions panel; inspections appear here too). */
export function TerrainDetails({ state, siteShort, provisional, layer, setLayer, camera, thresholdDeg, setThreshold, inspection, hasInspection, onClearInspection, onClose }: {
  state: SlopeState;
  siteShort: string;
  provisional: string | null;
  layer: TerrainLayer;
  /** Overlay choice: changes what is drawn, never the camera. */
  setLayer: (l: TerrainLayer) => void;
  camera: CameraMode;
  thresholdDeg: number;
  setThreshold: (v: number) => void;
  inspection: Inspection | null;
  hasInspection: boolean;
  onClearInspection: () => void;
  onClose: () => void;
}) {
  const a: SlopeAsset | null = state.state === "ready" ? state.asset : null;
  const s = a ? slopeSummary(a, thresholdDeg) : null;
  const ins = inspection && a ? inspectionText(inspection, thresholdDeg, a.method.baseline_m, a.method.cell_ground_m) : null;
  const ref = useRef<HTMLDivElement>(null);
  // only an inspection result is brought into view; opening Details never scrolls Sun/Earth away
  useEffect(() => {
    if (hasInspection) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [hasInspection]);
  return (
    <div ref={ref} className="terrain-details" id="terrain-details" data-testid="terrain-details" aria-label={`${SCREENING_NAME} details · ${siteShort}`} role="region">
      <div className="td-head">
        <p className="td-title small">Terrain details · {siteShort}</p>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close terrain details" data-testid="td-close">✕</button>
      </div>
      <div className="ctl">
        <span className="ctl-label" id="lbl-overlay">Terrain overlay</span>
        <div className="td-overlay">
          <div className="seg seg-small" role="radiogroup" aria-labelledby="lbl-overlay">
            <button type="button" role="radio" aria-checked={layer === "exceed"} className={layer === "exceed" ? "seg-b on" : "seg-b"} onClick={() => setLayer("exceed")} data-overlay-btn="exceed">
              Steep areas &gt;{fmtThreshold(thresholdDeg)}
            </button>
            <button type="button" role="radio" aria-checked={layer === "slope"} className={layer === "slope" ? "seg-b on" : "seg-b"} onClick={() => setLayer("slope")} data-overlay-btn="slope">
              Full slope map
            </button>
          </div>
          <button type="button" role="radio" aria-checked={layer === "surface"} className={layer === "surface" ? "oc-hide on" : "oc-hide"} onClick={() => setLayer("surface")} data-overlay-btn="surface" title="Hide the overlay (screening and warnings stay on)">
            {layer === "surface" ? "Hidden" : "Hide"}
          </button>
        </div>
        {camera === "eye" && <p className="muted small">Overlays are drawn in the Site overview; the horizon view is unchanged.</p>}
      </div>
      <div className="ts-thr">
        <label className="ctl-label" htmlFor="slope-thr">Illustrative screening threshold</label>
        <ThresholdInput id="slope-thr" value={thresholdDeg} onChange={setThreshold} />
        <p className="muted small ts-thr-note" id="slope-thr-note">{THRESHOLD_NOTE} Changes classifications only, never the measured slopes.</p>
      </div>
      {layer !== "surface" && <SlopeLegend layer={layer} thresholdDeg={thresholdDeg} cellM={state.state === "ready" ? (state.asset as SlopeAsset).method.cell_ground_m : undefined} />}
      {hasInspection && (
        <div className="ts-insp" data-testid="inspection" data-kind={inspection?.kind ?? "pending"}>
          <p className="ts-insp-h small"><span className="insp-mark" aria-hidden="true" /> Terrain inspection point</p>
          {ins ? (
            <>
              <p className={`small ts-insp-main ts-${ins.tone}`}>{ins.main}</p>
              <p className="muted small">{ins.sub}</p>
            </>
          ) : (
            <p className="muted small">Waiting for slope data…</p>
          )}
          <p className="muted small">Reads terrain only: the modeled observer, Sun/Earth status and mission metrics are unchanged and do not apply to this point.</p>
          <button type="button" className="tool-btn compact-text" onClick={onClearInspection} data-testid="clear-inspection">Clear inspection</button>
        </div>
      )}
      {s && (
        <dl className="ts-stats small">
          <div><dt>Median</dt><dd className="num" data-field="median">{deg(s.medianDeg)}</dd></div>
          <div><dt>95th pct</dt><dd className="num" data-field="p95">{deg(s.p95Deg)}</dd></div>
          <div><dt>Above {fmtThreshold(thresholdDeg)}</dt><dd className="num" data-field="above">{s.cellsAbove === 0 ? "none" : fmtPct(s.aboveFraction)}</dd></div>
          <div><dt>Max</dt><dd className="num">{deg(s.maxDeg)}</dd></div>
          <div><dt>Coverage</dt><dd className="num" data-field="coverage">{fmtPct(s.validFraction)} valid</dd></div>
          <div><dt>Cells</dt><dd className="num">{s.cellsValid.toLocaleString("en-US")}</dd></div>
          <div className="wide"><dt>Measurement</dt><dd className="num">{Math.round(s.cellM)} m cells, ~{Math.round(s.baselineM)} m baseline, {s.radiusM} m radius</dd></div>
        </dl>
      )}
      {!hasInspection && layer !== "surface" && camera === "overview" && <p className="muted small">Click terrain inside the 500 m ring to inspect a point.</p>}
      <details className="ts-method small">
        <summary>Source, method and limits</summary>
        {a && (
          <p>
            {a.source_dem.product} DEM, {fmtPixelM(a.source_dem.map_scale_m)} m pixels. Slope of each cell from a Horn 3 × 3 gradient across about{" "}
            {Math.round(a.method.baseline_m)} m on true ground distances, relative to the local lunar horizontal, within {a.footprint.radius_m} m of the
            modeled observer. Same method, radius and threshold at every site; one fixed 0–{LEGEND_MAX_DEG}° color scale. Sites whose DEMs have
            different pixel sizes measure slope over different baselines, so their values are not directly equivalent.
          </p>
        )}
        <p>{SCOPE_NOTE} A {a ? `${fmtPixelM(a.source_dem.map_scale_m)} m ` : ""}DEM grid is not a landing-safety guarantee at that scale, and terrain that is not highlighted is not rated safe.</p>
        <p>The source surface includes interpolation between measurements{a?.shot_quality.fraction_cells_with_lola_shot != null ? ` (${Math.round(a.shot_quality.fraction_cells_with_lola_shot * 100)} % of analysed cells contain a LOLA shot)` : "; local laser-shot counts have not been assessed"}.</p>
        {provisional && <p className="note">CR1: {provisional}.</p>}
        {a && <p>Reproduce: <code>{reproduceCommand(a.reproduce, a.site.id, `python pipeline/slope.py --site ${a.site.id}`)}</code></p>}
      </details>
    </div>
  );
}

// ------------------------------------------------------------------ Analysis: matched two-site comparison

export interface ComparisonSite {
  id: string;
  short: string;
  provisional: string | null;
  state: SlopeState;
  /** Existing availability results for the same sites (from computeMetrics). */
  sun: string;
  earth: string;
  /** The site has no slope screening (catalog reason); nothing is loaded or shown for it. */
  unavailable?: string | null;
}

/** Source DEM and measurement scale of a ready screening asset. */
const scaleKey = (a: SlopeAsset) => `${a.source_dem.product}|${a.source_dem.map_scale_m}|${a.method.baseline_m}`;

export function TerrainComparison({ sites, thresholdDeg, setThreshold, missionLabel, onRetry }: {
  sites: ComparisonSite[];
  thresholdDeg: number;
  setThreshold: (v: number) => void;
  missionLabel: string;
  onRetry: () => void;
}) {
  const assets = sites.map((x) => (!x.unavailable && x.state.state === "ready" ? (x.state.asset as SlopeAsset) : null));
  const sum = assets.map((a) => (a ? slopeSummary(a, thresholdDeg) : null));
  const cell = (k: number, f: (s: NonNullable<(typeof sum)[number]>) => string) => {
    const s = sum[k];
    const st = sites[k].state;
    if (sites[k].unavailable) return "no slope screening";
    if (s) return f(s);
    return st.state === "error" ? "not loaded" : "loading…";
  };
  const anyError = sites.some((x) => !x.unavailable && x.state.state === "error");
  const radius = sum.find((s) => s)?.radiusM;
  // Different source DEMs measure slope over different baselines: never presented as equivalent.
  const scales = [...new Set(assets.filter((a): a is SlopeAsset => a !== null).map(scaleKey))];
  const mixedScale = scales.length > 1;
  return (
    <section className="card terrain-compare" aria-labelledby="tc-h" data-testid="terrain-compare">
      <h2 id="tc-h">{SCREENING_NAME}: matched {radius ?? 500} m footprint</h2>
      <p className="muted small">
        {SCREENING_PURPOSE} {mixedScale ? "Same slope method, radius and threshold at every site, but not the same source DEM." : `Same DEM, slope method, radius and threshold at ${sites.length > 2 ? "every" : "both"} site${sites.length > 1 ? "s" : ""}.`}{" "}
        No single combined score ranks the sites: terrain steepness and Sun/Earth availability are shown side by side as tradeoffs.
      </p>
      {mixedScale && (
        <p className="note small" role="note" data-testid="mixed-scale">
          ⚠ Different measurement scales: these sites’ slopes come from DEMs with different pixel sizes (see “Source DEM” and “Slope method”). A coarser DEM
          measures slope over a longer baseline and smooths short steep slopes, so its median, 95th percentile and area above the threshold are not directly
          equivalent to a finer DEM’s. Compare each site against its own scale, not the numbers against each other.
        </p>
      )}
      <div className="tc-thr">
        <label htmlFor="slope-thr-a">Screening threshold</label>
        <ThresholdInput id="slope-thr-a" value={thresholdDeg} onChange={setThreshold} />
        <span className="muted small" id="slope-thr-a-note">{THRESHOLD_NOTE}</span>
      </div>
      {anyError && (
        <p className="note-err small" role="alert">
          Terrain screening data could not be loaded for {sites.filter((x) => x.state.state === "error").map((x) => x.short).join(", ")}. The rest of Analysis is unaffected.{" "}
          <button type="button" onClick={onRetry}>Retry</button>
        </p>
      )}
      <div className="table-scroll">
        <table className="tc-table">
          <thead>
            <tr><th scope="col">Measure</th>{sites.map((x) => <th scope="col" key={x.id}>{x.short}{x.provisional ? " ⚠" : ""}</th>)}</tr>
          </thead>
          <tbody>
            <tr data-row="dem"><th scope="row">Source DEM</th>{sites.map((x, k) => <td key={x.id}>{cell(k, () => `${assets[k]!.source_dem.product}, ${fmtPixelM(assets[k]!.source_dem.map_scale_m)} m pixels`)}</td>)}</tr>
            <tr><th scope="row">Analysis radius</th>{sites.map((x, k) => <td key={x.id} className="num">{cell(k, (s) => `${s.radiusM} m`)}</td>)}</tr>
            <tr><th scope="row">Slope method</th>{sites.map((x, k) => <td key={x.id}>{cell(k, (s) => `Horn 3×3, ${Math.round(s.cellM)} m cells, ~${Math.round(s.baselineM)} m baseline`)}</td>)}</tr>
            <tr data-row="median"><th scope="row">Median slope</th>{sites.map((x, k) => <td key={x.id} className="num">{cell(k, (s) => deg(s.medianDeg))}</td>)}</tr>
            <tr data-row="p95"><th scope="row">95th-percentile slope</th>{sites.map((x, k) => <td key={x.id} className="num">{cell(k, (s) => deg(s.p95Deg))}</td>)}</tr>
            <tr data-row="above"><th scope="row">Area above {fmtThreshold(thresholdDeg)}</th>{sites.map((x, k) => <td key={x.id} className="num">{cell(k, (s) => (s.cellsAbove === 0 ? "none detected" : fmtPct(s.aboveFraction)))}</td>)}</tr>
            <tr data-row="coverage"><th scope="row">Valid coverage</th>{sites.map((x, k) => <td key={x.id} className="num">{cell(k, (s) => `${fmtPct(s.validFraction)} (${s.cellsValid.toLocaleString("en-US")} cells)`)}</td>)}</tr>
            <tr data-row="sun"><th scope="row">Sun center visible · {missionLabel}</th>{sites.map((x) => <td key={x.id} className="num">{x.sun}</td>)}</tr>
            <tr data-row="earth"><th scope="row">Earth center visible · {missionLabel}</th>{sites.map((x) => <td key={x.id} className="num">{x.earth}</td>)}</tr>
            <tr data-row="status"><th scope="row">Terrain status</th>{sites.map((x) => <td key={x.id}>{x.provisional ? <span className="provisional">⚠ Provisional site terrain: sensitive to position and DEM resolution</span> : "—"}</td>)}</tr>
          </tbody>
        </table>
      </div>
      <p className="muted small">{SCOPE_NOTE} A DEM grid is not a landing-safety guarantee at its pixel size. Sun and Earth rows repeat the cards above for the same mission.</p>
    </section>
  );
}
