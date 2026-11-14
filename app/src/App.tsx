import { useCallback, useEffect, useState } from "react";
import { ElevationChart } from "./ElevationChart";
import {
  type Body,
  azimuth,
  compass,
  elevation,
  fmtDeg,
  fmtLat,
  fmtLonEast,
  fmtUtc,
  loadDataset,
  nearestIndex,
  parseUtc,
} from "./data";
import type { Dataset } from "./types";

const BODIES: { key: Body; label: string }[] = [
  { key: "sun", label: "Sun" },
  { key: "earth", label: "Earth" },
];

function initialIndex(ds: Dataset): number {
  const t = new URLSearchParams(window.location.search).get("t");
  if (t) {
    try {
      return nearestIndex(ds.times, parseUtc(t));
    } catch {
      /* ignore malformed ?t= */
    }
  }
  return Math.floor(ds.times.length / 2);
}

export function App() {
  const [ds, setDs] = useState<Dataset | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    loadDataset(import.meta.env.BASE_URL)
      .then((d) => {
        setDs(d);
        setIdx(initialIndex(d));
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const select = useCallback(
    (i: number) => {
      if (!ds) return;
      const clamped = Math.max(0, Math.min(ds.times.length - 1, i));
      setIdx(clamped);
      const url = new URL(window.location.href);
      url.searchParams.set("t", ds.site.samples[clamped].time_utc);
      window.history.replaceState(null, "", url);
    },
    [ds],
  );

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

  const { manifest, site, times } = ds;
  const meta = site.site;
  const s = site.samples[idx];
  const synthetic = manifest.is_synthetic || meta.is_synthetic;
  const QUERY_IDS = ["horizons-sun", "horizons-earth"];
  const querySources = site.sources.filter((x) => QUERY_IDS.includes(x.id));
  const docSources = site.sources.filter((x) => !QUERY_IDS.includes(x.id) && x.id !== "site-coordinates");

  return (
    <main className="page">
      <header className="masthead">
        <div>
          <p className="eyebrow">Lunar Visibility Navigator · Milestone 1</p>
          <h1>Sun and Earth from the lunar south polar region</h1>
        </div>
        <div className="badges">
          {synthetic ? (
            <span className="badge badge-warn">⚠ Synthetic data</span>
          ) : (
            <span className="badge">Real data · JPL Horizons</span>
          )}
          <span className="badge badge-warn" title={site.horizon.processing_notes}>
            ⚠ Terrain not yet modeled
          </span>
          <span className="badge">All times UTC</span>
        </div>
      </header>

      <section className="card site-card" aria-labelledby="site-h">
        <p className="label">Site</p>
        <h2 id="site-h">{meta.name}</h2>
        <p className="coords num">
          {fmtLat(meta.latitude_deg)}, {fmtLonEast(meta.longitude_deg_east)}
        </p>
        <p className="muted small">
          {meta.coordinate_frame}. Coordinates:{" "}
          <a href={meta.coordinate_source_url} target="_blank" rel="noreferrer">
            LROC
          </a>
          . Observer placed {meta.horizons_site_altitude_km} km above the 1737.4 km reference sphere
          {meta.surface_elevation_m === null ? " (local surface elevation not yet extracted)" : ""}.
        </p>
      </section>

      <section className="card time-card" aria-labelledby="time-h">
        <p className="label" id="time-h">Selected time</p>
        <p className="selected-time num" aria-live="polite">{fmtUtc(times[idx])}</p>
        <div className="readouts">
          {BODIES.map(({ key, label }) => {
            const el = elevation(s, key);
            const az = azimuth(s, key);
            return (
              <div className="readout" key={key} data-body={key}>
                <p className="readout-title">
                  <span className={`swatch swatch-${key}`} aria-hidden="true" />
                  {label}
                </p>
                <dl>
                  <dt>Elevation</dt>
                  <dd className="num" data-field="elevation">{fmtDeg(el)}</dd>
                  <dt>Azimuth</dt>
                  <dd className="num" data-field="azimuth">
                    {fmtDeg(az)} <span className="muted">{compass(az)}</span>
                  </dd>
                </dl>
                <p className="readout-note">
                  Center {el === null ? "unknown" : el > 0 ? "above" : "below"} the 0° smooth horizon
                </p>
              </div>
            );
          })}
        </div>
      </section>

      <section className="card chart-card" aria-labelledby="chart-h">
        <div className="chart-head">
          <h2 id="chart-h">Elevation versus time</h2>
          <ul className="legend" aria-label="Legend">
            <li><span className="swatch swatch-sun" />Sun center</li>
            <li><span className="swatch swatch-earth" />Earth center</li>
            <li><span className="swatch swatch-horizon" />0° smooth horizon</li>
          </ul>
        </div>
        <ElevationChart samples={site.samples} times={times} selected={idx} onSelect={select} />
        <div className="slider-row">
          <button type="button" onClick={() => select(idx - 1)} disabled={idx === 0} aria-label="Back 10 minutes">
            ‹
          </button>
          <input
            type="range"
            min={0}
            max={times.length - 1}
            step={1}
            value={idx}
            onChange={(e) => select(Number(e.target.value))}
            aria-label="Selected time"
            aria-valuetext={fmtUtc(times[idx])}
          />
          <button
            type="button"
            onClick={() => select(idx + 1)}
            disabled={idx === times.length - 1}
            aria-label="Forward 10 minutes"
          >
            ›
          </button>
        </div>
        <p className="muted small">
          {fmtUtc(times[0])} to {fmtUtc(times[times.length - 1])}, {site.samples.length} samples every{" "}
          {manifest.sample_step_seconds / 60} minutes. Drag on the chart or use the slider; arrow keys step 10 minutes.
          Lines connect samples only for display; values shown are the samples themselves.
        </p>

        <details className="table-view">
          <summary>Data table ({site.samples.length} samples)</summary>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Time (UTC)</th>
                  <th scope="col">Sun elev.</th>
                  <th scope="col">Sun az.</th>
                  <th scope="col">Earth elev.</th>
                  <th scope="col">Earth az.</th>
                </tr>
              </thead>
              <tbody>
                {site.samples.map((r, i) => (
                  <tr key={r.time_utc} className={i === idx ? "row-selected" : undefined} onClick={() => select(i)}>
                    <td className="num">{r.time_utc.slice(0, 16).replace("T", " ")}</td>
                    <td className="num">{fmtDeg(r.sun_elevation_deg)}</td>
                    <td className="num">{fmtDeg(r.sun_azimuth_deg)}</td>
                    <td className="num">{fmtDeg(r.earth_elevation_deg)}</td>
                    <td className="num">{fmtDeg(r.earth_azimuth_deg)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </section>

      <section className="card sources-card" aria-labelledby="src-h">
        <h2 id="src-h">Sources and limitations</h2>
        <div className="two-col">
          <div>
            <h3>Sources</h3>
            <ul className="sources">
              <li>
                Site coordinates:{" "}
                <a href={meta.coordinate_source_url} target="_blank" rel="noreferrer">
                  LROC, “IM-2 Athena Seen Obliquely” (10 Mar 2025)
                </a>
              </li>
              {querySources.map((x) => (
                <li key={x.id}>
                  <a href={x.url} target="_blank" rel="noreferrer">
                    {x.id === "horizons-sun" ? "Sun" : "Earth"} positions: exact JPL Horizons query
                  </a>
                  <span className="muted small"> · retrieved {x.retrieved_at_utc} · {x.product_version_or_filename}</span>
                </li>
              ))}
              {docSources.map((x) => (
                <li key={x.id}>
                  <a href={x.url} target="_blank" rel="noreferrer">{x.title}</a>
                </li>
              ))}
            </ul>
            <p className="muted small">
              Dataset <code>{manifest.dataset_id}</code>, generated {manifest.generated_at_utc}.
            </p>
          </div>
          <div>
            <h3>Limitations</h3>
            <ul>
              <li>
                <strong>Terrain not yet modeled.</strong> The 0° line is the local horizontal plane, not the
                real horizon. Nearby crater walls and massifs can block low Sun and Earth directions.
              </li>
              <li>
                Positions are airless apparent directions of the Sun and Earth <em>centers</em>, with no
                refraction and no partial-disk model.
              </li>
              <li>Earth above the horizon is a geometric opportunity, not a guaranteed link.</li>
              <li>Sun above the horizon is not electrical power output.</li>
              <li>Educational planning prototype, not a flight-qualified analysis tool.</li>
            </ul>
          </div>
        </div>
      </section>
    </main>
  );
}
