// Facts for a user-defined study point (catalog location type "user_defined_study_point"),
// derived from the site's own data file: entered coordinates, terrain sources, observer,
// sampling, processing record and the limitations that follow from the point being user-defined.

import { fmtLat, fmtLonEast, fmtUtc, parseUtc } from "./data";
import { USER_DEFINED_LIMITATIONS } from "./sites";
import type { SiteData } from "./types";

export interface UserDefinedFacts {
  entered: string;
  frame: string;
  terrain: string;
  observer: string;
  sampling: string;
  processing: string | null;
  limitations: string[];
}

export function userDefinedFacts(site: SiteData): UserDefinedFacts {
  const m = site.site;
  const t = site.terrain_horizon;
  const pix = t ? Object.entries(t.horizon.resolution.dem_pixel_m) : [];
  const s = site.samples;
  const stepMin = s.length > 1 ? Math.round((parseUtc(s[1].time_utc) - parseUtc(s[0].time_utc)) / 60_000) : null;
  const prep = t?.checks.preparation as { fingerprint?: string; algorithm?: string } | undefined;
  return {
    entered: `${fmtLat(m.latitude_deg)}, ${fmtLonEast(m.longitude_deg_east)}`,
    frame: m.coordinate_frame,
    terrain: pix.length
      ? `${pix.map(([name, px]) => `${name} (${px.toFixed(1)} m pixels)`).join("; ")}; ${t!.horizon.search_extent.unknown_azimuths} unknown skyline directions`
      : "No terrain horizon (smooth 0° comparison only)",
    observer: `${m.observer_height_above_surface_m} m nominal above the terrain-model surface${t?.observer ? ` (eye ${t.observer.eye_above_dem_surface_m.toFixed(3)} m above the interpolated surface)` : ""}; Horizons altitude ${m.horizons_site_altitude_km} km relative to the 1737.4 km sphere (negative = below it)`,
    sampling: s.length
      ? `${s.length.toLocaleString("en-US")} samples, ${fmtUtc(parseUtc(s[0].time_utc))} – ${fmtUtc(parseUtc(s[s.length - 1].time_utc))}${stepMin !== null ? `, every ${stepMin} minutes` : ""} (JPL Horizons)`
      : "No samples",
    processing: prep?.fingerprint ? `Offline Python pipeline (${prep.algorithm ?? "version not recorded"}), bundle ${prep.fingerprint.slice(0, 12)}…` : null,
    limitations: USER_DEFINED_LIMITATIONS,
  };
}

/** Collapsible facts list for a user-defined point (data-site scopes test selectors). */
export function UserDefinedPointFacts({ site, open = false }: { site: SiteData; open?: boolean }) {
  const f = userDefinedFacts(site);
  return (
    <details className="small user-defined-facts" open={open} data-testid="user-defined-facts" data-site={site.site.id}>
      <summary>User-defined study point: inputs and limitations</summary>
      <dl className="facts">
        <dt>Entered coordinates</dt>
        <dd className="num">{f.entered}</dd>
        <dt>Frame</dt>
        <dd>{f.frame}</dd>
        <dt>Terrain sources</dt>
        <dd className="num">{f.terrain}</dd>
        <dt>Observer</dt>
        <dd className="num">{f.observer}</dd>
        <dt>Sampling</dt>
        <dd className="num">{f.sampling}</dd>
        {f.processing && (
          <>
            <dt>Processing</dt>
            <dd className="num">{f.processing}</dd>
          </>
        )}
      </dl>
      <ul>
        {f.limitations.map((x) => <li key={x}>{x}</li>)}
      </ul>
    </details>
  );
}
