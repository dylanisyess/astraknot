# astraknots: Lunar Visibility Navigator

A NASA Space Apps prototype that shows when the Sun and Earth are above the
horizon from lunar south-polar sites. It is an educational planning tool, not
flight-qualified analysis.

**Milestone 1 (current):** one documented site (IM-2 Athena landing point,
84.7906° S, 29.1957° E), one UTC day (2026-12-01) of real JPL Horizons Sun and
Earth azimuth and elevation at 10-minute steps, and an interactive elevation
chart. Terrain is **not yet modeled**. See [docs/STATUS.md](docs/STATUS.md).

## Layout

```
app/                 React + TypeScript + Vite frontend
  public/data/       exported data the app loads (manifest.json, <site>.json)
  src/               UI code and tests (data.test.ts)
pipeline/            Python data preparation (standard library only)
  config.json        site, interval, targets: edit here
  horizons.py        Horizons query builder, sequential cached fetch, parser
  fetch.py           retrieve raw responses -> data/horizons/
  export.py          raw cache -> app/public/data/ (data contract v1.0)
  validate.py        contract + raw-vs-export checks
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

# 2. Frontend
cd app
npm install
npm run dev                       # http://localhost:5173
npm test                          # vitest unit tests
npm run build                     # typecheck + production build -> app/dist/
npm run preview                   # serve the built app on http://localhost:4173
```

Link to a specific time with `?t=`, for example
`http://localhost:5173/?t=2026-12-01T12:00:00Z`.

## Re-fetching from JPL Horizons
- Requests go one at a time with a pause between them. Each response is cached
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
`coord@301` (Moon), `GEODETIC` site `E-lon, lat, alt_km` = `29.1957,-84.7906,0`
(east-positive longitude, height above the 1737.4 km reference sphere),
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
