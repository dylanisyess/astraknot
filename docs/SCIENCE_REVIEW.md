# Science review (2026-11-14) and its follow-up

A read-only review of the scientific calculations was done before the 3D
milestone, at `main` = `origin/main` = `978f22a`. It found **no blocking
correctness issue**. Its nonblocking findings were:
- the limitations did not say that Earth's disk can show while its center is
  hidden;
- the in-repo azimuth-convention check was weak;
- two code paths produced the selected-time state;
- the docs were stale.

This file records which of the review's checks are now in the repository, how
to rerun them, and what they showed when rerun on 2026-11-14 on branch
`science-review-followup`. The 3D requirements the review produced are in
[SPEC.md](SPEC.md#3d-explore-requirements-for-the-next-milestone).

## Preserved checks

| Check | Where | Inputs | Runtime |
|---|---|---|---|
| Two-site Sun-direction consistency (0.001°), mirrored/west-longitude controls, Earth parallax → implied distance | `pipeline/direction_check.py`; unit tests in `pipeline/tests/test_conventions.py` | committed `app/public/data/*.json` only | < 1 s |
| Cardinal directions: Sun azimuth falls every step, Earth azimuth bands, right-handed ENU, map bearing = longitude + azimuth | `pipeline/tests/test_conventions.py` | committed exports | < 1 s |
| CR1 near-pole synthetic wall test (N/E/S/W and 137.4°) | `pipeline/tests/test_terrain_horizon.py` `test_cardinal_orientation_near_pole_cr1` | none (synthetic) | ~2 s |
| Surface under the observer, 7-azimuth independent ray march, pixel registration vs LOLA shots, mirrored-map control | `pipeline/review/spot_checks.py` (from the reviewer's `spot.py`) | committed reports and RDR caches **plus** `data/raw/lola/ldem_80s_20m/ldem_80s_20m.img` (1.85 GB, git-ignored; `python pipeline/fetch_terrain.py --site im2-athena`) | ~10 s |
| Motion rates, interpolation error, disk-vs-center statistics (nominal radii), every instant-vs-interval disagreement for both models, skyline distances, curvature, mesh-vs-bilinear skyline | `pipeline/review/design_numbers.py` (from the reviewer's `design_numbers.py`) | as above; `--no-mesh` skips the raster | ~20 s |
| Selected-time status at every disagreement case, every sample and every step midpoint, coverage edges, unknown data | `app/src/status.test.ts`, render checks in `app/src/app.test.tsx` | committed exports | < 2 s |

```sh
python pipeline/direction_check.py
python -m unittest pipeline.tests.test_conventions -v
python pipeline/review/spot_checks.py
python pipeline/review/design_numbers.py        # or --no-mesh without the raster
cd app && npm test
```

The review scripts import no pipeline module: they are a second implementation.
They now check the raster layout constants against the PDS label (30 400 px
square, 20 m, DN × 0.5 m, 1737.4 km sphere, pixel centres at
I = X/s + N/2 + 0.5). They also check the raster size before reading, and they
refuse unknown horizon entries instead of using them.

### Provenance
- `spot.py` and `design_numbers.py` were found in the reviewer session's
  temporary scratch directory and read in full before reuse. Both are
  read-only and import nothing from the pipeline.
- The originals were run unchanged once, then the repository versions. The
  outputs are:
  - `spot_checks.py`: identical, line for line.
  - `design_numbers.py`: identical, except for the word "nominal" and the
    added per-timestamp listing (section 3b).
- The two-site direction check was **not** a saved file. It was an inline
  command in the reviewer's session. Its source was recovered from that
  session's log and reimplemented as `direction_check.py` (same formulas). Its
  direction results match the review. The Earth-distance summary used three
  timestamps in the original and every timestamp here (see below).
- Not preserved: the review's sub-Earth longitude estimate (about −8° to +8°
  from Athena's Earth azimuths). It was a one-off printout. The Earth-band and
  parallax checks above cover the same convention more loosely.

## Results (rerun 2026-11-14)

**Directions** (8 641 samples, Athena vs CR1, 174.0 km apart):

| Quantity | Result |
|---|---|
| Sun, as implemented | max 0.000068° (expected parallax 6.8e-5°); tolerance 0.001° |
| Sun, mirrored azimuth / west-positive longitude | 26.80° (both) |
| Sun, one site shifted by one sample | > 0.05° (unit test) |
| Earth, as implemented | 0.0102–0.0166° (parallax) |
| Approximate Earth-distance scale implied by that parallax, all samples | 356 527–406 760 km |

### Earth-distance diagnostic: three dates versus the full series

The original review reported **377 000–396 000 km**. Its recovered inline
command evaluated distance only at sample indices 0, 4320 and 8640:

| UTC | Approximate implied distance (km) |
|---|---|
| 2026-12-01 00:00 | 376 543 |
| 2026-12-31 00:00 | 386 343 |
| 2027-01-30 00:00 | 395 850 |

`direction_check.py` uses the same formula at **all 8 641 timestamps**. Its
minimum is 356 527 km on 2026-12-24 08:00 UTC; its maximum is 406 760 km on
2027-01-07 07:00 UTC. The three-date rounded range and the full-series range
therefore agree; neither the exports nor the formula changed. These numbers
were reproduced from the existing exports during completion review, without
requests or terrain calculations.

Method: transform each site's Earth azimuth/elevation through its local ENU
frame into Moon-fixed unit directions, take their angular separation θ in
radians, and form the site-position baseline **b** from the configured sphere
radius plus each observer's altitude. With Athena's unit direction **v**, the
estimate is `sqrt(|b|² − (b·v)²) / θ`: the perpendicular baseline divided by
the small parallax angle. It is an approximate observer-to-Earth distance
scale, not a measured center-to-center Earth–Moon distance. The inputs are
rounded airless apparent directions, not independent simultaneous geometric
rays; the small angular denominator also amplifies direction errors.

This is useful only as a coarse plausibility check (the test accepts
340 000–420 000 km), capable of catching some gross inconsistencies. It does
**not validate ephemeris accuracy**, establish absolute frame/time accuracy,
or independently measure perigee and apogee. Both sites use the same source;
shared errors can pass this check.

### What the direction checks can establish

What the 0.001° Sun test **detects**: errors that act differently at the two
sites. Examples are a mirrored azimuth, west-positive longitude, a wrong or
swapped site coordinate, and a time offset of one site's series of more than
about 7 s.

Cross-site checks **cannot detect all shared errors**. Examples that can pass
the Sun comparison are a common
time-scale offset, a rotation of the whole body-fixed frame (another
realization, a wrong longitude zero), a common altitude or radius error, or a
wrong target applied to both. The single-direction check in
`horizon_crosscheck.py`, Earth parallax and azimuth bands detect only **some**
gross shared errors; they do not close these gaps or validate absolute
ephemeris accuracy.

**Independent ray march** (1 m steps to 3 km, then 5 m to 30 km):
- Athena: within 0.0018° of the pipeline at the 7 azimuths.
- CR1: within 0.0244°. Its skyline is 50–480 m away, where 1 m steps resolve
  relief that the pipeline's 5 m steps smooth over. This matches the
  documented convergence.

Surface under the observer: 5321.880448 m and 1941.820558 m; eye 1.019552 m
and 0.979442 m.

**Registration**: for both sites the best fit is the zero shift among ±40 m
trials in 5 m steps. All half-pixel shifts are worse:
- Athena: 1.603 m RMS from 6 259 shots.
- CR1: 0.967 m RMS from 1 758 shots.

The shots are the DEM's own source data, so this confirms how the product is
read, not terrain accuracy.

**Disk vs center** (terrain model, nominal radii Sun 0.27°, Earth 0.95°), the
share of 10-minute steps in which the center is hidden but part of the disk is
above the skyline:

| Body | Athena | CR1 |
|---|---|---|
| Sun | 1.5 % | 5.7 % |
| Earth | 14.8 % | 4.0 % |

**Mesh vs bilinear** (20 m two-triangle surface, terrain within 1 km): the
skyline moves by up to 0.038–0.067° at Athena and 0.170–0.275° at CR1. The
ground under CR1's observer moves by −0.057 / +0.064 m.

### Instantaneous-vs-interval disagreements (all 17, both models)
These are the sample times where the center at that instant and its
10-minute step's midpoint state disagree. The review counted the terrain ones
(Athena Sun 0, Athena Earth 5, CR1 Sun 5, CR1 Earth 2); the smooth ones were
found by the same enumeration. The app now shows each as "Near estimated
crossing", keeping both values. The cases are pinned in `app/src/status.test.ts`.

| Site | Model | Body | Time (UTC) | Step state | Center at that instant |
|---|---|---|---|---|---|
| Athena | terrain | Earth | 2026-12-04 08:30 | not visible | +0.00022° |
| Athena | terrain | Earth | 2026-12-09 14:00 | visible | −0.00012° |
| Athena | terrain | Earth | 2026-12-31 07:20 | not visible | +0.00037° |
| Athena | terrain | Earth | 2027-01-05 21:00 | visible | −0.00133° |
| Athena | terrain | Earth | 2027-01-27 10:50 | not visible | +0.00111° |
| CR1 | terrain | Sun | 2026-12-16 09:10 | not visible | +0.00100° |
| CR1 | terrain | Sun | 2026-12-24 00:00 | visible | −0.00154° |
| CR1 | terrain | Sun | 2026-12-27 08:00 | not visible | +0.00372° |
| CR1 | terrain | Sun | 2027-01-05 03:30 | visible | −0.00238° |
| CR1 | terrain | Sun | 2027-01-13 05:00 | not visible | +0.00157° |
| CR1 | terrain | Earth | 2026-12-15 10:30 | visible | −0.00183° |
| CR1 | terrain | Earth | 2027-01-22 19:40 | not visible | +0.00418° |
| Athena | smooth | Sun | 2027-01-27 22:20 | not visible | +0.00193° |
| Athena | smooth | Earth | 2026-12-11 05:00 | visible | −0.00005° |
| Athena | smooth | Earth | 2027-01-26 15:30 | not visible | +0.00336° |
| CR1 | smooth | Earth | 2026-12-26 22:30 | not visible | +0.00195° |
| CR1 | smooth | Earth | 2027-01-23 08:20 | not visible | +0.00265° |

All lie within 0.005° of the horizon. At every step **midpoint** the
instantaneous geometry equals the exported state: this was tested for all
8 640 steps × 2 bodies × 2 sites × 2 models.

## What remains unverified
These limits are carried over from the review:
- The source coordinates' frames and accuracy (LROC; NASA Data Book).
- Absolute terrain accuracy; no independent terrain data was used.
- The full horizon, sensitivity, cross-check and 5 m runs (not rerun here).
- Horizons internals.
- Athena's rounding-effect sentence in the app, which has no committed
  report behind it.
