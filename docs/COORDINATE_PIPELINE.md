# Coordinate-driven offline terrain preparation

Observed implementation and acceptance: 2026-11-15, 02:20 Pacific. This is the
feature worktree's uncommitted implementation, not a deployment record.

## Process another coordinate

Run from the repository root with Python 3. The preprocessing path is offline;
it does not fetch ephemerides or put CLI study points in the public catalog.

```powershell
python pipeline/prepare_site.py --id coordinate-smoke-20n --name "Unpublished coordinate smoke test" --lat 20.25 --lon 30.8 --frame MOON_ME_DE421 --observer-height 1 --start 2026-12-01T00:00:00Z --end 2026-12-02T00:00:00Z --step-seconds 600
```

Inputs are an ID/name, finite planetocentric latitude in [-90, 90], east-positive
longitude (normalized modulo 360), explicit frame, positive height above terrain,
UTC date range and positive whole-minute sampling interval. The date range must
contain a whole number of steps. Only `MOON_ME_DE421` is currently supported;
unknown frames are rejected, not silently transformed. Planetodetic coordinates
on the same 1737.4 km sphere are equivalent. Coordinates from other ellipsoids
or frames need an explicit reviewed conversion before use.

For a documented configured site, use the same entry point:

```powershell
python pipeline/prepare_site.py --config pipeline/config.json --site apollo17-lm
python pipeline/prepare_site.py --config pipeline/config.json --site im1-odysseus
```

The site configuration needs `id`, `name`, `latitude_deg`, `longitude_deg_east`,
`terrain_coordinate_frame: "MOON_ME_DE421"` and
`observer_height_above_surface_m`. Dataset-level inputs are
`coverage_start_utc`, `coverage_end_utc`, `sample_step_seconds`. Existing catalog
sites also retain their coordinate sources, point type, assumptions and modeled
`horizons_site_altitude_km`. Use `--site` explicitly for a multi-site config.
No site ID is consulted in terrain selection or processing.

Adding `--publish` to a **configured** site's command validates its completed
bundle, copies rendering/screening assets, exports that site using matching
cached ephemerides, and regenerates the dataset catalog last. This means local
files only; it does not publish a website. CLI study points cannot use this flag.
For a new catalog site, supply the existing documented coordinate/provenance
fields and acquire ephemerides with `pipeline/fetch.py --config PATH --site ID`
only after agreeing on the observer. Configuring a new coordinate within a
supported product does not require changing sampling, horizon, mesh, slope or
export code. No custom-coordinate browser UI, backend queue or global DEM
database is implemented.

## Supported products and coverage

`pipeline/terrain_sources.json` declares product IDs, adapters, selection
priority and local/distant roles. Actual coverage, projection, registration,
resolution, units, reference sphere and nodata come from validated source labels
and the per-query valid-pixel footprint. The product name alone never establishes
coverage. `Source.provenance()` records the label fields, raw/label hashes,
cache path, URL, priority and assumptions in each bundle's `input.json`.

| Cached source | Adapter / role | Geographic availability and resolution |
|---|---|---|
| LDEM_80S_20M | PDS south-polar stereographic; local and horizon; priority 10 | Actual square raster around the south pole, nominal 80 S boundary with corner extensions; approximately 20 m near Odysseus. Test projected pixel indices and all four interpolation pixels, rather than a circular latitude cutoff. |
| LDEM_75S_60M | Same adapter; local and horizon; priority 20 | Wider south-polar square, nominal 75 S boundary with corner extensions; approximately 60 m. |
| sldem2015_512_00n_30n_000_045_float | SLDEM2015 simple cylindrical; local and horizon; priority 10 | Cached tile 0 to 30 N, 0 to 45 E; approximately 59.23 m north-south and 55.59 m east-west at Apollo 17. |
| LDEM_64 | PDS simple cylindrical; **distant horizon only**; priority 100 | Global 64 pixels/degree, approximately 473.80 m north-south; east-west spacing decreases with latitude. Exterior latitude interpolation rows remain subject to valid-pixel checks. |

SLDEM2015 is published over 60 S to 60 N, but **only the tile above is cached**.
Other tiles can be registered and supplied without a new adapter. The existing
polar adapter supports square south-polar PDS integer rasters, not arbitrary
GeoTIFFs or north-polar projections. The current SLDEM reader accepts the label's
little-endian float format and rejects an undeveloped explicit nodata convention.
It treats nonfinite pixels as unknown. Older surface-only comments in the SLDEM
helper describe its original use; the generic adapter now uses that reader for
all four products.

Selection is first valid bilinear sample in ascending priority (registry order
breaks ties). Observer, mesh and slope additionally require `local: true` and
both ground pixel dimensions <=100 m. A global coarse DEM therefore cannot
make an unsupported local coordinate appear fully supported. All four
bilinear neighbors must be valid. Interior nodata can fall back to another valid
registered source; it is never converted to zero or extrapolated as flat terrain.
Co-registered adjacent cylindrical tiles of the same adapter/resolution can
supply exterior interpolation neighbors, with an exact pixel-centre alignment
check. Global longitude indexing wraps. Different local/distant products switch
by priority; no vertical offset or averaging hides their differences.

## Acquire or supply a missing tile

1. Read the coverage failure, including the coordinate, cached footprints,
   missing files and suggested SLDEM geographic tile or polar/regional coverage.
2. Identify the actual PDS product and label; verify format, frame, units,
   reference sphere, valid footprint and resolution. Add a source entry to a
   registry JSON (`--registry PATH` can use an alternate registry).
3. Fetch a registered product explicitly, or supply its original label and raw
   image in the same cache layout. Existing caches are shared by coordinates.

```powershell
python pipeline/terrain_sources.py fetch LDEM_64
python pipeline/terrain_sources.py fetch sldem2015_512_00n_30n_000_045_float
```

Acquisition uses Windows `curl.exe` with normal certificate verification,
resumes `.img.part`, checks the exact label-implied byte count, and records
raw/label SHA-256 in `verified-source.json`. Existing wrong-size final files
are preserved and refused. Labels for LOLA are under `data/terrain/labels/`,
images under ignored `data/raw/lola/<lowercase-product>/`. SLDEM labels/images
are under ignored `data/raw/sldem/<product>/`. Archive base URLs are in the
adapters. This command uses the default registry; an alternate registry's new
product should be supplied using its adapter's cache layout or registered in
the default acquisition registry first. Do not start another fetch over a live
partial download. Preprocessing itself never initiates a download.

To add a **new format**, extend `Source` with a reusable adapter implementing
`pixel_of`, `unit_at`, `value_m`, `sample`, `resolution` and `provenance`. Validate
its label/registration and datum explicitly. Add synthetic registration, nodata,
tile-edge and wrap tests before registering real sources. Do not add site-name
branches. A source with a different frame/height reference requires a documented
transformation; similar-looking elevations do not prove compatibility.

## Geometry, observer and completion rules

The same `Terrain.sample` interface supplies observer elevation, spherical
great-circle skyline rays, local rendering vertices and the slope neighborhood.
The observer surface is rounded to 0.1 m before adding nominal eye height. A
configured Horizons altitude must agree within this rounding allowance and is
then retained exactly. It is never changed to improve a mesh or match another
source. Horizons query cache keys contain the exact observer/query parameters;
changed observers require matching new ephemerides.

The skyline samples 3,600 azimuths at 0.1 degrees, starting 5 m away: 5 m radial
steps to 2 km, 25 m to 30 km, 100 m thereafter. Each ray must satisfy the existing
global-height stopping bound, 10,873 m above the 1737.4 km sphere, before the
500 km search cap. This is a declared lunar maximum-height assumption, not a
DEM accuracy guarantee. Missing coverage or an unstopped ray writes unavailable
evidence and prevents completion. Extent checks at 50/100/200/400 km and half-step
refinement at 36 azimuths quantify stability on the selected source grids.
They do not validate unresolved terrain below DEM resolution.

Rendering uses a local gnomonic square with 1,920 m half-width, x=east, y=up,
z=-north, centered on the same observer. Its bilinear grid is finer than the DEM
for rendering only. Distant relief is represented by the authoritative skyline
in Horizon view; the overview mesh does not reproduce the full distant mountains.
The exported profile alone masks the nominal Sun/Earth disks and determines
Terrain intervals. Mesh silhouette differences never change visibility states.

Slope uses Horn 3x3 on true 3D points of a local gnomonic grid, relative to each
point's radial vertical, within a 500 m ground-distance footprint. Native-scale
20/60 m cells imply roughly 40/120 m measurement baselines. The recorded
`baseline_m` is mean 3D neighbor chord length, including relief, not a finer DEM
resolution. Unknown neighborhoods remain unknown. Generic-path laser-shot
counts are **unassessed**, represented by null, not fabricated zero counts.
This screens steepness only, not landing safety. Comparisons disclose the
different measurement scales.

Artifacts live in `data/prepared/<fingerprint>/`: `input.json`, `observer.json`,
`terrain.json`, `horizon_report.json`, `<id>.terrain.{json,bin}`, `mesh_check.json`,
`<id>.slope.json`, `slope_report.json`, and finally `complete.json`.
Fingerprint inputs include normalized coordinates, exact observer, scenario,
source/label byte hashes, registry, processing parameters, algorithm versions and
actual processing-code hashes. Site name alone is insufficient. Hash-checked
individual rays permit interrupted runs to resume. A validated complete bundle
is reused; partial output never enables catalog capabilities. The completion
marker is atomic and last. Publication checks product identities and refuses
unknown unequal existing assets; known superseded generated assets remain in
their old bundles. Public files are replaced individually, not as a filesystem
transaction: after an interruption rerun the same command before serving the
release. Asset identity/hash validation rejects incoherent products.

## Personally measured results

Both public sites use the same unchanged implementation, verified again by
`python pipeline/generic_acceptance.py` without network requests. Full hashes,
source identities, protected-output comparisons and commands are recorded in
`data/release/generic_acceptance.json`.

| Result | Apollo 17 | Odysseus |
|---|---|---|
| Bundle fingerprint | ffa37016303a8b91ff89c88dc7b63f050d306b23ad57e881db1c0c4a689c03e0 | 0d4fc9cb2aff7a4806c0ba842a82718b01bde5e16c1f84c0bf8b054e3562d8c0 |
| DEM surface above sphere | -2627.992123 m | 2593.528393 m |
| Retained Horizons altitude / effective eye | -2.627 km / 0.992123 m | 2.5945 km / 0.971607 m |
| All skyline rays stopped by | 208.5 km | 176.7 km |
| Largest skyline increase beyond 50 / 100 km | 0.061786 / 0 degrees | 0 / 0 degrees |
| Maximum half-step refinement change (36 azimuths) | 0.003090 degrees | 0.003580 degrees |
| Mesh binary / resampled spacing | 792,588 bytes / 15 m | 7,096,332 bytes / 5 m |
| Mesh-profile maximum difference for setting points inside mesh | **0.10726 degrees; 10 of 50 directions exceed proposed 0.05-degree target** | 0.04414 degrees; 0 of 2,064 exceed target |
| Slope cell / mean 3D baseline | 60 / 119.967 m | 20 / 40.579 m |
| Slope median / p95 / max | 1.99 / 6.69 / 10.63 degrees | 11.15 / 16.33 / 20.84 degrees |

Apollo's proposed mesh agreement target is **not met**. Both sites have validated
complete scientific profiles and coherent rendering/slope products, but local
triangles are an approximation, especially near the observer on coarse terrain.
The authoritative Horizon-view profile remains essential. Optional finer LROC
Apollo data is deferred. No independent absolute terrain accuracy is established.

Odysseus overlap samples 500 m inside transitions: 20 m minus 60 m DEM ranges
-5.075 to +23.109 m (1,738 samples; mean +0.009 m); 60 m minus global LDEM_64
ranges -89.855 to +53.783 m (293 samples; mean -3.366 m). These differences are
recorded without adjustment; resolution/product differences are not an established
explanation for each residual. Global fallback is coarse distant coverage.

The NAIF IM-1 frames kernel states the same coordinate and 1737.4 km sphere,
but its **2.583 km landing-site origin** has unspecified terrain basis/accuracy
and relationship to the modeled eye. The DEM surface is 10.5284 m higher and
the retained modeled observer is 11.5 m higher. This difference remains unresolved.
It does not prevent an explicitly DEM-based educational model with one consistent
observer; it limits claims of agreement with the spacecraft kernel. See
[source investigation](ADDITIONAL_SITE_TERRAIN.md).

## Reusability and regression acceptance

The first command in this document generated observer, all 3,600 skyline rays,
mesh and slope for **20.25 N, 30.8 E**, supplied only through CLI inputs. Bundle:
`data/prepared/d029381f847ce1f0fc820596b1b698069abcc934718775ac7232c791c8c010ab`.
It uses the cached SLDEM tile; surface -2619.644558 m, effective eye 1.044558 m;
maximum half-step change 0.007669 degrees. All product hashes validate. The audit
confirms identical processing-code hashes for all three runs and no smoke-point
entry in configuration or public catalog. No ephemerides were fetched for it.
Its local mesh also misses the proposed target (0.16997 degrees maximum).

```powershell
python pipeline/prepare_site.py --id missing-coverage-smoke --name "Missing local terrain smoke test" --lat 40 --lon 180 --frame MOON_ME_DE421 --observer-height 1 --start 2026-12-01T00:00:00Z --end 2026-12-02T00:00:00Z --step-seconds 600
```

This exits 1, identifies no local <=100 m coverage and requests an SLDEM tile
covering 30..60 N, 180..225 E (actual filename/label must be verified). It creates
no complete marker or public capability. The global coarse raster is not used
to fabricate local support. The audit repeats this negative check and a valid
cache replay (2.98 seconds on this machine, no horizon/mesh rebuild).

Focused tests in `pipeline/tests/test_coordinate_terrain.py` cover coordinate
normalization, pixel registration/scaling, longitude wrap, nodata, adjacent tile
edges, ENU geometry, flat-sphere slopes, coarse-only refusal, fingerprint changes,
incomplete-bundle refusal, and analytic skyline/stopping failures. Personally run:
101 Python tests; 317 frontend tests; production build; 136/136 accepted and
266/266 expanded dataset checks. Release evidence verifies all 96 ephemeris
chunks and original Athena/CR1 outputs and old-window results unchanged.

Desktop production-preview screenshots were personally inspected for each new
site's Terrain Horizon view, overview, slope overlay and four-site comparisons.
Tracking/site-catalog interactions were also checked. Final URL reload, narrow
layout and remaining failure/reduced-motion checks are **not complete**: Computer
Use stopped because it could not establish the current Windows browser URL with
enough confidence to enforce policy. No browser actions followed that stop.
Checkpoint 4 browser acceptance was deferred by the user. See STATUS.md for the
precise release handoff and remaining browser checks.
