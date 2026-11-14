# Project Status

Update after each completed milestone or important decision.
Record observed results, not assumed progress.

## Current state
Planning documents drafted.
Repository setup and implementation are not yet verified.
No real dataset or terrain calculation has been validated.

## Next shared milestone
One documented lunar point, one day of real Horizons data,
and one working Sun/Earth elevation chart.

## Immediate tasks — Dylan
- Set up the React/TypeScript frontend in app/.
- Read DATA_CONTRACT.md.
- Load a clearly labeled development fixture.
- Render Sun/Earth elevation against UTC time.
- Add a selected-time cursor.
- Replace the fixture with the partner's real output.

## Immediate tasks — partner
- Choose and cite one exact lunar point.
- Confirm the meaning of Horizons location and altitude inputs.
- Retrieve one day of Sun/Earth positions.
- Preserve query parameters and raw output.
- Export the agreed JSON format.
- Identify a suitable LOLA terrain product.

## Decisions still open
- Site A coordinates and source.
- Site B coordinates and source.
- Supported date interval.
- Observer height above terrain.
- Terrain product and processing resolution.
- Deployment host.

## Milestone checklist
- [ ] Shared data contract accepted.
- [ ] One site with real sky positions.
- [ ] Complete smooth-horizon workflow.
- [ ] Terrain loaded and inspected.
- [ ] First terrain horizon checked.
- [ ] Second site integrated.
- [ ] Date-slip comparison verified.
- [ ] Sources and limitations complete.
- [ ] Deployment tested.
- [ ] Demo recorded.

## Validation log
For each check, record:
date | check | inputs | expected behavior | observed result | pass/fail

## Blockers
None investigated yet.

For each blocker, record:
owner | exact symptom | attempts made | next diagnostic step

## AI assistance log
Record tool/model, task, affected files, and human verification.
Use this to prepare an accurate submission disclosure.

## Handoff template
- Completed:
- Files changed:
- Checks run and results:
- Remaining uncertainty:
- Next task: