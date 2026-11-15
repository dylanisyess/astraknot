# Data Contract — Version 1

## Ownership
The pipeline owns scientific calculations and visibility states.
The frontend owns display, selected-window aggregation, and interaction.

Dylan owns both sides of this contract (sole developer).
Changes must be recorded in the changelog at the end of this file and
reflected in both pipeline/export.py and app/src/types.ts in the same commit.
Do not silently rename fields or change units.

## Files
app/public/data/manifest.json
app/public/data/<site_id>.json

Raw source responses remain separate from derived app files.
Development fixtures belong in data/sample/ and must be labeled.

## Manifest fields
- schema_version: "1.0"
- dataset_id: string
- generated_at_utc: ISO 8601 timestamp ending in Z
- coverage_start_utc: inclusive
- coverage_end_utc: exclusive for analysis
- sample_step_seconds: 600 initially
- sites: array of {id, name, file}
- is_synthetic: boolean

## Site metadata
- id: stable lowercase identifier
- name: display name
- latitude_deg: north positive
- longitude_deg_east: east positive, normalized to [0, 360)
- coordinate_frame: exact documented frame/realization
- coordinate_source_url: source of the selected point
- observer_height_above_surface_m: explicit number
- surface_elevation_m: number or null
- surface_elevation_reference: documented datum or null
- horizons_site_altitude_km: value actually submitted
- horizons_altitude_reference: documented meaning
- horizon_model: "smooth" or "terrain"
- is_synthetic: boolean

Height above terrain and altitude supplied to Horizons are different
quantities. Record how one was converted into the other.

## Sources
sources: array of
- id
- title
- url
- retrieved_at_utc
- product_version_or_filename
- notes

Preserve Horizons query parameters and raw response headers.
Record terrain projection, height reference, scale, missing-data
values, resolution, and coverage in processing metadata.

## Position samples
samples: array sorted by time, with unique timestamps.

Each sample contains:
- time_utc
- sun_azimuth_deg
- sun_elevation_deg
- earth_azimuth_deg
- earth_elevation_deg

All angles are degrees.
Azimuth: north = 0, east = 90, south = 180, west = 270.
Elevation is relative to the local horizontal plane.
Use observer-specific, airless center-of-body directions.
Document the exact Horizons output conventions.

Unavailable values are null, never zero.

Include a final position sample at coverage_end_utc so that the
last analysis interval has both bounding samples.

## Horizon
horizon:
- model: "smooth" or "terrain"
- azimuth_deg: ascending unique angles in [0, 360)
- elevation_deg: corresponding horizon elevations
- observer_height_above_surface_m
- interpolation: "linear_periodic"
- processing_notes

Interpolate cyclically across 360/0 degrees.
A missing terrain sector is unknown, not unobstructed.
The smooth model is the explicitly labeled 0-degree approximation.

Terrain calculations must account for lunar curvature once.
Record terrain search extent and resolution.

## Visibility intervals
visibility_intervals: sorted, contiguous, non-overlapping intervals.

Each interval contains:
- start_utc: inclusive
- end_utc: exclusive
- sun_visible: true, false, or null
- earth_visible: true, false, or null

null means unknown.

Initial method: evaluate visibility at each interval midpoint using
interpolated position samples and the horizon profile. Merge adjacent
intervals only when both visibility states match.

Interpolate azimuth across the shortest circular path.
For example, 359 to 1 degrees passes through 0, not 180.

Record the method as "10-minute midpoint classification".
Reported transitions are approximate interval boundaries.

## Selected-window metrics
Clip intervals to the selected mission window before aggregating.
Compute percentages using elapsed duration, not row counts.

If any relevant state is unknown, show the corresponding metric as
unavailable in version 1; do not silently exclude missing periods.

Both visible:
- true when both are true
- false when either is false
- unknown otherwise

Darkness means sun_visible is false.
Unknown intervals must not be merged into known darkness.

Return boundary flags for a longest dark interval that touches the
start or end of the selected mission window.

## Validation
- No duplicate or unordered timestamps.
- Position samples cover the complete analysis interval.
- Elevation values lie within [-90, 90] when present.
- Azimuth values lie within [0, 360) when present.
- Visibility intervals cover the advertised range exactly.
- Test a synthetic 359/1-degree azimuth crossing.
- Test all-visible, all-dark, and unknown intervals.
- Test mission windows that cut through interval boundaries.
- Verify duration totals and baseline-versus-delay comparisons.

Synthetic fixtures test code behavior; they do not validate
real lunar conditions.

## Clarifications and changelog

### 2026-11-14, milestone 1 (schema_version stays "1.0", additive only)
- Site file layout: `{schema_version, site: {<site metadata>}, sources,
  position_conventions, samples, horizon, visibility_method,
  visibility_intervals}`. Site metadata is nested under `site`.
- Added optional `site.altitude_conversion_note`: how
  `observer_height_above_surface_m` became `horizons_site_altitude_km`.
- Horizons source entries also carry `horizons_query_params`,
  `http_status`, `http_response_headers`, `api_signature`, and
  `ephemeris_header` (convention lines echoed by Horizons). This satisfies
  "preserve query parameters and raw response headers".
- `retrieved_at_utc` is a full timestamp for API responses. For web pages
  consulted by hand it is a date only (`YYYY-MM-DD`), because the time was not
  recorded.
- Raw Horizons responses are cached byte-for-byte in `data/horizons/`
  (committed; small). `data/raw/` stays git-ignored for large terrain products.
- Milestone 1 exports `horizon.model = "smooth"` (0° everywhere) and its
  midpoint-classified `visibility_intervals` so files are contract-complete;
  the UI does not yet display intervals or metrics.
- Horizons conventions used (verified in the response header):
  observer `coord@301` with `COORD_TYPE=GEODETIC`, `SITE_COORD = E-lon, lat, alt(km)`,
  frame `MEAN_ME (high precision) {East-longitude positive}`, reference sphere
  1737.4 km, quantity 4 airless apparent AZ/EL of the target center, `TIME_TYPE=UT`
  (UTC after 1962). Targets: Sun `10`, Earth `399` (body center, not barycenter `3`).

### 2026-11-14, terrain product selection (no schema change)
- Terrain sources: LDEM_80S_20M (near field) and LDEM_75S_60M (far field),
  PDS LRO-L-LOLA-4-GDR-V1.0 V2.0. Selection evidence and processing metadata
  (projection, height reference, scale, actual bounds, resolution, coverage,
  missing-data handling) are in `data/terrain/im2-athena_lola_coverage_report.json`.
- LOLA LDEM products have no missing-data value; every pixel is interpolated
  where no shot exists. Shot counts come from the matching LDEC products.
  A terrain horizon must record the LDEC count of the pixel that sets each
  azimuth. Terrain beyond the selected files is unknown: such an azimuth gets
  `elevation_deg: null`, never 0.
- `processing_notes` for a terrain horizon must state the stopping rule and
  the height bound used (global LOLA max 10 773 m + 100 m margin).

### 2026-11-14, milestone 2 (schema_version stays "1.0", additive only)
- Observer altitude: `site.surface_elevation_m` = LOLA surface height above
  the 1737.4 km sphere; `site.observer_height_above_surface_m` = 1;
  `site.horizons_site_altitude_km` = (surface + observer height) / 1000. All
  three heights share the same 1737.4 km reference, so no datum conversion
  is needed. Added `position_conventions.observer_altitude`.
- Horizons sources are per chunk: ids `horizons-<target>-<n>` (n = 1…6 for
  60 days in 10-day chunks), each with its exact query, headers and file.
  Chunks share endpoint timestamps; the exporter merges them only if those
  duplicate samples are identical.
- File layout: one sample / interval per line (compact JSON). Field names,
  units and semantics are unchanged.
- Mission windows (frontend): `[start, end)`; delays are offsets of +1/+3/+7 d
  from the baseline arrival, never cumulative; duration is unchanged by a
  delay. A window is valid only if `coverage_start ≤ start` and
  `end ≤ coverage_end`.
- Metric details (frontend, version 1):
  - A metric is unavailable if any relevant state in the window is null, or if
    the window is not fully covered by intervals. It is never shown as 0.
  - Darkness runs join adjacent intervals with `sun_visible: false`, even when
    Earth's state differs. A null interval breaks a run.
  - Ties for the longest run go to the earliest.
  - A run touching a window boundary is flagged. The app also reports the
    run's full extent in the data, and says when that extent reaches the edge
    of the coverage.
  - "Next change" searches to coverage end and otherwise reports "not found
    in available data".
- Smooth horizon = 0° local horizontal plane (ignores the ~0.06° dip for a
  1 m observer over a smooth surface).

### 2026-11-14, milestone 3: terrain horizon (schema_version stays "1.0", additive only)
- The top-level `horizon` and `visibility_intervals` are unchanged: the smooth
  0° model, byte-for-byte the milestone 2 result. `site.horizon_model` still
  describes that top-level horizon (`"smooth"`).
- New `site.available_horizon_models`: `["smooth"]` or `["smooth", "terrain"]`.
  Absent in older files, meaning `["smooth"]`.
- New optional top-level `terrain_horizon` (only when listed as available):
  - `horizon`: the contract's horizon fields with `model: "terrain"`,
    `azimuth_deg` (0.0 … 359.9 in 0.1° steps), `elevation_deg` (rounded to
    1e-5°; `null` = unknown, never 0), `observer_height_above_surface_m`,
    `interpolation: "linear_periodic"`, `processing_notes`, plus
    `search_extent` (stopping rule, `h_max_m`, stop distances, number of
    unknown azimuths) and `resolution` (azimuth step, radial steps, first
    sample distance, DEM pixel size per product).
  - `setting_points`: per-azimuth columns parallel to `azimuth_deg`:
    `distance_km`, `height_m` (above 1737.4 km), `lat_deg`, `lon_deg_east`,
    `product_index` (into `products`), `shot_count` (LDEC count of the nearest
    pixel; 0 = interpolated height). All `null` where the elevation is `null`.
    Shot counts are quality indicators, not accuracy guarantees.
  - `products`: name, role, content, pixel size, URL, sha256 of each LOLA file.
  - `observer`, `checks` (summary of the cross-checks and sensitivity).
    `checks.site_shift_scenarios` lists the four 100 m observer displacements
    (due N/E/S/W): skyline changes and demo-window metric changes relative to
    the nominal point. They are sensitivity scenarios, not a measured
    coordinate uncertainty or confidence interval. `checks.near_field` gives the
    nearest skyline distance and the effect of ignoring terrain within 20–300 m.
    `checks.lola_shots_note` / `azimuth_convention_note` state that those are a
    consistency check (the DEM was built from the shots) and a gross-error
    sanity check respectively. `horizon.resolution` separates the ray sampling
    distance (`radial_step_m`) from the terrain pixel spacing (`dem_pixel_m`,
    `near_dem_pixel_m_at_site`). (Added in the milestone 3 review; wording and
    metadata only, no numerical result changed.)
  - `visibility_method` and `visibility_intervals`: the same midpoint
    classification as the smooth model, against this profile. They are
    classified from the rounded profile that is exported, so a consumer
    re-classifying the samples gets identical intervals (tested in
    `validate.py` and `app/src/horizon.test.ts`).
- Horizon lookup rule (pipeline and app): linear periodic between profile
  azimuths; `null` if either bracketing value is `null`; exactly on a profile
  azimuth, that sample's own value is returned.
- Terrain geometry: great-circle rays in the ME frame from the observer at
  radius 1737.4 km + Horizons site altitude; elevation
  `atan2(r_t cos θ − r_o, r_t sin θ)`, so curvature is counted once; negative
  horizons are kept. The stopping rule and the 10 773 m + 100 m bound are as
  specified for terrain product selection; unknown = ray leaves every product first.
- Raw terrain inputs stay in git-ignored `data/raw/lola/`
  (`pipeline/fetch_terrain.py`). The committed evidence is
  `data/terrain/im2-athena_terrain_horizon.json` (every ray + sensitivity) and
  `data/terrain/im2-athena_horizon_crosscheck.json` (cross-checks).
- Observer height (clarified after the milestone 3 review):
  `observer_height_above_surface_m` = 1 is the nominal value. The submitted
  `horizons_site_altitude_km` was formed from the surface rounded to 0.1 m
  (5321.9 m vs the bilinear 5321.8804 m), so the actual point is 1.0196 m above
  the interpolated DEM surface; `terrain_horizon.observer.eye_above_dem_surface_m`
  records the exact value. Both the Sun/Earth directions and the terrain horizon
  use this one point (r = 1737.4 km + 5322.9 m). Measured effect of the 0.0196 m
  on the skyline: ≤ 0.0034°, one Sun 10-minute step in 60 days, no demo metric.
- The app selects Smooth or Terrain. It uses that model's intervals for every
  metric, timeline and readout; arrival, delay, duration and the selected time
  do not depend on the mode. URL parameter `horizon=smooth|terrain`.

### 2026-11-14, milestone 4A (no app schema change)
- Pipeline commands accept `--site ID`. Each exported filename must equal
  `<site_id>.json`; manifest entries and nested `site` identity must agree with
  config (ID, coordinates, nominal observer height, Horizons altitude).
- Intermediate coverage/elevation/terrain/cross-check reports are per-site:
  `data/terrain/<site_id>_<report_kind>.json`; altitude comparisons are
  `data/horizons/<site_id>_altitude_comparison.json`. Former Athena coverage,
  elevation and altitude filenames were migrated to this layout.
- Cross-check reports include `site` identity and `terrain_report_sha256` to
  bind the evidence to the exact horizon report. These are pipeline evidence
  fields, not additions to app data. Athena's existing evidence was annotated
  without changing its calculations. LOLA shot caches include site/query keys;
  source raster/label caches remain shared by product.

### 2026-11-14, milestone 4C (schema_version stays "1.0", no app field added)
- Second site file `app/public/data/connecting-ridge-cr1.json` uses the same
  layout; the manifest lists Athena first, then CR1. `dataset_id` is unchanged
  (still Athena-named) pending a full two-site re-export.
- `terrain_horizon.checks.pixel_sweep_max_abs_diff_deg_setting_ge_2km` may be
  `null` when no comparison bin has its skyline set >= 2 km away (CR1: skyline
  within 480 m). It is never 0 in that case. `processing_notes` then cite the
  same-direction and near-field checks instead.
- Note text that was Athena-specific (eye 1.02 m, "96-100 %" of shots) is now
  formed from each site's reports. Athena's exported bytes are unchanged.
- Pipeline evidence only (not app data): the cross-check report adds
  `near_field_bilinear`, `pixel_sweep.n_bins_ray_setting_ge_2km`,
  `pixel_sweep.max_pixel_minus_ray_deg`, and per-box/min-max
  `pct_shots_on_or_before_dem_cutoff`. New report kind
  `data/terrain/<site_id>_observer_rounding_check.json`
  (`pipeline/observer_rounding_check.py`) with site identity and terrain report sha256.
- Horizons altitude echo: validated by recomputing `Center cylindric` Dxy/Dz from
  the submitted latitude/altitude and comparing at the printed decimals (precision
  varies: Dz to 1e-3 km near the pole), not with a fixed |r| tolerance.

### 2026-11-14, CR1 5 m terrain assessment (no app data change)
- Pipeline evidence only: `data/terrain/<site_id>_terrain_5m_assessment.json`
  (`pipeline/terrain_5m.py`), carrying site identity and the 20 m terrain report sha256.
- `terrain_horizon.Raster.from_files` also accepts `PGDA_<SITE>_5M` and
  `PGDA_<SITE>_5M_B4` (GSFC PGDA GeoTIFFs via `pipeline/pgda.py`; raw files in
  git-ignored `data/raw/pgda/`). These are not referenced by `config.json`, and no exported file uses them.
