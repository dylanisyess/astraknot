import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifySteps, horizonAt, horizonFor, interpAzimuth, intervalsFor, terrainProblem } from "./horizon";
import { DAY_MS, computeMetrics, parseIntervals, scenarioWindow } from "./mission";
import type { HorizonMode, Manifest, SiteData } from "./types";

const dataDir = new URL("../public/data/", import.meta.url);
const readJson = <T,>(name: string): T => JSON.parse(readFileSync(new URL(name, dataDir), "utf-8")) as T;

describe("horizonAt (synthetic profiles)", () => {
  const h = { azimuth_deg: [0, 90, 180, 270], elevation_deg: [0, 2, null, 4] as (number | null)[] };

  it("interpolates linearly and wraps across 360/0", () => {
    expect(horizonAt(h, 45)).toBeCloseTo(1, 12);
    expect(horizonAt(h, 315)).toBeCloseTo(2, 12); // between 270 (4) and 360 = 0 (0)
    expect(horizonAt(h, 359.999)).toBeCloseTo(0.0000444, 6);
    expect(horizonAt(h, -45)).toBeCloseTo(2, 12);
    expect(horizonAt(h, 405)).toBeCloseTo(1, 12);
  });

  it("keeps unknown sectors unknown, never 0", () => {
    expect(horizonAt(h, 135)).toBeNull();
    expect(horizonAt(h, 225)).toBeNull();
    expect(horizonAt(h, 180)).toBeNull();
  });

  it("uses a known sample exactly at its azimuth even next to an unknown one (pipeline rule)", () => {
    expect(horizonAt(h, 90)).toBe(2);
    expect(horizonAt(h, 270)).toBe(4);
  });

  it("interpolates azimuth along the shortest path", () => {
    expect(interpAzimuth(359, 1, 0.5)).toBeCloseTo(0, 12);
    expect(interpAzimuth(1, 359, 0.5)).toBeCloseTo(0, 12);
    expect(interpAzimuth(350, 10, 0.25)).toBeCloseTo(355, 12);
  });
});

describe("real exported dataset: both horizon modes", () => {
  const manifest = readJson<Manifest>("manifest.json");
  const site = readJson<SiteData>(manifest.sites[0].file);
  const step = manifest.sample_step_seconds * 1000;
  const t0 = Date.parse(site.samples[0].time_utc);

  it("offers a terrain horizon that passes the loader checks", () => {
    expect(site.site.available_horizon_models).toEqual(["smooth", "terrain"]);
    expect(terrainProblem(site)).toBeNull();
    expect(site.terrain_horizon!.horizon.model).toBe("terrain");
    expect(site.horizon.model).toBe("smooth"); // milestone-2 smooth result kept as is
  });

  for (const mode of ["smooth", "terrain"] as HorizonMode[]) {
    it(`${mode}: TypeScript re-classification of every 10-min step equals the exported intervals`, () => {
      const steps = classifySteps(site.samples, horizonFor(site, mode)!);
      const iv = parseIntervals(site, intervalsFor(site, mode));
      let mismatches = 0;
      steps.forEach((s, k) => {
        const t = t0 + k * step;
        const cur = iv.find((x) => x.start <= t && t < x.end)!;
        if (cur.sun !== s.sun || cur.earth !== s.earth) mismatches++;
      });
      expect(steps).toHaveLength(site.samples.length - 1);
      expect(mismatches).toBe(0);
    });
  }

  it("terrain metrics for the demo scenario equal the independent Python reference", () => {
    // python pipeline/crosscheck_metrics.py --terrain (shares no code with this app)
    const iv = parseIntervals(site, intervalsFor(site, "terrain"));
    const base = Date.parse("2026-12-05T00:00:00Z");
    const m0 = computeMetrics(iv, scenarioWindow(base, 0, 14 * DAY_MS));
    const m3 = computeMetrics(iv, scenarioWindow(base, 3, 14 * DAY_MS));
    const v = (a: { ok: boolean; value?: number }) => (a.ok ? a.value! : NaN);
    expect(v(m0.sunPct)).toBeCloseTo(27.232142857142858, 9);
    expect(v(m0.earthPct)).toBeCloseTo(67.26190476190476, 9);
    expect(v(m0.bothPct)).toBeCloseTo(27.232142857142858, 9);
    expect(m0.longestDark.ok && m0.longestDark.value!.durationMs / 3_600_000).toBeCloseTo(244.5, 9);
    expect(v(m3.sunPct)).toBeCloseTo(48.660714285714285, 9);
    expect(v(m3.earthPct)).toBeCloseTo(88.69047619047619, 9);
    expect(m3.longestDark.ok && m3.longestDark.value!.durationMs / 3_600_000).toBeCloseTo(172.5, 9);
  });

  it("switching mode changes visibility, never the window or its duration", () => {
    const base = Date.parse("2026-12-05T00:00:00Z");
    const w = scenarioWindow(base, 3, 14 * DAY_MS);
    const ms = computeMetrics(parseIntervals(site, intervalsFor(site, "smooth")), w);
    const mt = computeMetrics(parseIntervals(site, intervalsFor(site, "terrain")), w);
    expect(mt.window).toEqual(ms.window);
    expect(mt.durationMs).toBe(ms.durationMs);
    expect(ms.sunPct.ok && mt.sunPct.ok && ms.sunPct.value !== mt.sunPct.value).toBe(true);
  });

  it("exports the four 100 m site-shift scenarios as deltas vs the nominal point", () => {
    const sc = site.terrain_horizon!.checks.site_shift_scenarios!;
    expect(sc.note).toMatch(/not a measured coordinate uncertainty/);
    expect(sc.rows.map((r) => r.direction)).toEqual(["north", "east", "south", "west"]);
    const east = sc.rows[1];
    expect(east.demo_windows).toEqual(["+0d", "+1d", "+3d", "+7d"]);
    expect(east.earth_pct_change_pp).toEqual([-4.81, -4.81, -4.81, 0]);
    expect(east.skyline_max_abs_change_deg).toBeCloseTo(2.013, 3);
    for (const r of sc.rows) for (const v of r.sun_pct_change_pp) expect(Math.abs(v ?? 0)).toBeLessThanOrEqual(0.05);
    const nf = site.terrain_horizon!.checks.near_field!;
    expect(nf.min_setting_distance_m).toBe(330);
    expect(nf.max_change_ignoring_terrain_within_20_to_300m_deg).toBe(0);
  });

  it("terrainProblem rejects a broken block (synthetic)", () => {
    const broken = structuredClone(site);
    broken.terrain_horizon!.horizon.azimuth_deg[5] = 400;
    expect(terrainProblem(broken)).toMatch(/ascending/);
    const gap = structuredClone(site);
    gap.terrain_horizon!.visibility_intervals.splice(1, 1);
    expect(terrainProblem(gap)).toMatch(/contiguous/);
    const none = structuredClone(site);
    delete none.terrain_horizon;
    expect(terrainProblem(none)).toMatch(/no terrain/);
  });
});
