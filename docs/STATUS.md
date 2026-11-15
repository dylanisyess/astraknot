# Project Status

Update after each completed milestone or important decision.
Record observed results, not assumed progress.

Owner: Dylan (sole developer; all frontend, pipeline, and data work).

## Start here (handoff for a new session, updated 2026-11-14 after milestone 5B)
Read this section first, then `docs/SPEC.md`, `docs/DATA_CONTRACT.md` and
`docs/SCIENCE_REVIEW.md`. The rest of this file is the detailed record behind it.

**Git snapshot (2026-11-14, 5A–5B closeout):**
- `main` = `origin/main` = `c5e8432` ("Merge pull request #3 from
  dylanisyess/science-review-followup"). The science-review follow-up is
  committed (`ca385fc`), pushed and merged. Verified at the start of 5A.
- **Milestone 5A (first working 3D Explore)** was developed on branch
  `milestone-5a-explore` (from `c5e8432`). See "Milestone 5A" below.
- **Milestone 5B (power/comms framing, profile-based observer-view occlusion,
  four-state timeline, guided crossings, then the completion pass: Sun/Earth
  markers in both views, scene-first layout, outside-mission navigation,
  shareable mission/camera state)** is on the same branch on top of 5A. See
  "Milestone 5B" and "5B completion" below.
- **Closeout:** 5A–5B are committed as one checkpoint on
  `milestone-5a-explore` and published through a PR to `main` with the
  established merge-commit workflow; 5C work starts on
  `milestone-5c-terrain-screening` from the merged `main`. This snapshot
  records the reviewed state at commit time, not the merge result: verify
  live Git/PR state before continuing.
- Older local branches are historical.

**Primary user experience: Explore (3D, default view).** A 3D view of the
real LOLA terrain around the fixed modeled observer. The two-site dashboard is
**Analysis**; both share one scenario and URL (`view=explore|analysis`). Every
visibility word in both comes from `selectedTimeStatus` (`app/src/status.ts`).
The rendering meshes are separate assets (`pipeline/render_assets.py`), not
scientific data; no export, interval or horizon changed.

**Previous milestone (science-review follow-up, now merged in PR #3):** post-review cleanup,
details in "Science-review follow-up" below. No terrain model change, no
Horizons fetch, no terrain recomputation.
- Review evidence is in the repo (`pipeline/review/`,
  `pipeline/direction_check.py`, `docs/SCIENCE_REVIEW.md`).
- Two-site Sun-direction test (0.001°) and cardinal-direction tests.
- A shared selected-time status API (`app/src/status.ts`) now feeds the cards,
  readouts and panorama. "Near estimated crossing" appears where the step
  state and the instantaneous center disagree (17 cases over both sites and
  models).
- Center-based and 10-minute wording.
- Dataset renamed `lvn-2026-12-01-60d`.
- Checks:
  - Python: 68 tests; validation 136/136.
  - Frontend: 140 vitest tests and the production build (completion review).
  - Browser: 29/29 headless-Chrome checks in the original follow-up;
    not rerun during completion review.
  - Separate ChatGPT development-app browser smoke check: passed, as
    reported by the user; see the closeout record below. Not run by Codex.
  - Site files and terrain evidence match `978f22a` byte for byte under Git's
    checkout filters; mission metrics are unchanged. See the completion
    review below for the CRLF/LF distinction.

**Two-site comparison interface (4D; merged in PR #2):** on top of `ca0c996`. It loads Athena and CR1
from the manifest with strict identity checks and uses one shared scenario:
arrival, duration, delay, horizon model and UTC time. It shows per-site cards
with baseline-to-delay changes, both timelines on one UTC axis, an active-site
selector for the panorama/readouts/chart, a projected locator, and per-site
sources and limitations. CR1 is labelled "Connecting Ridge CR1 — NASA notional
study point" and marked "Provisional: sensitive to terrain model" next to its
metrics in Terrain mode, with the 5 m assessment as a read-only summary. Checks:
90 vitest tests, production build, and **42/42 headless-Chrome checks** at the time. See "Milestone 4D: two-site
comparison interface" below, including the **browser review checklist** (a
person has not yet ticked it).

**Earlier:** 4C is `627a4cc` ("feat: add provisional CR1 dataset and
sensitivity evidence"). The follow-up **CR1 terrain-product assessment**
(5 m PGDA Site01 vs 20 m LDEM) is `ca0c996` (recommendation accepted). Both are
now pushed and merged via PR #2.
See "CR1 terrain-product assessment" below. **Recommendation: retain CR1
terrain as provisional.** The 5 m product is documented, numerically converged,
and best-fits the 20 m map at zero shift among the tested shifts.
But it shifts results by about as much as its own documented error, and 100 m
position changes are ten times larger. No exported data changed; no Horizons
re-fetch was needed, because no new surface elevation was adopted.

**Milestone 4C checkpoint:** completed on `milestone-4-site-comparison` (now merged),
starting from verified `94cf13f` with a clean tree. `connecting-ridge-cr1` (NASA notional study point, 89.468 S,
222.6 E; [SECOND_SITE.md](SECOND_SITE.md)) now has real 60-day Horizons
positions (12 sequential live requests at 1.9428 km, raw responses cached), a
full 0.1° terrain horizon with sensitivity, cross-checks and an exported
`app/public/data/connecting-ridge-cr1.json` (smooth + terrain). Validation
68/68 for each site (136/136 batch). Athena's outputs are byte-identical.
**Key finding:** CR1's terrain skyline is set entirely by DEM relief
50–480 m from the point (median 90 m), while the Sun's center stays only
0.07–1.98° above the horizontal plane. The terrain result is implementation-
checked and numerically converged, but **not robust**. Ignoring terrain within
300 m, using the 60 m DEM, or moving the observer 100 m each flips thousands of
the 8 640 Sun steps. Treat CR1 terrain percentages as highly position- and
resolution-dependent; see "Milestone 4C" below. The manifest lists both sites
(Athena first). Unscoped batch commands now cover both prepared sites.

### What works (verified)
- **Data:** 60 days of real JPL Horizons Sun/Earth airless apparent az/el of
  body centers at 10 min (2026-12-01T00:00Z to 2027-01-30T00:00Z, 8 641
  samples incl. final endpoint), for **both sites**: the IM-2 Athena site
  84.7906° S, 29.1957° E (observer 5.3229 km above the 1737.4 km sphere =
  LOLA surface 5 321.9 m + 1 m) and CR1 (1.9428 km; see below). Raw responses
  with query, headers and sha256 are in `data/horizons/`. Dataset ID
  `lvn-2026-12-01-60d` (site-neutral since the science-review follow-up).
- **Terrain horizon (milestone 3):** 0.1° profile from LOLA LDEM_80S_20M
  (+ LDEM_75S_60M beyond its edge), exact sphere geometry, per-ray stopping
  rule, no unknown sectors. Synthetic geometry tests and sensitivity runs pass;
  an independently implemented pixel sweep on the same DEM agrees; the DEM's
  own source laser shots are consistent with the skyline (see "Milestone 3"
  below). Exported next to the unchanged smooth horizon.
- **App** (`app/`, React 19 + TS 7 + Vite 8), **two-site comparison (4D, merged in PR #2):**
  - One shared scenario: Smooth / Terrain for all sites (default Terrain),
    baseline arrival + duration, and +1/+3/+7 d slips relative to the baseline.
  - A comparison card per site with baseline / delay / "Change: +N d vs baseline".
  - Both sites' Sun/Earth/both timelines on one UTC axis.
  - A site selector for the readouts, **horizon panorama** (centred per site)
    and elevation chart.
  - A projected south-polar locator, and per-site sources and limitations.
  - Carried over: one shared cursor, boundary flags, unknown handling.
  - URL state: `arrival, days, delay, t, horizon, sites, site`. Older Athena links still work.
  - **Selected-time status (science-review follow-up, uncommitted):** one function
    (`app/src/status.ts`, `selectedTimeStatus`) gives each body's step state
    (exported intervals, unchanged) and its instantaneous center clearance. It
    feeds the cards, readouts and panorama labels, and is meant for 3D Explore.
    When the two disagree, every place shows the same "Near estimated
    crossing" explanation.
- **Second site data (milestone 4C):** CR1 60 days of real Horizons Sun/Earth
  positions (8 641 samples, same coverage/step/conventions as Athena), smooth and
  terrain horizons, intervals, sources and checks in
  `app/public/data/connecting-ridge-cr1.json`; shown in the app since 4D.

### Key files
Pipeline (`pipeline/`, Python standard library only; run from the repo root):
- `connecting-ridge-cr1` evidence: `data/terrain/connecting-ridge-cr1_{site_selection,lola_coverage_report,site_elevation_report}.json`
  (4B preparation) and `_{terrain_horizon,horizon_crosscheck,observer_rounding_check}.json` (4C).
- `observer_rounding_check.py` (4C): recomputes a site's profile with the eye at
  exactly the nominal height and reports skyline/step/demo-metric changes.
- `pgda.py` (assessment): GSFC PGDA 5 m GeoTIFF download (sequential, resumable,
  size = Content-Length, sha256) into git-ignored `data/raw/pgda/`, a stdlib
  GeoTIFF reader, and `PGDA_*` rasters for the ray march (`terrain_horizon.Raster.from_files`
  dispatches on the name prefix; PDS products unchanged).
- `terrain_5m.py` (assessment) → `data/terrain/connecting-ridge-cr1_terrain_5m_assessment.json`.
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
- Tests: `tests/test_pipeline.py`, `tests/test_lola.py`, `tests/test_terrain_horizon.py`, `tests/test_sites.py`, `tests/test_offline_terrain.py`, `tests/test_pgda.py`, `tests/test_conventions.py`.

App (`app/src/`):
- `mission.ts` (window, delay, metric logic), `horizon.ts` (profile lookup,
  loader check, step re-classification for tests), `data.ts` (multi-site loader,
  `checkSites` identity checks), `sites.ts` (per-site profiles, strict
  one-model-for-all rules, data-derived facts, locator projection),
  `assessment.ts` (CR1 5 m summary), `urlState.ts`, `Panorama.tsx` (`centerAz`),
  `Timeline.tsx` (multi-site tracks), `ElevationChart.tsx`, `App.tsx`, `axis.ts`,
  `status.ts` (shared selected-time status; the only source of "visible at time t").
- Tests: `mission.test.ts`, `data.test.ts`, `horizon.test.ts`, `sites.test.ts`,
  `assessment.test.ts`, `urlState.test.ts`, `status.test.ts`, `app.test.tsx` (server-rendered `Workspace`).

Review evidence (science-review follow-up): `pipeline/direction_check.py`
(two-site Sun-direction check), `pipeline/tests/test_conventions.py`, and
`pipeline/review/{spot_checks,design_numbers,_dem}.py` (independent spot
checks; need the 1.85 GB LDEM_80S_20M raster). See `docs/SCIENCE_REVIEW.md`.

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
  5.3229 km to the digits submitted.
- **CR1 echo (4C):** all 12 responses echo `Center geodetic 222.6, -89.468,
  1.9428` exactly and `Center cylindric 222.6, 16.14983, -1739.268 km`. Near the
  pole Dz is printed with only **3** decimals, so |r| as printed is 177 mm above
  1737.4 + 1.9428 km, while the exact Dxy/Dz (16.1498296, −1739.2678227 km) round to
  exactly the printed digits (residuals +0.4 / −177.3 mm). The echo confirms the
  radius only to ±0.5 m there. `validate.py`'s check (changed in 4C) now
  recomputes Dxy/Dz from the submitted lat/alt and requires equality at the
  echo's printed decimals. The former fixed 0.1 m |r| tolerance would have
  failed CR1 for a print-precision reason. Athena still passes (stricter test).
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
- **CR1 (4C):** frame ME/DE421 planetocentric is assumed (source silent);
  coordinate accuracy unknown. The skyline is set within 50–480 m by a DEM whose
  nearest pixel to the point has no LOLA shot (881 of 3 600 setting points sit in
  zero-shot pixels). Ignoring terrain within 300 m changes it up to 4.05°.
  The 60 m product changes it up to 2.72°, and the 100 m scenarios up to 4.15°.
  Those scenarios change the demo Sun share by up to +42.2 pp and the longest
  darkness by up to −141.7 h. They are scenarios, not an uncertainty. Eye
  rounding (0.979 m vs 1 m) moves the skyline by ≤ 0.024° and flips 13 Sun /
  3 Earth steps (≤ 0.25 pp, ≤ 0.83 h). No independent terrain data or published
  skyline for CR1 was used.
- (Resolved in the science-review follow-up) `manifest.dataset_id` was the
  Athena-named `m2-athena-2026-12-01-60d`; it is now `lvn-2026-12-01-60d`
  after a full two-site re-export with byte-identical site files.
- Visibility is center-based for both bodies. With nominal radii in terrain
  mode, Earth's center is hidden while part of its disk clears the skyline in
  about 15 % of steps at Athena; for the Sun at CR1 this is about 6 %. Stated in
  the app's limitations since the follow-up.
- Horizons API signature 1.2 vs doc page 1.3; future leap seconds unknown.
- Not tested: screen readers, Firefox/Safari, touch devices, keyboard use of
  the timeline itself, keyboard hover on the panorama.

### Validation commands (expected results on 2026-11-14)
```sh
python pipeline/direction_check.py                                   # Sun max 0.000068 deg (<= 0.001); controls 26.8 deg; PASS
python pipeline/review/spot_checks.py                                # needs the LDEM_80S_20M raster; see docs/SCIENCE_REVIEW.md
python pipeline/validate.py --site im2-athena                        # 68/68 checks passed
python pipeline/validate.py --site connecting-ridge-cr1              # 68/68 checks passed
python pipeline/validate.py                                          # 136/136 (both sites)
python pipeline/fetch.py --site connecting-ridge-cr1                 # "0 live request(s) made"
python pipeline/crosscheck_metrics.py --site connecting-ridge-cr1 --terrain  # 12-05 +0 d: sun 72.123..., earth 25.446..., dark 62.833 h (touches end)
python pipeline/crosscheck_metrics.py --site connecting-ridge-cr1    # 12-05 +0 d: sun 100.0, earth 28.373..., dark 0.0 h
python pipeline/observer_rounding_check.py --site connecting-ridge-cr1  # max 0.0235 deg; sun 13, earth 3 steps
python -m unittest discover -s pipeline/tests      # Ran 76 tests ... OK (68 before milestone 5A)
python pipeline/pgda.py fetch Site01 surf ldec toterr   # 3 x ~41 MB into data/raw/pgda/site01 (~60 KB/s observed)
python pipeline/terrain_5m.py --site connecting-ridge-cr1   # ~12 min; F5_fixed vs L20: max 0.97 deg, 321 Sun steps
python pipeline/fetch.py --site im2-athena                           # "0 live request(s) made" (all cached)
python pipeline/crosscheck_metrics.py --site im2-athena              # 12-05 +0 d: sun 43.353..., dark 190.333 h
python pipeline/crosscheck_metrics.py --site im2-athena --terrain    # 12-05 +0 d: sun 27.232..., earth 67.262..., dark 244.5 h
python pipeline/compare_altitude.py --site im2-athena                # earth mean 8.041e-04 deg, sun 2.067e-06 deg
cd app && npm test                                 # 217 passed (12 files; 202 after 5B, 173 after 5A, 140 before 5A)
python pipeline/render_assets.py --site connecting-ridge-cr1        # ~10 s; mesh check vs profile max |d| 0.1076 deg (needs LDEM_80S_20M)
python pipeline/render_assets.py --site im2-athena                  # ~10 s; mesh check vs profile max |d| 0.1124 deg
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

### Next steps

0. 5A–5B closeout: one checkpoint commit and a PR to `main` (see the
   snapshot above). Next branch: `milestone-5c-terrain-screening`.
   **Bounded 5C follow-up checks (recorded, not yet performed; not verified
   bugs):**
   - Overview celestial projection during orbit, pan and zoom. Markers are
     placed at the direction's vanishing point and tested under camera
     translation; panning, zooming and orbit extremes, and the behind-camera
     edge-chip position, have not been checked systematically.
   - Explore/Analysis handling of time outside the mission windows. Explore
     views any covered time; Analysis shows the same stored time clamped to
     its windows. Review whether that interplay is clear to users.
   - Explanation for disabled delay options at the coverage boundary. Delays
     whose window would end after the data are disabled, with a tooltip and
     (when the chosen delay no longer fits) a note; check that Explore
     explains this clearly enough.
   - Before any deployment: the minified bundle drops three.js's MIT license
     comment; ship the notice (README "Third-party software").
1. Human pass over the 4D browser review checklist and a person's pass over
   Explore (headed browser, real mouse/touch, Firefox/Safari). Deployment from
   a fresh browser session is still untested.
2. Recommended next bounded milestone: user acceptance of Explore, then a
   static deployment and fresh-session check; measure load on a non-local
   network (the Athena mesh is 6.5 MB). Optional later feature: DEM-derived
   slope visualization (no hazard or landing-safety claims). No scientific
   change.
3. Still open: how to present CR1's provisional terrain result (for example
   smooth and terrain side by side, or a range across DEMs, eye heights and
   position scenarios). If CR1 terrain is later adopted from the 5 m product,
   its surface (1942.159 m) changes the observer: re-fetch Horizons at
   1.9432 km before publishing, as recorded in the assessment.
4. (Done) 5 m assessment committed; CR1 stays provisional. (Done) Two-site
   frontend merged; `dataset_id` renamed.

To regenerate CR1 from the caches (order matters; all inputs cached, no network):
`export.py` → `validate.py` → `terrain_horizon.py` (~5 min) →
`horizon_crosscheck.py` (~5 min; RDR boxes cached) → `export.py` →
`validate.py` → `observer_rounding_check.py`, all with `--site connecting-ridge-cr1`.

## Milestone 5B: power/comms framing and guided horizon exploration (2026-11-14)

Builds on the uncommitted 5A work on `milestone-5a-explore`. At the start of 5B
the 5A report was re-verified: `c5e8432`, 5A files present, protected outputs
unchanged. **Uncommitted, for review.** Frontend only:
- no Python, export, interval, horizon or render-asset change;
- no Horizons fetch;
- Analysis code unchanged.

### Observer-view occlusion (Part 1)
- **Reproduced from data.** These are mesh/profile cases, separate from the
  17 interval/instant near-crossings.
  - CR1: 9 Sun samples and 1 Earth sample have the center *above* the exported
    profile but *below* the measured mesh silhouette. Example: 2026-12-27 07:50
    UTC, Sun center +0.012° above the profile, mesh 0.008° above the center.
    CR1's +0.1° mesh excesses are at azimuths about 2.5° and 60°, where no body
    passes.
  - Athena: 10 Earth samples have the center below the profile but above the
    mesh. Example: 2026-12-04 08:40, −0.0053°.
  - In 5A the mesh could hide such a body (the positive case).
- **Treatment (stencil mask).** In the observer view the exported profile is
  drawn first as a mask of every direction at or below the skyline, down to
  nadir (`geometry.ts profileMask`).
  - The DEM mesh is drawn only inside the mask, so the displayed horizon is
    exactly the profile. Where the mesh is lower, the flat profile band shows.
  - The Sun and Earth disks are drawn only outside it, so the profile alone
    decides occlusion: the same rule `selectedTimeStatus` uses for the center.
  - Disks keep their nominal sizes and exact instantaneous positions.
  - Near a crossing the drawn center and the step's label can differ; the
    "Near estimated crossing" explanation is unchanged.
  - Smooth mode draws the disks on top. Its terrain is clipped to the profile
    and dimmed, as context only.
  - The overview shows the unclipped mesh.
  - The treatment is stated in the legend and in Details.
- Fixed on the way: a terrain *group* `renderOrder` made three.js draw every
  sky object before all terrain. Smooth-mode disks were therefore clipped by
  terrain. Order is now per mesh.
- The measured mesh/profile discrepancies are unchanged (CR1 max 0.108°,
  Athena 0.112°, "Milestone 5A" below). **The 0.05° target is still not met
  by the mesh.** The observer view no longer depends on the mesh for the
  horizon.

### Power/comms framing, timeline and crossings (Parts 2–5)
- **Status panel: two groups**, labels from `selectedTimeStatus`
  (`explore/availability.ts`):
  - *Solar-power potential*: "Direct sunlight available / blocked /
    Sunlight status unknown".
  - *Direct-to-Earth communication*: "Earth visibility window open / Earth
    below horizon / Earth visibility unknown".
  - Kept: the near-crossing pill and explanation, instantaneous clearance
    and el/az, and a "Nominal disk straddles the horizon; its center is
    above/below it" line.
  - Next-change wording.
  - The purpose sentence is in Details, verbatim as specified. No watts,
    battery or go/no-go wording.
- **Mission summary** (site panel):
  - Baseline and delay columns of `computeMetrics` results, the same
    numbers as the Analysis cards:
    - direct sunlight %;
    - Earth window %;
    - both %;
    - longest period without direct sunlight, with the existing boundary
      flags and one combined "may be longer" note.
  - Clicking a column chooses the active mission (default: delayed when a
    delay applies).
- **Four-state timeline** (time bar):
  - Exported intervals clipped with `mission.clip` over the scenario span
    (`availabilitySegments`).
  - States: Sun + Earth (split amber/blue), Sun only (amber, top half),
    Earth only (blue, bottom half), neither (charcoal).
  - Unknown and uncovered periods are hatched, never "neither".
  - The active window is outlined; the rest of the span is dimmed.
  - Playhead, click and keyboard scrubbing (range input:
    arrows/Page/Home/End).
  - Hover/focus tooltip with the interval, UTC bounds and Sun/Earth state;
    `aria-valuetext` includes the state.
  - "Outside the … mission · Jump to mission".
- **Guided crossings.**
  - Sun/Earth selector, Previous/Next, and a range of "this mission" or
    "all cached data".
  - Transitions are interval boundaries where a *known* state flips. Gaps,
    unknown sides and the data end are excluded.
  - Navigation:
    - pauses, then selects a sample 1 h (Sun) or 6 h (Earth) before the
      transition;
    - switches to the observer view and looks toward the body
      (FOV 10°/18°);
    - sets 10 min/s (Sun) or 1 h/s (Earth);
    - shows "Sun center crosses the modeled skyline near … UTC" with the
      10-minute note.
  - Events outside the shown windows are reported, not navigated.
  - Messages are tied to site and mode.
  - Reduced motion uses the existing instant-camera path; it was not
    browser-tested.
- **Layout and wording.**
  - Two-row time bar.
  - Event card above the camera bar.
  - Compact site/horizon controls.
  - Lighting wording: "Display lighting only, not sunlight."
  - Panel heights account for the time bar.
  - The narrow-layout time bar is no longer sticky (it covered the camera
    bar).

### Checks run personally (2026-11-14)
- `npm test`: **202 passed, 11 files** (173 before 5B).
  - New: `explore/availability.test.ts` (17) and 12 Explore render tests.
  - Covered:
    - four-state composition and unknown/uncovered periods;
    - clipping and half-open boundaries, with segment durations equal to
      `computeMetrics` for both sites, models and two windows;
    - transitions (unknown sides, gaps, range edges, data end, prev/next,
      none, agreement with `nextChange` on real data, 10-minute grid);
    - power/comms labels at both near-crossing cases and the final sample;
    - the purpose text, mission summary values and boundary note;
    - band states, unknown hatching, outside-mission/Jump, scrubber
      `aria-valuetext`;
    - profile mask (top edge = exported profile at both sites, nadir rows,
      unknown columns omitted) and disk relation.
  - Five 5A assertions were updated for intentionally changed wording.
- `npm run build`: passed.
- Protected outputs: all 14 sha256 unchanged, and `git diff` on data and
  config is empty. No Python changed, so the Python suite was not rerun
  (76 OK in 5A).
- **Browser.**
  - Setup: Chrome 157 **headed** (visible window) via `puppeteer-core`, ANGLE
    Intel Arc 140V D3D11, 8-bit stencil, dev server; 1440×900 unless stated.
  - Occlusion:
    - CR1 2026-12-27 07:50: the disk straddles the skyline, its center above.
      The upper half is drawn with no mesh over it; status "Direct sunlight
      available".
    - CR1 azimuth 3° (mesh +0.1°): terrain ends exactly at the profile line.
    - Athena 2026-12-04 08:40: the lower half of Earth is hidden by the
      profile band; "Earth below horizon".
    - CR1 2026-12-24 00:00: "available" plus "Near estimated crossing",
      center 0.0015° below the skyline.
    - Smooth mode: disk drawn whole over terrain (after the group-order fix).
  - Crossings:
    - Athena Sun Next: 2026-12-15 04:30 crossing; selected 03:30, observer
      view, 10 min/s.
    - Playback to 04:50: blocked became available; URL `t` written on pause.
    - Next again: "No later Sun crossing in the delay +3 d mission". Prev
      returned to the same event.
    - Earth Next: none in the mission. With all cached data: the 2026-12-31
      07:20 event reported as outside the windows.
    - CR1 at 2027-01-29 23:00: "No later … The data ends 2027-01-30 00:00 UTC;
      that is not a crossing." End key: both unknown, Play disabled.
  - Timeline:
    - Click moved the time. Arrow keys stepped and showed the focus tooltip
      (screenshot).
    - The hover tooltip text and box were read from the DOM. **No headed
      screenshot captured the hover tooltip**; the focus tooltip uses the
      same element.
    - Home went outside the mission; Jump to mission returned to the window
      start. Summary column focus worked.
  - Mission and views:
    - Delay +7 d matched Analysis. Reload and back to Explore kept the
      scenario; the active-mission choice is not in the URL.
    - Overview and observer view for both sites at 1440×900.
    - 390×844: no horizontal overflow; observer and overview for both sites.
  - Failure: WebGL disabled showed the message. Status, timeline and crossing
    navigation still worked without the renderer; Open Analysis opened the
    dashboard. No console errors except the expected WebGL-disabled messages.
- Not verified: Firefox/Safari, touch, screen readers, reduced motion in a
  browser, real-mouse observer-view drag, a hover-tooltip screenshot,
  non-local network loading.

### Remaining limitations
- The mesh still differs from the profile by up to about 0.11°; the overview
  shows that mesh.
- In the observer view, terrain detail near the skyline is the profile's
  0.1° outline, not the mesh.
- Shading is display lighting, and no shadows are computed.
- Visibility is center-based on the 10-minute grid.
- CR1 stays provisional; its frame and accuracy are assumed.
- The active-mission choice and camera mode are not in the URL.
- On narrow screens a focused scrubber's tooltip can cover the speed
  control, and the overview's Sun label can touch the right edge.
- **Next optional feature (not started):** a DEM-derived slope visualization,
  separate from any hazard or landing-safety claim.

### 5B completion: Sun/Earth in both views, scene-first layout, navigation fixes (2026-11-14)

Same branch, on top of the 5B work above; **uncommitted**. Frontend only: no
Python, export, interval, horizon or render-asset change.

**What changed**
- **Site overview body markers.**
  - Visuals: a warm Sun disk and a blue graticule globe for Earth.
  - Placement: HTML buttons at each direction's vanishing point (camera
    position + direction × 200 km), so camera translation cannot shift them
    against nearby terrain. Each sits on the screen extension of its ray from
    the fixed observer.
  - State: from `selectedTimeStatus` (`markerState`). Visible bodies are
    solid. Below-horizon bodies are dashed outlines labelled "Below observer
    horizon".
  - Off-screen bodies: an edge chip on an inset rectangle that avoids the
    side panels, toolbar and legend.
  - Click: opens Horizon view centered on the body.
  - Legend: "Body markers enlarged for orientation".
  - Removed: the floating mesh-edge label, which overlapped the observer
    label (the edge is now explained in the legend's info).
  - Composition: default overview elevation 27° → 13° with a 50° FOV.
    *Reason:* at 27° the true horizon, where every near-horizon body lies,
    was above the frame.
- **Horizon view.**
  - Kept: nominal 0.53°/1.9° disks, the profile stencil mask and Smooth mode.
  - New: a restrained limb-shaded Sun texture, and a decorative graticule on
    Earth (no geography or phase).
  - New: a center cross inside each dashed selection ring.
- **Mode names:** "Site overview" and "Horizon view". Look toward Sun/Earth,
  and a marker click, always enter Horizon view and center the body.
- **Layout.**
  - Top bar: identity, Explore/Analysis, "All times UTC". The source badge
    moved to Details.
  - Left, *Mission setup*:
    - site selector with the CR1 badge, and a disclosure for the full
      site name and coordinates;
    - horizon model;
    - arrival date/hour; duration in "days"; arrival delay;
    - a collapsible *Mission comparison* with an always-visible line for the
      active mission and a Baseline/+N d selector.
  - Right, *Conditions*:
    - the two groups (state, next change, near-crossing/unknown note);
    - "Simultaneous availability: Yes/No/Unknown";
    - a *Geometry at this time* disclosure (clearance, el/az, disk relation,
      DEM model).
  - Viewport toolbar: one compact strip at the top of the scene.
  - Legend: one line with an info popover; "Illustrative lighting" stays
    visible.
  - Time area: row 1 has playback, ±10 min, the single **Viewing time**
    readout, "Outside selected mission · Jump to mission" and speed. Row 2
    has the timeline with "Baseline arrival" and "+N d arrival" markers.
    Row 3 has the legend (or the hover/focus interval line) and the crossing
    controls.
  - The timeline hover/focus detail is now an info line in that row, so it
    cannot cover any control.
  - Narrow screens: Mission setup starts collapsed and Conditions comes
    first. Edge chips shorten and arrival labels drop their times.
- **Viewing time independent of the missions** (`scenario.ts`).
  - Explore's `sel` can be anywhere in the coverage, and `statusSel` is
    computed there.
  - Analysis keeps its established cursor clamped to its windows.
  - Arrival, duration, delay and metrics are never changed by navigation.
  - The timeline widens to include an outside viewing time
    (`timelineSpan`).
  - Playback runs to the end of the windows, or past them to the end of the
    data when started beyond them.
- **Crossing navigation** (`planCrossing`).
  - The "all cached data" range now jumps to events outside the missions.
    The event card shows "Outside selected mission".
  - Repeated Next/Previous advance between events. Anchor rule: while the
    viewing time is where the last navigation put it, the reference is that
    crossing.
  - The event card shows the live "Crossing in …" countdown, "Jump to
    crossing" and the 10-minute note.
  - Lead-ins are unchanged: 1 h for the Sun at 10 min/s, 6 h for Earth at
    1 h/s.
  - The selection is cleared when site, model, arrival, duration, delay,
    mission, body or range changes, and on Jump to mission.
  - The data end is never a crossing.
- **Shareable view state:** `mission=baseline|delayed` and
  `cam=overview|horizon` in the URL (replaceState only, not during playback).
  Old links still work.

**Checks run personally**
- `npm test`: **217 passed, 12 files** (202 before).
  - New: `explore/navigation.test.ts`.
  - Updated: Explore render and URL tests.
  - Covered:
    - repeated Next/Previous; the stale-anchor rule;
    - mission-range lead clamp; real-data all-range navigation;
    - the data end;
    - countdown text; marker states (visible/below/unknown/near-crossing);
    - edge-point geometry;
    - a three.js check that the marker NDC is unchanged under camera
      translation and equals the ray's vanishing point;
    - URL `mission`/`cam`;
    - outside-window viewing time (Explore shows it, Analysis clamps,
      metrics unchanged);
    - "Simultaneous availability" and the new mode names.
  - Several earlier assertions were updated for intentionally changed
    wording and markup.
- `npm run build`: passed.
- Protected outputs: all 14 sha256 unchanged. Render assets and Python
  untouched (5A timestamps). Python tests not rerun.
- **Browser.**
  - Setup: headed Chrome 157 (`puppeteer-core`), Intel Arc 140V D3D11, dev
    server. 1915×1030 to match the user's screenshots; 390×844 narrow.
  - "Before" set from the pre-change build:
    the session scratchpad (`shots5c/before/`; local only, not committed) (CR1 and Athena overview and horizon,
    Athena narrow).
  - Markers:
    - CR1 2027-01-16: Earth globe in the sky, collinear with its ray. The
      Sun's edge chip reads "Below observer horizon".
    - Orbiting moved bodies to edge chips correctly.
    - Athena 2026-12-08 after a 180° keyboard orbit: an on-screen dashed Sun
      marker, "Below observer horizon".
    - Clicking the Earth marker entered Horizon view centered on Earth, with
      `cam=horizon` in the URL.
  - Horizon view:
    - both sites in Terrain; CR1 Smooth with the disk on top;
    - CR1's hidden Sun fully masked with the ring at the skyline;
    - CR1 2026-12-24 near-crossing: "available" plus the explanation.
  - URL: `mission=baseline&cam=overview` restored, and `cam=horizon`
    survived a reload.
  - Crossings:
    - All cached data, Earth Next ×3: 12-31 07:20, then 01-05 21:00, then
      01-27 10:50, each "Outside selected mission".
    - Prev returned to 01-05.
    - Jump to crossing gave "Crossing now".
    - Jump to mission returned to 12-08.
    - Changing the delay cleared the card.
    - Sun Next with Play: the countdown went from "in 1 h" to "in 30 min".
  - Endpoint: CR1 2027-01-30 00:00 shows both unknown with the final-sample
    reason, Play and +10 disabled. "The data ends …; that is not a
    crossing."
  - Analysis kept the time; returning kept Horizon view.
  - Layout: no horizontal overflow at 390 px. No console errors.
- **Not verified:**
  - a screenshot of the mouse-hover info line (headed screenshots drop the
    hover state; its text was read from the DOM, and the keyboard-focus path
    uses the same element);
  - Firefox/Safari, touch, screen readers, reduced motion in a browser;
  - real-mouse drag in Horizon view; non-local network loading.

**Remaining acceptance issues**
- Edge-chip direction for bodies behind the overview camera is approximate:
  the chip side is reliable, its position along the edge less so.
- The mesh still misses the 0.05° target (max 0.108°/0.112°). Horizon view
  does not depend on the mesh for the horizon.
- Explore and Analysis share one stored time. Analysis shows it clamped to its
  windows, so after viewing an outside time, Analysis displays the nearest
  window edge.
- Next optional feature (not started): DEM-derived slope visualization,
  without hazard claims.

## Milestone 5A: first working 3D Explore (2026-11-14)

Branch `milestone-5a-explore` from `c5e8432` (verified: clean tree,
`main` = `origin/main` = `c5e8432`, science-review follow-up merged in PR #3).
**Uncommitted, for review.** No Horizons fetch, no terrain download, no
terrain-product change, no horizon or sensitivity recomputation, no change to
site exports or intervals.

### What works (observed)
- **Shell.** Compact top bar with Explore / Analysis. Explore is the default
  when the URL has no `view`. Old links open Explore with their scenario.
  `view=analysis` opens the unchanged dashboard. One `useScenario` hook
  (`app/src/scenario.ts`, moved out of the former `Workspace` without rule
  changes) holds site, compared sites, UTC time, arrival, duration, delay and
  horizon mode for both views. URL writes use `replaceState` only and are
  skipped while playback runs.
- **Explore layout.** Full-bleed black-sky stage. Left: one site and mission
  panel (active site, Smooth/Terrain, baseline arrival date and hour, duration,
  delay, window summary, window metrics; collapsible). Right: selected-time
  status from `selectedTimeStatus` (state pills, center clearance, el/az, next
  change, near-crossing and unknown explanations). Bottom: time bar (play/pause,
  ±10 min, scrubber over Sun/Earth state strips, baseline and delay window
  markers, selected time shown apart from baseline arrival, speed 1 h/s or
  6 h/s). Camera bar: Overview / Observer view, Reset, Look toward Sun, Look
  toward Earth. Details sheet: method, site and frame, mesh, mesh check,
  limitations, link to Analysis. CR1's provisional badge stays in the site
  panel.
- **Overview camera.** Orbit around the observer. Composed oblique default per
  site. Observer pin and ring, north arrow, Sun/Earth direction rays from the
  observer (dashed when the status says not visible), outline and label of the
  meshed extent. In Smooth mode, a translucent 0° reference plane.
- **Observer view.** The camera is fixed at the exported observer point; only
  rotation (drag, arrows) and FOV (wheel, +/−) change. Terrain mode draws:
  - the exported 0.1° profile as the bright skyline (always on top);
  - a flat "profile silhouette" band where the profile rises above the mesh
    (angular only, hidden in the overview);
  - Sun and Earth disks at nominal 0.53° and 1.9°, hidden behind
    band and mesh;
  - a larger dashed click ring and an HTML label from the status;
  - cardinal letters at 0°, a faint dashed 0° reference, and off-screen
    indicators.
  Smooth mode makes the 0° line the bright horizon, dims the terrain, draws
  the disks on top and shows a stage note that terrain does not hide the
  bodies in this model.
- **Robustness.**
  - The renderer (`TerrainScene.tsx`, the only three.js importer) is
    lazy-loaded; the production build puts it in its own chunk.
  - Assets are fetched per active site and refused unless they match the
    site's ID, coordinates, altitude, observer radius, eye height and
    byte/sha256 layout.
  - On a site switch the old terrain is removed at once. The loading toast
    names the new site.
  - WebGL failure, asset failure and context loss each show a message with
    Retry/Restart and Open Analysis.
  - Rendering is on demand only.
  - Reduced motion makes camera moves instant.
  - Below 760 px the layout stacks.

### Rendering assets (`pipeline/render_assets.py`)
Reproduce: `python pipeline/render_assets.py --site <id>` (about 10 s per site,
reads the cached 1.85 GB LDEM_80S_20M; `--no-rehash` skips re-hashing it).
- Source: `LDEM_80S_20M`, sha256 `db44c3b2…ab365` re-verified this run against
  the site export's product record. Read through `terrain_horizon.Raster`,
  bilinear, with the established pixel-centre registration.
- Observer: the export's `terrain_horizon.observer` point (checked to 1e-6 m).
  Eye above the interpolated surface: 1.0196 m (Athena), 0.9794 m (CR1).
- Mapping:
  - square grids in polar-stereographic map space aligned to DEM pixel
    centres;
  - exact inverse stereographic, then Moon-centred float64 positions;
  - observer-relative local frame `x = east, y = up, z = −north`, rounded to
    float32 only at the end.

  Curvature is in the positions once; there is no exaggeration. Nested rings
  are stitched by moving fine boundary vertices onto coarse edges. Indices are
  generated in the app with the same triangulation.
- Levels and sizes:

| Site | Rings (spacing, half-width) | Vertices | Triangles | `.bin` |
|---|---|---|---|---|
| CR1 | 2.5 m ±640 m (interpolated); 20 m ±2.56 km; 80 m ±10.24 km (decimated) | 395 267 | 770 048 | 4 743 204 B |
| Athena | 5 m ±640 m; 20 m ±2.56 km; 40 m ±10.24 km; 160 m ±30.72 km | 543 492 | 1 007 616 | 6 521 904 B |

  Metadata `.terrain.json` is about 6 KB per site. Per-azimuth evidence is in
  `data/render/<site>_mesh_check.json` (637 KB CR1, 587 KB Athena; its
  `site_export_sha256` is of the local working-tree bytes). Terrain beyond the
  outer square is not meshed; the profile is computed to hundreds of km.
- **Measured mesh silhouette vs the exported profile.**
  - Method: exact triangle / vertical-half-plane intersection from the
    observer, 3 600 azimuths.
  - Coverage: every azimuth's setting point is inside the meshed extent
    (0 beyond) for both sites.

| | CR1 | Athena |
|---|---|---|
| Mesh − profile, signed min / max | −0.0021° / +0.1076° | −0.1124° / +0.0178° |
| \|Δ\| median / p95 / max | 0.0079° / 0.0467° / 0.1076° | 0.0023° / 0.0107° / 0.1124° |
| Azimuths over the proposed 0.05° target | 154 | 11 |
| Mesh − fine march (same DEM), \|Δ\| p95 / max | 0.0022° / 0.0076° (3 600 az, 0.25 m steps to 1 km) | 0.0017° / 0.0095° (1 135 az, 1 m steps to 2 km) |
| Fine march − profile, max | +0.1026° | +0.0175° |

  **The 0.05° target is missed at both sites; it is a rendering target, not a
  source-data accuracy.** Causes as measured:
  - CR1's misses are the mesh standing *above* the profile at crests
    50–90 m away. A 0.25 m march of the same bilinear DEM agrees with the mesh
    (≤ 0.0076°), so the excess is the exported profile's own 5 m radial
    sampling cutting under sharp crests. This was spot-confirmed at azimuths
    2.5° and 60° (5 m march reproduces the profile exactly). The profile was
    not changed; status still uses it.
  - Athena's 11 misses (az 5.1–6.7°) have the mesh *below* the profile where
    the skyline is set 14.5–15.3 km away in the 160 m decimated ring. There
    the profile band shows the skyline.
  - Controls: within 10 km Athena's max |Δ| is ≤ 0.018°. A plain 20 m mesh
    at CR1 gives max 0.171°, matching the science review's independent
    0.170–0.275°.

  The bright skyline line is the profile itself and is drawn on top, so this
  disagreement is visible, not hidden. No terrain is warped.

### Checks run personally (2026-11-14)
- `npm test`: **173 passed, 10 files** (140 inherited + 33 new:
  `explore/geometry.test.ts`, `explore/explore.test.tsx`, URL view tests).
  `npm run build`: passed (TerrainScene chunk 603 kB / 152 kB gzip; Vite's
  >500 kB chunk notice concerns that lazy chunk).
- `python -m unittest discover -s pipeline/tests`: **76 OK** (68 + 8 in
  `test_render_assets.py`: axes, handedness, stereographic round trip,
  observer at origin, curvature once vs `terrain_horizon.elevation_deg`,
  negative elevations, triangulation, exported asset identity).
  `python pipeline/validate.py`: **136/136**.
- Protected files: sha256 of `app/public/data/*.json` (3) and every
  `data/terrain/*.json` (11) recorded before work and re-checked after:
  **all 14 identical**. `git diff` on `app/public/data`, `data/terrain`,
  `data/horizons`, `pipeline/config.json`: empty.
- **Browser.**
  - Setup: Chrome 157 headless via `puppeteer-core` (scratch install, not in
    the repo), against the Vite dev server and once against `vite preview`.
    WebGL renderer reported: ANGLE Intel Arc 140V, D3D11.
  - Viewports 1440×900 (most checks), 1280×800, 390×844.
  - Screenshots of both sites in both camera modes were inspected by eye.
  - Results:
    - Both sites in overview and observer view, Terrain and Smooth.
    - Look toward Sun/Earth and Reset in both modes; overview mouse drag.
    - ±10 min stepping across the Athena Earth near-crossing (13:50 → 14:00
      shows "Near estimated crossing" with the Analysis sentence; back
      clears it).
    - Keyboard scrubbing; playback at 6 h/s. During playback the URL `t` and
      `history.length` were unchanged; pause wrote `t`.
    - Delay +7 d, hour 06:00 and duration 10 d set in Explore, then read back
      identically in Analysis and back in Explore.
    - Analysis reload kept the view and time.
    - CR1 badge; CR1 Sun near-crossing (2026-12-24 00:00) in the observer
      view.
    - Loading state: CR1 status with no Athena terrain.
    - WebGL disabled (`--disable-webgl`): message plus Open Analysis worked.
    - CR1 mesh request blocked: CR1-specific error, nothing substituted.
    - `WEBGL_lose_context`: message, Restart gave one fresh canvas.
    - 390 px: no horizontal overflow. No console errors except the expected
      WebGL-disabled and blocked-request messages.
- **Performance** (same machine and browser, localhost):
  - Load to terrain-ready: 3.4 s on the dev server, 2.2 s on the production
    preview (two 1.7 MB site files plus the 6.5 MB Athena mesh).
  - Site switch: 0.40 s (to CR1), 0.32 s (to Athena) on the dev server.
  - Overview drag: 120 renders in 1.99 s (60.4/s, display-bound). CPU time
    per frame: median 1.6 ms, p95 2.6 ms (CPU submit only, not GPU time).
  - Playback at 6 h/s: 37 renders/s.
- Not checked: a headed window, real touch, Firefox/Safari, screen readers,
  reduced-motion in a browser, observer-view mouse drag and wheel FOV by a
  real pointer, the native date picker, non-local network load times.

### Known limitations
- Mesh vs profile up to 0.108° (CR1) and 0.112° (Athena), as measured above.
  In the observer view the mesh can stand a little above the authoritative
  line at CR1 and occlude part of a disk the status calls visible. The status
  and line are authoritative; Details states this.
- Shading is a fixed illustrative light with normals averaged over about
  10 m (shading only); it does not show modeled sunlight. No shadows.
- 20 m DEM: relief finer than one to two pixels is not represented. The
  2.5–5 m rings interpolate and add no measured detail. Coarse rings are
  decimated and alias distant relief.
- The CR1 coordinate frame and accuracy remain assumed; CR1 terrain remains
  provisional; partial disks are not modeled (center-based).
- Camera mode is not stored in the URL; reload returns to the overview.

### Files
- New: `pipeline/render_assets.py`, `pipeline/tests/test_render_assets.py`,
  `app/public/render/<site>.terrain.{json,bin}`,
  `data/render/<site>_mesh_check.json`, `app/src/scenario.ts`,
  `app/src/explore/{Explore.tsx,TerrainScene.tsx,geometry.ts,terrainAsset.ts,explore.css,geometry.test.ts,explore.test.tsx}`.
- Changed:
  - `app/src/App.tsx`: shell plus `Analysis`, with the dashboard JSX
    unchanged.
  - `app/src/urlState.ts`: `view`.
  - `app/src/main.tsx`: CSS import.
  - `app/src/app.test.tsx`: requests `view=analysis`.
  - `app/src/urlState.test.ts`.
  - `app/package.json` / lock: `three@0.187.0`, `@types/three@0.187.0`,
    exact pins.
  - `.gitattributes`: `app/public/render/*.bin binary`.

## Science-review follow-up (2026-11-14)

Branch `science-review-followup` from `978f22a` (verified `main` =
`origin/main`, clean tree). **Uncommitted for review**; no push or merge.
Bounded scope:
- No 3D, no terrain-model change, no Horizons fetch, no terrain recomputation.
- Exported site files, terrain reports, intervals and mission metrics are
  unchanged.

The review itself and the rerun numbers are in `docs/SCIENCE_REVIEW.md`.

### What changed
- **Review evidence preserved.**
  - The reviewer's `spot.py` and `design_numbers.py`, found in its temporary
    scratch directory and read before reuse, are now
    `pipeline/review/spot_checks.py` and `pipeline/review/design_numbers.py`,
    with a shared `_dem.py`. They need the git-ignored LDEM_80S_20M raster.
    Changes: label-checked constants, a raster presence and size check, and
    unknown-horizon guards. `design_numbers.py` also lists every
    instant-vs-interval disagreement for both models.
  - The originals and the repo versions were run on the same inputs. The
    outputs are identical, apart from that listing and the word "nominal".
  - The reviewer's inline two-site direction check was recovered from its
    session log and reimplemented as `pipeline/direction_check.py`.
- **Convention checks** (`pipeline/tests/test_conventions.py`, 9 tests):
  - Sun direction from the two sites agrees within **0.001°** (max 0.000068°,
    i.e. parallax). Controls fail: a mirrored azimuth or west-positive
    longitude gives 26.8°, a one-sample shift > 0.05°, swapped site metadata
    > 1°.
  - The Earth parallax gives an approximate distance scale of
    356 527–406 760 km over all samples. The original 377 000–396 000 km
    summary used only three dates with the same formula; see SCIENCE_REVIEW.md.
    This is a coarse plausibility check, not validation of ephemeris accuracy.
  - The Sun's azimuth falls every 10-minute step (−0.08 to −0.09°), so the Sun
    moves right to left when facing north.
  - Earth stays in the azimuth bands 322–339° (Athena) and 129–146° (CR1).
  - The local frame is right-handed, and map bearing = east longitude +
    azimuth at both sites.
  - The existing single-direction gross check in `horizon_crosscheck.py` is
    kept: it detects some gross errors common to both sites. Cross-site
    checks cannot detect all shared errors; gross checks do not close that gap.
  - `test_terrain_horizon.py` adds a CR1 near-pole synthetic wall test.
- **Shared selected-time status** (`app/src/status.ts`):
  - `selectedTimeStatus` returns, per body:
    - `visible` (the exported step state; classification semantics
      unchanged);
    - `geometry` (instantaneous az/el, horizon there, signed clearance; exact
      at samples, linear between, no extrapolation);
    - `nearCrossing`;
    - a reason for every unknown: outside coverage, end of data (final
      sample), position unavailable, horizon unknown, state unknown.
  - The cards, readouts and panorama labels now all use it. The panorama
    marker stays at the true position, gets a dashed ring, and its label says
    "near estimated crossing". The readouts gain a "Center vs skyline/0°
    horizon" row.
  - Tests (`status.test.ts`, render tests in `app.test.tsx`):
    - all 17 disagreement cases (terrain: Athena Earth 5, CR1 Sun 5, CR1
      Earth 2; smooth: Athena 3, CR1 2);
    - every sample and every step midpoint for both sites and both models;
    - coverage edges and synthetic unknowns;
    - the same explanation in readouts, panorama and card;
    - the panorama's cardinal tick order.
  - Fixed on the way: the old readouts showed "Unknown" at the final sample
    while the panorama showed "visible". Both now say "Unknown (final
    sample)". `intervalAt(NaN)` matches an interval; the status code guards it.
- **Wording:**
  - Banners, method and limitations now state that visibility uses the
    center of both the Sun and Earth, and that part of either disk may remain
    visible when its center is hidden (nominal sizes 0.5° and 1.9°).
  - 10 minutes is described as sampling and reporting resolution, not
    guaranteed event accuracy: method, card footnote, next-change text,
    table captions, timeline tooltips.
  - CR1's provisional label and the coordinate/frame limitations are
    unchanged.
- **Dataset ID** `m2-athena-2026-12-01-60d` → `lvn-2026-12-01-60d`.
  - Consumers checked first: only `export.py` writes it, `sites.load_site_data`
    requires manifest = config, and the app footer shows it.
  - A full two-site `export.py` from the caches left both site files
    byte-identical (sha256 unchanged).
  - CR1's `preparation_status` in config no longer says "frontend still
    single-site". It is not exported.
- **Docs:**
  - STATUS handoff and stale branch/uncommitted/single-site statements.
  - SPEC: scope, Explore/Analysis, definitions, 3D requirements.
  - SECOND_SITE, DATA_CONTRACT changelog; new SCIENCE_REVIEW.md.

### Checks observed during the original follow-up
- `python -m unittest discover -s pipeline/tests`: **68 OK** (58 + 10).
- `python pipeline/validate.py`: **136/136**. Its full output is byte-identical
  to before the change.
- `crosscheck_metrics.py` for both sites, smooth and terrain: output
  byte-identical to before.
- sha256 of `app/public/data/{im2-athena,connecting-ridge-cr1}.json` and every
  `data/terrain/*.json`: unchanged. The manifest changed only in `dataset_id`
  and `generated_at_utc`.
- `npm test`: **134 passed, 8 files** (was 90 / 7). `npm run build`: passed.
- Headless Chrome against the production build (`vite preview`): **29/29**.
  - Athena Earth at 2026-12-09 14:00 (terrain): the readout, panorama and
    card show "Visible" + "Near estimated crossing" with one identical
    sentence; the clearance is −0.00012°; the ring is centred on the true
    marker position.
  - ArrowRight to 14:10 clears the qualifier (clearance +0.0051°); ArrowLeft
    restores it.
  - The site switch keeps Athena's card qualifier; the CR1 Sun case
    (2026-12-24 00:00) and the smooth case (2026-12-11 05:00) also show it.
  - At the final sample everything reads "Unknown" with the reason.
  - The new wording and dataset ID are present.
  - No horizontal overflow at 390 px (dark) or 1280 px. No console errors.
  - Screenshots inspected by eye in light and dark.

### Bounded completion review (2026-11-14, OpenAI Codex)
- Continued the existing work on `science-review-followup`; no restart,
  requests, terrain calculations, scientific-model changes or 3D work.
- Confirmed the diff matches the reported scope: shared selected-time status,
  presentation wording, review helpers/tests, documentation, and manifest/config
  metadata. README was not modified; its mention above was corrected.
- Corrected the milestone 3 assistance log's stale "not committed" statement.
  It now preserves the original timing and records commit `9e2b1b4`, already
  included in the branch base. Accurate historical descriptions and the current
  follow-up's uncommitted status remain.
- Fixed two status edge cases: an interior interval gap was incorrectly called
  "end of data" and discarded its sample step; it now reports "state unknown"
  and retains that step. The final sample now refuses interval state even if
  an interval incorrectly extends beyond coverage. No exported states change.
- Added six regressions: north wrap in both directions and strict equality at
  the horizon, unknown state with known instantaneous geometry, unexplained
  explicit unknown state, an interior interval gap, an overlong final interval,
  and half-open interior step boundaries. Existing all-sample, all-midpoint and
  17-disagreement tests still pass without changing their expected values.
- Recovered the original Earth-distance command: it sampled only indices
  0/4320/8640. The same formula reproduces its rounded 377 000–396 000 km
  summary; all samples give 356 527–406 760 km. SCIENCE_REVIEW.md explains
  the method and limitations. This approximate parallax diagnostic does not
  validate ephemeris accuracy. Gross checks detect only some shared errors.
- Checks rerun: **68 Python tests**, **136/136 cached validation checks**,
  `direction_check.py` PASS, **140 frontend tests in 8 files**, production
  build PASS, and `git diff --check` PASS. No browser run in this completion
  review; the original browser results above remain historical evidence.
- Compared both site exports and all tracked `data/terrain/` evidence:
  **102 files match the base byte for byte after Git's checkout filters**.
  Eleven text files (the two exports and nine JSON reports) use CRLF locally
  versus LF blobs; removing only CRLF/LF differences gives exact bytes and
  equal parsed JSON. Protected terrain-horizon reports and raw evidence match
  the blobs directly. No untracked scientific exports or terrain evidence.
  The manifest retains only its existing dataset ID and generation-time edits.
- Independent sample-based metric comparisons against base data match for
  **16 cases** (two sites × two models × baseline/+1/+3/+7-day windows).
  Metric and classification implementations are unchanged.
- Git after review: HEAD/base/main/origin-main all
  `978f22a2b48d53586843444759c77882cf698f56`; branch `science-review-followup`,
  no upstream, **12 modified tracked files and 8 untracked files**, nothing
  staged. No commit, push or merge. The pending human review and scientific
  limitations below remain.

### Remaining limits
- The status explains disagreements only at the selected time. Timeline
  boundaries remain the 10-minute estimates, as before.
- Cross-site checks cannot detect all shared errors (see SCIENCE_REVIEW.md).
  Gross checks detect only some shared errors; absolute accuracy remains
  unverified.
- The review scripts need the 1.85 GB raster and were not added to the unit
  test suite.
- Unchanged from the review:
  - coordinate frames and accuracy are assumed;
  - absolute terrain accuracy is unverified;
  - CR1 terrain is provisional;
  - Athena's rounding sentence has no committed report;
  - screen readers, Firefox/Safari and touch devices are untested.

### Closeout review and separate ChatGPT browser evidence (2026-11-14)
- Codex re-inspected the tracked and staged diffs and all eight untracked
  follow-up files. The starting state matched the completion record:
  `science-review-followup` at `978f22a`, no upstream, 12 modified tracked
  files, eight untracked files, nothing staged. All 20 files belong to this
  follow-up; generated builds, dependencies, bytecode and raw DEMs are excluded.
- Existing verification evidence is retained: 140 frontend tests, production
  build, 68 Python tests, 136/136 cached validation checks, direction check,
  102 base-data comparisons and 16 metric comparisons. No code changes or
  material discrepancies required another test run. No new scientific audit,
  Horizons fetch or terrain calculation was performed for closeout.
- The user separately reported a subsequent **ChatGPT browser smoke check**
  against the **development app at localhost:5174**. It passed Athena/CR1
  near-crossing cases, forward/back stepping, site switching, Smooth/Terrain
  state preservation, URL reload, final-sample unknown status and disabled
  out-of-range controls, with no captured console warnings or errors.
  This is separate from the original production-preview check and was
  **not personally run by Codex**. It does not tick the human 4D review checklist.
- The reviewed scope remains status presentation, convention/review evidence,
  wording, metadata and documentation. Scientific exports, models, metrics
  and terrain reports remain unchanged; all scientific limitations above apply.

## Milestone 4D: two-site comparison interface (2026-11-14)

On `milestone-4-site-comparison` after `ca0c996`; written uncommitted for review, later committed as `0826ccb` and merged to `main` in PR #2 (`978f22a`).
Frontend only: no exported data, pipeline code or Athena output changed (the
manifest and both site files are byte-identical to `ca0c996`). No 3D, no new
sites, no custom coordinates, no further terrain experiments.

### What it does
- **Loading:** every manifest site is loaded (`data.ts`, `checkSites`). The
  dataset is rejected unless:
  - IDs are unique and valid, and each manifest `file` is `<id>.json`;
  - each file's `site.id` and `site.name` equal its entry;
  - all sites share identical sample times (one coverage, one cursor index).
- **One shared scenario:** arrival, duration, delay, horizon model and selected
  UTC time apply to all compared sites. Windows are identical by construction;
  delays are baseline offsets. Delay limits use the common coverage.
  Active-site and model changes keep the scenario (state is shared, not per site).
- **No mixing:** Terrain is offered only when every compared site has a terrain
  block that passes the loader check. Otherwise every site is shown smooth, with
  a notice. `strictHorizon` / `strictIntervals` never fall back to smooth data
  for a terrain request (the old `intervalsFor` fallback is no longer used by the UI).
- **Cards:** one per compared site, with the model shown, Sun / Earth / both %
  and longest darkness for the baseline and the delay. The change column is
  labelled "Change: +N d vs baseline". Each card also has boundary flags, the
  state at the selected time, and "Show in panorama".
- **CR1:**
  - Labelled "Connecting Ridge CR1 — NASA notional study point".
  - In Terrain mode, "⚠ Provisional: sensitive to terrain model" appears above
    its metrics, in the panorama area and on its timeline track.
  - The model is named "20 m LOLA model (LDEM_80S_20M; LDEM_75S_60M beyond its edge)".
  - The **5 m assessment** is an expandable read-only summary: both
    observer-height conventions, the pairwise comparisons, the demo-window
    table, and the "non-statistical illustration" and "not additive" caveats.
    It is explicitly not a selectable model; no assessment variant is loaded as data.
- **Timelines:** one SVG, one UTC axis, one labelled track per compared site.
  **Panorama, readouts, elevation chart and horizon facts:** for the active site
  (selector). The panorama is centred per site (Athena N, CR1 SE, near each Earth
  direction), and its axis caption follows the centre.
- **Locator:** south polar stereographic on the 1737.4 km sphere (0° up, 90° E
  right, LOLA convention), positions projected, labelled schematic (no terrain).
  It shows the ~174 km surface distance.
- **Sources and limitations per site:** coordinate source, Horizons queries
  and LOLA products from that site's own file, with site-specific limitations
  either data-derived or from the site's profile (`sites.ts`). Common
  limitations are listed once, including "no overall ranking". The app never
  calls either site better.
- **URL:** `arrival, days, delay, t, horizon, sites, site`. Links without
  `sites`/`site` (all earlier Athena links) compare both sites with Athena in the
  panorama. Unknown IDs are reported, never invented.
- **Leakage guard:** site-specific text lives in per-site profiles or is computed from
  that site's file. The previous Athena-only strings in the panorama facts
  (0.0034° rounding effect, "about a quarter", "up to 2°", the
  `im2-athena_terrain_horizon.json` path, "Athena's actual operating
  conditions") are now per site.

### Checks observed
- `npm test`: **90 passed, 7 files** (was 43). New:
  - `sites.test.ts`: both sites × both models against the independent Python
    references, for the demo windows (CR1 +0/+1/+3/+7 d, Athena +0 d), to 1e-9.
    Also the one-model rule, strict no-fallback, profile leakage and locator geometry.
  - `assessment.test.ts`: every UI number against the committed assessment JSON.
    The JSON refers to the exported CR1 site and to the sha256 of the 20 m report.
    CR1's rounding-effect sentence is checked against
    `connecting-ridge-cr1_observer_rounding_check.json`.
  - `urlState.test.ts`: parse, restore, old link, unknown IDs, round trip.
  - `app.test.tsx`: server-rendered `Workspace`, covering reference values in
    both cards, CR1 label and provisional position, no leakage both ways,
    active-site switching, identical cards under a switch, URL restoration, the
    no-mixing fallback, delay limits and the panorama caption.
  - A mutation check (injecting "CR1" into Athena's profile) made 2 tests fail, as intended.
- `npm run build`: passed (JS 293 kB, 91 kB gzip; CSS 19 kB).
- Headless Chrome (DevTools protocol, production build via `vite preview`):
  **42/42 checks**:
  - **Load and identity:** default URL state; reference metrics in both cards;
    CR1 label and provisional placement; 20 m model named; no leakage either
    way; one timeline SVG with both tracks; locator with both sites; no "best site" claim.
  - **5 m assessment:** content present (conventions, non-statistical, not
    selectable); the model buttons are only Smooth / Terrain.
  - **Active-site switch:** URL `site` changes; arrival/delay/days/t/horizon and
    cursor index unchanged. The panorama side carries only CR1 text and data
    tags; the caption reads NW/SE; cards are identical after the switch.
  - **Mode switch:** both cards switch together (Athena 43.4 %, CR1 100.0 % in
    smooth); the provisional label is hidden in smooth and returns in terrain;
    the scenario is preserved.
  - **Delays:** +7 d then +1 d gives +1 d (not cumulative). At the latest
    arrival only the baseline fits, and the delay columns disappear.
  - **Keyboard on the time slider:** ArrowRight/Left ±10 min, Home/End at the
    window edges, PageUp a larger step; the cards' "At <time>" follows.
  - **URL restoration:** one site, smooth, +7 d, time; old Athena link; unknown
    ID notice. Deselecting a site moves the active site; the last site cannot be
    deselected.
  - **Layout:** no horizontal page overflow at 1280 and 390 px, light and dark.
  - **Console:** no errors.
  - Screenshots were inspected by eye (desktop and narrow, light and dark).
- Bugs found and fixed during this review:
  - `Workspace` re-read the URL on every render, losing the unknown-ID notice
    after the URL was rewritten; the link is now read once.
  - Athena's card table was clipped on the right at desktop width (header wrap, tighter padding).
  - Locator latitude and longitude labels overlapped.
  - The panorama caption still said "north in the middle" for CR1.
  - A `/favicon.ico` 404 (empty inline icon added).
- The Python pipeline was not touched: unit tests and validation results are
  those recorded for `ca0c996` (58 tests, 136/136).

### Known limits of the interface
- At 390 px the elevation chart's long 0° line label is clipped by the plot.
  This predates 4D and is cosmetic.
- Athena's rounding-effect sentence (0.0034°, 2026-12-30 step) is static
  profile text from the milestone 3 measurement; no committed report holds those
  numbers, so it is not machine-checked. CR1's is tested against its report.
- (Resolved in the science-review follow-up) `manifest.dataset_id` was `m2-athena-…`; now `lvn-2026-12-01-60d`.
- Not tested: screen readers, Firefox/Safari, real touch devices, keyboard
  use of the timeline SVG itself (the slider is the keyboard control), and a
  deployed build from a fresh browser session.

### Browser review checklist (for the human review; not yet done by a person)
- [ ] Default page: two cards; Athena 27.2 % / 67.3 % / 244.5 h and CR1 72.1 % /
      25.4 % / 62.8 h at baseline (2026-12-05, 14 d, Terrain). Both show "Delay +3 d" and
      "Change: +3 d vs baseline".
- [ ] CR1 card reads "Connecting Ridge CR1 — NASA notional study point" and
      shows "Provisional: sensitive to terrain model" above its metrics, and "20 m
      LOLA model". The note disappears in Smooth.
- [ ] Open "5 m terrain assessment": both observer conventions (0.641 m fixed,
      1.041 m nominal / 1.9432 km), "not additive", "non-statistical
      illustration", "not offered as selectable models".
- [ ] Switch the panorama site Athena ↔ CR1: cards, arrival, delay and time stay the
      same. The panorama recentres (N vs SE) and its facts and scenarios change to
      that site, with no other-site text.
- [ ] Smooth ↔ Terrain changes both cards together, never one alone.
- [ ] +7 d then +1 d gives +1 d. "Latest arrival without delay" disables all delays.
- [ ] Drag the timeline and elevation chart; arrow keys / Home / End / Page Up on
      the slider. Cards' "At …" and readouts follow the one UTC time.
- [ ] Copy the URL into a new tab: sites, panorama site, model, scenario and time
      return. An old link such as `?arrival=2026-12-05T00:00Z&days=14&delay=3&horizon=terrain`
      still works.
- [ ] Untick a site in "Compared sites"; the remaining one cannot be unticked.
- [ ] Check at desktop and phone width, in light and dark: no sideways scroll,
      tables readable, locator labels legible.
- [ ] Wording: no claim that either site is the better landing site; CR1 never
      described as an actual or approved landing site.

## CR1 terrain-product assessment: 5 m PGDA vs 20 m LDEM (2026-11-14)

Bounded follow-up to 4C, started after committing 4C as `627a4cc`. Committed
locally; recommendation accepted. No change to any exported app data, Athena output or frontend.

### Product and checks of its metadata
- Sources: PGDA product 78, "High-Resolution LOLA Topography for Lunar South
  Pole Sites", **Site01 Connecting ridge** (https://pgda.gsfc.nasa.gov/products/78,
  README https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/README). Barker et al. 2021,
  PSS 203, 105119, doi:10.1016/j.pss.2020.105119. The 87–90°S mosaic (product 81,
  3.3 GB, no uncertainty layer listed) was not needed: Site01 covers the point.
- Downloaded sequentially (2026-11-14T23:10–23:56Z, ~60 KB/s; one transient
  DNS failure, resumed): `_surf` (sha256 3ba7b97c…), `_ldec` (16d6ed21…),
  `_toterr` (cf2cf52f…), 40 980 744–40 980 810 bytes each = Content-Length,
  in git-ignored `data/raw/pgda/site01/` (`download.meta.json`). Not downloaded:
  slope layers, the point cloud and the 100 clones.
- Read from the files, not assumed: 3 200 × 3 200 float32, uncompressed;
  X −19 000…−3 000 m, Y −20 000…−4 000 m (16 × 16 km); 5 m pixels.
  - **Registration:** GeoTIFF PixelIsArea, tiepoint at the outer corner, and GMT
    `xyz2grd -r` (`node_offset 1`), so centres are at corner + 2.5 m. This matches the
    README's "pixel-registered (centres)".
  - **Projection:** polar stereographic, origin −90°, pole longitude 0, scale 1, on a
    1 737 400 m sphere, the same as the PDS LOLA products. Frame MOON_ME/DE421 (README).
  - **Nodata:** NaN (`GDAL_NODATA`); **0 NaN** in all three layers. Empty pixels
    are filled by interpolation upstream.
- **Height reference** (not stated by PGDA): checked against LDEM_80S_20M,
  heights above 1737.4 km. The 4 × 4 block mean of the 5 m surface falls exactly
  on LDEM_80S_20M's pixel centres. Block mean − LDEM is +0.28 m over the tile
  (sd 1.29 m, 640 000 px) and +0.15 m within 1 km (sd 1.14 m). This is consistent
  with the same reference, with sub-metre product differences.
- **Horizontal alignment:** among the shifts tested (±40 m in 5 m steps, 5 m
  surface vs LDEM_80S_20M bilinear), the lowest RMS is at **(0, 0)**, both within
  1 km and within 6 km (RMS about the mean 1.006 m). This is the best fit among
  those shifts only. It does not resolve offsets below 5 m, does not test shifts
  beyond ±40 m, rotations or local distortions, and does not prove that
  either product is correctly positioned. Both derive from LOLA, so a shared
  positioning error would not appear here.
- **Coverage:** the point (map −10 919.5, −11 874.8 m) is ≥ 7 875 m from every
  tile edge, and all 3 600 setting points lie in the tile. Rays continue in the
  validated LDEM_80S_20M / LDEM_75S_60M beyond it. 5 m − 20 m heights 25 m inside
  the edge: mean +0.46 m, sd 1.45 m, max 11.0 m, worth ≤ 0.061° there. Terrain
  beyond the tile is at least **1.46° below** every azimuth's horizon, so the
  hand-off cannot change the result.
- **Interpolation and uncertainty:** the nearest 5 m pixel has 0 LOLA returns;
  93 % of 5 m pixels within 100 m (90 % within 500 m) are interpolated. PGDA
  total-Z RMS error is 0.34 m at the point (median 0.34 m, p95 0.64 m within 500 m).
  At the 5 m setting points it is median 0.27 m (p95 0.79 m). Converted to an
  angle, atan(σ_Z / distance), that is a **median 0.16° (p95 1.40°, max 1.62°)**,
  because the skyline is 29–450 m away. *What this conversion includes:* only
  PGDA's per-pixel vertical RMS at each azimuth's setting point, bilinearly
  interpolated, at that point's distance. *What it omits:* the observer's own
  surface height error (which shifts every elevation angle at once), horizontal
  position error, error correlation between pixels, other terrain points that
  could become the new skyline, the coordinate's unknown accuracy, and
  sub-pixel relief or rocks. It is a per-azimuth scale indicator, not a
  propagated uncertainty of the horizon or of any mission metric. Finer
  pixels here mean more interpolated pixels between tracks, not measured detail.

### Observer conventions
Surface at the point (bilinear): LDEM_80S_20M 1941.821 m; 5 m **1942.159 m**
(+0.338 m); 5 m block mean 1942.549 m.
- *Fixed absolute radius* r = 1 739 342.8 m: the same point in space as the
  fetched Horizons positions. Eye above the 20 m / 5 m / block surface:
  0.979 / **0.641** / 0.251 m; never below a surface (the script refuses that).
- *Nominal height on the 5 m surface* (pipeline rounding): 1942.2 + 1 m gives
  1.9432 km, r = 1 739 343.2 m, eye 1.041 m. It would need new Horizons positions
  and was evaluated for the skyline only. Sun/Earth directions are unchanged at
  ~1e-9° per 0.4 m, but are not consistent for publication.

### Results (ray sampling 1.25 m to 2 km, then 5 m; 0.1° azimuth; 0 unknown in every run)
Each row is a **pairwise comparison** of two full recomputations that differ in
the stated way (Sun / Earth = 10-minute steps that differ, of 8 640). The rows
are not an additive decomposition of error. Effects do not sum, the
"sampling" and "product" rows are two different comparisons rather than two
parts of the 20 m → 5 m difference, and the scenario rows are not uncertainties.

category | comparison | skyline max (median) | Sun / Earth steps
---|---|---|---
numerical convergence | 5 m: radial 0.625/2.5 m vs base | 0.017° (0.000°) | 0 / 0
numerical convergence | 5 m: radial 5/10 m vs base | 0.092° (0.003°) | 2 / 1
numerical convergence | 5 m: azimuth 0.05° vs 0.1° | 0.003° | 0 / 0
numerical convergence | 20 m: 4C sampling vs 1.25/5 m | 0.087° (0.005°) | 3 / 0
terrain product (fixed radius, same sampling) | LDEM 20 m → PGDA 5 m | **0.97° (0.23°)** | **321 / 3**
comparison: same product, coarser grid | PGDA 5 m → its own 20 m block mean | 0.38° (0.057°) | 78 / 11
comparison: different product, same 20 m grid | LDEM 20 m → PGDA block mean | 1.00° (0.20°) | 307 / 12
observer convention | 5 m: eye 0.641 → 1.041 m | 0.60° (0.24°) | 248 / 53
product + own nominal observer | 4C result → 5 m nominal | 1.25° (0.14°) | 340 / 56
observer location (scenarios) | 5 m: 100 m N / E / S / W | 3.51 / 3.08 / 3.78 / 3.47° | 4 153 / 3 416 / 3 701 / 3 079 Sun
removing real nearby terrain | 5 m: ignore < 20 / 50 / 100 / 300 m | 0 / 0.15 / 1.18 / 3.78° | 0 / 0 / 85 / 5 498 Sun
PGDA error, non-statistical illustration | every setting point's elevation moved by its own atan(σ_Z/d), all up or all down | median 0.16° | 432 (up) / 179 (down) Sun

- The 5 m skyline is still set **29–450 m** away (median 95 m), range −0.31°
  to +3.82° (20 m: −0.83° to +4.11°, 50–480 m).
- Comparing the two products on the same 20 m grid changes the skyline about
  as much as the full 20 m → 5 m comparison (1.00° vs 0.97° max; 307 vs 321 Sun
  steps). Coarsening the 5 m surface by itself changes it less (0.38°, 78
  steps). This **suggests** that the change comes mainly from the different
  product (track-adjusted LOLA vs LDEM V2.0) rather than pixel spacing. It is a
  comparison, not an attribution: block-averaging is not how LDEM_80S_20M was
  made, and the effects are not additive. The product difference is of the same
  order as the angle scale of the 5 m product's stated 1σ error (above).

Mission metrics (14-day demo windows from 2026-12-05; Sun % / both % / longest dark h):

The last column is the non-statistical "all up / all down" illustration above.
It is not a confidence interval, does not bound the metrics, and has no stated probability.

window | 20 m (4C, exported) | 5 m fixed radius | 5 m nominal eye | 5 m block mean (fixed) | 5 m all-up / all-down illustration (Sun %, dark h)
---|---|---|---|---|---
+0 d | 72.12 / 6.75 / 62.8 | 66.52 / 0.20 / 85.0 | 69.59 / 2.88 / 78.3 | 68.15 / 0.94 / 83.2 | 62.9–69.0, 78.7–92.5
+1 d | 72.12 / 6.75 / 86.8 | 66.52 / 0.20 / 109.0 | 69.54 / 2.88 / 102.3 | 68.11 / 0.94 / 107.2 | 62.9–69.0, 102.7–116.5
+3 d | 59.87 / 6.75 / 134.8 | 53.27 / 0.20 / 157.0 | 55.26 / 2.88 / 150.3 | 53.82 / 0.94 / 155.2 | 51.0–55.2, 150.7–164.5
+7 d | 45.59 / 21.03 / 182.8 | 39.04 / 14.53 / 204.8 | 42.31 / 18.50 / 193.8 | 39.29 / 14.98 / 204.0 | 34.6–42.4, 193.7–219.7

Earth share changes by ≤ 0.8 pp across these (Earth's path crosses lower, more
distant skyline). Sun transitions over 60 days (UTC; rise ↑ / set ↓):

event | 20 m (4C) | 5 m fixed | 5 m nominal | block mean
---|---|---|---|---
first sunrise | 12-06 06:50 | 12-06 03:30 | 12-05 23:50 | 12-05 23:50
sunset | 12-16 09:10 | 12-15 11:00 | 12-15 17:40 | 12-15 12:50
sunrise | 12-24 00:00 | 12-23 23:50 | 12-23 19:30 | 12-24 00:50
sunset | 12-27 08:00 | 12-27 18:00 | 12-27 23:50 | 12-27 17:50
sunrise | 01-05 03:30 | 01-05 03:50 | 01-05 00:30 | 01-05 02:40
sunset | 01-13 05:00 | 01-12 11:20 | 01-12 23:30 | 01-12 16:30
extra sunlit period | — | — | 01-24 01:00–06:20 | —
longest darkness (60 d) | 403.0 h (to coverage end) | 420.7 h | 265.5 h | 415.5 h

Events move by up to ~22 h between products. A 0.4 m eye change creates or
removes a 5 h sunlit interval, which by itself changes the 60-day longest darkness
from 420.7 to 265.5 h.

### Recommendation: retain CR1 terrain as provisional
Do not adopt either DEM's CR1 terrain as a final result.
- **For the 5 m product:** it is well suited technically. It covers the point,
  best-fits LDEM_80S_20M at zero shift among the tested shifts, and has a
  consistent height reference, no missing data and numerical convergence. It
  ships documented uncertainty. If CR1 terrain is shown, it is the
  better-documented surface.
- **Against calling either result final:**
  - The difference between the two products (0.97° max; −5.6 pp Sun and +22 h
    darkness in the baseline window) is the same order as the effect of the 5 m
    product's own stated 1σ height error. The non-statistical all-up/all-down
    illustration moves the same window by about −3.6/+2.5 pp and +7.5/−6.3 h.
  - A 0.4 m change of eye height has comparable effects.
  - A 100 m change of position has ~10× larger effects.
  - The coordinate's accuracy, the lander's height and local rocks are unknown
    and act at this scale.
- **The finer DEM does not make CR1 robust;** it confirms that CR1's Sun
  visibility in this window is decided by metre-scale relief within ~100 m.
- **Consequences:**
  - The exported CR1 file stays the committed 20 m provisional result.
  - No Horizons re-fetch was made, because no surface elevation was adopted.
  - Adopting the 5 m surface later would require positions at 1.9432 km
    (nominal convention) and a re-run of export/validation.

### Checks observed
- `python -m unittest discover -s pipeline/tests`: **58 passed** (3 new synthetic
  GeoTIFF tests: header parsing, PixelIsArea centres, exact mapping onto the
  ray-march grid incl. stencil edges, off-lattice rejection).
- `validate.py` (both sites): **136/136**. Athena's 74 tracked files are
  sha256-identical. Athena and CR1 exports recompute byte-identically after the
  `terrain_horizon.py` change (PDS products take the unchanged code path).
- Not done (bounded scope): clone ensemble (100 × 41 MB), slope layers, the
  87–90°S mosaic, sub-5 m horizontal alignment, re-fetching Horizons.

## Milestone 4C: CR1 positions, terrain horizon and validation (2026-11-14)

Started from verified branch `milestone-4-site-comparison`, commit `94cf13f`,
clean tree. Left uncommitted for review at the time (since committed as `627a4cc` and merged in PR #2). No frontend,
site-list, custom-coordinate or 3D change.

Commands run (in order, all `--site connecting-ridge-cr1` unless noted):
`fetch.py --print-urls` (dry run) → `fetch.py` → `export.py` → `validate.py`
→ `terrain_horizon.py` → `horizon_crosscheck.py` (first attempt crashed, see
code changes; re-run) → `export.py` → `validate.py` → `validate.py --site
im2-athena` → `crosscheck_metrics.py [--terrain]` (both sites) →
`observer_rounding_check.py` → `fetch.py` (cache re-run) → `validate.py` (batch)
→ unit tests, `npm test`, `npm run build`. `compare_altitude.py` was **not**
run for CR1: it needs extra 0 km Horizons queries that were not part of this task.

### Positions
- 12 live requests (Sun `10`, Earth `399`; six 10-day chunks each), made
  sequentially with the 2 s pause, 2026-11-14T22:18:08Z–22:18:37Z, all HTTP 200,
  API signature 1.2. Bodies cached byte-for-byte with query, headers and sha256
  in `data/horizons/connecting-ridge-cr1__*`; no failed responses. Re-run: 0 live.
- Query `SITE_COORD='222.6,-89.468,1.9428'` (E-lon, lat, alt km), `coord@301`,
  `GEODETIC`, quantity 4, `AIRLESS`, `UT`. Echo checked rather than assumed:
  geodetic exact; frame `MEAN_ME (high precision) {East-longitude positive}`;
  radii 1737.4 km sphere; cylindric consistent only to its printed precision
  (±0.5 m, see "CR1 echo" in Verified conventions).
- Smooth export: 8 641 samples, 0 nulls, export = raw 17 282/17 282, 5 boundary
  samples identical per target. Sun elevation **0.065° to 1.984°** for all
  60 days, Earth −7.50° to +6.16°. Smooth 0° model: Sun center visible 100 %, Earth 40.19 %.

### Observer and frame (explicit)
- ME/DE421 planetocentric, east-positive frame **assumed** for the source
  coordinate (unchanged from 4B). Horizons interprets it in MOON_ME.
- Nominal eye 1 m. Submitted altitude (1941.8 + 1) m = 1.9428 km uses the
  0.1 m-rounded surface. The terrain run reads the bilinear foot as 1941.8205581 m
  (same as 4B to 1e-12 m), so the eye is **0.979442 m** above the DEM.
  Sun/Earth and skyline share r = 1 739 342.8 m.
- Rounding effect, measured (`observer_rounding_check.py`, profile with the eye
  at exactly 1.000 m): skyline lower by up to **0.0235°** (az 286.7°, set 50 m
  away; mean 0.0139°). That flips **13 Sun / 3 Earth** steps of 8 640. Demo-window
  changes are Sun ≤ +0.25 pp, Earth ≤ +0.05 pp and longest darkness −0.67 to
  −0.83 h. Larger than Athena's (≤ 0.0034°, 1 step) because CR1's skyline is
  ~50–100 m away. Kept, consistent with the established convention, and
  documented in `site.altitude_conversion_note`.

### Terrain horizon (`data/terrain/connecting-ridge-cr1_terrain_horizon.json`)
- 3 600/3 600 rays met the stopping rule (91–203 km, median 142 km); **0
  unknown**. Horizon −0.83° to +4.11° (median 1.26°), 624 negative azimuths.
- **Every setting point lies 50–480 m from the point (median 90 m), 3 574
  within 200 m**, all in LDEM_80S_20M. 881 setting points have 0 LOLA shots in
  the nearest pixel. Cardinal directions: N 3.207° (75 m), E 1.734° (65 m),
  S 2.273° (140 m), W 0.133° (85 m). The 100 m N/E/S/W points are 4.6/2.7/3.7/0.8 m
  higher than the point: in this DEM it sits in a shallow local low.
- No ray crossed the 80S edge before stopping, so there are no seam
  statistics (`n_rays_crossing: 0`).

Sensitivity (full recomputations; steps of 8 640; demo = largest change over
the four 14-day windows from 2026-12-05):

variant | max \|Δ\| (p99) | Sun / Earth steps | demo change (Sun pp, Earth pp, dark h)
---|---|---|---
azimuth 0.05° / 0.02° | 0.004° / 0.004° | 0 / 0 | 0
0.005° within ±0.3° of 10 crossings | 0.0004° | 0 / 0 | 0
radial 2.5 / 5 m | 0.087° (0.064°) | 2 / 0 | 0.05, 0, 0.17
radial 10 / 20 m | 0.330° (0.161°) | 13 / 17 | 0.25, 0.15, 0.83
radial 20 / 40 m and 20 / 60 m | 0.330° (0.189°) | 45 / 27 | 1.29, 0.20, 4.33
ignore terrain < 20 m / < 50 m | 0 | 0 / 0 | 0
ignore terrain < 100 m | 1.14° | 161 / 0 | 3.62, 0, 0
ignore terrain < 300 m | **4.05°** | **5 334 / 816** | 54.4, 12.6, 182.8
truncate at 10 / 25 / 50 / 100 km | 0 | 0 / 0 | 0
height bound = products' maximum | 0 | 0 / 0 | 0
60 m product everywhere | **2.72°** (2.72°) | **2 340 / 544** | 28.5, 11.1, 74.2
switch to 60 m at 5 / 25 / 100 km | 0 | 0 / 0 | 0
scenario: observer 100 m N | 3.10° (median 1.87°) | 3 594 / 198 | 40.1, 4.6, 134.8
scenario: observer 100 m E | 2.71° (median 1.11°) | 3 770 / 648 | 42.2, 8.0, 141.7
scenario: observer 100 m S | 4.15° (median 1.06°) | 3 627 / 331 | 20.6, 6.0, 38.3
scenario: observer 100 m W | 3.08° (median 1.68°) | 2 751 / 198 | 27.9, 2.9, 66.8

Interpretation: azimuth spacing, search extent, height bound and far-field
handoff are converged. Sub-pixel ray sampling matters at the 0.1–0.3° level
because the skyline is only a few pixels away. **The result is dominated by
20 m DEM relief within ~300 m** and is not robust to DEM resolution or to a
100 m position change. The scenarios are not a coordinate uncertainty (it is
unknown). Since the Sun is never more than 1.98° up, small skyline changes
decide whole sunlit periods.

### Checks by other routes (`data/terrain/connecting-ridge-cr1_horizon_crosscheck.json`)
- **Near-field bilinear check (new in 4C):** separately written positions
  (spherical-trig destination), projection (documented `polar_inverse`),
  bilinear code and vector geometry with a numerical local frame. Evaluated at
  the ray march's 5 m distances to 1 km, every azimuth. It reproduces all 3 600
  azimuths within **2.2 × 10⁻⁹ °** at identical setting distances; azimuth error
  ≤ 1.9 × 10⁻⁷ °. This confirms the implementation; it shares the DEM, reader,
  sample distances and observer, so it says nothing about terrain accuracy.
- Pixel sweep (16 wedges, 64 bins): **no bin has the skyline set ≥ 2 km away**,
  so the Athena-style statistic is `null`. Pixel − ray is ≤ +0.049° in every bin,
  so the upper-bound consistency holds. Bins are mostly −0.5° to −6° because a
  0.25° bin at 50–500 m holds few pixel centres. Same-direction check −0.051°
  to +6.0°. `all_sweeps_extent_sufficient` is false for that same near-field
  reason, not because of the search extent. Not informative for CR1's values.
- LOLA RDR shots (8 boxes, ±250 m, cached in `data/terrain/lola_rdr/connecting-ridge-cr1__*`,
  queried sequentially from ODE GDS): **100 %** of shots predate the DEM cutoff,
  so this is a consistency check only. The ±0.1° windows at 65–165 m contain 0–2
  shots, so **the skyline-vs-shot comparison is uninformative** (lower bounds).
  The boxes overlap the site neighbourhood (836–931 shots each). There, DEM − shot
  heights are mean −0.32 to −0.36 m, sd 0.74–1.00 m, max |5.42| m.
- Azimuth convention (sanity check): ME +X at az 137.40°; Horizons 60-day mean
  Earth az 137.81° (Δ 0.41°). A mirrored convention would give 222.60° (~85° off).
- Metrics: `crosscheck_metrics.py` (independent of `visibility.classify`)
  equals the sensitivity module's demo metrics exactly. `validate.py`
  re-classifies the exported profile with identical intervals.

### Demonstration windows (14 days from 2026-12-05; no rankings implied)
window | smooth Sun / Earth / both / dark | terrain Sun / Earth / both / dark
---|---|---|---
+0 d | 100 / 28.37 / 28.37 % / 0 h | 72.12 / 25.45 / 6.75 % / 62.8 h ⚠ end
+1 d | 100 / 35.52 / 35.52 % / 0 h | 72.12 / 32.59 / 6.75 % / 86.8 h ⚠ end
+3 d | 100 / 49.80 / 49.80 % / 0 h | 59.87 / 46.88 / 6.75 % / 134.8 h ⚠ end
+7 d | 100 / 78.37 / 78.37 % / 0 h | 45.59 / 75.45 / 21.03 % / 182.8 h

60 days, terrain: Sun center visible 35.82 %, Earth 36.90 %, 11 intervals, no
unknown state. Given the sensitivity above, these terrain numbers describe this
DEM at this exact point only.

### Code changes
- `terrain_sensitivity.py`: **bug fix**. 4A added unused `cfg, site` parameters
  to `seam_check` but not to its call, so any full sensitivity run raised
  `TypeError` after ~5 min. Athena's report predates 4A and was never re-run.
  Restored the original signature; no calculation changed.
- `validate.py`: the cylindric-echo check compares at the echo's printed
  decimals (see Verified conventions); 2 new unit tests use the real Athena and CR1 echoes.
- `horizon_crosscheck.py`: crashed formatting the `null` ≥ 2 km statistic
  (fixed). Adds the near-field bilinear check, `n_bins_ray_setting_ge_2km`,
  `max_pixel_minus_ray_deg`, the per-box share of shots by the DEM cutoff, and
  a computed mirrored-azimuth offset in the note (was the Athena-specific "~60 deg").
- `export.py`: replaced Athena-specific note text (eye "1.02 m", "96-100 %")
  with each site's values. When the pixel sweep has no ≥ 2 km bins it says so
  and cites the same-direction and near-field checks. It adds Sun share/darkness
  scenario changes when > 1 pp, plus a "NOT robust" sentence when every skyline
  point is within 2 km. Athena's export is **byte-identical** (content compared in
  memory; on-disk files unchanged).
- New `observer_rounding_check.py`; config CR1 text fields updated from
  "planned, not submitted" to the submitted/echoed facts (identity fields unchanged).

### Checks observed
- `validate.py --site connecting-ridge-cr1`: **53/53** after the smooth export,
  **68/68** after the terrain export; `--site im2-athena` **68/68**; batch **136/136**.
- `python -m unittest discover -s pipeline/tests`: **55 passed** (53 + 2 new).
- `npm test` **43 passed**; `npm run build` passed (JS 275 kB, 86 kB gzip).
- Athena: all 74 tracked files whose names contain "athena" (export, caches,
  reports, RDR boxes) are byte-identical to `94cf13f` (sha256). Demo metrics are
  unchanged (terrain 27.232 % / 67.262 % / 244.5 h; smooth 43.353 % / 55.655 % / 190.333 h).
- Manifest now lists Athena then CR1, with a new `generated_at_utc`. The app
  still loads only `sites[0]` (Athena); not browser-rechecked, since no
  frontend code changed.

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
(At 4A) the frontend was single-site and no second site had been selected/fetched; both changed in 4B–4D.
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
2026-11-14 | CR1 retrieval (4C) | 12 chunked requests | sequential, cached raw, complete | 12 live, re-run 0 live; 6 × 1 441 rows per target; HTTP 200 | pass
2026-11-14 | CR1 Horizons conventions (4C) | 12 responses | geodetic echo = 222.6, −89.468, 1.9428; MEAN_ME east-positive; 1737.4 km sphere; airless; UT | as expected; cylindric = submitted point at printed 5/3 decimals (|r| +177 mm as printed, ±0.5 m precision) | pass
2026-11-14 | CR1 `validate.py` smooth (4C) | raw + export | contract + raw checks | **53/53**; export = raw 17 282/17 282 | pass
2026-11-14 | CR1 terrain profile (4C) | 3 600 rays | stopping rule met; no unknown | 3 600 stopped (91–203 km); −0.83…4.11°; set 50–480 m | pass
2026-11-14 | CR1 terrain sensitivity (4C) | 22 variants | numerical convergence; report robustness | az/extent/height bound converged; ray step ≤ 0.33°; **near field < 300 m 4.05°, 60 m DEM 2.72°, 100 m scenarios ≤ 4.15° (up to 3 770 Sun steps)** | numerics pass; robustness **not met** (reported)
2026-11-14 | CR1 near-field bilinear check, independent implementation, same DEM (4C) | 3 600 azimuths, ≤ 1 km | equal to ray march | ≤ 2.2e-9°, same setting distance 3 600/3 600 | pass
2026-11-14 | CR1 pixel sweep (4C) | 16 wedges, 64 bins | pixel ≤ ray; ≥ 2 km agreement | pixel − ray ≤ +0.049°; no ≥ 2 km bins (statistic null) | pass (upper bound only)
2026-11-14 | CR1 LOLA RDR shots, consistency (4C) | 8 boxes | skyline vs shots | 0–2 shots per ±0.1° window: uninformative; box DEM − shot mean −0.32…−0.36 m | inconclusive (reported)
2026-11-14 | CR1 azimuth convention, sanity (4C) | ME +X vs mean Earth | gross errors only | 137.40° vs 137.81° (mirrored 222.60°) | pass
2026-11-14 | CR1 observer rounding (4C) | eye 0.979 vs 1.000 m | small, documented | ≤ 0.0235°; 13 Sun / 3 Earth steps; ≤ 0.25 pp, ≤ 0.83 h | pass (kept, documented)
2026-11-14 | CR1 `validate.py` with terrain (4C) | export incl. terrain | contract + re-classification | **68/68**; batch both sites **136/136** | pass
2026-11-14 | CR1 metrics cross-check (4C) | demo windows, both models | independent Python = pipeline | exact (72.123 %, 25.446 %, 62.833 h terrain +0 d) | pass
2026-11-14 | Athena preservation (4C) | 74 tracked Athena files; export recomputed in memory | identical | sha256 74/74; export content identical; 68/68; metrics unchanged | pass
2026-11-14 | Tests and build (4C) | pipeline, vitest, build | pass | 55 OK; 43 passed; build OK | pass
2026-11-14 | PGDA Site01 download (5 m assessment) | surf, ldec, toterr | size = Content-Length; sha256 recorded | 3/3; one transient DNS failure resumed | pass
2026-11-14 | PGDA metadata (5 m assessment) | GeoTIFF tags, GeoKeys, GMT history | registration, projection, sphere, nodata as documented | PixelIsArea + GMT -r (centres = corner + 2.5 m); polar stereographic on 1737.4 km sphere; NaN nodata, 0 NaN | pass
2026-11-14 | 5 m vs 20 m alignment (5 m assessment) | 640 000 coincident 20 m cells; shift search ±40 m | consistent height reference; best fit among tested shifts | +0.28 m tile / +0.15 m within 1 km; lowest RMS at (0, 0) among ±40 m in 5 m steps (sub-5 m, larger, rotational offsets not tested) | pass
2026-11-14 | 5 m tile edge (5 m assessment) | 640 edge points; beyond-tile profile | hand-off cannot set the horizon | Δh mean +0.46 m (≤ 0.061°); beyond-tile terrain ≥ 1.46° below | pass
2026-11-14 | 5 m numerical convergence (5 m assessment) | radial, azimuth variants | converged | ≤ 0.017° and 0 steps (radial halving); 0.003° (azimuth) | pass
2026-11-14 | 5 m vs 20 m horizon and metrics (5 m assessment) | product, sampling, observer, location, near terrain | report separately | product 0.97° / 321 Sun steps; sampling 0.38° / 78; eye 0.4 m 0.60° / 248; 100 m 3.1–3.8° / 3 079–4 153 | reported; recommendation provisional
2026-11-14 | Two-site interface: unit/render tests (4D) | 7 vitest files | references, identity, no mixing, no leakage, URL, assessment consistency | 90 passed | pass
2026-11-14 | Two-site interface: production build (4D) | `npm run build` | no errors | JS 293 kB (91 kB gzip) | pass
2026-11-14 | Two-site interface: headless Chrome (4D) | production build, 1280/390 px, light/dark | 42 scripted checks + screenshots inspected | 42/42; 5 layout/wording bugs found and fixed first | pass (human review pending)
2026-11-14 | Regression after 5 m code (5 m assessment) | tests, validate, exports | unchanged | 58 OK; 136/136; Athena 74/74 sha256; both exports byte-identical | pass

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
- **CR1 terrain robustness (4C, open):** skyline set 50–480 m away by 20 m DEM
  relief at a point whose nearest pixel has no LOLA shot. Sun-visibility results
  change by tens of percentage points under 100 m scenarios, the 60 m DEM, or
  ignoring terrain < 300 m. Lander height, boulders and sub-pixel relief are
  unmodeled and would matter here. How to present this is undecided.
  The 5 m PGDA assessment is consistent with this: the product change is of the
  same order as the angle scale of its own stated 1σ error, and eye height and
  position matter as much or more. **CR1 terrain stays provisional.**
- CR1 eye is 0.979 m (rounded surface), skyline effect ≤ 0.024°, 13 Sun steps:
  kept for consistency with the established convention.
- CR1 RDR skyline comparison is uninformative (0–2 shots per window); no
  independent terrain data for CR1 was used.
- (Resolved) `manifest.dataset_id` named Athena only; renamed to `lvn-2026-12-01-60d` in the science-review follow-up.
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
**3D Explore** as the primary user experience, with the current dashboard kept
as Analysis (shared site/time/scenario state). Requirements: `docs/SPEC.md`,
"3D Explore: requirements for the next milestone". Before that: review and
commit the science-review follow-up. Milestones 4A–4D are merged; both sites
are in the app, and CR1 terrain is provisional.

## Milestone checklist
- [x] Shared data contract accepted (v1.0 + clarifications).
- [x] One site with real sky positions.
- [x] Complete smooth-horizon workflow.
- [x] Terrain loaded and inspected (4 LOLA products downloaded, sizes = labels, sha256 recorded).
- [x] First terrain horizon checked (synthetic tests, sensitivity, independently implemented pixel sweep, LOLA-shot consistency); reviewed in the browser 2026-11-14.
- [x] Milestone 4A: explicit site selection and pipeline file isolation.
- [x] Milestone 4B: second point cited, cached coverage planned, surface/observer altitude documented.
- [x] Milestone 4C: CR1 positions fetched and validated; terrain horizon computed, implementation-checked, sensitivity reported (not robust).
- [x] CR1 terrain-product assessment (5 m PGDA Site01): recommendation, retain CR1 terrain as provisional.
- [x] Second site integrated in the frontend (4D, merged in PR #2; human browser review checklist still pending).
- [x] Science review (2026-11-14, no blocking issue) and follow-up: review checks in the repo, two-site direction test, shared selected-time status, wording (uncommitted on `science-review-followup`).
- [ ] 3D Explore (next milestone; requirements in SPEC.md).
- [x] Date-slip comparison verified (smooth horizon).
- [ ] Sources and limitations complete: per-site sources and limitations shown in the app (4D); awaiting human review.
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
  Human verification: **pending** (written before the milestone commit;
  milestone 3 is now committed as `9e2b1b4` and included in `978f22a`).

- 2026-11-14 | OpenAI Codex | Milestone 4A: site IDs, report/export/cache isolation,
  focused synthetic tests and Athena regression verification | pipeline/,
  renamed/annotated cached evidence, README.md, docs | Human verification: **pending**.

- 2026-11-14 | OpenAI Codex | Milestone 4B: two-candidate source review,
  NASA CR1 selection, cached coarse coverage/surface elevation, offline tool
  support and five focused tests | pipeline/, new CR1 preparation reports,
  docs/SECOND_SITE.md, SPEC.md, STATUS.md, README.md | Human verification: **pending**.

- 2026-11-14 | Claude Code (Claude Opus 5.5) | Milestone 4C: CR1 Horizons
  retrieval, exports, terrain horizon, cross-checks, rounding check; fixes in
  `terrain_sensitivity.py`, `validate.py`, `horizon_crosscheck.py`, `export.py`;
  new `observer_rounding_check.py`; 2 tests | pipeline/, data/horizons,
  data/terrain, app/public/data, docs | Human verification: **pending**
  (`627a4cc`, merged in PR #2).

- 2026-11-14 | Claude Code (Claude Opus 5.5) | Milestone 4D two-site interface:
  `app/src/App.tsx`, `data.ts`, `sites.ts`, `assessment.ts`, `urlState.ts`,
  `Timeline.tsx`, `Panorama.tsx`, `types.ts`, `styles.css`, `index.html`, tests;
  README, DATA_CONTRACT, STATUS | Human verification: **pending** (merged in
  PR #2; browser review checklist not yet ticked by a person).

- 2026-11-14 | Claude Code (Claude Opus 5.5) | CR1 terrain-product assessment:
  `pipeline/pgda.py`, `pipeline/terrain_5m.py`, `pipeline/tests/test_pgda.py`,
  PGDA dispatch in `terrain_horizon.py`, assessment report, docs | Human
  verification: **pending** (`ca0c996`, merged in PR #2).

- 2026-11-14 | Claude Code (Claude Opus 5.5) | Science-review follow-up:
  `app/src/status.ts` (+ tests), `App.tsx`, `Panorama.tsx`, `Timeline.tsx`,
  `styles.css`, `app.test.tsx`; `pipeline/direction_check.py`,
  `pipeline/review/`, `pipeline/tests/test_conventions.py`, CR1 wall test;
  `config.json` dataset ID + full re-export (site files unchanged); docs |
  Human verification: **pending** (uncommitted on `science-review-followup`).

- 2026-11-14 | OpenAI Codex | Bounded completion of the interrupted
  science-review follow-up: status interval-gap/final-endpoint guards and six
  regression tests; Earth-distance provenance and shared-error limitations;
  stale milestone 3 commit wording; lightweight checks and base-data comparison
  | `app/src/status.ts`, `status.test.ts`, `pipeline/direction_check.py`,
  `docs/SCIENCE_REVIEW.md`, `docs/STATUS.md` | Human verification: **pending**;
  all work remains uncommitted.

## Handoff template
- Completed:
- Files changed:
- Checks run and results:
- Remaining uncertainty:
- Next task:
