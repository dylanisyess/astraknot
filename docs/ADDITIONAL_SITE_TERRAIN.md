# Terrain support for Apollo 17 and IM-1 Odysseus

## Implemented state — 2026-11-15, 02:25 Pacific

Both sites now have Terrain horizons, local rendering and 500 m slope screening
through the same coordinate-driven offline pipeline. Apollo 17 uses the cached
SLDEM2015 tile; Odysseus uses the existing 20/60 m polar LOLA DEMs and newly
acquired global LDEM_64 for distant skyline coverage. Capabilities are enabled
only after bundle and served-product validation. A third CLI-only coordinate
passed without changing processing code; a missing-local-coverage point failed
explicitly. See [COORDINATE_PIPELINE.md](COORDINATE_PIPELINE.md) for exact
commands, hashes, measured results, source selection and adapter instructions.

The selected observers and original Athena/CR1 data are preserved. The Odysseus
kernel/DEM difference remains unresolved as described below. Apollo's local
mesh does not meet the proposed 0.05-degree profile agreement target (maximum
0.10726 degrees); the authoritative Horizon-view skyline controls masking and
visibility. Optional finer Apollo LROC data and adjusted polar GeoTIFFs remain
unintegrated candidates, not claimed support. The dated discovery record below
is retained to distinguish initial findings from completed implementation.

## Historical source discovery (superseded implementation status)

Source discovery checked 2026-11-15, approximately 01:30 Pacific. This is a
candidate-data record, not implementation evidence. At that point both sites
were Smooth-only; the implementation status above supersedes that limitation.

## Apollo 17

The existing, downloaded SLDEM2015 tile
`sldem2015_512_00n_30n_000_045_float` covers the configured point
(20.1911 N, 30.7723 E). Its surface elevation report is
`data/terrain/apollo17-lm_site_elevation_report.json`. The local reader supports
surface lookup; it had not yet been connected to horizon, render or slope processing
at the time of this discovery record.
At this point the pixel spacing is approximately 55.59 m east-west by 59.23 m
north-south. NASA's [SLDEM2015 product page](https://pgda.gsfc.nasa.gov/products/54)
describes the combined LOLA/Kaguya terrain and coverage from 60 S to 60 N.
The existing tile is 1,415,577,600 bytes; the completed release check rehashed it
to `9a3ce2afd311cef9a25e7e7f632a0c623a669c29e5da661d97698da1ef3532d7`.

NASA/LROC also publishes the
[Apollo 17 Taurus-Littrow DTM mosaic](https://data.lroc.im-ldi.com/lroc/view_rdr/NAC_DTM_APOLLO17),
product `NAC_DTM_APOLLO17`, at 5 m per pixel. Its published bounding box is
19.39–21.30 N, 29.91–31.66 E, enclosing the configured landing point.
The [download page](https://data.lroc.im-ldi.com/lroc/view_rdr_product/NAC_DTM_APOLLO17)
lists a 441.93 MB GeoTIFF and a confidence map is available from the group page.
Bounding-box inclusion does not establish that the exact pixel is valid or that
all required skyline terrain fits inside the mosaic. The detailed label/readme
could not be retrieved in this check (archive redirect/access errors).

The smallest implementation route is to use the cached SLDEM2015 tile for the
terrain calculations and rendering first, retaining the current modeled observer.
The 5 m mosaic is an optional later improvement: check valid footprint, reference
surface, registration, vertical agreement and far-field coverage before adoption.
A slope calculated from ~60 m pixels must disclose its different measurement
baseline from Athena/CR1's ~40 m baseline. Do not present resampled pixels as
new measured detail.

## IM-1 Odysseus

The existing 20 m LOLA DEM covers the point (-80.12759, 1.44587 E) and its
immediate surroundings. The inherited coarse coverage report
`data/terrain/im1-odysseus_lola_coverage_report.json` identifies distant rays
that leave even the cached 75S DEM before satisfying the horizon stopping rule.
That is a limitation of the cached extent, not an absence of NASA terrain data.

NASA's [PGDA product 90](https://pgda.gsfc.nasa.gov/products/90), *A New View of
the Lunar South Pole from LOLA*, supplies larger south-polar elevation products:

- `LDEM_60S_240MPP_ADJ.TIF`: listed as 210M, 240 m pixels, extending to 60 S.
- `LDEM_60S_120MPP_ADJ.TIF`: listed as 785M, 120 m pixels.
- `LDEM_60S_60MPP_ADJ.TIF`: listed as 2.9G, 60 m pixels.
- Counts, effective-resolution and height-error products accompany these DEMs.

The page specifies south-polar stereographic coordinates in metres and
MOON_ME/DE421. These are candidates for the missing distant terrain. Their actual
georeferencing, height datum, nodata, seams with the older unadjusted cached DEM,
and sufficient extent for every ray still need verification. The 210M product is
a useful first coverage candidate; its coarse pixels must be disclosed and its
skyline sensitivity assessed. No new large terrain file was downloaded here.

Keep the configured observer at 2.5945 km unless a deliberately reviewed observer
change is made. The inherited DEM surface is 2593.5284 m, with nominal 1 m eye
height formed after rounding the surface to 0.1 m. The
[NAIF frames kernel](https://naif.jpl.nasa.gov/pub/naif/pds/pds4/clps/clps_spice/spice_kernels/fk/clps_to2im_im1_v02.tf)
describes the same latitude/longitude and 1737.4 km sphere, but its 2.583 km
altitude is the kernel landing-site origin, whose terrain basis and relationship
to the modeled eye are unspecified. The 10.5284 m surface difference and
11.5 m difference from the selected observer remain unresolved; no explanation
or interchangeable observer definition is established.

## Space Apps connection and remaining checks

The official [Lunar Landing Site Navigator challenge](https://www.spaceappschallenge.org/2026/challenges/lunar-landing-site-navigator/)
was located in search. Its full page/Resources content could not be retrieved
(web reader 502; direct Python request failed local certificate verification).
The data above are verified NASA mission/archive sources suitable for evaluating
this project; this check does not establish that each is explicitly listed in
the challenge's Resources section. No certificate verification was disabled.

The discovery-stage requirements before promoting either site to Terrain were:
implement the correct raster reader
path, test geometry and nodata, retain a consistent observer across positions,
profile and rendering, establish complete search coverage, measure numerical
convergence and seams, and generate the horizon/render/slope evidence separately.
Existing Horizons caches can be retained when the configured observer is unchanged.
These integration checks are now recorded in the coordinate-pipeline evidence;
the remaining mesh, absolute-accuracy and height-source limits are still explicit.
