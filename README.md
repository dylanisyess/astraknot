# astraknots: Lunar Visibility Navigator

A NASA Space Apps prototype that shows when the Sun and Earth are above the
horizon from lunar south-polar sites. It is an educational planning tool, not
flight-qualified analysis.

**Milestone 2 (current):** smooth-horizon mission windows for one documented
site (IM-2 Athena landing point, 84.7906° S, 29.1957° E). The data is 60 days
(2026-12-01 to 2027-01-30 UTC) of real JPL Horizons Sun and Earth
azimuth/elevation at 10-minute steps, for an observer 1 m above the LOLA
surface. You can pick a baseline arrival and duration, and compare +1/+3/+7-day
slips. Visibility timelines, an elevation chart and the readouts all share one
cursor. Terrain is **not yet included**. See [docs/STATUS.md](docs/STATUS.md).

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
  lola.py            LOLA PDS label parsing, polar projection, range reads
  terrain_check.py   verify LOLA products, bounds, orientation, coverage
  tests/             unit tests (synthetic fixtures)
data/horizons/       raw Horizons responses (byte-for-byte) + request metadata
data/terrain/        LOLA PDS labels + terrain coverage report (committed)
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
python pipeline/fetch.py          # uses the cache; fetches only what is missing
python pipeline/export.py         # writes app/public/data/*.json
python pipeline/validate.py       # prints PASS/FAIL per check
python -m unittest discover -s pipeline/tests -v
python pipeline/terrain_check.py  # LOLA product/coverage check: downloads ~44 MB
                                  # to data/raw/lola/, rest via byte-range reads
python pipeline/site_elevation.py # surface elevation vs LOLA shots (cached query)
python pipeline/compare_altitude.py
python pipeline/crosscheck_metrics.py 2026-12-05T00:00:00Z 14

# 2. Frontend
cd app
npm install
npm run dev                       # http://localhost:5173
npm test                          # vitest unit tests
npm run build                     # typecheck + production build -> app/dist/
npm run preview                   # serve the built app on http://localhost:4173
```

The scenario is kept in the URL, for example
`http://localhost:5173/?arrival=2026-12-05T00:00Z&days=14&delay=3&t=2026-12-12T22:20:00Z`
(`arrival` = baseline arrival in UTC, `days` = mission duration, `delay` = 0, 1, 3 or 7,
`t` = cursor time).

## Re-fetching from JPL Horizons
- The coverage is split into 10-day chunks (`horizons_chunk_days`). Requests go
  one at a time with a pause between them, and transient errors (HTTP 429/5xx,
  timeouts) are retried up to 3 times with backoff. Each response is cached
  in `data/horizons/<site>__<target>__<hash>.response.json`, keyed by the
  exact query parameters, with a `.meta.json` next to it holding the request
  URL, parameters, HTTP status, response headers, API signature, retrieval time
  and sha256.
- `python pipeline/fetch.py --print-urls` prints the exact query URLs. Each can
  be reproduced with `curl -sS "<url>"`.
- `python pipeline/fetch.py --refresh` re-downloads everything.
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
- [JPL Horizons API](https://ssd-api.jpl.nasa.gov/doc/horizons.html) and
  [Horizons manual](https://ssd.jpl.nasa.gov/horizons/manual.html)
