# Data Contract — Version 1

## Ownership
The pipeline owns scientific calculations and visibility states.
The frontend owns display, selected-window aggregation, and interaction.

Changes to this contract require both teammates to agree.
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