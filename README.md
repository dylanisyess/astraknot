# astraknots: Lunar Visibility Navigator

A NASA Space Apps prototype that shows when the Sun and Earth are above the
horizon from lunar south-polar sites. It is an educational planning tool, not
flight-qualified analysis.

**Milestone 4B complete (second-site terrain preparation):** mission windows for one documented
site (IM-2 Athena landing point, 84.7906° S, 29.1957° E) with a **terrain
horizon** computed from the LOLA terrain model (20 m pixels), and the smooth 0° horizon kept as a
comparison mode. The data is 60 days (2026-12-01 to 2027-01-30 UTC) of real
JPL Horizons Sun and Earth azimuth/elevation at 10-minute steps, for an
observer 1 m above the LOLA surface. You can pick a baseline arrival and
duration, compare +1/+3/+7-day slips, switch Smooth/Terrain, and see a horizon
panorama, visibility timelines, an elevation chart and readouts that share one
cursor. This is regional DEM-based visibility, not a reconstruction of
Athena's actual conditions. A second point, NASA's notional Connecting Ridge CR1
study location (89.468 S, 222.6 E), is configured with cached coverage/elevation
evidence; it has no fetched positions or final horizon yet. See
[docs/SECOND_SITE.md](docs/SECOND_SITE.md) and [docs/STATUS.md](docs/STATUS.md).

## Layout

```
app/                 React + TypeScript + Vite frontend
  public/data/       exported data the app loads (manifest.json, <site>.json)
  src/               UI code and tests (data.test.ts)
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
  tests/             unit tests (synthetic fixtures)
data/horizons/       raw Horizons responses (byte-for-byte) + request metadata
data/terrain/        LOLA PDS labels, coverage report, terrain horizon + cross-check reports (committed)
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
are errors. Two sites are configured and both have exported app data (CR1 since
milestone 4C), but the frontend still displays only Athena. CR1's terrain horizon
is set by relief within ~500 m and is highly position-sensitive; see
`docs/STATUS.md`, "Milestone 4C".

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
`t` = cursor time, `horizon` = `terrain` or `smooth`).

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
- Nothing is deployed yet.

## Sources
- Site coordinates: LROC, [IM-2 Athena Seen Obliquely](https://lroc.im-ldi.com/images/1408)
- Terrain: LOLA gridded products LDEM/LDEC_80S_20M and LDEM/LDEC_75S_60M,
  PDS Geosciences Node, [LRO-L-LOLA-4-GDR-V1.0 polar products](https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/polar/img/);
  individual LOLA RDR shots via the [ODE GDS service](https://oderest.rsl.wustl.edu/livegds/)
- [JPL Horizons API](https://ssd-api.jpl.nasa.gov/doc/horizons.html) and
  [Horizons manual](https://ssd.jpl.nasa.gov/horizons/manual.html)
