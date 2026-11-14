# Project Status

Update after each completed milestone or important decision.
Record observed results, not assumed progress.

Owner: Dylan (sole developer; all frontend, pipeline, and data work).

## Start here (handoff for a new session, updated 2026-11-14 after milestone 4B)
Read this section first, then `docs/SPEC.md` and `docs/DATA_CONTRACT.md`.
The rest of this file is the detailed record behind it.

**Current checkpoint:** Milestone 4B complete on `milestone-4-site-comparison`,
starting from verified `61a0a18` with a clean tree. Selected
`connecting-ridge-cr1`: NASA's notional study/assumed landing point at
89.468 S, 222.6 E. Source, candidate decision and limits: [SECOND_SITE.md](SECOND_SITE.md).
Cached coarse coverage planning and DEM elevation checks support preparation;
no second-site Horizons request, full terrain horizon, export or frontend change.
Athena configuration and every existing app/source/evidence file are preserved.
The app manifest still contains Athena alone; config now contains two sites.
**Exact next task (4C):** explicitly fetch CR1 positions at the planned
1.9428 km altitude, export/check smooth samples, then calculate and cross-check
its full terrain horizon. Exact commands are below; none were run in 4B.
Always use `--site`: single-site commands now require it; unscoped batch
fetch/export/validation would include the unprepared second site.

### What works (verified)
- **Data:** 60 days of real JPL Horizons Sun/Earth airless apparent az/el of
  body centers at 10 min (2026-12-01T00:00Z to 2027-01-30T00:00Z, 8 641
  samples incl. final endpoint), for the IM-2 Athena site 84.7906° S,
  29.1957° E. Observer: 5.3229 km above the 1737.4 km sphere (LOLA surface
  5 321.9 m + 1 m). Raw responses with query, headers and sha256 are in
  `data/horizons/`.
- **Terrain horizon (milestone 3):** 0.1° profile from LOLA LDEM_80S_20M
  (+ LDEM_75S_60M beyond its edge), exact sphere geometry, per-ray stopping
  rule, no unknown sectors. Synthetic geometry tests and sensitivity runs pass;
  an independently implemented pixel sweep on the same DEM agrees; the DEM's
  own source laser shots are consistent with the skyline (see "Milestone 3"
  below). Exported next to the unchanged smooth horizon.
- **App** (`app/`, React 19 + TS 7 + Vite 8): **Smooth / Terrain selector**
  (default Terrain); baseline arrival + duration, +1/+3/+7 d slips; comparison
  table; Sun/Earth/both timelines; **horizon panorama** linked to the cursor;
  elevation chart with the skyline under each body (terrain mode); one shared
  cursor; boundary flags (short, expandable); unknown handling; URL state
  including `horizon=`.

### Key files
Pipeline (`pipeline/`, Python standard library only; run from the repo root):
- `connecting-ridge-cr1` is configured for terrain preparation only; see
  `data/terrain/connecting-ridge-cr1_{site_selection,lola_coverage_report,site_elevation_report}.json`.
- `config.json`: sites, altitude, coverage, chunking, shared terrain product choice (single source of truth).
- `sites.py`: site selection, canonical report paths, identity and report fingerprint checks.
  Every pipeline entry point accepts `--site ID`; batch fetch/export/validate
  still default to all configured sites. Other scripts default only when one site exists.
- `horizons.py`, `fetch.py`, `export.py`, `validate.py`, `visibility.py`,
  `compare_altitude.py`, `crosscheck_metrics.py` (milestone 2; `export.py`,
  `validate.py`, `visibility.py` and `crosscheck_metrics.py` extended for terrain).
- `lola.py`: PDS3 labels, polar projection, range reads, **`download_stream`**
  (chunked, resumable, size-checked, sha256).
- `fetch_terrain.py`: downloads the four selected LOLA products into
  `data/raw/lola/` (git-ignored, 3.47 GB); `--check [--rehash]` verifies them.
- `terrain_horizon.py`: the ray march (memory-mapped files, parallel, stdlib)
  → `data/terrain/im2-athena_terrain_horizon.json` (every ray + sensitivity).
- `terrain_sensitivity.py`: azimuth/radial/extent/product/site-position variants.
- `horizon_crosscheck.py`: pixel sweep (independent implementation, same DEM),
  LOLA RDR shot consistency near the skyline, azimuth-convention sanity check
  vs Horizons → `data/terrain/im2-athena_horizon_crosscheck.json`.
- `terrain_check.py`, `site_elevation.py`: coverage planning and surface elevation;
  both accept `--offline`; elevation accepts `--dem-only` to omit unavailable RDR checks.
- Tests: `tests/test_pipeline.py`, `tests/test_lola.py`, `tests/test_terrain_horizon.py`, `tests/test_sites.py`, `tests/test_offline_terrain.py`.

App (`app/src/`):
- `mission.ts` (window, delay, metric logic), `horizon.ts` (profile lookup,
  mode selection, loader check, step re-classification for tests),
  `Panorama.tsx`, `Timeline.tsx`, `ElevationChart.tsx`, `App.tsx`, `data.ts`, `axis.ts`.
- Tests: `mission.test.ts`, `data.test.ts`, `horizon.test.ts`.

### Verified conventions (do not change without re-running the checks)
- **Horizons:** `CENTER='coord@301'`, `COORD_TYPE='GEODETIC'`,
  `SITE_COORD='E-lon,lat,alt_km'` = `29.1957,-84.7906,5.3229`; east-positive
  longitude; altitude above a 1737.4 km sphere; `QUANTITIES='4'`,
  `APPARENT='AIRLESS'`; azimuth clockwise from north; `TIME_TYPE='UT'` (UTC);
  targets Sun `10`, Earth `399`.
- **LOLA heights:** LSB int16, height = DN × 0.5 m relative to 1737.4 km. No
  MISSING_CONSTANT: every pixel is interpolated. LDEC counts are **unsigned**
  8-bit (labels say LSB_INTEGER, but LDEC_75S_60M has MAXIMUM = 159); 0 = no shot.
- **LOLA frame:** "MEAN EARTH/POLAR AXIS OF DE421", planetocentric latitude,
  east longitude, as Horizons MOON_ME.
- **Polar stereographic (south), as implemented in `lola.py`:**
  X = (I − N/2 − 0.5)·s, Y = −(J − N/2 − 0.5)·s; LON = atan2(X, Y);
  LAT = −90° + 2·atan(√(X²+Y²) / (2·1737400 m)); inverse
  I = X/s + N/2 + 0.5, J = −Y/s + N/2 + 0.5 (1-based, pixel centres at integers).
  From a unit vector p: X = 2R·p_y/(1 − p_z), Y = 2R·p_x/(1 − p_z) (tested equal).
  Lon 0° is up, 90° E right. Verified against LDEM_64 and 1 131 LOLA RDR shots.
  Do not use the separately printed inverse in `dsmap_polar.cat` literally.
- **Actual grid bounds:** compute from LINES × MAP_SCALE (corners reach further
  than the label's MAXIMUM_LATITUDE).
- **Observer height, nominal vs effective (traced 2026-11-14):** nominal 1 m.
  `site_elevation.py:181` rounds the bilinear LDEM_80S_20M surface
  5321.880448 m to 5321.9 m, and line 186 forms the Horizons altitude
  (5321.9 + 1) / 1000 = 5.3229 km (echoed by Horizons: `Center geodetic …
  5.3229`; |cylindric| = 1742.7228895 km, see "Echoed radius" below). `terrain_horizon.py:357` builds the
  observer radius from that same altitude, r_o = 1 742 722.9 m, and the
  terrain foot under it is the same bilinear value 5321.880448 m (the
  range-read and memory-mapped readers agree to 1e-12 m). Eye above the
  interpolated surface = 1 742 722.9 − 1 737 400 − 5321.880448 = **1.019552 m**.
  Cause: rounding only, not interpolation and not inconsistent inputs; Sun,
  Earth and skyline share one observer point. Measured effect of the extra
  0.0196 m (profile recomputed with the eye at exactly 1.000 m): skyline
  higher by ≤ 0.00338° (az 255°, set 330 m away; mean 0.0008°), 1 of 8 640 Sun
  steps changes (the 2026-12-30 sunset would be one step earlier, 01:10 instead
  of 01:20 UTC), 0 Earth steps, no demo-window metric changes. On the Sun/Earth
  directions it is ~3e-9° (scaled from the measured altitude parallax). Kept as
  a documented approximation. No absolute vertical accuracy of the surface
  value is claimed (see "Surface value: what the numbers mean" in the Observer
  altitude section), and the coordinate's accuracy is unknown.
  (`terrain_check.py`, planning only, used the unrounded surface + 1 m.)
- **Echoed radius (0.0105 m):** every one of the 12 responses echoes
  `Center cylindric: 29.1957, 158.23221, -1735.5246 km`, so |r| = 1742.7228895 km,
  10.5 mm below the terrain observer radius 1742.7229000 km. Computing Dxy and Dz
  exactly from the submitted latitude and 5.3229 km gives 158.2322069 and
  −1735.5246109 km; printed to Horizons' 5 and 4 decimals they become exactly
  the echoed values (residuals +3.1 mm and +10.9 mm, within ±5 mm and ±50 mm of
  printed precision). Cause: output rounding of the echo. The echo is therefore
  consistent with the submitted radius only to its printed precision (about
  ±5 cm on |r|); it does not show exact agreement. `Center geodetic` echoes
  5.3229 km to the digits submitted. `validate.py` now reports this difference
  and uses a 0.1 m tolerance (was 1 m).
- **Terrain horizon geometry:** ME frame; observer at r_o = 1737.4 km +
  Horizons altitude; local zenith = radial (sphere); north/east from d/dlat,
  d/dlon; azimuth clockwise from north. Great-circle ray at azimuth A; point at
  angle θ; e = atan2(r_t cos θ − r_o, r_t sin θ). Curvature counted once; no
  clamping.

### Unresolved assumptions
- The site coordinate frame is assumed to be ME. LROC states neither the frame
  nor the coordinate's accuracy, so **no coordinate uncertainty is known**.
  Four sensitivity *scenarios* (observer moved 100 m due N, E, S, W; not an
  uncertainty range or confidence interval) changed the skyline by up to 2.0°
  in one direction (median ≤ 0.06°) and, relative to the nominal point, the
  demo-window Earth-visible share by up to −4.8 pp (east scenario; baseline,
  +1 d and +3 d windows; +7 d unchanged). Other directions/distances untested.
- Regional DEM only: terrain pixels are 20 m apart (60 m beyond ~165 km), so
  features narrower than about one to two pixels, boulders, the lander itself
  and its final attitude are not resolved (the 5–10 m ray sampling interpolates
  the pixels and adds no detail). DEM-based visibility for the published point,
  not Athena's actual operating conditions.
- 974 of 3 600 skyline-setting points lie in 20 m pixels without a LOLA shot
  (interpolated heights). The laser shots near the skyline are consistent with
  the DEM, but the DEM was built from them (96–100 % predate its 2017-02-02
  data cutoff), so that is not independent validation. Shot counts are quality
  indicators, not accuracy guarantees.
- The smooth horizon is still the 0° plane (ignores the ~0.06° dip); it is
  kept only as the comparison mode.
- Horizons API signature 1.2 vs doc page 1.3; future leap seconds unknown.
- Not tested: screen readers, Firefox/Safari, touch devices, keyboard use of
  the timeline itself, keyboard hover on the panorama.

### Validation commands (expected results on 2026-11-14)
```sh
python pipeline/validate.py --site im2-athena                        # 68/68 checks passed
python -m unittest discover -s pipeline/tests      # Ran 53 tests ... OK
python pipeline/fetch.py --site im2-athena                           # "0 live request(s) made" (all cached)
python pipeline/crosscheck_metrics.py --site im2-athena              # 12-05 +0 d: sun 43.353..., dark 190.333 h
python pipeline/crosscheck_metrics.py --site im2-athena --terrain    # 12-05 +0 d: sun 27.232..., earth 67.262..., dark 244.5 h
python pipeline/compare_altitude.py --site im2-athena                # earth mean 8.041e-04 deg, sun 2.067e-06 deg
cd app && npm test                                 # 43 passed
cd app && npm run build                            # builds without errors
# terrain (needs the 3.47 GB LOLA files; fresh clone: fetch first, ~1-2 min at ~50 MB/s):
python pipeline/fetch_terrain.py --site im2-athena                   # 4 files, sizes = labels, sha256 recorded
python pipeline/fetch_terrain.py --site im2-athena --check --rehash  # OK x4
python pipeline/terrain_horizon.py --site im2-athena                 # profile 3600 az (~10 s) + sensitivity (~5 min)
python pipeline/horizon_crosscheck.py --site im2-athena              # pixel sweep max |diff| 0.0116 deg (>= 2 km); RDR; az convention
python pipeline/export.py --site im2-athena                          # "10 smooth-horizon interval(s), 10 terrain-horizon interval(s)"
# network-using milestone 1.5 checks (unchanged):
python pipeline/site_elevation.py --site im2-athena                  # DEM - shot mean -0.26 m, Horizons altitude 5.3229 km
python pipeline/terrain_check.py --site im2-athena                   # orientation OK; 30 azimuths need the 75S product
```
Order matters for terrain: `terrain_horizon.py` → `horizon_crosscheck.py` →
`export.py` → `validate.py`. `export.py` writes the terrain block only when
both reports exist and pass its consistency checks; otherwise it exports the
smooth horizon alone and the app disables Terrain with the reason.

Environment notes (Windows):
- Run `npm test`, not `npx vitest`. `app/scripts/run-vitest.mjs` works around a
  Vitest failure when the drive letter is lowercase.
- Set `PYTHONIOENCODING=utf-8` if a script fails printing Unicode to the console.
- Stopping a background `vite preview` can leave a child `node` process holding
  port 4173. Check with `netstat -ano | grep 4173`.
- `.gitattributes` marks `data/horizons/**`, `data/terrain/labels/**` and
  `data/terrain/lola_rdr/**` as `-text`. Keep it: CRLF conversion would break
  the recorded sha256 of the raw files.
- `numpy` happens to be installed globally but is deliberately **not** used:
  the pipeline stays standard-library only.

### Next steps: Milestone 4C, positions then verified terrain for CR1

These are the next commands for a separately authorized milestone, **not run
in 4B**. The first contacts Horizons; the full terrain and cross-check steps
are deliberately deferred. Initial export creates the samples needed by
sensitivity and the azimuth check. Keep Athena first and preserve its outputs.

```sh
python pipeline/fetch.py --site connecting-ridge-cr1
python pipeline/export.py --site connecting-ridge-cr1
python pipeline/validate.py --site connecting-ridge-cr1
python pipeline/terrain_horizon.py --site connecting-ridge-cr1
python pipeline/horizon_crosscheck.py --site connecting-ridge-cr1
python pipeline/export.py --site connecting-ridge-cr1
python pipeline/validate.py --site connecting-ridge-cr1
python pipeline/validate.py --site im2-athena
python pipeline/crosscheck_metrics.py --site connecting-ridge-cr1 --terrain
```

Verify the returned geodetic site and altitude rather than assuming agreement.
Review fine-ray coverage, stopping distances, null sectors, source/frame
assumptions and sensitivity before claiming a second verified terrain horizon.
No new large terrain products are required by the coarse preparation evidence;
keep the existing 75S far-field fallback, since fine-ray coverage is unverified.
The frontend remains single-site. Two-site UI is later work.

## Milestone 4B: second-site selection and cached terrain preparation (2026-11-14)

Started from verified branch `milestone-4-site-comparison`, commit `61a0a18`,
clean working tree. Completed selection/preparation only; no push or merge.

- Chose **Connecting Ridge CR1, 89.468 S, 222.6 E**, from NASA ACD-50044 Rev A,
  section 7.3.3 p.46 (same coordinate tuple in Figure 0.1 p.38). This is an
  assumed landing point in a notional study, not an actual landing or an
  operational mission destination. Only CR1 and nearby C2 were evaluated;
  CR1's clearly described hypothetical landing role, geographic contrast with
  Athena and cached raster suitability determined selection. No visibility
  prediction was used. See [SECOND_SITE.md](SECOND_SITE.md) for the source URL,
  rationale, frame assumption and unresolved accuracy questions.
- Added CR1 to config after verifying published coordinates and cached DEM
  placement/elevation. Athena's site dictionary and all other shared config
  values are identical to `61a0a18`. Source frame/latitude type and coordinate
  accuracy are not stated in the relevant passages; ME/DE421 planetocentric
  interpretation is explicit as an assumption, not fabricated source metadata.
- Actual LDEM_80S_20M pixel: sample **14654.527161**, line **15794.241002**;
  inside the 30400-square raster, with sampled edge distances **291.61-427.19 km**.
  LDEM_75S_60M also covers it, with **443.35-631.07 km** sampled edge distances.
- Coarse coverage planning: **360 rays, 1 degree azimuth, 240 m radial steps**,
  existing 10873 m height bound; stopping distances **147.84 / 215.76 / 296.16 km**
  (min/median/max), **0 sampled rays exited before stopping**, **0 required
  crossing the 80S edge**. Smallest direction-matched 80S margin **3.35 km**.
  These are diagnostics, **not a final terrain horizon**; unsampled/fine rays
  still require verification. Keep the 75S fallback. Empty seam checks are
  explicitly null (no measurement), not zero differences.
- Bilinear LDEM_80S_20M surface **1941.8205581012821 m**, rounded **1941.8 m**
  above the 1737.4 km sphere. Nominal eye **1 m**, planned altitude
  **1.9428 km**, radius **1739342.8 m**, effective eye **0.979441898718 m**
  over the unrounded DEM. The coarse planner uses the unrounded surface + 1 m;
  later full terrain and positions must share the configured rounded point.
  Altitude is planned only, **not submitted to Horizons**.
- Cached 60 m product gives **1942.985638 m** (about +1.17 m); other local
  comparisons unavailable and reported as null. Nearest 20 m count pixel has
  **0 shots**; **21.93%** of the 101-square-pixel window has zero shots.
  No local RDR consistency check or absolute vertical-accuracy estimate is
  claimed. Source coordinate uncertainty is also unknown. Ring ranges are
  terrain variation, not accuracy/uncertainty bounds.
- Minimal tool changes: `--offline` prevents HTTP; windows reuse complete local
  IMG files; `--dem-only` skips RDR checks and labels missing cached comparisons;
  the planner handles a site needing no seam checks. Existing calculations kept.

Checks observed:

```sh
python pipeline/terrain_check.py --site connecting-ridge-cr1 --offline
python pipeline/site_elevation.py --site connecting-ridge-cr1 --offline --dem-only
python -m unittest discover -s pipeline/tests
python pipeline/validate.py --site im2-athena
```

- Both preparation commands passed, including a repeat with HTTP patched to
  raise on any attempted request. Cached terrain only, no new datasets or RDR
  requests. Existing 480-point projection check repeated: RMS 30 m forward,
  2507 m mirrored. Local file sizes match labels where images are downloaded;
  other size-check results remain null rather than asserting remote checks.
- **53 pipeline tests passed**, including five new cache-only tests (signed and
  unsigned pixel windows, missing/truncated cache rejection without network,
  empty seam semantics and unchanged nonempty seam statistics).
- Surface height matches the established mmap raster reader to **1e-12 m**;
  only a point was read, no full horizon computed.
- **68/68 Athena validation checks passed**. Compared config and all existing
  tracked app/source/evidence content to `61a0a18`: unchanged. No second-site
  Horizons cache, exported JSON, full horizon or cross-check report exists.
- Frontend unchanged; no frontend build/browser rerun needed for preparation.

Exact next task: **Milestone 4C**, run the explicit CR1 commands above, inspect
its returned observer conventions and then produce a verified full terrain
horizon. Second-site frontend and deployment remain deferred.

## Milestone 4A: explicit site IDs and file isolation (2026-11-14)

Completed on `milestone-4-site-comparison` from `9e2b1b4`. Starting branch,
commit and clean tree were checked, not assumed. No push or merge.

- Added shared selection/ID validation (`sites.py`) and `--site ID` to fetch,
  terrain downloads/planning/elevation, terrain horizon/cross-check, altitude
  comparison, metric reference, export and validation. Existing Athena commands
  and metric positional arguments remain supported. Batch fetch/export/validate
  default to all configured sites; other commands require an explicit ID once
  more than one site is configured. Invalid, unknown and duplicate IDs fail clearly.
- Reports use `<site_id>_<report_kind>.json`; migrated Athena's coverage,
  elevation and altitude reports. Cross-check reports now carry site identity
  (ID, coordinates, observer height, Horizons altitude) and the exact terrain
  report SHA-256 (terrain reports are `-text` in `.gitattributes` to preserve
  that fingerprint across checkouts). The existing Athena cross-check was annotated from its known
  provenance, without recomputing it; its timestamp and calculations are preserved.
- Readers reject mismatched site files, manifest aliases/duplicates, incompatible
  coverage/dataset metadata, report identities and stale cross-check fingerprints.
  Raw Horizons reads also check site/target/query/body SHA-256 and echoed observer.
  Scoped exports prepare selected outputs and validate retained entries before
  writing; unselected site JSON bytes are preserved.
- LOLA shot caches now include the site ID and exact-query fingerprint, and
  verify cached site/query metadata. Migrated all 10 existing Athena cache sets;
  the 30 raw query/CSV/label files are byte-identical. Large LOLA rasters, labels
  and pixel windows remain shared product caches, as they contain no site choice.
- Coordinate source date/product metadata comes from each site's config rather
  than Athena's LROC product being attached to every site. No app schema change.

Checks observed:

- `python -m unittest discover -s pipeline/tests`: **48 passed**, including
  14 new tests for explicit/non-first selection, ID errors across all 10 CLIs,
  report/cache separation, same-coordinate different-ID rejection, wrong/stale
  reports, manifest aliasing, scoped-export preservation and failure before writes.
  Multi-site fixtures are synthetic; they do not select a second real site.
- `python pipeline/validate.py` and `--site im2-athena`: **68/68 passed**;
  all 17 282 exported Sun/Earth sample pairs match raw Horizons exactly.
- Default `fetch.py` and explicit Athena fetch: **0 live requests**. All 10
  migrated shot cache sets were read with network access mocked to fail.
  `fetch_terrain.py --site im2-athena --check`: **4/4 match** label sizes and
  recorded download metadata (no expensive rehash or terrain recomputation).
- Comparison against committed `9e2b1b4`: all 8 641 samples, smooth horizon,
  both visibility interval lists, terrain profile/setting points/products/checks
  and observer metadata **exactly equal** (only report/source text changed).
  All four migrated reports retain identical prior calculations/timestamps;
  the original full terrain report is unchanged.
- Independent metrics for baseline/+1/+3/+7 d in both modes: **8/8 exactly equal**
  to the starting export. Baseline terrain remains Sun 27.232142857142858%,
  Earth 67.26190476190476%, longest darkness 244.5 h; smooth remains Sun
  43.3531746031746%, Earth 55.654761904761905%, darkness 190.33333333333334 h.
  `compare_altitude.py --site im2-athena`: same 145 rows/target and all values.
- `npm test`: **43 passed**; `npm run build`: passed. No browser recheck was
  needed for this pipeline-only change; existing browser limitations still apply.

Limits/next task: config's terrain product selection and the planning/elevation
checks still target the existing south-polar LOLA product family. Site IDs do
not establish that a future point has adequate coverage; verify that first.
The frontend remains single-site, and no second site was selected/fetched.
**Next at the 4A checkpoint (completed in 4B above):** choose/cite a second
documented point and verify terrain coverage and surface elevation.

## Milestone 3: terrain horizon for the Athena site (2026-11-14)
Branch `milestone-3-terrain` from `3971fdd`; browser-reviewed and committed after the review corrections below.

### Inputs (verified before use)
product | role | grid | bytes (= label) | sha256 (first 16)
---|---|---|---|---
LDEM_80S_20M | near-field heights | 30400², 20 m/px at the pole (19.96 m at the site) | 1 848 320 000 | db44c3b2444acff1
LDEC_80S_20M | near-field shot counts | same grid, uint8 | 924 160 000 | 5601290a9c1e08ad
LDEM_75S_60M | far-field heights | 15248², 60 m/px | 465 003 008 | d6d65d69c81af393
LDEC_75S_60M | far-field shot counts | same grid, uint8 | 232 501 504 | 395daaa206fd8255

- Labels re-read: LSB int16, SCALING_FACTOR 0.5, OFFSET 1 737 400 m, MAP_SCALE
  20/60 m, frame MEAN EARTH/POLAR AXIS OF DE421, planetocentric, polar
  stereographic true at the pole, no MISSING_CONSTANT. LDEC MAXIMUM 28 (80S)
  and 159 (75S): counts are unsigned bytes.
- Coverage: the site is inside both; actual square-grid bounds were computed
  in milestone 1.5 (80S edge 165–568 km from the site, 75S ≥ 317 km).
- Downloaded by streaming (8 MB chunks, resumable with HTTP Range), sizes
  checked against the labels before rename, sha256 recorded in
  `data/raw/lola/<product>/download.meta.json`. The 26 byte ranges read in
  milestone 1.5 are byte-identical to the full files.
- Read through `mmap` + `memoryview` (no copy), so 3.5 GB never sits in memory.
  Site height through the new reader: 5 321.880 m (= milestone 2 value).

### Method
- Observer at radius 1737.4 km + 5.3229 km, the point Horizons computed the
  Sun/Earth directions for. The bilinear DEM surface there is 5 321.880 m, so
  the eye is 1.020 m above the DEM surface (the Horizons altitude used the
  surface rounded to 0.1 m).
- 3 600 great-circle rays (0.1°). Samples: 5 m steps from 5 m to 2 km, then
  10 m (≤ ¼ pixel near, ≤ ½ pixel beyond; ⅙ of a 60 m pixel in the far
  field). Bilinear height from LDEM_80S_20M wherever the 2×2 stencil fits,
  otherwise LDEM_75S_60M; neither = unknown (null).
- Elevation e = atan2(r_t cos θ − r_o, r_t sin θ): exact sphere geometry,
  curvature once, negatives kept.
- Stopping rule re-applied per ray in this calculation (the 240 m planning
  distances were not reused): stop when a point at 10 873 m (global LOLA
  maximum + 100 m) at that distance would be below the running maximum.
- Observer cell (specific handling, not a general claim): the foot is on the
  same bilinear surface that is sampled, with the eye 1.02 m above it, and the
  first sample is at 5 m, so the observer's own raster cell cannot produce a
  spurious obstruction from a foot/surface mismatch. Observed for this site: no
  azimuth's skyline is set closer than 330 m, and ignoring all terrain within
  20, 50, 100 or 300 m changes no skyline value (max |Δ| 0.000°). This says
  nothing about real ground next to the lander: relief smaller than a pixel,
  rocks and the lander are not in the DEM.
- Ray sampling vs pixel spacing: rays sample the bilinear DEM surface every
  5 m (to 2 km) and 10 m beyond; the terrain itself has 20 m pixels (19.96 m
  at the site) and 60 m in the far-field product. Sampling finer than the
  pixels only follows the interpolated surface.
- Recorded per azimuth: elevation, distance, lat/lon, height, product, pixel,
  LDEC count of the nearest pixel and of the four bilinear neighbours, stop
  distance and status.

### Result
- 3 600/3 600 rays met the stopping rule (62.0–189.9 km, median 115.9 km);
  **no unknown sectors**. Horizon −1.47° to +4.07° (median 0.82°), set by
  terrain 0.33–29.7 km away (median 12.8 km), all within LDEM_80S_20M; the
  60 m product was searched (292 rays, az 319.4°–351.5°) but never set the
  maximum. 974 setting points (27 %) lie in pixels with 0 LOLA shots.
- Cardinal directions: N −0.495° (16.3 km), E 2.909° (27.4 km), S 3.088°
  (0.62 km, local rise), W −0.607° (1.26 km).

### Checks
Synthetic tests (`tests/test_terrain_horizon.py`, 11 tests; they share the
code under test and validate behaviour, not lunar terrain):
- Smooth sphere: horizon = −arccos(R/(R+H)) within 2e-5° for H = 1 m and
  10 m at 8 azimuths (1 m: −0.0615°; counting curvature twice would give
  ≈ −0.087°); tangent distance √(2RH) within 25 m.
- Wall 100 m high, 2 km north: angle within the analytic bounds, distance
  within 35 m, latitude increases (north), other azimuths = sphere dip.
- N/E/S/W walls placed by lat/lon only: maximum within 3° of 0/90/180/270.
- 359.9°/0° seam symmetric; interpolation wraps; unknown when the ray leaves
  every raster; near/far product priority; sloped ground does not obstruct
  from the observer's cell; projection from vectors = `lola.polar_inverse`.

Sensitivity (full recomputations; angular = max |change| vs the base profile;
steps = 10-minute steps that change state over the 60 days, of 8 640;
demo = largest metric change over the four demo windows):

variant | max \|Δ\| (p99) | Sun / Earth steps | demo change
---|---|---|---
azimuth 0.05° | 0.065° (0.003°) | 0 / 0 | 0
azimuth 0.02° | 0.063° (0.003°) | 0 / 0 | 0
0.005° within ±0.3° of all 9 crossings | 0.003° | 0 / 0 | 0
radial 2.5 / 5 m | 0.017° (0.007°) | 1 / 0 | 0
radial 10 / 20 m | 0.063° (0.014°) | 0 / 0 | 0
radial 20 / 40 m | 0.091° (0.025°) | 1 / 0 | 0
first sample 20 / 50 / 100 / 300 m | 0 | 0 / 0 | 0
truncate at 10 km | 3.33° | 386 / 572 | 9.7 pp, 32.7 h
truncate at 25 km | 0.44° | 22 / 0 | 0.5 pp, 1.7 h
truncate at 50 / 100 km | 0 | 0 / 0 | 0
height bound = max of the two products (7 127 m) | 0 (stops 23–135 km) | 0 / 0 | 0
60 m product for the whole ray | 0.128° (0.093°) | 4 / 3 | 0.05 pp, 0.17 h
switch to 60 m at 5 km | 0.074° | 1 / 3 | 0.05 pp
switch to 60 m at 25 km | 0.005° | 1 / 0 | 0.05 pp
switch to 60 m at 100 km | 0 | 0 / 0 | 0
scenario: observer 100 m N | 0.40° (median 0.03°) | 17 / 13 | Earth −0.20 pp
scenario: observer 100 m E | **2.01°** at az 270° (median 0.06°) | 340 / 187 | **Earth −4.81 pp** (baseline/+1/+3 d; +7 d 0)
scenario: observer 100 m S | 0.30° (median 0.03°) | 27 / 19 | Earth +0.25 pp
scenario: observer 100 m W | 0.80° (median 0.03°) | 26 / 19 | Earth +0.25 pp

The four site-shift rows are sensitivity scenarios, not a measured coordinate
uncertainty or confidence interval. Each moves the observer 100 m along a great
circle due N/E/S/W (eye kept 1.02 m above the DEM at the new point) and is
compared with the nominal point in terrain mode. Sun share changes are ≤ 0.05 pp
(one 10-minute step) and longest darkness ≤ 10 min in all four.

- Seam (product transition): where rays leave the 20 m product, the 20 m and
  60 m heights differ by 0.006 m on average (max 20.3 m, ≤ 0.007°), and every
  seam point is ≥ 2.32° below that azimuth's skyline, so the hand-off cannot
  change the result.
- Interpretation: numerical settings are adequate (0.1° azimuth, 5/10 m
  steps). The stopping rule is conservative (50 km already gives the same
  answer). Resolution matters at the 0.1° level. **The site position matters
  most** in the scenarios: the surface 100 m N, E and W is 3.3, 2.6 and 2.4 m
  lower and 100 m S is 4.5 m higher (a slope rising to the south across a
  slight east–west crest), so nearby relief takes over in some directions.
  (Corrected in review: an earlier draft called the site "a small local high"
  with all four points lower; the south point is higher.)

Checks by other routes (`horizon_crosscheck.py`). Only the pixel sweep is an
independent *implementation*; none of them is independent *terrain data*:
- Pixel sweep (different algorithm and separately written geometry, same DEM: every
  pixel centre in 1° wedges to 200 km as 3D vectors, local frame from
  numerical derivatives, no great circles, no θ formula, no interpolation), 14
  wedges (N/E/S/W, all 9 crossing azimuths, max and min skyline), 56 bins of
  0.25°, compared with 0.01° ray-march rays: **max |Δ| 0.0116° where the skyline
  is set ≥ 2 km away**. Where it is set at 0.3–0.7 km (az 180°, 257.5°), the
  pixel sweep is up to 0.24° lower, because a 0.25° bin is only metres wide
  there and holds few pixel centres. Same-direction check: a ray at the exact
  azimuth of the highest pixel reaches that pixel's elevation to within
  −0.006° (the change over half a 5 m step) in all 56 bins.
- LOLA RDR laser shots: a **consistency check, not independent validation**.
  The LDEM was gridded from LOLA RDR shots through 2017-02-02, and 96–100 % of
  the shots in each box predate that cutoff (only 3–25 per box are later).
  Shots within ±250 m of the skyline-setting point, positioned from their own
  lat/lon/radius, ±0.1° azimuth window. Agreement shows the gridded surface, our
  reading of it and the ray geometry are consistent with the measurements it
  came from; it cannot reveal errors shared by the shots and the DEM, and few
  shots in a window give only a lower bound:

  azimuth | shots in window | highest shot − DEM skyline | DEM − shot height (box)
  ---|---|---|---
  0° | 83 | +0.0016° | −0.29 m
  90° | 139 | +0.0015° | −0.28 m
  78.2° (sunrise) | 103 | −0.0003° | −0.27 m
  332.5° (Earth) | 74 | +0.0018° | −0.26 m
  337.2° (Earth) | 63 | −0.0049° | −0.29 m
  180° (set at 0.62 km) | 4 | −0.16° (too few shots) | −0.12 m
  270° (1.26 km) | 4 | +0.020° | −0.23 m
  257.5° (sunset, 0.33 km) | 2 | −0.073° (too few shots) | −0.18 m
- Azimuth convention vs Horizons (**sanity check only**): the ME +X axis (mean
  Earth direction) seen from the site in the local frame is at az 330.70°; the
  mean Horizons Earth azimuth over the 60 days is 331.12° (Δ 0.42°). A
  counter-clockwise convention would give 29.30°. Limitations: libration moves
  Earth by several degrees, so a 60-day mean need not equal +X; only one
  direction is tested; the elevation differs by ~1° (4.55° vs 3.59°; parallax
  and residual libration, not analysed). It rules out mirrored or grossly
  rotated azimuths (tens of degrees), not sub-degree offsets. All four cardinal
  directions are tested separately with synthetic walls placed by lat/lon.
- Visibility: `validate.py` re-classifies the samples against the exported
  profile and gets identical intervals; the app's TypeScript re-classification
  of all 8 640 steps matches in both modes; the independent Python metric
  reference (`crosscheck_metrics.py --terrain`, own interpolation) equals the
  app's metrics to 1e-9.
- What these checks share, and therefore cannot catch: the LOLA DEM itself and
  the laser shots it was built from, the 1737.4 km reference and projection
  constants (checked separately against LDEM_64 and shots), the site coordinate
  and its assumed ME frame, the observer height, and the Horizons positions. No
  external published skyline for this site was found or used, so the terrain
  horizon is **checked, not independently validated**.

### Review corrections (2026-11-14, before commit)
Documentation and UI wording only; no implementation error was found that
changes a result, and the recomputed reports reproduce every number exactly.
- The four 100 m observer displacements (due N/E/S/W, eye kept 1.02 m above
  the DEM) are now described everywhere as **sensitivity scenarios, not a
  measured coordinate uncertainty or confidence interval**; changes are stated
  relative to the nominal point. "Up to 4.8 pp" = −4.81 pp Earth-visible share
  in the east scenario for the baseline, +1 d and +3 d demo windows (+7 d: 0).
  The app shows a one-line note under the panorama with an expandable table
  (exported as `terrain_horizon.checks.site_shift_scenarios`). No band drawn.
- Corrected a factual error in this file: the site is not "a small local
  high"; the point 100 m S is 4.5 m higher (N/E/W are 3.3/2.6/2.4 m lower).
- LOLA laser-shot comparisons (milestone 2 surface elevation and milestone 3
  skyline) are relabelled consistency checks: the LDEM was gridded from those
  shots (96–100 % predate its data cutoff). `config.json`'s
  `surface_elevation_reference` text changed accordingly.
- "Its own cell cannot obstruct" is replaced by the specific handling (foot on
  the sampled bilinear surface, eye 1.02 m, first sample 5 m) and the observed
  result (nearest skyline 330 m; ignoring terrain within 20–300 m: 0.000°),
  with the caveat that sub-pixel relief, rocks and the lander are not modeled.
- The mean-Earth azimuth comparison is described as a sanity check for gross
  errors only, with its limitations (libration, one direction, elevation not
  analysed).
- Terrain pixel spacing (20 m / 60 m; 19.96 m at the site) is now distinguished
  from the ray sampling distance (5 m / 10 m) in the app, export
  (`horizon.resolution.note`) and docs.

### Effect on the demonstration scenario
Terrain neither uniformly improves nor worsens visibility here. The Sun is
blocked by the 2–3° eastern skyline at sunrise; Earth (az ~320–350°) sits over
a **negative** northern skyline (−0.9 to −1.4°), so it stays visible below 0°.

window (14 d from) | Sun % smooth → terrain | Earth % | Both % | longest darkness
---|---|---|---|---
baseline 12-05 | 43.4 → 27.2 | 55.7 → 67.3 | 43.4 → 27.2 | 190.3 → 244.5 h ⚠ start
+1 d 12-06 | 50.5 → 34.4 | 62.8 → 74.4 | 50.5 → 34.4 | 166.3 → 220.5 h ⚠
+3 d 12-08 | 64.8 → 48.7 | 77.1 → 88.7 | 64.8 → 48.7 | 118.3 → 172.5 h ⚠
+7 d 12-12 | 93.4 → 77.2 | 100 → 100 | 93.4 → 77.2 | 22.3 → 76.5 h ⚠

The +3 d slip still gains +21.4 pp of Sun in both models, but terrain moves
first sunlight from 12-12 22:20 to **12-15 04:30** (+54 h 10 min).

event | smooth | terrain | shift
---|---|---|---
Earth lost | 12-03 09:50 | 12-04 08:30 | +22 h 40 min
Earth regained | 12-11 05:00 | 12-09 14:00 | −39 h
Sunrise | 12-12 22:20 | 12-15 04:30 | +54 h 10 min
Sunset | 12-29 23:40 | 12-30 01:20 | +1 h 40 min
Earth lost | 12-30 10:50 | 12-31 07:20 | +20 h 30 min
Earth regained | 01-07 08:50 | 01-05 21:00 | −35 h 50 min
Sunrise | 01-12 01:50 | 01-14 00:10 | +46 h 20 min
Earth lost | 01-26 15:30 | 01-27 10:50 | +19 h 20 min
Sunset | 01-27 22:20 | 01-28 03:00 | +4 h 40 min

Over the 60 days: Sun visible 789.8 h → 695.7 h; Earth 982.3 h → 1 119.7 h.
Times are 10-minute midpoint estimates for the published coordinate.

### App changes
- Horizon model selector (Smooth (0°) / Terrain (LOLA)); default Terrain; the
  choice is in the URL (`horizon=`). Switching recomputes intervals, metrics,
  timeline, readouts and "next change"; arrival, delay, duration and the
  selected time are untouched (browser-checked).
- Horizon panorama: azimuth (S–W–N–E–S, north centred) × elevation, terrain
  silhouette, 0° comparison line, faint Sun/Earth tracks through the plotted
  windows, markers at the cursor time. Hidden bodies are drawn hollow and
  dashed with "hidden by terrain −x°"; bodies outside the view get an arrow and
  their value. Unknown sectors would be hatched. Hover gives azimuth, skyline
  elevation, setting distance, product and shot count. A text summary below it
  repeats the marker states (also `aria-label`).
- Elevation chart: in terrain mode, a dashed "skyline under the Sun/Earth"
  line in each body's color; readouts show "Skyline there".
- "About this horizon" panel: source, observer height, resolution, search
  extent, skyline range, data density, limits; method/sources/limitations
  updated; banner explains regional DEM-based visibility.
- Usability: "Latest arrival without delay"; unsupported delays stay visible
  and disabled (with a reason); darkness warnings are one line with the
  boundary details in an expandable section.
- If the terrain block is missing or fails the loader check, Terrain is
  disabled with the reason and the smooth workflow is unchanged.

## Milestone 2 state (2026-11-14)
Milestone 2 is complete and verified locally: a smooth-horizon mission-window
workflow for the IM-2 Athena site, using 60 days of real JPL Horizons data.

- Milestone 1: commit `171b561`. Milestone 2: commit `ab4229c`, merged to
  `main` as `7c45625` (PR #1).
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
Terrain changes all of these; see "Effect on the demonstration scenario"
under Milestone 3.

## Observer altitude (verified 2026-11-14)
Evidence: `data/terrain/im2-athena_site_elevation_report.json` (`python pipeline/site_elevation.py`).

Two different quantities:
- **Surface elevation** = height of the modeled lunar surface above the
  1737.4 km reference sphere = **5 321.9 m** (LOLA LDEM_80S_20M, bilinear at
  the site).
- **Observer height above surface** = **1 m** (documented choice).
- Horizons altitude = (5 321.9 + 1) m = **5.3229 km above the 1737.4 km sphere**.

Checks:
- Scaling and reference: height = DN × 0.5 m relative to 1737.4 km (label).
  Checked for consistency against **1 131 individual LOLA RDR laser shots** (PDS
  ODE GDS, valid shots only) within ~600 m. Each shot gives radius from the
  Moon's center in km, with no scaling. DEM − shot: mean **−0.26 m**, sd
  0.67 m, max 4.71 m.
- These shots are the data the LDEM was gridded from, so this is a
  consistency check of our product reading (scaling, reference, orientation,
  pixel selection, interpolation), not an independent check of the terrain.
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
  the coordinate's accuracy.
- Surface value, what the numbers mean (corrected 2026-11-14; an earlier
  version claimed "good to ~1 m" and "~±5 m" without a source): **no absolute
  vertical accuracy is claimed.** The DEM − shot residuals (mean −0.26 m,
  sd 0.67 m, max 4.71 m) are agreement with the DEM's own source data, and the
  8 shots within 30 m spanning 5 321.75–5 322.69 m (0.94 m) are local spread;
  neither is an accuracy. The −4.4…+4.6 m within 100 m is a height range
  around the stated coordinate, not an uncertainty, because the coordinate's
  accuracy is unknown. A published LOLA/LDEM vertical accuracy has not been
  checked here.
- Rounding: the surface is rounded to 0.1 m before forming the altitude, so the
  submitted point is 1.0196 m above the interpolated surface (nominal 1 m);
  traced and measured in "Start here → Verified conventions".
- Horizons convention: GEODETIC altitude is height above the reference body;
  for the Moon that is a 1737.4 km sphere (header `Center radii`). In all 12
  responses: echoed `Center geodetic … 5.3229`, and |`Center cylindric`| =
  1742.7228895 km, which equals 1737.4 + 5.3229 = 1742.7229 km to within the
  echo's printed precision (difference 10.5 mm; see "Echoed radius").

Measured effect of the correction (2026-12-01, 145 samples, 0 km vs 5.3229 km;
`data/horizons/im2-athena_altitude_comparison.json`):
- Earth: angular change 7.99–8.09 × 10⁻⁴° (mean 8.04 × 10⁻⁴°), all in elevation
  (lower). This matches the parallax h·cos(el)/d at ~379 000 km.
- Sun: 2.07 × 10⁻⁶°. Azimuth changes ≤ 4 × 10⁻¹⁰°.
- At 10-minute resolution this does not change any visibility state by itself.
- The 0 km responses are kept in `data/horizons/` for this comparison.

## Decisions
Milestone 3:
- **Full downloads, not windows:** the four products are downloaded whole
  (3.47 GB, ~1–2 min) and memory-mapped, so the stopping rule can run as far as
  it needs without a pre-chosen window. Range-read windows remain in `lola.py`.
- **Standard library only:** pure-Python ray march with `mmap` and
  `ProcessPoolExecutor` (3 600 rays in ~10 s on 8 cores); numpy not used.
- **Resolution:** 0.1° azimuth; 5 m steps to 2 km, then 10 m. Chosen first,
  then confirmed by the sensitivity runs (finer settings change ≤ 2 of 8 640 steps).
- **Height bound:** the global LOLA maximum + 100 m (10 873 m) is kept as
  the stopping-rule bound even though the regional maximum (7 127 m) gives
  identical results with shorter searches; the global value needs no
  per-product assumption.
- **Observer:** the Horizons altitude point (eye 1.02 m above the bilinear DEM
  surface), so terrain and Sun/Earth elevations refer to the same point and
  the same local horizontal plane.
- **App default:** Terrain when its block passes the loader check; Smooth is
  kept as the comparison mode. The top-level smooth horizon/intervals in the
  data file are unchanged for compatibility.
- **Panorama:** north-centred (S–W–N–E–S), so Earth (az ~320–350°) is not split
  at the edge; fixed vertical range per dataset so it does not jump with time.

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
Evidence: `data/terrain/im2-athena_lola_coverage_report.json` (`python pipeline/terrain_check.py`).

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
2026-11-14 | Horizons altitude convention | 12 responses | echo 5.3229; \|cylindric\| ≈ 1737.4 + alt | 12/12: 1742.7228895 km, 10.5 mm below, within printed precision (±~50 mm) | pass
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
2026-11-14 | LOLA downloads (M3) | LDEM/LDEC 80S_20M, 75S_60M | size = label; stable sha256; earlier range reads identical | 4/4 sizes match; sha256 recorded; 26/26 cached windows byte-identical | pass
2026-11-14 | Terrain geometry, synthetic (M3) | 11 unit tests | sphere dip analytic; wall angle/distance; N/E/S/W; seam; unknown; product priority; observer cell | sphere dip within 2e-5°; all pass | pass
2026-11-14 | Terrain profile (M3) | 3 600 rays, 0.1° | stopping rule met; no unknown; negatives kept | 3 600 stopped (62–190 km); −1.47…4.07°; 0 unknown | pass
2026-11-14 | Terrain sensitivity (M3) | 19 full variants | numerical choices small vs. 10-min metrics | az/radial ≤ 0.09° and ≤ 2 steps; 50 km truncation identical; 100 m site-shift scenarios up to 2.0° / −4.8 pp Earth vs nominal | pass (scenarios reported, not an uncertainty)
2026-11-14 | Product seam (M3) | 292 rays crossing 80S edge | step small, far below skyline | ≤ 0.007°; ≥ 2.32° below skyline | pass
2026-11-14 | Pixel sweep, independent implementation, same DEM (M3) | 14 wedges, 56 bins | agree with ray march | ≤ 0.0116° where set ≥ 2 km; near-field bins explained (same-direction ≥ −0.006°) | pass
2026-11-14 | LOLA RDR shots at skyline, consistency (DEM source data) (M3) | 8 azimuths, ±250 m boxes | highest shot ≈ DEM skyline | 5 dense directions within 0.005°; sparse (2–4 shots) directions are lower bounds | pass
2026-11-14 | Azimuth convention, sanity check (M3) | ME +X vs Horizons 60-day mean Earth | agree within libration (gross errors only) | 330.70° vs 331.12° (mirrored 29.30°) | pass
2026-11-14 | `validate.py` (M3) | export incl. terrain | contract + re-classification | **66/66** (16 new terrain checks) | pass
2026-11-14 | Terrain metrics cross-check (M3) | demo windows | app = independent Python | equal to 1e-9 (27.232 %, 67.262 %, 244.5 h) | pass
2026-11-14 | Frontend tests (M3) | vitest | pass | 43 passed (11 new) | pass
2026-11-14 | Production build (M3) | `npm run build` | no errors | JS 270 kB (84 kB gzip), CSS 16 kB | pass
2026-11-14 | Browser checks (M3) | headless Chrome, DevTools protocol | 34 checks: terrain default, metrics both modes, scenario preserved on switch and back, hidden Sun drawn, Earth visible below 0°, slider/timeline drive the panorama, hover tooltip, usability items, labels inside the plot, no overflow at 1280/390 px light/dark, no console errors | **34/34** | pass
2026-11-14 | Review corrections (M3) | wording/metadata only; recomputed reports | numbers unchanged | `terrain_horizon.py` + `horizon_crosscheck.py` re-run: every ray, sensitivity value, bin and shot row identical (only timestamps, run time, text); export: samples, both horizons, setting points and intervals identical; 66/66, 34 pipeline tests, 43 vitest, build OK | pass
2026-11-14 | Browser checks after review (M3) | headless Chrome | 34 earlier checks + site-shift note (scenarios wording, 4 rows, collapsed, hidden in Smooth) + facts wording (pixels vs sampling, shot consistency, gross-error azimuth check) | **37/37** | pass

Not yet checked: screen readers, Firefox/Safari, real touch hardware,
keyboard-only use of the timeline (the slider is keyboard-accessible; the
timeline itself is pointer-only).

## Unresolved issues and assumptions
- Site coordinate frame assumed ME; LROC does not state the frame or the
  coordinate's accuracy. Terrain within 100 m spans −4.4…+4.6 m (a height range,
  not an uncertainty). No absolute vertical accuracy of the surface is claimed.
- Centimetre-scale approximations kept by decision (no re-fetch): the
  submitted point is 1.0196 m above the interpolated surface (0.1 m rounding),
  and the echoed radius is 10.5 mm below the computed one (echo print
  precision). Both are documented in "Start here → Verified conventions".
- Terrain horizon (milestone 3) is regional DEM-based visibility for the
  published coordinate. In 100 m site-shift scenarios (N/E/S/W) the skyline
  changed by up to 2° in one direction; the coordinate's real accuracy is
  unknown. Features narrower than about one to two pixels (20 m; 60 m far
  field), rocks and the lander are not resolved.
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
- Resolved in milestone 3: the stopping rule is re-applied per ray (62–190 km;
  50 km would already suffice); the LOLA products are downloaded and verified
  (3.47 GB, git-ignored).
- `data/terrain/im2-athena_terrain_horizon.json` is 1.3 MB (every ray, full
  precision) and the RDR caches add ~1.8 MB; `app/public/data/im2-athena.json`
  grew to 1.7 MB with the terrain block.
- Windows only: Vitest needs `app/scripts/run-vitest.mjs` (drive-letter case).

## Backlog (not in this milestone)
- Curated list of documented sites (second site, then more), each with a
  cited coordinate source and verified surface elevation.
- Custom user-entered coordinates (requires live or precomputed positions and
  terrain; conflicts with the static-data architecture, design first).
- Keyboard interaction for the timeline itself.

## Next milestone
Milestone 4C: CR1 sky positions and full terrain validation, using the explicit
commands in Start here. Milestones 4A and 4B are complete; the second site is
configured but not fetched/exported/integrated. Frontend comparison follows later.

## Milestone checklist
- [x] Shared data contract accepted (v1.0 + clarifications).
- [x] One site with real sky positions.
- [x] Complete smooth-horizon workflow.
- [x] Terrain loaded and inspected (4 LOLA products downloaded, sizes = labels, sha256 recorded).
- [x] First terrain horizon checked (synthetic tests, sensitivity, independently implemented pixel sweep, LOLA-shot consistency); reviewed in the browser 2026-11-14.
- [x] Milestone 4A: explicit site selection and pipeline file isolation.
- [x] Milestone 4B: second point cited, cached coverage planned, surface/observer altitude documented.
- [ ] Second site integrated.
- [x] Date-slip comparison verified (smooth horizon).
- [ ] Sources and limitations complete (terrain sources/limits added; second site pending).
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
  `data/terrain/lola_rdr/`, `data/terrain/im2-athena_site_elevation_report.json`);
  60-day chunked retrieval with retries (`pipeline/horizons.py`, `fetch.py`,
  `export.py`, `validate.py`); altitude comparison (`compare_altitude.py`);
  independent metric reference (`crosscheck_metrics.py`); mission-window UI
  (`app/src/mission.ts`, `axis.ts`, `Timeline.tsx`, `ElevationChart.tsx`,
  `App.tsx`, `styles.css`) and tests; docs | Human verification: **pending**,
  see the manual checklist in the milestone report.

- 2026-11-14 | Claude Code (Claude Opus 5.5) | Milestone 3: terrain horizon
  (`pipeline/lola.py` streaming download, `fetch_terrain.py`,
  `terrain_horizon.py`, `terrain_sensitivity.py`, `horizon_crosscheck.py`,
  `export.py`, `validate.py`, `visibility.py`, `crosscheck_metrics.py`, tests),
  app (`horizon.ts`, `Panorama.tsx`, `ElevationChart.tsx`, `App.tsx`,
  `data.ts`, `mission.ts`, `types.ts`, `styles.css`, `horizon.test.ts`), docs |
  Human verification: **pending** (not committed; see milestone report).

- 2026-11-14 | OpenAI Codex | Milestone 4A: site IDs, report/export/cache isolation,
  focused synthetic tests and Athena regression verification | pipeline/,
  renamed/annotated cached evidence, README.md, docs | Human verification: **pending**.

- 2026-11-14 | OpenAI Codex | Milestone 4B: two-candidate source review,
  NASA CR1 selection, cached coarse coverage/surface elevation, offline tool
  support and five focused tests | pipeline/, new CR1 preparation reports,
  docs/SECOND_SITE.md, SPEC.md, STATUS.md, README.md | Human verification: **pending**.

## Handoff template
- Completed:
- Files changed:
- Checks run and results:
- Remaining uncertainty:
- Next task:
