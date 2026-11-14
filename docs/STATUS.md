# Project Status

Update after each completed milestone or important decision.
Record observed results, not assumed progress.

Owner: Dylan (sole developer; all frontend, pipeline, and data work).

## Current state (2026-11-14)
Milestone 1 is complete and verified locally:
one documented lunar point, one day of real JPL Horizons Sun/Earth
positions, and a working interactive elevation chart.

- Site: IM-2 Athena landing point, 84.7906° S, 29.1957° E, from
  [LROC "IM-2 Athena Seen Obliquely"](https://lroc.im-ldi.com/images/1408)
  (M. Robinson, 10 March 2025).
- Interval: 2026-12-01T00:00:00Z (inclusive) to 2026-12-02T00:00:00Z,
  145 samples at 600 s, including the final sample at coverage end.
- Raw Horizons responses and request metadata: `data/horizons/`.
- App data: `app/public/data/manifest.json`, `app/public/data/im2-athena.json`
  (`is_synthetic: false`).
- Frontend (React 19 + TypeScript 7 + Vite 8): site and coordinates, selected
  UTC time, Sun/Earth elevation curves, 0° smooth-horizon line, slider and
  ±10 min buttons, a synchronized cursor (drag or click on the chart), hover
  tooltip, current az/el readouts, a data table, sources, and a prominent
  "Terrain not yet modeled" label. Deep link: `?t=<ISO UTC>`.

Observed in the data: on this day the Sun's center is below the
horizontal plane all day (−0.24° → −1.24°, azimuth 250.8° → 238.7°). Earth's
center is above it all day (3.20° → 1.75°, azimuth ~337.4°–337.7°).
With terrain these conclusions can change. Earth only a few degrees up is
especially likely to be blocked.

## Decisions made in milestone 1
- **Ownership.** The documents assumed two people; updated for a sole developer
  (SPEC.md, DATA_CONTRACT.md).
- **Site.** IM-2 Athena (84.79° S) is a precisely published point (four
  decimals, by the LRO camera team), is a real surface site, and lies poleward
  of 80° S, so the LOLA polar DEMs will cover it.
- **Coordinate frame (assumption).** The LROC page does not name its frame.
  LRO products use the Mean Earth/polar axis (ME) frame by convention, and
  Horizons interprets lunar site coordinates in MOON_ME (DE421). Treated as the
  same frame; the difference between ME realizations is far below this
  milestone's 10-minute resolution. Revisit if a source states otherwise.
- **Altitude.** `horizons_site_altitude_km = 0`, i.e. on the 1737.4 km
  reference sphere, because the local LOLA surface elevation is not yet
  extracted (`surface_elevation_m = null`), and
  `observer_height_above_surface_m = 0`. A radial offset of a few km changes the
  Earth direction by < 0.001° (h / 384 400 km). It matters for terrain
  horizons, which are deferred.
- **Date.** 2026-12-01 UTC: a near-future day inside Horizons' EOP prediction
  span (EOP file `eop.261113.p270209`, predicts to 2027-02-08). Chosen for
  convenience, not for an event.
- **Raw cache location.** `data/horizons/` (committed). `data/raw/` is
  git-ignored in the root `.gitignore`, so it is reserved for large terrain
  downloads.
- **Smooth horizon.** Exported (0°, labeled `smooth`) with midpoint-classified
  intervals so the files are contract-complete; the UI shows only the 0° line.
- **Dependencies.** The pipeline uses the Python standard library only.

## Terrain product selection (2026-11-14)
Evidence: `data/terrain/lola_coverage_report.json`, produced by
`python pipeline/terrain_check.py`; labels cached in `data/terrain/labels/`.

**Selected:** LDEM_80S_20M (near field) + LDEM_75S_60M (far field), with
LDEC_80S_20M / LDEC_75S_60M shot counts. Both come from the PDS Geosciences
Node, data set LRO-L-LOLA-4-GDR-V1.0, product version V2.0, LOLA data through
2017-02-02T22:18:35. Frame: "MEAN EARTH/POLAR AXIS OF DE421" (same as
Horizons MOON_ME). Projection: polar stereographic, spherical R = 1737.4 km,
scale true at the pole. Values: LSB int16, height = DN × 0.5 m relative to
1737.4 km.

product | grid (px) | m/px at pole (at site) | actual bounds (edge mid / corner) | site inside | site → file edge
---|---|---|---|---|---
LDEM_875S_5M/10M/20M | 30336/15168/7584 | 5/10/20 | 87.499° S / 86.464° S | no | n/a
LDEM_85S_10M/20M/40M | 30336/15168/7584 | 10/20/40 | 85.001° S / 82.935° S | **yes** (square corner) | only 13.7 km (min)
**LDEM_80S_20M** | 30400 | 20 (19.96) | 80.000° S / 75.894° S | yes | 165.2–505 km
**LDEM_75S_60M** | 15248 | 60 (59.88) | 75.001° S / 68.907° S | yes | ≥ 316.8 km

(Labels give only nominal MAXIMUM_LATITUDE. Actual bounds were computed from
LINES × MAP_SCALE using the projection equations in `dsmap_polar.cat`.)

Why both products: a horizon ray can stop only once no terrain beyond it
could rise above the horizon found so far. The test assumes the global LOLA
maximum height of 10 773 m (LDEM_64 label MAXIMUM) plus a 100 m margin. On a
240 m planning grid, rays need 62–190 km of terrain (median 117 km). In
azimuths **320°–351°** this is up to 24.6 km beyond the LDEM_80S_20M edge.
That sector contains Earth on our day (az 337.4°–337.7°), and its horizon is
low (about −1° on the coarse grid), so far terrain matters there. Every
azimuth reaches its stopping point inside LDEM_75S_60M. A ray that leaves
every file before stopping will be recorded as unknown (null), never as flat
terrain.

Missing data: no LDEM label defines MISSING_CONSTANT. Every pixel is filled
by GMT `surface` interpolation between LOLA tracks, so a gap never appears as
a missing value. The LDEC count files record which pixels were actually
measured:
- In the 2.02 km window around the site, **33.9 % of 20 m pixels have 0 shots**
  (their values are interpolated). The site pixel has 1 shot; the maximum count
  in the window is 9.
- Sampled along the rays at 240 m, 0 % of pixels had 0 shots (43 166 samples).

The horizon computation must report the LDEC count of the pixel that sets
each azimuth's horizon, so horizons set by interpolated terrain are visible.

Site terrain: 5321.9 m above 1737.4 km (LDEM_80S_20M, bilinear). The 2 km
window spans 5238.5–5358.5 m. Not yet fed back into Horizons (altitude still 0 km).

## Validation log
date | check | inputs | expected behavior | observed result | pass/fail
---|---|---|---|---|---
2026-11-14 | Horizons observer body | both raw responses | `Center body name: Moon (301)` | as expected | pass
2026-11-14 | Site echoed by Horizons | both | `29.1957, -84.7906, 0.0 {E-lon(deg),Lat(deg),Alt(km)}` | as expected | pass
2026-11-14 | Longitude convention | both | east-positive | `MEAN_ME (high precision) {East-longitude positive}` | pass
2026-11-14 | Altitude reference | both | stated reference surface | `Center radii: 1737.4, 1737.4, 1737.4 km` (sphere) | pass
2026-11-14 | Time standard | both | UT = UTC | `... 00:00:00.0000 UT`; footer: "Times AFTER 1962 are in UTC" | pass
2026-11-14 | Airless, target center | both | no refraction, body center | `Atmos refraction: NO (AIRLESS)`; column = "Airless apparent azimuth and elevation of target center" | pass
2026-11-14 | Targets | both | Sun 10, Earth 399 | `Sun (10)`, `Earth (399)`, source DE441 | pass
2026-11-14 | Parsing / row count | both | 145 rows, no `n.a.` | 145 + 145, 0 missing | pass
2026-11-14 | Timestamp order, spacing | exported samples | strictly increasing, unique, 600 s | as expected | pass
2026-11-14 | Coverage | exported samples | first = start, last = end | 2026-12-01T00:00:00Z … 2026-12-02T00:00:00Z | pass
2026-11-14 | Ranges | exported samples | el in [−90, 90], az in [0, 360) | el −1.2426…3.2019 | pass
2026-11-14 | Export = raw | 290 values | exact equality | 0 mismatches | pass
2026-11-14 | Raw integrity | cached bodies | sha256 = metadata | match | pass
2026-11-14 | Intervals | smooth horizon | contiguous, exact coverage | 1 interval (Sun false, Earth true) | pass
2026-11-14 | Independent sanity | Sun rows | Horizons' own daylight flag flips when the upper limb (center + ~0.27° semi-diameter) crosses 0° | `*` at 00:40 (center −0.2696°), `s` at 00:50 (center −0.2769°): consistent with ~0.27° semi-diameter | pass
2026-11-14 | Pipeline unit tests (synthetic) | 11 tests: 359/1° crossing, periodic horizon, unknown sectors, all-visible, all-dark, unknown-not-merged, strict >, parsing, `n.a.`→null, refracted rejected | all pass | `Ran 11 tests … OK` | pass
2026-11-14 | Frontend unit tests | 11 vitest tests (real file + synthetic bad inputs) | all pass | 11 passed | pass
2026-11-14 | Typecheck + production build | `npm run build` | no errors | built: JS 233 kB (73 kB gzip), CSS 7 kB | pass
2026-11-14 | Displayed = source | headless Chrome DOM at 6 times (00:00, 00:50, 07:20, 12:00, 17:40, 24:00) | readouts equal raw values rounded to 0.001° | 24/24 values + 6/6 time labels match | pass
2026-11-14 | Interaction | Chrome DevTools Protocol | slider keys, buttons, click, drag keep cursor/readout/slider/URL in sync; hover shows tooltip | 12:00 → +2 keys 12:20 → back 12:10 → click 06:00 → drag 18:00; tooltip 08:00 on hover | pass
2026-11-14 | Layout | screenshots 1280 px (dark), 390 px iframe (light) | no overflow, legible | no horizontal overflow; light and dark both render | pass

2026-11-14 | LOLA label vs file | 13 LDEM + 2 LDEC polar south products | LINES × LINE_SAMPLES × bytes = HTTP Content-Length | all 15 match | pass
2026-11-14 | LOLA polar orientation | LDEM_75S_240M vs global LDEM_64, 480 points | one east/west reading clearly fits | RMS 30 m (90°E right of pole) vs 2507 m (mirrored); `dsmap_polar.cat`'s printed inverse is mirrored, forward equations used | pass
2026-11-14 | Seam consistency | 20 points near the 80S edge, az 320°–351° | products agree to resolution | 80S_20M − 75S_60M: mean +1.4 m, max 9.5 m; − 75S_240M: mean +2.0 m, max 21.5 m | pass
2026-11-14 | Terrain coverage | ray march, 360 azimuths | every azimuth reaches its stopping point inside a selected file | 360/360 inside LDEM_75S; 330/360 inside LDEM_80S | pass (with far field)
2026-11-14 | Projection unit tests | 6 tests (round trip, pole, orientation, bounds, site inside, outside → None) | pass | `Ran 17 tests … OK` (all pipeline tests) | pass

Not yet checked: screen reader output, Firefox/Safari, touch devices
(pointer events are used but were not tested on real touch hardware).

## Unresolved issues
- Horizons API signature reports version **1.2**, while the API doc page
  describes **1.3**. The output format was inspected by hand and parses as
  expected; `fetch.py` prints a warning on every run until this is resolved.
- Site coordinate frame is assumed (see decisions).
- Surface elevation at the site is unknown; terrain is not modeled, so
  "above 0°" says nothing about real visibility yet.
- Vitest 5 on Windows fails ("failed to find the current suite") when the
  shell's working directory uses a lowercase drive letter (`c:\…`).
  Worked around by `app/scripts/run-vitest.mjs` (used by `npm test`).
- Future UTC: Horizons applies the last known leap second over future spans.
- `dsmap_polar.cat` (2022-01-15 revision) prints a southern-hemisphere inverse
  that mirrors east/west relative to its own forward equations and text. We
  use the forward equations, verified against data.
- The stopping distances come from a 240 m planning grid, which smooths the
  near-field horizon. The real computation must apply the same stopping rule
  itself rather than reuse these distances.
- The LDEM_80S_20M and LDEM_75S_60M files (1.85 GB + 0.47 GB) are not yet
  downloaded. The checks used byte-range reads; only LDEM_75S_240M and
  LDEC_75S_240M are stored, in `data/raw/lola/` (git-ignored).

## Next milestone
Smooth-horizon workflow over the full supported dataset for Site A:
1. Choose the ~60-day interval (supporting a 14-day mission, +1/+3/+7-day
   slips) and fetch it in ≤ 1-month chunks, sequentially, with the same cache.
2. Show visibility rows (Sun, Earth, both) from `visibility_intervals` and
   the selected-window metrics, including the boundary flags and "not found in
   available data".
3. Add frontend tests for window clipping and duration-based percentages.
Then Stage 2: set the Horizons altitude from the LOLA site height (5.3219 km
plus observer height) and re-fetch. Then compute the terrain horizon from
LDEM_80S_20M + LDEM_75S_60M using the stopping rule above, with LDEC flags and
null for unknown sectors.

## Milestone checklist
- [x] Shared data contract accepted (v1.0, with 2026-11-14 clarifications).
- [x] One site with real sky positions.
- [ ] Complete smooth-horizon workflow.
- [ ] Terrain loaded and inspected.
- [ ] First terrain horizon checked.
- [ ] Second site integrated.
- [ ] Date-slip comparison verified.
- [ ] Sources and limitations complete.
- [ ] Deployment tested.
- [ ] Demo recorded.

## Blockers
None open.

For each blocker, record:
owner | exact symptom | attempts made | next diagnostic step

## AI assistance log
Record tool/model, task, affected files, and human verification.

- 2026-11-14 | Claude Code (Claude Opus 5.5) | Milestone 1: picked and documented
  the site; consulted the Horizons docs; wrote the pipeline (`pipeline/`); ran
  the Horizons retrievals (2 live requests, sequential); exported the data;
  wrote the React app (`app/`); ran the checks; updated the docs (SPEC.md,
  DATA_CONTRACT.md, STATUS.md, README.md) | Human verification: **pending**.
  Dylan should review the site choice, the frame assumption, and the rendered app.
- 2026-11-14 | Claude Code (Claude Opus 5.5) | LOLA terrain product verification and
  selection: `pipeline/lola.py`, `pipeline/terrain_check.py`,
  `pipeline/tests/test_lola.py`, `pipeline/config.json` (terrain section),
  `data/terrain/`, STATUS.md, DATA_CONTRACT.md, README.md | Human verification: **pending**.

## Handoff template
- Completed:
- Files changed:
- Checks run and results:
- Remaining uncertainty:
- Next task:
