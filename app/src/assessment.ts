// Summary of the CR1 5 m terrain-product assessment (pipeline evidence, not app data).
// Source: data/terrain/connecting-ridge-cr1_terrain_5m_assessment.json, committed in
// ca0c996. assessment.test.ts checks every number below against that file and checks
// that it refers to the same site and the same 20 m terrain report as the exported data.
//
// These variants are NOT offered as selectable models. Their Sun/Earth positions are
// the 20 m observer's (fixed radius), or were never fetched (nominal 5 m observer);
// they were not exported or validated like the displayed result.

export interface DemoRow {
  window: "+0d" | "+1d" | "+3d" | "+7d";
  /** [Sun %, longest darkness h] */
  displayed20m: [number, number];
  fixed5m: [number, number];
  nominal5m: [number, number];
  /** Non-statistical "all setting points up / all down by atan(sigma_Z/d)" illustration. */
  allUp: [number, number];
  allDown: [number, number];
}

export const CR1_5M = {
  siteId: "connecting-ridge-cr1",
  product: {
    title: "PGDA High-Resolution LOLA Topography for Lunar South Pole Sites, Site01 Connecting ridge (5 m/pixel)",
    url: "https://pgda.gsfc.nasa.gov/products/78",
    citation: "Barker et al. 2021, Planetary and Space Science 203, 105119, doi:10.1016/j.pss.2020.105119",
  },
  surfaceM: { ldem20: 1941.821, pgda5: 1942.159 },
  observer: {
    fixedRadiusAltitudeKm: 1.9428,
    fixedEyeAbove20m: 0.979,
    fixedEyeAbove5m: 0.641,
    nominalAltitudeKm: 1.9432,
    nominalEyeAbove5m: 1.041,
  },
  alignment: { bestShiftM: [0, 0] as [number, number], tested: "±40 m in 5 m steps", verticalWithin1kmM: 0.15 },
  sigmaAngleDeg: { median: 0.16, p95: 1.4 },
  comparisons: [
    { label: "20 m → 5 m model, same observer point and sampling", maxDeg: 0.97, sunSteps: 321 },
    { label: "Same 5 m model coarsened to 20 m (sampling)", maxDeg: 0.38, sunSteps: 78 },
    { label: "Different model on the same 20 m grid", maxDeg: 1.0, sunSteps: 307 },
    { label: "Eye 0.64 m → 1.04 m above the 5 m surface", maxDeg: 0.6, sunSteps: 248 },
    { label: "Observer moved 100 m (N/E/S/W scenarios, 5 m model)", maxDeg: 3.78, sunSteps: 4153 },
    { label: "Real terrain within 300 m removed (5 m model)", maxDeg: 3.78, sunSteps: 5498 },
  ],
  demo: [
    { window: "+0d", displayed20m: [72.12, 62.83], fixed5m: [66.52, 85.0], nominal5m: [69.59, 78.33], allUp: [62.9, 92.5], allDown: [69.0, 78.67] },
    { window: "+1d", displayed20m: [72.12, 86.83], fixed5m: [66.52, 109.0], nominal5m: [69.54, 102.33], allUp: [62.9, 116.5], allDown: [69.0, 102.67] },
    { window: "+3d", displayed20m: [59.87, 134.83], fixed5m: [53.27, 157.0], nominal5m: [55.26, 150.33], allUp: [51.04, 164.5], allDown: [55.16, 150.67] },
    { window: "+7d", displayed20m: [45.59, 182.83], fixed5m: [39.04, 204.83], nominal5m: [42.31, 193.83], allUp: [34.62, 219.67], allDown: [42.36, 193.67] },
  ] as DemoRow[],
  demoWindows: "14 days from 2026-12-05 00:00 UTC, delays +0/+1/+3/+7 d, terrain mode",
} as const;
