# Lunar Visibility Navigator — Specification

## Purpose
Help users compare how lunar location and arrival date affect
Sun visibility and geometric Earth visibility.

Main demonstration:
"We planned to arrive here. If arrival slips seven days,
how do the visibility windows change at these two locations?"

## Audience
Educators, students, the public, and people exploring early
mission-planning tradeoffs.

This is an educational planning prototype, not a flight-qualified
landing, power, thermal, or communications analysis tool.

## Scope
- Two precisely documented lunar surface points.
- Cached JPL Horizons positions for the Sun and Earth.
- Approximately 60 days of supported data.
- Default mission duration: 14 Earth days.
- Arrival shifts of +1, +3, and +7 days relative to the baseline.
- Only allow scenarios fully covered by the dataset.
- UTC throughout the application.

Site A: IM-2 Athena landing point, 84.7906° S, 29.1957° E (LROC).
Supported interval (milestone 2): 2026-12-01T00:00Z to 2027-01-30T00:00Z.
Site B: Connecting Ridge CR1, 89.468 S, 222.6 E, NASA ACD-50044 Rev A section
7.3.3 (selected in milestone 4B, data in 4C). This is a hypothetical landing
point in a notional study, not an actual landing site. Frame assumed ME; source
frame/coordinate accuracy unresolved. See [SECOND_SITE.md](SECOND_SITE.md).
Both sites are in the app (two-site comparison, milestone 4D, merged to `main`
in PR #2). CR1's terrain result is **provisional**: it is highly sensitive to
near-field DEM relief, the terrain model, eye height and position.
Choose points with suitable terrain coverage and document sources.

## Required user experience
1. Open a useful preloaded scenario.
2. See both locations and their coordinates.
3. Select arrival date.
4. Compare visibility over the same mission duration.
5. Apply a delay and see changes from the baseline.
6. Select a timeline time to update the sky visualization.
7. Open methodology and source information.

## Required views
The primary experience is **Explore** (the default view), a 3D view of the
terrain around a fixed observer; a first working version exists since
milestone 5A (requirements below; evidence in STATUS.md). The dashboard is
**Analysis**:
- Small site locator.
- Two comparison cards.
- Shared visibility timeline with Sun, Earth, and both-visible rows.
- Horizon panorama linked to the selected time.
- Methodology and sources panel.

Every view gets "visible / not visible at the selected time" from the one
shared status function (`app/src/status.ts`), never from its own geometry.

## Metrics
For the selected mission window:
- Sun-center-visible percentage.
- Earth-center-visible percentage.
- Both-centers-visible percentage.
- Longest continuous modeled darkness within the window.
- Estimated next visibility loss when the body is currently visible.

If an event is outside available coverage, show "not found in
available data." Never translate that into "never."

Flag darkness touching a mission-window boundary; its full
duration may extend outside that window.

Earth visibility is a geometric opportunity, not a guaranteed link.
Sun visibility is not electrical power output.

## Scientific stages
Stage 1: Smooth-horizon approximation, explicitly labeled.
Stage 2: Verified terrain horizon for one site.
Stage 3: Verified terrain horizons for both sites.

Initial visibility definition:
The center of the body must be strictly above the modeled horizon. This
applies to both the Sun and Earth. Part of either disk may remain visible
when its center is hidden, and part may be hidden while its center is
visible. Earth appears about 1.9° across and the Sun about 0.5° (nominal
sizes). No atmospheric refraction or partial-disk model.

Initial temporal resolution: 10 minutes. This is the sampling and reporting
resolution, not a guaranteed accuracy of event times. Each 10-minute step is
classified at its midpoint. Event times are estimates on that grid; do not
imply finer validated accuracy. At a selected time inside a step, the body
center can be on the other side of the horizon from the step's state. Show
both values and say "Near estimated crossing"; never alter either one.

## Architecture
- React + TypeScript + Vite frontend.
- Python preparation pipeline.
- Static JSON outputs.
- Static deployment.
- No live NASA requests required during normal app use.
- No database, accounts, or AI inference inside the app.

## Ownership
Dylan is the sole developer and owns all work: interface, visualization,
integration, deployment, source data, terrain processing, visibility
generation, data contract, validation, demo, and documentation.
(Updated 2026-11-14; earlier drafts split this with a partner.)

## Deferred features
- Curated list of additional documented sites (backlog).
- Arbitrary user-selected (custom) coordinates and terrain (backlog).
- Live calculation server.
- Battery sizing or link budgets.
- Automatic overall "best site" score.
- Multi-year coverage.
- Observer-height controls.

## 3D Explore: requirements
Recorded after the 2026-11-14 science review
([SCIENCE_REVIEW.md](SCIENCE_REVIEW.md)). Milestone 5A implements them with
separate rendering assets (`pipeline/render_assets.py`); its measured
mesh-vs-profile disagreement (item 9) misses the 0.05° target at both sites
and is recorded in STATUS.md, "Milestone 5A".
Since milestone 5B the observer view clips terrain to the exported profile and
lets only the profile hide the Sun and Earth (stencil mask), so the mesh
discrepancy cannot add or remove occlusion there; the overview shows the mesh.
Explore frames visibility as solar-power potential and direct-to-Earth
communication windows (STATUS.md, "Milestone 5B").
1. **Fixed modeled observer, separate from the camera.** The observer is the
   exported `terrain_horizon.observer` radius at the site coordinate.
   - The eye view only rotates and zooms: no translation, no vertical
     exaggeration.
   - In the orbiting overview, the Sun and Earth are direction rays from the
     observer marker.
   - Status always means "seen from the observer", never "from the camera".
     Moving the camera changes no status or readout.
2. **Explicit, tested renderer-axis mapping.** The scene uses a local
   east-north-up frame at the observer. For a right-handed Y-up renderer:
   x = east, y = up, z = −north, so a direction is
   (cos el · sin az, sin el, −cos el · cos az).
   - Required tests: north is −z and east is +x.
   - Facing north, the Sun moves right to left: its azimuth falls about
     0.085° per 10 minutes.
   - Earth stays at azimuth 322–339° at Athena and 129–146° at CR1.
   - LOLA map bearing = east longitude + azimuth (tested in
     `pipeline/tests/test_conventions.py`).
3. **Observer-relative terrain coordinates and consistent curvature.**
   - Convert each vertex to Moon-centred Cartesian, rotate it into the site
     frame in 64-bit, and send coordinates relative to the observer. 32-bit
     floats at Moon-centre scale resolve only 0.1–0.25 m.
   - Count lunar curvature exactly once: the drop is 1.2 m at 2 km, 29 m
     (0.16°) at 10 km and 259 m (0.49°) at 30 km.
4. **Detailed nearby terrain plus a distant-horizon representation.**
   - Near the observer, sample heights bilinearly from the same DEM and
     registration. A plain 20 m two-triangle mesh moves CR1's skyline by up
     to 0.17–0.28°.
   - Athena's skyline is set 0.33–29.7 km away (53 % of azimuths beyond
     10 km), so a local patch cannot reproduce it. Draw the exported 0.1°
     profile as the authoritative distant silhouette, use coarser rings for
     the overview, and mark what is not meshed.
   - CR1's skyline lies within 480 m.
   - No synthetic detail that changes the silhouette. Any added texture is
     labelled illustrative. State the 20 m pixel scale.
5. **Computed status independent of illustrative shadows.**
   - Status text comes only from `selectedTimeStatus`.
   - Rendered shadows are labelled illustrative and never drive a label.
     They are least reliable with the Sun at 0–2° (CR1) or below 6.5°
     (Athena).
6. **Nominal disk sizes and center-based labels.** Draw the Sun and Earth at
   nominal display angular diameters (about 0.53° and 1.9°) with a center
   mark. These are nominal values, not measured or time-varying diameters: the
   dataset holds no diameters, so label them nominal. When a disk straddles
   the skyline, say "center hidden" or "center visible".
7. **No extrapolation beyond time coverage.**
   - Playback stays inside the samples; linear interpolation between samples
     is fine (< 0.00002° error over 20 minutes).
   - Status changes only at step boundaries.
   - Event times stay on the 10-minute grid, marked "≈".
8. **Shared site/time/scenario state across Explore and Analysis.** Switching
   views keeps the site, time, horizon mode, arrival, duration and delay
   (URL state). Switching sites swaps mesh, observer, profile and samples
   together.
9. **Mesh-versus-profile comparison with measured discrepancies.** For every
   azimuth the mesh covers, compute the mesh silhouette seen from the observer
   and report its difference from the exported profile. **0.05° is a proposed
   rendering target, not a statement of source-data accuracy.** The terrain
   itself is uncertain by more than that, for CR1 by degrees.
10. **Smooth mode states its assumption.** Smooth mode uses a 0° horizontal
    plane, which real terrain contradicts. The 3D view must say clearly that
    it shows the 0° reference assumption, not the terrain's horizon.
11. **Provisional results stay visible.** CR1 keeps its provisional badge in
    Explore. No 5 m data is shown, and the coordinate/frame limitations stay
    with the site.

## Terrain hazard screening (milestone 5C)
DEM-derived slope from LDEM_80S_20M within a 500 m radius of each modeled observer
(`pipeline/slope.py`; method, scale and results in STATUS.md, "Milestone 5C").
- Terrain layers (Surface / Slope / Above threshold) in the Site overview only.
- An illustrative, editable screening threshold (default 15°).
- A terrain inspection point that never becomes a modeled site.
- A matched two-site table in Analysis next to Sun/Earth availability.
- It screens steepness at the DEM's ~40 m measurement scale only: no boulders, small
  craters, bearing strength or landing safety, and no combined "best site" score.
  Changing a layer or the threshold never changes visibility.

## Completion criteria
- Both sites work over the supported dates.
- Delay comparisons preserve mission duration.
- Timeline, panorama, readouts, cards and metrics agree (one status source).
- No unlabeled synthetic data appears in the delivered app.
- Sources and limitations are accessible.
- Deployed app works from a fresh browser session.
- Validation evidence is recorded.