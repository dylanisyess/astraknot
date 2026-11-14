# Project Status

Update after each completed milestone or important decision.
Record observed results, not assumed progress.

Owner: Dylan (sole developer; all frontend, pipeline, and data work).

## Current state (2026-11-14, milestone 2)
Milestone 2 is complete and verified locally: a smooth-horizon mission-window
workflow for the IM-2 Athena site, using 60 days of real JPL Horizons data.

- Branch `milestone-2-mission-window`; checkpoint commit `171b561` holds
  milestone 1. Milestone 2 changes are in the working tree (not committed).
- Data: 2026-12-01T00:00:00Z (inclusive) to 2027-01-30T00:00:00Z, 8 641
  samples at 600 s, including the final endpoint. Fetched as 12 sequential
  Horizons requests (Sun and Earth, six 10-day chunks).
- Observer: 5 322.9 m above the 1737.4 km sphere (LOLA surface 5 321.9 m +
  1 m observer height); Horizons altitude 5.3229 km. Verified, see below.
- App: baseline arrival (UTC date + hour), duration (default 14 Earth days),
  slips of +1/+3/+7 d from the baseline; comparison table (Sun/Earth/both
  visible %, longest darkness, changes in pp and h); Sun/Earth/both timeline
  rows for baseline and slipped windows; elevation chart; one shared cursor for
  timeline, chart, readouts and slider; interval table; boundary flags;
  "not found in available data"; smooth-horizon banner.
- URL state: `?arrival=2026-12-05T00:00Z&days=14&delay=3&t=<ISO UTC>`.

What the data shows (smooth horizon only): the Sun's center is below 0°
from coverage start until 2026-12-12 22:20, above it until 12-29 23:40, below
until 2027-01-12 01:50, above until 01-27 22:20. Earth's center is below 0° on
12-03 09:50 → 12-11 05:00, 12-30 10:50 → 01-07 08:50 and 01-26 15:30 → end.
Terrain could change all of these.

## Observer altitude (verified 2026-11-14)
Evidence: `data/terrain/site_elevation_report.json` (`python pipeline/site_elevation.py`).

Two different quantities:
- **Surface elevation** = height of the modeled lunar surface above the
  1737.4 km reference sphere = **5 321.9 m** (LOLA LDEM_80S_20M, bilinear at
  the site).
- **Observer height above surface** = **1 m** (documented choice).
- Horizons altitude = (5 321.9 + 1) m = **5.3229 km above the 1737.4 km sphere**.

Checks:
- Scaling and reference: height = DN × 0.5 m relative to 1737.4 km (label).
  Independently tested against **1 131 individual LOLA RDR laser shots** (PDS
  ODE GDS, valid shots only) within ~600 m. Each shot gives radius from the
  Moon's center in km, with no scaling. DEM − shot: mean **−0.26 m**, sd
  0.67 m, max 4.71 m.
- Orientation and pixel selection: the same comparison with an
  east/west-mirrored pixel mapping gives mean −5 899 m, so our mapping places
  the terrain correctly. Earlier check: LDEM_75S_240M vs global LDEM_64, RMS
  30 m vs 2 507 m mirrored.
- Interpolation: bilinear between pixels (19055, 8300)–(19056, 8301); fractional pixel
  (19055.91, 8300.84). Nearest pixel 5 322.0 m vs bilinear 5 321.88 m.
- Shots within 30 m of the site: 8, heights 5 321.75–5 322.69 m (mean 5 322.17 m).
- Products at the site: 80S_20M 5 321.88, 80S_40M 5 321.70, 85S_20M 5 321.88,
  85S_10M 5 322.00, 75S_60M 5 321.45, LDEM_64 (nearest) 5 323.00 m.
- Sensitivity to the site coordinate: local slope 2.3°; height changes
  −1.5…+1.2 m within 30 m and −4.4…+4.6 m within 100 m. LROC does not state
  the coordinate's accuracy, so the surface value is good to ~1 m **for the
  stated coordinates**, and ~±5 m if the true point is up to 100 m away.
- Horizons convention: GEODETIC altitude is height above the reference body;
  for the Moon that is a 1737.4 km sphere (header `Center radii`). Verified in
  all 12 responses: echoed `Center geodetic … 5.3229` and
  |`Center cylindric`| = 1742.7229 km = 1737.4 + 5.3229.

Measured effect of the correction (2026-12-01, 145 samples, 0 km vs 5.3229 km;
`data/horizons/altitude_comparison.json`):
- Earth: angular change 7.99–8.09 × 10⁻⁴° (mean 8.04 × 10⁻⁴°), all in elevation
  (lower). This matches the parallax h·cos(el)/d at ~379 000 km.
- Sun: 2.07 × 10⁻⁶°. Azimuth changes ≤ 4 × 10⁻¹⁰°.
- At 10-minute resolution this does not change any visibility state by itself.
- The 0 km responses are kept in `data/horizons/` for this comparison.

## Decisions
Milestone 2:
- **Coverage:** 60 days from 2026-12-01T00:00Z, in 10-day chunks. Each chunk
  includes both endpoints; the exporter refuses to merge if a shared boundary
  sample differs (all 5 boundaries identical per target).
- **Service limits:** sequential requests with a 2 s pause, at most 3 retries
  (10/30/90 s or Retry-After) for HTTP 429/5xx/timeouts only, cache keyed by
  exact query parameters, so re-runs make 0 requests (observed). Failures stop
  the run; nothing is substituted.
- **Mission windows:** [arrival, arrival + duration), end exclusive. Arrivals
  are whole UTC hours, durations whole Earth days (1–60), delays fixed at
  0/1/3/7 d from the baseline. Earliest arrival = coverage start; latest =
  coverage end − duration. A delay is offered only if its window ends at or
  before coverage end. If a chosen delay stops fitting, the app shows the
  baseline and says so.
- **Default scenario:** baseline 2026-12-05 00:00 UTC, 14 d, +3 d. It spans
  the 12-12 sunrise, so the slip visibly changes the metrics.
- **Smooth horizon:** 0° local horizontal plane. This ignores the ~0.06° dip of
  a 1 m observer over a smooth surface; terrain will replace it.
- **Metrics:** shares of elapsed time; unavailable (never 0) when any
  relevant state is unknown or the window is not fully covered. Darkness =
  Sun not visible; unknown breaks darkness runs; ties go to the earliest run.
  The full darkness run in the data is reported when it touches a boundary.

Milestone 1 and terrain selection (unchanged): site IM-2 Athena, 84.7906° S,
29.1957° E (LROC); coordinate frame assumed ME (LROC does not state it); raw
Horizons cache in `data/horizons/`; terrain products LDEM_80S_20M (near field)
+ LDEM_75S_60M (far field). Raw source files are marked `-text` in
`.gitattributes` so line endings never change their recorded sha256.

## Terrain product selection (milestone 1.5, unchanged)
Evidence: `data/terrain/lola_coverage_report.json` (`python pipeline/terrain_check.py`).

**Selected:** LDEM_80S_20M (near field) + LDEM_75S_60M (far field), with
LDEC_80S_20M / LDEC_75S_60M shot counts. PDS Geosciences Node,
LRO-L-LOLA-4-GDR-V1.0, product V2.0, LOLA data through 2017-02-02T22:18:35.
Frame "MEAN EARTH/POLAR AXIS OF DE421" (as Horizons MOON_ME). Polar
stereographic, spherical R = 1737.4 km, true at the pole; LSB int16,
height = DN × 0.5 m relative to 1737.4 km.

product | grid (px) | m/px at pole (at site) | actual bounds (edge mid / corner) | site inside | site → file edge
---|---|---|---|---|---
LDEM_875S_5M/10M/20M | 30336/15168/7584 | 5/10/20 | 87.499° S / 86.464° S | no | n/a
LDEM_85S_10M/20M/40M | 30336/15168/7584 | 10/20/40 | 85.001° S / 82.935° S | yes (square corner) | only 13.7 km (min)
**LDEM_80S_20M** | 30400 | 20 (19.96) | 80.000° S / 75.894° S | yes | 165.2–505 km
**LDEM_75S_60M** | 15248 | 60 (59.88) | 75.001° S / 68.907° S | yes | ≥ 316.8 km

Rays need 62–190 km of terrain (stopping rule with the global LOLA maximum
10 773 m + 100 m). Azimuths 320°–351° (Earth's direction) need up to 24.6 km
beyond the 80S file, so the 75S product is required. LDEM has no
missing-data value (everything is interpolated); LDEC counts show 33.9 % of
20 m pixels near the site have no LOLA shot.

## Validation log
date | check | inputs | expected behavior | observed result | pass/fail
---|---|---|---|---|---
2026-11-14 | Horizons conventions (M1) | 2 raw responses | Moon (301) observer; site echoed E-lon,Lat,Alt; MEAN_ME east-positive; 1737.4 km sphere; UT=UTC; airless; target centers Sun 10 / Earth 399 | as expected | pass
2026-11-14 | M1 data and app | 145 samples; DOM at 6 times | parse, order, 600 s, export = raw, display = raw | 290/290 values exact; 24/24 displayed values match | pass
2026-11-14 | LOLA label vs file | 13 LDEM + 2 LDEC products | LINES × LINE_SAMPLES × bytes = HTTP Content-Length | 15/15 match | pass
2026-11-14 | LOLA orientation vs global grid | LDEM_75S_240M vs LDEM_64, 480 points | our mapping fits, mirrored does not | RMS 30 m vs 2 507 m | pass
2026-11-14 | Seam 80S_20M vs 75S_60M | 20 points near the 80S edge | agree to resolution | mean +1.4 m, max 9.5 m | pass
2026-11-14 | Surface elevation vs LOLA shots | 1 131 RDR shots within ~600 m | DEM − shot ≈ 0 | mean −0.26 m, sd 0.67 m; mirrored control −5 899 m | pass
2026-11-14 | Horizons altitude convention | 12 responses | echo 5.3229; \|cylindric\| = 1737.4 + alt | 12/12: 1742.7229 km | pass
2026-11-14 | Altitude effect | 2026-12-01, 0 vs 5.3229 km | Earth ~h/d ≈ 8 × 10⁻⁴°, Sun ~2 × 10⁻⁶° | Earth 8.04 × 10⁻⁴° (mean), Sun 2.07 × 10⁻⁶° | pass
2026-11-14 | 60-day retrieval | 12 chunked requests | sequential, cached, complete | 12 live, then re-run 0 live; 6 × 1 441 rows per target | pass
2026-11-14 | `validate.py` | raw cache + export | contract + raw checks | **50/50 pass**: per chunk sha256, HTTP 200, conventions, altitude, row counts, 0 `n.a.`; 5 identical boundaries per target; 8 641 samples, uniform 600 s, final endpoint; el −4.26…10.72°; export = raw 17 282/17 282; 10 contiguous intervals | pass
2026-11-14 | Pipeline unit tests | 23 tests (synthetic + labels) | pass | `Ran 23 tests … OK` | pass
2026-11-14 | Frontend unit tests | 32 vitest tests | pass | 32 passed | pass
2026-11-14 | Mission rules (tests) | synthetic coverage | delays are offsets, not cumulative; duration unchanged; earliest/latest arrival; end-exclusive fit; disabled delays | all pass | pass
2026-11-14 | Metric rules (tests) | synthetic intervals | all-visible, all-dark, unknown, both-known-false, duration not counts, clipping through intervals, beyond-data, unknown breaks darkness, ties | all pass | pass
2026-11-14 | Real-data metrics | 3 windows (5 cases) | TypeScript = independent Python (`crosscheck_metrics.py`, from samples, no shared code) | equal to 1e-9 | pass
2026-11-14 | Manual cross-check | 2026-12-05 + 14 d vs interval list | Sun 145.67 h / 336 h; Earth 187 h; dark 12-05 00:00 → 12-12 22:20 | 43.35 %, 55.65 %, 190.33 h (touches start); app shows 43.4 % / 55.7 % / 190.3 h ⚠ | pass
2026-11-14 | Production build | `npm run build` | no errors | JS 252 kB (79 kB gzip), CSS 12 kB | pass
2026-11-14 | Browser checks | headless Chrome via DevTools protocol | 29 checks: metrics, deltas, duration unchanged, +1 after +7 = +1, latest/earliest arrival, disabled delays, fallback notice, real drag on timeline and chart, cursor sync, arrow key, readouts at 12-12 22:10/22:20, "not found in available data" near the end, banner, no overflow at 1280/390 px light and dark | **29/29 pass** | pass

Not yet checked: screen readers, Firefox/Safari, real touch hardware,
keyboard-only use of the timeline (the slider is keyboard-accessible; the
timeline itself is pointer-only).

## Unresolved issues and assumptions
- Site coordinate frame assumed ME; LROC does not state the frame or the
  coordinate's accuracy, which drives the ±5 m surface uncertainty.
- Terrain is not included; "visible" is the smooth 0° approximation only.
- Horizons API signature 1.2 vs doc page 1.3 (output format verified by hand).
- Future UTC: Horizons applies the last known leap second (EOP predictions to
  2027-02-08 cover the dataset).
- `app/public/data/im2-athena.json` is 1.5 MB (≈ 400 kB gzip). Fine for now;
  revisit with a second site or longer coverage.
- Projection documentation: when we read the printed lat/lon → line/sample
  equations in `dsmap_polar.cat` literally, they place 90° E left of the pole.
  That conflicts with the same document's forward equations and description.
  We have not established whether the text or our reading is at fault, so we
  make no claim that the document is wrong. We implement the forward equations
  and their algebraic inverse, and that mapping is checked against independent
  data (global grid, LOLA shots).
- Planning-grid stopping distances must be recomputed by the real horizon code.
- LDEM_80S_20M / LDEM_75S_60M are not downloaded (1.85 + 0.47 GB).
- Windows only: Vitest needs `app/scripts/run-vitest.mjs` (drive-letter case).

## Backlog (not in this milestone)
- Curated list of documented sites (second site, then more), each with a
  cited coordinate source and verified surface elevation.
- Custom user-entered coordinates (requires live or precomputed positions and
  terrain; conflicts with the static-data architecture, design first).
- Keyboard interaction for the timeline itself.

## Next milestone
Stage 2 terrain horizon for the Athena site:
1. Download LDEM_80S_20M and LDEM_75S_60M (+ LDEC) into `data/raw/lola/`.
2. Compute the horizon with the stopping rule, curvature once, LDEC flags, and
   null for unknown sectors; record extent and resolution.
3. Export `horizon.model = "terrain"` and re-classify intervals; show smooth
   and terrain results side by side and label which is shown.

## Milestone checklist
- [x] Shared data contract accepted (v1.0 + clarifications).
- [x] One site with real sky positions.
- [x] Complete smooth-horizon workflow.
- [ ] Terrain loaded and inspected (products selected and verified; not downloaded).
- [ ] First terrain horizon checked.
- [ ] Second site integrated.
- [x] Date-slip comparison verified (smooth horizon).
- [ ] Sources and limitations complete.
- [ ] Deployment tested.
- [ ] Demo recorded.

## Blockers
None open.

For each blocker, record:
owner | exact symptom | attempts made | next diagnostic step

## AI assistance log
Record tool/model, task, affected files, and human verification.

- 2026-11-14 | Claude Code (Claude Opus 5.5) | Milestone 1 (site, one day of
  Horizons data, elevation chart) | pipeline/, app/, docs | Human verification: **pending**.
- 2026-11-14 | Claude Code (Claude Opus 5.5) | LOLA terrain product selection |
  `pipeline/lola.py`, `pipeline/terrain_check.py`, `data/terrain/` | Human verification: **pending**.
- 2026-11-14 | Claude Code (Claude Opus 5.5) | Milestone 2: checkpoint commit;
  observer altitude verification (`pipeline/site_elevation.py`,
  `data/terrain/lola_rdr/`, `data/terrain/site_elevation_report.json`);
  60-day chunked retrieval with retries (`pipeline/horizons.py`, `fetch.py`,
  `export.py`, `validate.py`); altitude comparison (`compare_altitude.py`);
  independent metric reference (`crosscheck_metrics.py`); mission-window UI
  (`app/src/mission.ts`, `axis.ts`, `Timeline.tsx`, `ElevationChart.tsx`,
  `App.tsx`, `styles.css`) and tests; docs | Human verification: **pending**,
  see the manual checklist in the milestone report.

## Handoff template
- Completed:
- Files changed:
- Checks run and results:
- Remaining uncertainty:
- Next task:
