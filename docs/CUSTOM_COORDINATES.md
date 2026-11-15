# Custom south-polar coordinates: static demonstration, prototype and public design

## Current capability

> Custom coordinates can be processed with the offline Python pipeline. This site demonstrates
> one generated result. Live coordinate processing is not available on this deployment.

There is no backend, queue, paid host or live processing. Status 2026-11-15, prepared locally;
**not committed, pushed or deployed.**

### What is packaged

The demonstration is one **optional fifth site** in the current 120-day dataset
(`lvn-2026-12-01-120d`):

| Field | Value |
|---|---|
| Site ID | `custom-85p5s-315e` |
| Name | Custom-coordinate demonstration (85.5 S, 315.0 E) |
| Short name | Custom demo |
| Catalog location type | `user_defined_study_point` ("User-defined study point") |
| Status | Not a documented landing site or an approved landing target |

How it sits next to the curated sites:
- **Same contract:** it went through the same configured-site path as Apollo 17 and Odysseus (`prepare_site.py --config pipeline/config.json --site custom-85p5s-315e --publish`, then `context_terrain.py`).
- **Defaults unchanged:** a link without `sites` still compares Apollo 17 only, and at most four sites can be compared at once.
- **Guided example unchanged:** the guide's finder step selects the four documented sites, not the custom point.

Bundle `92fe1a278e16…` contains:
- the observer: LDEM_80S_20M surface −3866.41 m, Horizons altitude −3.8654 km, eye 1.0137 m above the interpolated surface;
- 3,600 skyline rays with 0 unknown directions;
- the 5 m-spacing mesh and the 500 m slope grid.

Its 24 Horizons responses are the cached ones from the prototype, unchanged, and no new
request was made. `validate.py` passes **331/331** checks for all five sites, covering
timestamps, observer, model metadata, asset identities and an exact re-classification of
intervals.

### Source-aware wording in the app

The wording is driven by the catalog location type, never by the site ID:
- **Analysis Terrain banner:** says "published coordinates" for curated sites, "a user-defined study point (an entered coordinate)" for this point, and "published coordinates and a user-defined study point" when both are compared.
- **Coordinate source:** shown as text, not a link, because a user-defined point has no source URL.
- **Facts panel:** Explore's "About" panel and Analysis's "Method, sources and limitations" show a "User-defined study point: inputs and limitations" panel. It covers the entered coordinates and frame, terrain sources and pixel size, observer height and eye, sampling (17,281 samples every 10 minutes), the processing bundle, and the limitations, including the statement above. Every value is read from the site's data file.
- **Catalog card:** the "Add site" card shows the type label and the same limitations.

### Terrain versus smooth (verified from exported data)

`python pipeline/review/custom_demo_metrics.py` recomputes every 10-minute state independently
from the exported samples and horizon profiles. Its record is
[data/release/custom_demo_metrics.json](../data/release/custom_demo_metrics.json).
- **Exported intervals:** it matches them exactly (0.0 pp difference).
- **App metrics:** `app/src/customDemo.test.ts` checks the app's own `computeMetrics` against this record. Both are computations; no result is hard-coded into either.

| Scope | Horizon | Sun | Earth | Sun + Earth |
|---|---|---|---|---|
| **Full coverage**, 2026-12-01 to 2027-03-31 (120 days) | Smooth 0° | 53.13 % | 56.87 % | 19.01 % |
| | Terrain | 10.75 % | 31.18 % | **0.00 %**: no 10-minute step has both |
| **Mission window**, 14 days from 2026-12-15 00:00 UTC | Smooth 0° | 71.97 % | 99.16 % | 71.13 % |
| | Terrain | 16.47 % | 62.80 % | **0.00 %** |

These are two different measures and should be quoted separately:
- **Full-coverage shares** describe the whole dataset.
- **Mission-window shares** describe one 14-day arrival.

Across all 107 daily 14-day arrivals, the terrain Sun + Earth share is 0.00 % for every one
of them. The demo window is chosen by a stated rule: the largest smooth-minus-terrain gap,
earliest on ties. The comparison site, Athena, shows 98.66 % Sun + Earth in the same window
with its terrain horizon.

**Demo scenario:**
`/?ds=lvn-2026-12-01-120d&sites=im2-athena,custom-85p5s-315e&site=custom-85p5s-315e&arrival=2026-12-15T00:00Z&days=14&delay=0&horizon=terrain&view=analysis`
In Explore, `&view=explore&t=2026-12-20T12:00:00Z` shows the Earth window open and the Sun blocked by terrain.

### Download size added

| Asset | Bytes (LF) | gzip -9 | Fetched |
|---|---|---|---|
| Catalog, manifest and dataset-index entries | +1,349 | — | every visit |
| `data/lvn-2026-12-01-120d/custom-85p5s-315e.json` | 3,336,971 | 626,098 | only after the point is added |
| `render/custom-85p5s-315e.terrain.{json,bin}` | 7,099,170 | 5,281,092 | Explore, point active |
| `render/custom-85p5s-315e.context.{json,bin}` | 682,039 | 577,442 | Explore, after the mesh |
| `screening/custom-85p5s-315e.slope.json` | 32,952 | 11,642 | Explore screening |
| **Total if fully explored** | **11,151,132** | **6,496,274** | |

Repository evidence that is not served:
- 48 Horizons cache files (2.43 MB);
- the bundle without its ignored ray files (9.28 MB);
- this document and the metrics script and record.

Raw terrain, `data/custom/` (private config, checks, screenshots, the prototype's separate
dataset) and the superseded prototype bundle `c7e96707…` remain git-ignored.

### Checks performed

- **Accepted outputs:** 433 pre-existing files under `app/public`, `data/prepared`, `data/horizons`, `data/terrain`, `data/render` and `data/screening` were hashed before and after. The only changes are the 120-day `manifest.json` (site appended, `generated_at_utc`) and `catalog.json` (site appended, manifest hash, and the `terrain_3d.bytes` correction below), plus `pipeline/config.json`. The four sites' data, render, screening files and bundles are byte-identical. The accepted 60-day release validates **136/136**.
- **Tests:** 104 Python tests and **422 frontend tests** pass (7 new; two real-dataset tests updated from four to five sites). Typecheck and production build pass.
- **Real browser:** headless Edge (SwiftShader WebGL) was driven through the DevTools protocol against `vite preview` on 127.0.0.1, with **12/12 steps passing**:
  1. default selection;
  2. catalog entry and add;
  3. About facts;
  4. Horizon view and Site overview, with mesh, context and slope files fetched for the point and no asset or scene error;
  5. Smooth/Terrain switching;
  6. URL reload keeping sites, active site, mode, camera and time;
  7. switching the active site and removing the point;
  8. the four-site limit blocking a fifth;
  9. Analysis with Athena, the source-aware banner and the unlinked coordinate source;
  10. Analysis Smooth versus Terrain (Sun + Earth 71.1 % versus 0.0 %);
  11. the arrival finder across Athena and the point (214 candidates);
  12. no uncaught errors.

  The step results are in [data/release/custom_demo_browser_check.json](../data/release/custom_demo_browser_check.json). The driver script and screenshots stayed local.
- **Not done:** narrow and phone layouts, keyboard-only navigation, reduced motion, and any non-Edge browser.

### Changes made while packaging, and a known issue

- **Catalog byte count.** `catalog.py` counted the render metadata file with `stat().st_size`, which includes CRLF on a Windows checkout. It now uses LF bytes, like every other catalog size. Display changes: Athena's and CR1's `terrain_3d.bytes` change by −214 and −190 bytes (shown as 6.5 / 4.7 MB either way), and Odysseus's and Apollo 17's are unchanged from the committed values.
- **Known issue, not fixed.** `prepare_site.validate_bundle` reads `input.json` without an explicit encoding. On Windows, non-ASCII site text (for example "°") therefore hashes differently and the bundle fails validation. The demonstration's site text is ASCII. Fixing the reader changes `prepare_site.py`'s implementation hash and so the fingerprint of any future rebuild of the curated generic sites. Do it as a separate reviewed change.

---

*Sections 1–7 below are the earlier local prototype record (separate dataset, no catalog entry).
Their measurements stand. Section 4's separate-dataset packaging is superseded by the
integration above.* Measurements: [data/release/custom_coordinate_prototype.json](../data/release/custom_coordinate_prototype.json).

## 1. Supported region (measured, not assumed)

The cached sources were scanned directly (strided raw pixels plus the pipeline's own
bilinear sampler at every 1° of longitude):

| Source | Invalid pixels (strided scan) | Bilinear-valid edge |
|---|---|---|
| LDEM_80S_20M (local, ~20 m) | 0 of 2,310,400 | 80.01° S on the 0/90/180/270° E axes; 75.9° S at the square's corners |
| LDEM_75S_60M (local, ~60 m) | 0 of 2,325,625 | 75.01° S axes; 68.91° S corners |
| LDEM_64 (distant only, ~474 m) | 0 of 1,179,648 | global, valid to the pole |

The registered SLDEM tile is **not cached** on this machine. It does not affect the south pole.

**Conservative public region: latitude ≤ 80.5° S at any longitude.** This keeps the
coordinate at least ~15 km inside the 20 m raster's closest edge, well beyond the 2.7 km
mesh diagonal and the 500 m slope footprint. Latitude alone is only the **pre-check**.
A coordinate counts as supported only when `prepare_site.py` writes `complete.json`:

- the observer, mesh and slope footprint were sampled from a ≤100 m local source, with all
  four bilinear neighbours valid;
- all 3,600 skyline rays stopped inside valid data;
- the products were validated.

If any of these fails, the job fails. It never falls back to a nearest site, a smooth
horizon or a flat terrain substitute.

## 2. What was run

The coordinate was **85.5° S, 315.0° E**: a user-style study point, unprocessed before
and distinct from Athena, CR1 and Odysseus. The observer is 1 m above the surface, the
coverage is the current 120-day dataset (2026-12-01 to 2027-03-31) and the step is 10 minutes.
The existing pipeline ran unchanged, from a private config:

```powershell
# private config (git-ignored): dataset_id custom-85p5s-315e-120d, dataset_dir app/public/data/custom-85p5s-315e
python pipeline/prepare_site.py --config data/custom/custom-85p5s-315e/config.json --site custom-85p5s-315e   # fresh build
# copy the derived horizons_site_altitude_km / surface_elevation_m from complete.json into the config, then:
python pipeline/prepare_site.py --config data/custom/custom-85p5s-315e/config.json --site custom-85p5s-315e   # CACHE VALID
python pipeline/fetch.py        --config data/custom/custom-85p5s-315e/config.json --site custom-85p5s-315e   # 24 Horizons requests
python pipeline/prepare_site.py --config data/custom/custom-85p5s-315e/config.json --site custom-85p5s-315e --publish
python pipeline/context_terrain.py --site custom-85p5s-315e
python pipeline/validate.py     --config data/custom/custom-85p5s-315e/config.json --site custom-85p5s-315e   # 65/65 PASS
```

Results:
- **Bundle and observer:** bundle `c7e96707…`. DEM surface −3866.41 m (LDEM_80S_20M), Horizons altitude −3.8654 km, effective eye 1.0137 m.
- **Skyline:** 0 unknown azimuths. Rays stopped at 89.7 / 130.3 / 176.9 km (min / median / max), all within LDEM_80S_20M (0 source transitions). Distant terrain matters: the skyline rises up to **2.36° beyond 50 km**, and by 0° beyond 100 km. The largest change under half-step refinement is 0.0156°.
- **Mesh (display only):** 7 of 746 inside-footprint directions exceed the proposed 0.05° target (maximum 0.057°). Visibility comes only from the exported profile.
- **Slope:** median / p95 / maximum 5.42 / 8.03 / 12.79°, 100% of the 500 m footprint valid, baseline about 40 m.
- **Visibility finding:** with the terrain horizon, the Sun and Earth are **never both above the skyline in 120 days**. Earth's centre is up 31% of the time and the Sun's 10.8%, in alternating periods. The smooth 0° model gives 71% simultaneous visibility for the best 14-day window. Nearest-site or smooth-only answers would be badly wrong here.
- **Accepted assets:** all 61 pre-existing files in `app/public/{data,render,screening}` and `data/prepared` were hashed before and after: **0 changed**. 104 Python tests and 415 frontend tests pass, and the build passes.

## 3. Measured cost of one fresh coordinate (this laptop, 4 workers)

| Stage | Wall time | Peak memory (sum of Python processes) | Network |
|---|---|---|---|
| Observer + 3,600 rays + refinement + mesh + slope (fresh) | 47.6 s (≈3 s is SHA-256 of the 2.8 GB source rasters) | 1,313 MB working set (includes shared mmap DEM pages), 536 MB private, 5 processes | 0 |
| Same command, valid cache | 3.9 s | 62 MB | 0 |
| Horizons, 24 queries (2 bodies × 12 ten-day chunks), sequential with pauses | 53.0 s | 32 MB | **24 requests**, 0 failures, 2.4 MB |
| Export + asset copy + catalog | 8.4 s | 62 MB | 0 |
| Context terrain | 1.7 s | 251 MB working set / 132 MB private | 0 |
| Validation | 1.5 s | 59 MB | 0 |
| **Fresh total** | **≈112 s** | **≈1.3 GB peak** | **24** |

**Served result: 11.2 MB raw**:
- site JSON 3.36 MB (0.66 MB gzip);
- mesh binary 7.10 MB (5.27 MB gzip);
- context terrain 0.68 MB;
- slope 33 KB;
- manifest and catalog 2 KB.

The fingerprinted bundle is 10.8 MB, of which 1.5 MB is 3,600 per-ray resume files. The
worker needs the **2.84 GB** of cached rasters (LDEM_80S_20M, LDEM_75S_60M, LDEM_64) on
local disk, because the sampler memory-maps them.

## 4. App demonstration (prototype; superseded by "Current capability" above)

The custom site was a **separate dataset** (`custom-85p5s-315e-120d`) with its own
manifest and catalog. It was added only to the built `dist/data/datasets.json`. The
tracked index and the curated catalog were not edited. Through `vite preview` on
127.0.0.1:
- **Explore:** Horizon view with the exported skyline, Terrain-mode status, slope screening and timeline.
- **Analysis:** 1-site terrain comparison.
- **Arrival finder:** a script check called the app's own `loadIndexedDataset`, terrain/slope/context validators and `evaluate`/`bestPerSite` over 107 arrivals in both horizon models. The curated default dataset still loads exactly four sites.

The finder was checked by script, not by clicking through it in a browser. Screenshots
and the check script are in `data/custom/custom-85p5s-315e/checks/` (git-ignored, on
this laptop only).

**Isolation.** Every custom output is git-ignored, so it is never committed and Netlify
(which builds from git) never deploys it. A *local* `npm run build` does copy whatever is
in `app/public/` into `dist/`. After the demonstration, the custom public files were moved
to `data/custom/custom-85p5s-315e/public/` and `dist/` was rebuilt clean. To re-run the
demonstration:

```sh
cp -r data/custom/custom-85p5s-315e/public/* app/public/   # restores data/custom-85p5s-315e/, render/custom-*, screening/custom-*
cd app && npm run build
# append to dist/data/datasets.json -> datasets:
#   {"id":"custom-85p5s-315e-120d","label":"LOCAL PROTOTYPE · custom 85.5° S, 315° E","dir":"data/custom-85p5s-315e/"}
npx vite preview --host 127.0.0.1
# http://127.0.0.1:4173/?ds=custom-85p5s-315e-120d&view=explore&horizon=terrain
```

## 5. Smallest reliable public implementation (proposal)

### Coordinate validation (synchronous, at the API)
- Inputs: latitude and east longitude only. Longitude is normalized modulo 360.
- Fixed for v1, matching the curated release: frame MOON_ME_DE421, observer 1 m, the
  current dataset window, 10-minute step. No user-chosen dates, heights or frames in v1.
- Round to 4 decimals (about 3 m) and **display the processed coordinate**. Rounding
  bounds the key space and makes repeat requests hit the cache.
- Reject unless finite and **≤ 80.5° S**. Then do a quick (<1 s) check that the four
  corners of the 1,920 m mesh square sample from a local ≤100 m source. Points near a
  curated site are allowed, but are still processed and labelled as custom; they are
  never answered with the curated site's results.
- The authoritative gate stays `complete.json`, not the pre-check.

### Background processing worker
- A single worker process that writes a job config and runs:
  `prepare_site.py` → `fetch.py` → `--publish` → `context_terrain.py` → `validate.py`.
  This is exactly the sequence above.
- Needed refactor: `catalog.py`, `prepared_export.publish_assets` and `context_terrain.py`
  hard-code `app/public/{render,screening}`. They need an output-root argument so jobs
  write to a job directory, never into the app tree.
- Pre-verify the source raster hashes once at worker start-up, not per job.
- Resume is already built in: per-ray files and the Horizons cache let a retried job continue.

### Bounded queue and request limits
- **One job at a time** (≈1.3 GB peak, 4 cores, ≈2 min). Queue capacity 20; beyond that,
  reject with `queue_full`.
- Per-IP: 1 active job, at most 5 per day. Global: at most 100 fresh jobs per day, which
  is ≤2,400 Horizons requests per day, always sequential (single-flight).
- Job timeout 10 minutes. Identical (rounded) coordinates deduplicate to one job or result.

### Progress and error states
- `queued (position n)` → `terrain (rays k/3600)` → `ephemerides (k/24)` → `exporting` →
  `validating` → `complete`. Ray and chunk counts come straight from the resume files.
- Failures are explicit:
  - `rejected: outside_supported_region | queue_full | rate_limited`;
  - `failed: incomplete_terrain_coverage | horizons_unavailable | validation_failed | timeout`.
- A failed job publishes nothing and shows the reason. It never shows a substitute result.

### Cached result storage
- Immutable, content-addressed: `results/<fingerprint>/{manifest.json, catalog.json, <id>.json, render/…, screening/…}`.
- A small job table maps `job_id → state → fingerprint`.
- About 11 MB per result, so 100 results ≈ 1.1 GB. Set a retention policy (e.g. 90 days
  since last access) plus explicit pinning.

### Loading completed results in the app
- `?custom=<fingerprint>` loads one dataset from an allow-listed results origin (`RESULTS_BASE`).
  It is never merged into `datasets.json` or the curated catalog.
- Needed change: the dataset loader and the Explore asset loaders
  (`terrainAsset.ts`, slope, context) assume a single `base` for `data/`, `render/` and
  `screening/`. They need a per-dataset asset base.
- All existing validators (identity, observer, hashes, intervals) apply unchanged. Times
  are identical to the curated 120-day grid, so comparing against curated sites in one
  view is a later, separate change.
- Copy: Analysis currently says "results for published coordinates". Custom datasets need
  "user-entered coordinate, not reviewed".
- The coordinate form and job-status panel come last.

## 6. Hosting beyond the static Netlify site

Netlify keeps serving the static app. Custom processing needs three more things that
**do not depend on this laptop being online**:

1. **A compute host for the worker and a tiny API**, e.g. one small container or VM with
   a persistent volume. Minimum: 2–4 vCPU, ≥2 GB RAM, ≥5 GB disk for the 2.84 GB of rasters
   plus results, and outbound HTTPS to `ssd.jpl.nasa.gov`. Python standard library only.
   An always-on instance or a scale-to-zero job runner both work.
   Netlify Functions are not a fit, as documented at the time of writing (please confirm):
   memory is about 1 GB, the synchronous limit is about 10–26 s, background functions run
   at most 15 min, and the deploy-size limits cannot hold 2.8 GB of mmapped rasters.
2. **Durable storage for results and the job table.** The same volume, served with CORS,
   is enough for v1. Object storage is the scalable option.
3. **An HTTPS endpoint with CORS** for `POST /jobs`, `GET /jobs/:id` and the result files,
   with rate limiting at that edge.

Each of these is a paid or quota-limited service. Choosing one, and any deployment, is
still the owner's decision. None was set up here.

## 7. Remaining integration (not done)

Ordered list:
1. Output-root refactor (catalog, asset publish, context terrain), with tests.
2. Worker script that generates the job config and drives the stages.
3. Job API, queue and limits.
4. Frontend `?custom=` loader with a per-dataset asset base.
5. Custom-coordinate copy and badge.
6. Coordinate form and status UI.
7. Hosting selection and deployment.

Also outstanding: a full browser pass of the finder drawer (clicking through it) with a
custom dataset.
