import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CR1_5M } from "./assessment";
import { DAY_MS, HOUR_MS, computeMetrics, parseIntervals, scenarioWindow } from "./mission";
import type { SiteData } from "./types";

const repo = new URL("../../", import.meta.url);
const evidencePath = new URL("data/terrain/connecting-ridge-cr1_terrain_5m_assessment.json", repo);
const reportPath = new URL("data/terrain/connecting-ridge-cr1_terrain_horizon.json", repo);
const ev: any = JSON.parse(readFileSync(evidencePath, "utf-8"));
const site = JSON.parse(readFileSync(new URL("../public/data/connecting-ridge-cr1.json", import.meta.url), "utf-8")) as SiteData;

describe("CR1 5 m assessment summary matches the committed evidence", () => {
  it("refers to the exported CR1 site and to the 20 m report the export was built from", () => {
    expect(ev.site.id).toBe(CR1_5M.siteId);
    expect(ev.site.id).toBe(site.site.id);
    expect(ev.site.latitude_deg).toBe(site.site.latitude_deg);
    expect(ev.site.longitude_deg_east).toBe(site.site.longitude_deg_east);
    expect(ev.site.horizons_site_altitude_km).toBe(site.site.horizons_site_altitude_km);
    const sha = createHash("sha256").update(readFileSync(reportPath)).digest("hex");
    expect(ev.terrain_report_20m_sha256).toBe(sha);
  });

  it("surfaces and observer conventions", () => {
    const o = ev.observer;
    expect(o.surface_m.ldem20_bilinear).toBeCloseTo(CR1_5M.surfaceM.ldem20, 3);
    expect(o.surface_m.pgda5_bilinear).toBeCloseTo(CR1_5M.surfaceM.pgda5, 3);
    expect(o.fixed_radius.horizons_altitude_km).toBe(CR1_5M.observer.fixedRadiusAltitudeKm);
    expect(o.fixed_radius.eye_above_ldem20_m).toBeCloseTo(CR1_5M.observer.fixedEyeAbove20m, 3);
    expect(o.fixed_radius.eye_above_pgda5_m).toBeCloseTo(CR1_5M.observer.fixedEyeAbove5m, 3);
    expect(o.nominal_on_pgda5.horizons_altitude_km).toBe(CR1_5M.observer.nominalAltitudeKm);
    expect(o.nominal_on_pgda5.eye_above_pgda5_m).toBeCloseTo(CR1_5M.observer.nominalEyeAbove5m, 3);
    expect(site.site.horizons_site_altitude_km).toBe(CR1_5M.observer.fixedRadiusAltitudeKm); // displayed = fixed point
  });

  it("alignment and uncertainty scale", () => {
    expect([ev.alignment.shift_search_within_1km.best.dx_m, ev.alignment.shift_search_within_1km.best.dy_m]).toEqual(CR1_5M.alignment.bestShiftM);
    expect(ev.alignment.shift_search_within_1km.max_shift_m).toBe(40);
    expect(ev.alignment.shift_search_within_1km.shift_step_m).toBe(5);
    expect(ev.alignment.block_mean_minus_ldem20_m.within_1km.mean).toBeCloseTo(CR1_5M.alignment.verticalWithin1kmM, 2);
    expect(ev.uncertainty.as_elevation_angle_deg.median).toBeCloseTo(CR1_5M.sigmaAngleDeg.median, 2);
    expect(ev.uncertainty.as_elevation_angle_deg.p95).toBeCloseTo(CR1_5M.sigmaAngleDeg.p95, 1);
  });

  it("pairwise comparisons (largest values over the listed variants)", () => {
    const c = (a: string, b: string) => ev.comparisons.find((x: any) => x.a === a && x.b === b);
    const pick = (pairs: [string, string][]) => ({
      maxDeg: Math.max(...pairs.map(([a, b]) => c(a, b).angular_b_minus_a.max_abs_deg)),
      sunSteps: Math.max(...pairs.map(([a, b]) => c(a, b).sun_steps_changed)),
    });
    const expected = [
      pick([["L20_fixed_base5", "F5_fixed"]]),
      pick([["F5_fixed", "B4_fixed"]]),
      pick([["L20_fixed_base5", "B4_fixed"]]),
      pick([["F5_fixed", "F5_nominal"]]),
      pick((["N", "E", "S", "W"] as const).map((d) => ["F5_fixed", `F5_shift_100m_${d}`] as [string, string])),
      pick([["F5_fixed", "F5_ignore_lt_300m"]]),
    ];
    CR1_5M.comparisons.forEach((row, k) => {
      expect(row.maxDeg).toBeCloseTo(expected[k].maxDeg, 2);
      expect(row.sunSteps).toBe(expected[k].sunSteps);
    });
  });

  it("demo-window rows, and the displayed 20 m column equals the app's own metrics", () => {
    const prof = ev.profiles;
    const ill = ev.uncertainty.coherent_1sigma_shift_illustration;
    const iv = parseIntervals(site, site.terrain_horizon!.visibility_intervals);
    for (const r of CR1_5M.demo) {
      const pair = (d: { sun_pct: number; longest_dark_h: number }) => [d.sun_pct, d.longest_dark_h];
      const close = (got: number[], want: readonly number[]) => {
        expect(got[0]).toBeCloseTo(want[0], 2);
        expect(got[1]).toBeCloseTo(want[1], 2);
      };
      close(pair(prof.L20.demo[r.window]), r.displayed20m);
      close(pair(prof.F5_fixed.demo[r.window]), r.fixed5m);
      close(pair(prof.F5_nominal.demo[r.window]), r.nominal5m);
      close(pair(ill.plus_1sigma.demo[r.window]), r.allUp);
      close(pair(ill.minus_1sigma.demo[r.window]), r.allDown);
      const m = computeMetrics(iv, scenarioWindow(Date.parse("2026-12-05T00:00:00Z"), Number(r.window.slice(1, 2)), 14 * DAY_MS));
      expect(m.sunPct.ok && m.sunPct.value).toBeCloseTo(r.displayed20m[0], 2);
      expect(m.longestDark.ok ? m.longestDark.value!.durationMs / HOUR_MS : NaN).toBeCloseTo(r.displayed20m[1], 2);
    }
  });
});

describe("CR1 rounding-effect wording matches the pipeline evidence", () => {
  it("connecting-ridge-cr1_observer_rounding_check.json", async () => {
    const { PROFILES } = await import("./sites");
    const r = JSON.parse(readFileSync(new URL("data/terrain/connecting-ridge-cr1_observer_rounding_check.json", repo), "utf-8"));
    const txt = PROFILES["connecting-ridge-cr1"].roundingEffect!;
    expect(r.site.id).toBe("connecting-ridge-cr1");
    expect(txt).toContain(`${(1 - r.eye_above_dem_submitted_m).toFixed(4)} m lower`);
    expect(txt).toContain(`${r.skyline_change_deg.max_abs.toFixed(4)}°`);
    expect(txt).toContain(`${r.steps_changed.sun} Sun and ${r.steps_changed.earth} Earth`);
    const d = Object.values(r.demo_metric_change_exact_minus_submitted) as { sun_pct: number; longest_dark_h: number }[];
    expect(txt).toContain(`+${Math.max(...d.map((x) => x.sun_pct)).toFixed(2)} pp`);
    expect(txt).toContain(`−${Math.max(...d.map((x) => -x.longest_dark_h)).toFixed(2)} h`);
  });
});
