# Second site: Connecting Ridge CR1

Milestone 4B, 2026-11-14. Selection and terrain preparation only.

Chosen point: **89.468 degrees S, 222.6 degrees E**, stored as latitude
`-89.468`, east longitude `222.6`, ID `connecting-ridge-cr1`.

The authoritative source is NASA's
[Lunar Surface Data Book, ACD-50044 Revision A, May 2023](https://ntrs.nasa.gov/api/citations/20230007818/downloads/ACD-50044%20Lunar%20Surface%20Data%20Book%20Rev%20A.pdf#page=46),
NTRS document 20230007818. Section 7.3.3, printed/PDF page 46, supplies that
exact CR1 tuple as an assumed landing location for a notional traverse.
Figure 0.1 on page 38 also prints the same tuple as C1. Section 7.3 on page 37
explains the illustrative nature of the traverses. Source consulted 2026-11-14.

This is a **study location with a hypothetical landing role**, not an observed
landing, an operational mission selection, or a confirmed Artemis destination.
The coordinates were transcribed, not inferred from a map or region centroid.
The source's Appendix A polygon-center table describes different points; its
accuracy statement is not assigned to this coordinate.

Only two candidate points were evaluated. No sky-position or visibility results
were computed or used to rank them.

| Candidate | Published coordinate | Coordinate documentation and relevance | Cached terrain suitability | Decision |
|---|---|---|---|---|
| CR1 | 89.468 S, 222.6 E | Explicit NASA section 7.3.3 study point with a hypothetical landing role; closer to the pole and at a substantially different longitude from Athena | Inside both existing 80S 20 m and 75S 60 m rasters | Selected for its clearly described role and reusable coverage |
| C2 | 89.500 S, 222.1 E | Explicit NASA Figure 0.1 logistics-transfer endpoint on the same ridge | Inside both rasters; minimum sampled 20 m raster edge distance 292.17 km | Documented alternative, but its role is a traverse endpoint rather than the explicitly assumed landing location |

No optimization for illumination, Earth visibility or a favorable comparison
was performed. The machine-readable selection record is
`data/terrain/connecting-ridge-cr1_site_selection.json`.

## Coordinate assumptions

The coordinate passages do not specify a frame realization, latitude type or
coordinate accuracy. For this educational pipeline we **assume** lunar ME/DE421,
planetocentric latitude, east-positive longitude, consistent with the cached
LOLA labels. Source-to-DEM frame equivalence has not been demonstrated.
Published decimal places are not an accuracy estimate; nearby points sharing
the label CR1 in other publications must not be substituted silently.

## Cached terrain checks

Commands actually run, also repeated with `urllib.request.urlopen` patched to
fail on any network request:

```sh
python pipeline/terrain_check.py --site connecting-ridge-cr1 --offline
python pipeline/site_elevation.py --site connecting-ridge-cr1 --offline --dem-only
```

The offline mode reuses the complete local images and existing range caches.
No HEAD requests, new terrain downloads, RDR queries or Horizons requests were
made by these checks. The preparation tools now read windows from a complete
local IMG before attempting a cached or remote byte range.

- LDEM_80S_20M: actual grid 30,400 by 30,400 pixels; fractional sample/line
  `(14654.527161, 15794.241002)`, 1-based. The point and its interpolation
  neighbors are inside. Raster edge distances sampled every 5 degrees are
  **291.61 to 427.19 km**.
- LDEM_75S_60M: actual grid 15,248 by 15,248; sample/line
  `(7442.509054, 7822.413667)`. Edge distances **443.35 to 631.07 km**.
- The established coarse planner used LDEM_75S_240M, 360 azimuths at 1 degree,
  240 m radial steps, exact spherical curvature and the existing global maximum
  height plus margin, **10,873 m**. Required search distances were
  **147.84 / 215.76 / 296.16 km** (minimum/median/maximum).
  All 360 sampled rays met the stopping rule before exiting the coarse raster.
  No sampled ray required terrain beyond the 80S raster in its own direction;
  the smallest direction-matched margin was **3.35 km**.
- These are **coarse coverage diagnostics, not a final terrain horizon**.
  Unsampled directions and fine terrain may require longer searches. Keep the
  cached 75S far-field product and reapply the stopping rule in the later full
  calculation. No final visibility percentages or predictions follow from this
  planning run. No seam statistics were measured because no sampled planning
  ray required a seam crossing; report values are null, not fabricated zeros.
- The pre-existing 480-point orientation check was repeated from cached data:
  RMS about 30 m for the implemented orientation, versus 2,507 m mirrored.
  This checks the projection implementation; it does not establish the source
  coordinate frame or absolute terrain accuracy.

Full evidence: `data/terrain/connecting-ridge-cr1_lola_coverage_report.json`.
Raster dimensions/scales come from cached PDS labels. Downloaded file sizes
were checked locally against those labels. Undownloaded candidate products
have null size-verification results; no new remote sizes were asserted.

## Surface elevation and planned observer

The bilinear LDEM_80S_20M surface at the published point is
**1,941.8205581012821 m above the 1,737.4 km sphere**. The printed digits describe
the calculation, not physical accuracy. The established mmap reader gives the
same result as the local-window reader to 1e-12 m. The nearest pixel is
1,942.0 m. The existing central-difference local slope diagnostic is 1.43 degrees.

Using the pipeline's established rounding convention:

```text
surface rounded to 0.1 m = 1941.8 m
nominal observer height = 1 m
planned Horizons altitude = (1941.8 + 1) / 1000 = 1.9428 km
planned observer radius = 1737400 + 1942.8 = 1739342.8 m
effective eye above bilinear DEM = 0.979441898718 m
```

Rounding puts the planned point 0.020558 m below an exact 1 m eye over the
unrounded DEM. The coarse coverage planner uses the unrounded surface plus
1 m, following its existing method. Later positions and the full horizon must
use the same configured observer altitude and verify the Horizons echo.
**This altitude is planned only; it has not been submitted to Horizons.**

The cached 60 m product gives **1,942.985638 m**, about 1.17 m higher. Agreement
between related DEM products is not an independent vertical-accuracy estimate.
Other product comparisons were unavailable in the local cache and are null.

The nearest 20 m LDEC pixel has **zero shots**; 21.93% of the surrounding
101 by 101 pixel window has zero shot counts. This is an interpolated DEM,
not an absence of terrain. No local RDR-shot consistency check was performed;
that missing check is explicitly recorded. The sampled 30 m and 100 m rings
span changes of about +0.08 to +2.03 m and -1.64 to +6.41 m relative to the
point. These are local terrain variations, not coordinate uncertainty or
absolute elevation accuracy. Boulders and other subpixel relief are unresolved.

Full evidence: `data/terrain/connecting-ridge-cr1_site_elevation_report.json`.

## 4B checkpoint (superseded by 4C below)

At 4B the point was configured for preparation only; the altitude above was
planned, not yet submitted.

## Milestone 4C: positions and terrain horizon (2026-11-14)

The planned 1.9428 km altitude was submitted to Horizons (12 sequential
requests, raw responses in `data/horizons/connecting-ridge-cr1__*`). Horizons
echoed the geodetic site exactly. Its cylindric echo matches the submitted
radius only to its printed precision (about ±0.5 m near the pole). The eye
sits **0.979 m** above the bilinear DEM, not 1 m, because of the 0.1 m surface
rounding. Its measured skyline effect is ≤ 0.024° (13 Sun / 3 Earth 10-minute
steps in 60 days).

The full 0.1° terrain horizon has no unknown sectors and is converged in its
numerical settings. An independently written near-field check reproduces it
to 2e-9°. But the skyline is set entirely by DEM relief **50–480 m** from
the point, where the Sun's center is never more than 1.98° above the horizontal.
Ignoring terrain within 300 m, using the 60 m product or moving the observer
100 m changes the skyline by 2.7–4.2° and flips thousands of Sun steps. CR1's
terrain visibility is therefore **not robust**. It is a DEM result for this exact
published coordinate, whose accuracy is unknown. It is not a prediction for a
real lander, whose height and surroundings would matter at this scale.
Numbers and the full sensitivity table: `STATUS.md`, "Milestone 4C".
Exported to `app/public/data/connecting-ridge-cr1.json`; not shown in the app yet.

## 5 m terrain-product assessment (2026-11-14)

NASA GSFC PGDA's Site01 "Connecting ridge" 5 m product (Barker et al. 2021;
https://pgda.gsfc.nasa.gov/products/78) covers CR1 with at least 7.9 km of margin
in every direction. Its metadata is consistent with LDEM_80S_20M: same
projection and sphere, pixel-centre registration, no missing pixels, and a
+0.15 m vertical offset near the point. Its best fit among the tested
horizontal shifts (±40 m in 5 m steps) is (0, 0); smaller or untested offsets are
not ruled out. Its 5 m surface at CR1 is 1942.159 m (+0.34 m).

Recomputing the horizon with it changes the skyline by up to 0.97° and the
baseline Sun share by −5.6 pp. Comparisons with a coarsened copy suggest the
change comes mainly from the different product rather than pixel spacing. These
are comparisons, not an additive error decomposition. The change is of the same
order as the angle scale of the product's own documented 1σ height error at the
30–450 m skyline. That scale is a per-azimuth indicator, not a propagated
uncertainty. A 0.4 m eye-height change or a 100 m move matters as much or ten
times more. **CR1 terrain therefore remains provisional.**
The exported data still uses the 20 m result, and no new Horizons altitude was
adopted. Details and tables: `STATUS.md`, "CR1 terrain-product assessment".
