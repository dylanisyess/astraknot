# Astraknot: Lunar Landing Site Navigator

A NASA Space Apps prototype that shows when the Sun and Earth are above the
horizon from documented lunar landing and study sites. It is an educational
planning tool, not flight-qualified analysis. (Earlier milestone records below
use its former name, Lunar Visibility Navigator; dataset IDs and URLs are unchanged.)

**First visit (current release, `149c89f`).** A first root visit opens a short welcome screen.
"Watch a south-pole sunrise" loads a hypothetical 14-day Terrain mission at the IM-1 Odysseus
landing point (Malapert A region), arriving 2026-12-18 00:00 UTC with the dataset's dates (not a
replay of the 2024 IM-1 landing), and starts a skippable three-step guide:
1. **Watch the Sun clear the ridge:** Horizon view tracking the Sun, starting 3 h before the Sun's
   center crosses a 5.28° terrain ridge near 10:40 UTC; the guide's Play runs at 3 h/s, so the
   crossing appears about 1 s after Play.
2. **Compare another site:** the "+ Add site" control, an explicit "Add Athena for comparison"
   button, both sites' metrics and switching between them.
3. **Test a 3-day arrival delay:** baseline → +3 d values for the compared sites, then Find arrival
   windows with those sites pre-selected.

"Open navigator", or a later root visit, opens the same scenario without the guide; "How to use"
in the header reopens the welcome screen. Scenario links open as given. Why this example was
chosen, and every number it shows: [docs/STATUS.md](docs/STATUS.md), "Mentor feedback and
south-polar guided introduction". (The earlier Apollo 17 example is recorded there under
"Onboarding".)

**Hosting note.** A Netlify "Powered by Netlify" badge in the bottom-right corner is
injected by Netlify at the edge, not by this app. The owner can turn it off in the
Netlify UI under *Project configuration > General > Powered by Netlify badge*; the app
keeps its controls out of that corner either way. See [docs/STATUS.md](docs/STATUS.md),
"Presentation polish".

**Releases (2026-11-15).**
- *Current release candidate (`149c89f` on `main`, on top of `868883b`):* five catalog sites, four
  documented sites (IM-2 Athena, Connecting Ridge CR1, IM-1 Odysseus, Apollo 17) plus one
  custom-coordinate demonstration, with **up to four compared at once**; the Odysseus opening and
  revised guide above; an Analysis takeaway with one "Method & limits" disclosure; chart and view
  recovery states; Horizon view opening on the Sun; turn-direction edge labels. Frontend and
  documentation only on top of the five-site data. Deployment state: see "Deployment" under Notes.
- *Four-site release (accepted; merged to `main` as `c0622dc`):* continuous body
  tracking, a catalog/shortlist of up to four sites, and versioned 120-day data
  (2026-12-01 to 2027-03-31, 10-minute samples). Athena, CR1, Apollo 17 and Odysseus
  have Smooth/Terrain visibility, local meshes and slope screening. Accepted
  two-site 60-day data remains unchanged. The dataset and comparison model are
  explicit; different slope measurement scales are disclosed.
- *Arrival Window Finder release (branch `milestone-7-arrival-finder`):* the finder
  described below, Earth-blockage metrics, bounded percentage formatting and shipped
  third-party notices. Frontend only: no dataset, terrain asset or scientific
  calculation changed. Evidence: [docs/STATUS.md](docs/STATUS.md), "Release summary".

**Custom-coordinate demonstration.** Custom coordinates can be processed with the offline Python
pipeline. This site demonstrates one generated result. Live coordinate processing is not available
on this deployment. There is **no public coordinate-input service**: the app has
no coordinate field, and new coordinates are processed only locally with the pipeline. The result
(85.5° S, 315.0° E, a user-defined study point, not a documented landing site or an approved
landing target) is an optional fifth site of the 120-day dataset, never a default, and can be one
of the four compared sites; see
[docs/CUSTOM_COORDINATES.md](docs/CUSTOM_COORDINATES.md), which also records the prototype
measurements and a proposed public worker, queue and hosting design.

[Coordinate-driven offline preprocessing](docs/COORDINATE_PIPELINE.md) documents
how to generate observer, skyline, mesh and slope for another supported coordinate
using configuration or CLI inputs without processing-code edits. It includes the
third-coordinate smoke test, missing-coverage rejection and NASA source provenance.
Apollo's mesh agreement target and the Odysseus kernel/DEM height difference
remain explicit limitations. [Current status and acceptance](docs/STATUS.md)
records, for the four-site release, 101 Python tests, 317 frontend tests (343 at its
merge), a passing production build and 136/266 dataset checks, with partial browser
acceptance; for the finder release, 394 frontend tests and its own browser checks.
Neither release has been deployed. *(Correction, 2026-11-15: both are merged and pushed, and so
are `868883b` and `149c89f`; for the deployment state see Notes.)*

**Arrival Window Finder (release 7):** "Find arrival
windows" in Mission setup (Explore) or the shared scenario (Analysis) opens a drawer that
checks arrivals once per UTC day at a chosen UTC hour for one full mission duration,
across any sites of the current dataset (or only the active site), with the current horizon
model. It summarizes the best matching arrival per site, previews +1/+3/+7-day slips for any
result, and never displays 100 % or 0 % unless exact. It
ranks by simultaneous Sun + Earth availability (default), sunlight, Earth visibility or the
shortest longest Sun/Earth blockage within the mission, shows the actual values with
boundary warnings, applies optional user limits, exports CSV, and changes the scenario only
through "Use this arrival". Results are the best among evaluated dates, not a
continuous-time optimum, and not a landing-safety rating. See
[docs/STATUS.md](docs/STATUS.md), "Arrival Window Finder".

The milestone descriptions below describe the accepted two-site baseline;
the feature candidate above extends its site count, coverage and terrain sources.

**Explore (default view, milestones 5A–5C):** a 3D view of the real LOLA terrain
around a fixed modeled observer at either site. It frames the challenge directly:
direct sunlight (solar-power potential) and Earth visibility (direct-to-Earth
communication windows) at the viewing time, a four-state mission timeline
(Sun + Earth / Sun only / Earth only / neither) and guided navigation to horizon
crossings. A *Site overview* orbit and a fixed *Horizon view* from the observer
are offered. In the horizon view the exported skyline profile alone decides what
hides the Sun or Earth. The Sun and Earth disks use nominal display angular
diameters (0.53° and 1.9°), and terrain shading is illustrative, not modeled
sunlight. Every visibility label comes from the same status function as the
dashboard. The two-site dashboard described below is the **Analysis** view.

**Terrain hazard screening (milestone 5C):**
- Explore's Conditions panel reports how much of the terrain within 500 m of the modeled
  observer is steeper than an illustrative threshold (default 15°), and highlights
  those cells on the terrain.
- A full slope map is one click away.
- Slope is computed from the 20 m LOLA DEM over about 40 m
  (`pipeline/slope.py`). It screens steepness only: not boulders, small craters, bearing
  strength or landing safety.
- Analysis compares both sites with the same method, radius and threshold, next to
  their Sun and Earth availability, without a combined score.

**Two-site comparison (Analysis view, milestone 4):** the app compares
the IM-2 Athena landing point (84.7906° S, 29.1957° E) with Connecting Ridge CR1,
a NASA notional study point (89.468° S, 222.6° E; not an actual or approved landing
site). Both use 60 days (2026-12-01 to 2027-01-30 UTC) of real JPL Horizons Sun
and Earth azimuth/elevation at 10-minute steps, for an observer 1 m above the LOLA
surface. One shared scenario (baseline arrival, duration, +1/+3/+7-day slip,
Smooth or Terrain horizon, selected UTC time) drives a comparison card per site,
both sites' visibility timelines on one UTC axis, and a site selector for the
horizon panorama, readouts and elevation chart. The terrain horizon comes from
the LOLA terrain model (20 m pixels); the smooth 0° horizon is a comparison mode.
**CR1's terrain result is provisional**: its skyline is set by modeled relief
within ~500 m and changes noticeably with the terrain model, observer height and
position (a 5 m terrain assessment is summarized in the app). Results are
DEM-based visibility for published coordinates, not actual lander conditions,
and the app does not rank the sites. See [docs/SECOND_SITE.md](docs/SECOND_SITE.md)
and [docs/STATUS.md](docs/STATUS.md).

## Layout

```
app/                 React + TypeScript + Vite frontend
  public/data/       exported data the app loads (manifest.json, <site>.json)
  public/render/     3D rendering meshes (<site>.terrain.json/.bin) and wide context
                     terrain (<site>.context.json/.bin); display only, not scientific data
  public/screening/  terrain screening slope grids (<site>.slope.json; lazy-loaded)
  src/               UI code and tests; src/explore/ is the 3D Explore view
pipeline/            Python data preparation (standard library only)
  config.json        site, altitude, interval, chunking, terrain products
  horizons.py        Horizons queries, chunking, retries, cache, parser
  fetch.py           retrieve raw responses -> data/horizons/ (sequential)
  export.py          raw cache -> app/public/data/ (data contract v1.0)
  validate.py        contract + raw-vs-export checks
  site_elevation.py  verify LOLA surface elevation vs LOLA laser shots
  compare_altitude.py  0 km vs corrected-altitude angular differences
  crosscheck_metrics.py  independent reference for mission-window metrics
  lola.py            LOLA PDS label parsing, polar projection, range reads, streaming download
  terrain_check.py   verify LOLA products, bounds, orientation, coverage
  fetch_terrain.py   download the selected LOLA products -> data/raw/lola/ (3.47 GB)
  terrain_horizon.py terrain horizon ray march (+ terrain_sensitivity.py)
  horizon_crosscheck.py  pixel-sweep check (independent implementation), LOLA-shot consistency, azimuth sanity check
  render_assets.py   rendering meshes for Explore from the cached LDEM_80S_20M + mesh-vs-profile check
  context_terrain.py wide context rings (to 92 km) around each detailed mesh, from the cached local DEMs
  slope.py           DEM-derived slope within 500 m of each observer (terrain hazard screening)
  tests/             unit tests (synthetic fixtures)
data/horizons/       raw Horizons responses (byte-for-byte) + request metadata
data/terrain/        LOLA PDS labels, coverage report, terrain horizon + cross-check reports (committed)
data/render/         per-azimuth mesh silhouette vs exported profile (rendering evidence)
data/screening/      slope method, coverage, statistics and checks per site (screening evidence)
data/raw/            large downloads (git-ignored)
docs/                SPEC.md, DATA_CONTRACT.md, STATUS.md
```

## Requirements
- Python 3.10+ (no third-party packages)
- Node.js 20.19+ or 22.12+ (tested with Node 24.16, npm 11.13)

## Setup and run

From the repository root:

```sh
# 1. Data: the raw responses and exported files are committed, so this step
#    is only needed to change the site or interval, or to re-verify.
python pipeline/fetch.py --site im2-athena          # uses the cache; fetches only what is missing
python pipeline/export.py --site im2-athena         # writes app/public/data/*.json
python pipeline/validate.py --site im2-athena       # prints PASS/FAIL per check
python -m unittest discover -s pipeline/tests -v
python pipeline/terrain_check.py --site im2-athena  # LOLA product/coverage check: downloads ~44 MB
                                  # to data/raw/lola/, rest via byte-range reads
python pipeline/site_elevation.py --site im2-athena # surface elevation vs LOLA shots (cached query)
python pipeline/compare_altitude.py --site im2-athena
python pipeline/crosscheck_metrics.py --site im2-athena 2026-12-05T00:00:00Z 14
python pipeline/crosscheck_metrics.py --site im2-athena 2026-12-05T00:00:00Z 14 --terrain

# Terrain horizon (only to recompute it; the results are committed):
python pipeline/fetch_terrain.py --site im2-athena          # 3.47 GB of LOLA data -> data/raw/lola/ (git-ignored)
python pipeline/fetch_terrain.py --site im2-athena --check --rehash
python pipeline/terrain_horizon.py --site im2-athena        # ~10 s profile + ~5 min sensitivity
python pipeline/horizon_crosscheck.py --site im2-athena     # cross-checks (LOLA shot queries cached)
python pipeline/export.py --site im2-athena && python pipeline/validate.py --site im2-athena

# 2. Frontend
cd app
npm install
npm run dev                       # http://localhost:5173
npm test                          # vitest unit tests
npm run build                     # typecheck + production build -> app/dist/
npm run preview                   # serve the built app on http://localhost:4173
```

All pipeline entry points accept `--site ID`, for example:

```sh
python pipeline/fetch.py --site im2-athena
python pipeline/export.py --site im2-athena
python pipeline/validate.py --site im2-athena
python pipeline/crosscheck_metrics.py --site im2-athena 2026-12-05T00:00:00Z 14 --terrain
```

Fetch, export and validation default to all configured sites. The other commands
use the sole configured site by default; with multiple sites, specify `--site`.
IDs must be unique lowercase letters/digits separated by hyphens. Unknown IDs
are errors. Two sites are configured and both have exported app data; the frontend
loads every manifest site and compares them. *(Correction, 2026-11-15: five sites are now
configured in `pipeline/config.json` and exported in the 120-day dataset; the app compares up to
four of them at once.)* CR1's terrain horizon is set by relief
within ~500 m and is highly position-sensitive (provisional); see `docs/STATUS.md`.

Repeat CR1 preparation without network access:

```sh
python pipeline/terrain_check.py --site connecting-ridge-cr1 --offline
python pipeline/site_elevation.py --site connecting-ridge-cr1 --offline --dem-only
```

The latter omits local laser-shot checks and marks uncached product comparisons
unavailable. These commands do not create a final horizon or request positions.

Reports are `data/terrain/<site_id>_{lola_coverage_report,site_elevation_report,
terrain_horizon,horizon_crosscheck}.json` and
`data/horizons/<site_id>_altitude_comparison.json`. LOLA shot caches include the
site ID and query fingerprint; large raster/label caches stay shared by product.
Terrain cross-checks carry site identity and the exact horizon report SHA-256,
so rerunning a horizon requires rerunning its cross-check before export.
A scoped export preserves other valid manifest entries and their data files;
incompatible retained metadata or files cause an error before writing.
Coordinate source date/product belong in each site config as
`coordinate_source_retrieved_at_utc` and `coordinate_source_product`.

The scenario is kept in the URL, for example
`http://localhost:5173/?arrival=2026-12-05T00:00Z&days=14&delay=3&t=2026-12-14T12:00:00Z&horizon=terrain`
(`arrival` = baseline arrival in UTC, `days` = mission duration, `delay` = 0, 1, 3 or 7,
`t` = cursor time, `horizon` = `terrain` or `smooth`). Explore also uses `view`
(`explore` or `analysis`), `mission`, `cam` (`overview` or `horizon`), `layer` (terrain
overlay: `exceed` for steep areas, the default; `slope` for the full slope map; `hide`)
and `thr` (screening threshold in degrees).

## Re-fetching from JPL Horizons
- The coverage is split into 10-day chunks (`horizons_chunk_days`). Requests go
  one at a time with a pause between them, and transient errors (HTTP 429/5xx,
  timeouts) are retried up to 3 times with backoff. Each response is cached
  in `data/horizons/<site>__<target>__<hash>.response.json`, keyed by the
  exact query parameters, with a `.meta.json` next to it holding the request
  URL, parameters, HTTP status, response headers, API signature, retrieval time
  and sha256.
- `python pipeline/fetch.py --site im2-athena --print-urls` prints the exact query URLs. Each can
  be reproduced with `curl -sS "<url>"`.
- `python pipeline/fetch.py --site im2-athena --refresh` re-downloads Athena responses.
- Failed requests are never turned into data. The error, the saved failed
  body (`*.FAILED.json`) and a reproducible `curl` command are printed instead.
  `export.py` only reads the cache and never goes to the network.

Horizons settings used (verified against each response header): observer
`coord@301` (Moon), `GEODETIC` site `E-lon, lat, alt_km` = `29.1957,-84.7906,5.3229`
(east-positive longitude; altitude = 5321.9 m LOLA surface + 1 m observer, above
the 1737.4 km reference sphere),
quantity 4 (airless apparent azimuth/elevation of the target center),
`TIME_TYPE=UT` (UTC), targets Sun `10` and Earth `399`.

## Notes
- Windows: Vitest 5 fails if the shell's working directory uses a lowercase
  drive letter (`c:\...`). `npm test` runs through `app/scripts/run-vitest.mjs`,
  which works around this; calling `npx vitest` directly may not.
- **Deployment (checked 2026-11-15 evening, before this documentation pass):** `main` and
  `origin/main` are both at `149c89f`. The GitHub repository is now `dylanisyess/astraknot`
  (the local remote still uses the old name and is redirected). The repository has no Netlify
  configuration file and no CI workflow; GitHub records no deployment or commit status for
  `149c89f`. The hosted Netlify site's build settings live in the Netlify UI, so whether it
  serves `149c89f` must be confirmed on the site itself: `data/lvn-2026-12-01-120d/manifest.json`
  lists five sites, and a private-window root visit shows "Watch a south-pole sunrise".

## Sources

NASA source data, as accessed by the pipeline (the exact URL of every file is also recorded in
each site's data file under `sources`). NASA data and imagery are generally not subject to U.S.
copyright; NASA asks to be acknowledged
([NASA images and media usage guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/)).

| Resource | Public URL | Use | Attribution |
|---|---|---|---|
| JPL Horizons API (observer tables, quantity 4: airless apparent azimuth/elevation) | https://ssd.jpl.nasa.gov/api/horizons.api; [API documentation](https://ssd-api.jpl.nasa.gov/doc/horizons.html); [manual](https://ssd.jpl.nasa.gov/horizons/manual.html) | Sun and Earth directions every 10 minutes for each site's observer point (24 queries per site, cached in `data/horizons/`) | NASA JPL Solar System Dynamics |
| LOLA LDEM_80S_20M and LDEC_80S_20M | https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/polar/img/ldem_80s_20m.img (and `ldec_80s_20m.img`) | Near-field skyline, observer surface, 3D mesh and slope screening at the south-polar sites; laser-shot counts | LRO LOLA Science Team, NASA GSFC; PDS Geosciences Node |
| LOLA LDEM_75S_60M and LDEC_75S_60M | https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/polar/img/ldem_75s_60m.img (and `ldec_75s_60m.img`) | Far-field skyline and context terrain | Same |
| LOLA LDEM_64 | https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/cylindrical/img/ldem_64.img | Distant skyline beyond the polar rasters (Odysseus, custom demonstration) | Same |
| SLDEM2015 tile `sldem2015_512_00n_30n_000_045_float` | https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/sldem2015/tiles/float_img/sldem2015_512_00n_30n_000_045_float.img | Apollo 17 skyline, mesh and slope (59.2 m pixels) | NASA GSFC via PDS; merges LOLA with **JAXA SELENE (Kaguya) Terrain Camera** data (Barker et al. 2016, *Icarus* 273, 346–355). JAXA is an upstream contributor; no JAXA archive was accessed directly. |
| LOLA RDR laser shots (ODE GDS service) | https://oderest.rsl.wustl.edu/livegds/ | Consistency checks of the surface elevation and skyline points (not displayed data) | NASA PDS Geosciences Node |
| PGDA high-resolution LOLA topography, Site01 Connecting Ridge (5 m) | https://pgda.gsfc.nasa.gov/products/78 | CR1 sensitivity assessment only; not a selectable or displayed model | Barker et al. 2021, *Planetary and Space Science* 203, 105119, doi:10.1016/j.pss.2020.105119 |
| CGI Moon Kit colour map `lroc_color_poles_4k.tif` | https://svs.gsfc.nasa.gov/4720/ | Landing-page Moon image, rendered deterministically by `app/scripts/render_welcome_moon.py` (no generative imagery) | "NASA's Scientific Visualization Studio"; derived by SVS from the LRO LROC WAC mosaic, poles from LOLA albedo. The NASA insignia is not used. |

Coordinate references (one coordinate read from each; no imagery from them is included):

| Site | Reference |
|---|---|
| IM-2 Athena | LROC, "IM-2 Athena Seen Obliquely": https://lroc.im-ldi.com/images/1408 (LROC: NASA/GSFC/Arizona State University) |
| Connecting Ridge CR1 | NASA Lunar Surface Data Book ACD-50044 Rev A, p. 46: https://ntrs.nasa.gov/api/citations/20230007818/downloads/ACD-50044%20Lunar%20Surface%20Data%20Book%20Rev%20A.pdf#page=46 |
| IM-1 Odysseus | NAIF CLPS IM-1 frames kernel `clps_to2im_im1_v02.tf`: https://naif.jpl.nasa.gov/pub/naif/pds/pds4/clps/clps_spice/spice_kernels/fk/clps_to2im_im1_v02.tf |
| Apollo 17 | LROC, "Spacecraft Related Coordinates – 2016 Update" (Wagner et al. 2017, *Icarus* 283, 92–103): https://lroc.im-ldi.com/images/938 |
| Custom demonstration | User-entered coordinate (85.5° S, 315.0° E); no published source |

Derived products (deterministic outputs of this project's code from the cached inputs above,
reproducible with the commands in this README and docs/COORDINATE_PIPELINE.md): terrain skylines,
visibility intervals, mission metrics, 3D rendering meshes and context terrain
(`pipeline/render_assets.py`, `pipeline/context_terrain.py`), and slope screening grids
(`pipeline/slope.py`).

## Third-party software and fonts

Shipped in the app bundle:

| Component | Version | License | Source |
|---|---|---|---|
| React and React DOM | 19.3.1 | MIT | https://react.dev/ ; license https://github.com/facebook/react/blob/main/LICENSE |
| scheduler (React dependency) | 0.28.0 | MIT | https://github.com/facebook/react/tree/main/packages/scheduler |
| three.js | 0.187.0 | MIT (Copyright © 2010-2026 three.js authors) | https://threejs.org/ ; license https://github.com/mrdoob/three.js/blob/dev/LICENSE |
| Vite runtime helpers (module preload) | 8.3.8 | MIT | https://vite.dev/ ; license https://github.com/vitejs/vite/blob/main/LICENSE |
| Barlow Condensed SemiBold 600, Latin subset (WOFF2 from `@fontsource/barlow-condensed` 5.3.0) | 5.3.0 | SIL Open Font License 1.1 (Copyright 2017 The Barlow Project Authors) | https://github.com/jpt/barlow ; https://fontsource.org/fonts/barlow-condensed (package `@fontsource/barlow-condensed`) ; license text served at `welcome/fonts/BarlowCondensed-OFL.txt` |
| Space Grotesk 400/500, Latin subset (WOFF2 from `@fontsource/space-grotesk` 5.3.0) | 5.3.0 | SIL Open Font License 1.1 (Copyright 2020 The Space Grotesk Project Authors) | https://github.com/floriankarsten/space-grotesk ; https://fontsource.org/fonts/space-grotesk (package `@fontsource/space-grotesk`) ; license text served at `welcome/fonts/SpaceGrotesk-OFL.txt` |

SIL Open Font License 1.1: https://openfontlicense.org/open-font-license-official-text/ .
Icons are hand-written inline SVG (no icon library); there is no favicon file.

Development only (not shipped): TypeScript (https://www.typescriptlang.org/, Apache-2.0),
Vitest (https://vitest.dev/, MIT), `@vitejs/plugin-react` (https://github.com/vitejs/vite-plugin-react,
MIT), and, for the one-off Moon render script, NumPy (https://numpy.org/, BSD-3-Clause) and Pillow
(https://python-pillow.org/, MIT-CMU). The data pipeline uses the Python standard library only.

The minified bundle drops license comments, so every production build writes
`dist/THIRD_PARTY_LICENSES.md` with the full license text of each bundled package,
taken from the installed packages (`build.license` in `app/vite.config.ts`).
`npm run build` then runs `app/scripts/check-notices.mjs`, which fails the build if
any of those texts is missing. The app links the file from the Analysis footer
(below "Method & limits") and from the welcome screen's About panel.

## Use of AI tools

- **Tools:** Claude Code (Anthropic), OpenAI Codex and ChatGPT (OpenAI).
- **Development and debugging:** writing and refactoring application and pipeline code, and
  investigating defects (including the mentor's mobile Analysis report).
- **Tests and checks:** writing automated tests, and scripting the headless-browser and WebKit
  checks recorded in docs/STATUS.md.
- **Design:** interface layout, CSS and the guide's flow.
- **Writing:** interface copy and the project documentation.

The owner directed the work and reviewed the results.

**What is and is not AI output.**
- **NASA source data are not AI-generated.** That covers JPL Horizons positions, LOLA and
  SLDEM2015 terrain (with JAXA SELENE data upstream), the PGDA assessment product and the NASA SVS
  imagery.
- **Every result the app displays is computed deterministically** from those cached inputs by the
  project's code, which was written with AI assistance: skylines, visibility intervals, metrics,
  meshes, slope grids, the arrival-finder ranking and the rendered Moon image. The same inputs give
  the same outputs.
- **No result is produced by an AI model at run time.**
- **The app contains no generative images, audio or video.**

**Demo video:** edited screen recordings of the actual app, with Microsoft Clipchamp AI
narration added.
