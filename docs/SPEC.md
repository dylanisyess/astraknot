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

Exact sites and dataset dates are pending data-owner selection.
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
- Small site locator.
- Two comparison cards.
- Shared visibility timeline with Sun, Earth, and both-visible rows.
- Horizon panorama linked to the selected time.
- Methodology and sources panel.

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
The center of the body must be strictly above the modeled horizon.
No atmospheric refraction or partial-disk illumination model.

Initial temporal resolution: 10 minutes.
Event times are estimates; do not imply finer validated accuracy.

## Architecture
- React + TypeScript + Vite frontend.
- Python preparation pipeline.
- Static JSON outputs.
- Static deployment.
- No live NASA requests required during normal app use.
- No database, accounts, or AI inference inside the app.

## Ownership
Dylan: interface, visualization, integration, deployment.
Partner: source data, terrain processing, visibility generation.
Both: data contract, validation, demo, documentation.

## Deferred features
- Arbitrary user-selected terrain coordinates.
- Live calculation server.
- Battery sizing or link budgets.
- Automatic overall "best site" score.
- Multi-year coverage.
- 3D terrain and observer-height controls until the core works.

## Completion criteria
- Both sites work over the supported dates.
- Delay comparisons preserve mission duration.
- Timeline, panorama, and metrics agree.
- No unlabeled synthetic data appears in the delivered app.
- Sources and limitations are accessible.
- Deployed app works from a fresh browser session.
- Validation evidence is recorded.