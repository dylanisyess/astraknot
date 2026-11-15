import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Availability, DAY_MS, HOUR_MS, computeMetrics, parseIntervals, scenarioWindow } from "./mission";
import {
  PROFILES,
  modeAvailability,
  polarXY,
  profileFor,
  strictHorizon,
  strictIntervals,
  surfaceDistanceKm,
  terrainFacts,
  terrainModelLabel,
} from "./sites";
import type { HorizonMode, Manifest, SiteData, SiteEntry } from "./types";

const dataDir = new URL("../public/data/", import.meta.url);
const readJson = <T,>(name: string): T => JSON.parse(readFileSync(new URL(name, dataDir), "utf-8")) as T;
const manifest = readJson<Manifest>("manifest.json");
const byId = Object.fromEntries(manifest.sites.map((e) => [e.id, readJson<SiteData>(e.file)])) as Record<string, SiteData>;
const entry = (d: SiteData): SiteEntry => ({ id: d.site.id, data: d, terrainProblem: d.terrain_horizon ? null : "no terrain horizon" });

// Independent Python reference: pipeline/crosscheck_metrics.py [--terrain] --site ID (values recorded in STATUS.md).
// [sun %, earth %, both %, longest darkness h] for 14 days from 2026-12-05 + delay.
const REF: Record<string, Record<HorizonMode, Record<number, [number, number, number, number]>>> = {
  "im2-athena": {
    terrain: { 0: [27.232142857142858, 67.26190476190476, 27.232142857142858, 244.5] },
    smooth: { 0: [43.3531746031746, 55.654761904761905, 43.3531746031746, 190.33333333333334] },
  },
  "connecting-ridge-cr1": {
    terrain: {
      0: [72.12301587301587, 25.446428571428573, 6.746031746031746, 62.833333333333336],
      1: [72.12301587301587, 32.589285714285715, 6.746031746031746, 86.83333333333333],
      3: [59.87103174603175, 46.875, 6.746031746031746, 134.83333333333334],
      7: [45.58531746031746, 75.44642857142857, 21.03174603174603, 182.83333333333334],
    },
    smooth: {
      0: [100, 28.373015873015873, 28.373015873015873, 0],
      1: [100, 35.51587301587302, 35.51587301587302, 0],
      3: [100, 49.801587301587304, 49.801587301587304, 0],
      7: [100, 78.37301587301587, 78.37301587301587, 0],
    },
  },
};

describe("each site's metrics equal its exported reference (both models)", () => {
  const base = Date.parse("2026-12-05T00:00:00Z");
  for (const [id, modes] of Object.entries(REF)) {
    for (const [mode, rows] of Object.entries(modes) as [HorizonMode, Record<number, number[]>][]) {
      for (const [delay, [sun, earth, both, dark]] of Object.entries(rows)) {
        it(`${id} ${mode} +${delay} d`, () => {
          const site = byId[id];
          const iv = parseIntervals(site, strictIntervals(site, mode));
          const m = computeMetrics(iv, scenarioWindow(base, Number(delay), 14 * DAY_MS));
          const v = (a: Availability<number>) => (a.ok ? a.value : NaN);
          expect(v(m.sunPct)).toBeCloseTo(sun, 9);
          expect(v(m.earthPct)).toBeCloseTo(earth, 9);
          expect(v(m.bothPct)).toBeCloseTo(both, 9);
          const d = m.longestDark.ok ? (m.longestDark.value?.durationMs ?? 0) / HOUR_MS : NaN;
          expect(d).toBeCloseTo(dark, 9);
        });
      }
    }
  }
});

describe("one model for every compared site (no silent mixing)", () => {
  const athena = byId["im2-athena"];
  const cr1 = byId["connecting-ridge-cr1"];
  const cr1NoTerrain: SiteData = { ...cr1, terrain_horizon: undefined };

  it("terrain is offered only when every compared site has it", () => {
    expect(modeAvailability([entry(athena), entry(cr1)]).terrain).toBe(true);
    const a = modeAvailability([entry(athena), { ...entry(cr1NoTerrain), terrainProblem: "test: removed" }]);
    expect(a.terrain).toBe(false);
    expect(a.missing).toEqual([{ id: "connecting-ridge-cr1", reason: "test: removed" }]);
    expect(modeAvailability([entry(athena)]).terrain).toBe(true);
  });

  it("a terrain request never falls back to smooth data", () => {
    expect(() => strictIntervals(cr1NoTerrain, "terrain")).toThrow(/terrain intervals requested/);
    expect(() => strictHorizon(cr1NoTerrain, "terrain")).toThrow(/terrain horizon requested/);
    expect(strictHorizon(cr1, "terrain").model).toBe("terrain");
    expect(strictHorizon(cr1, "smooth").model).toBe("smooth");
    expect(strictIntervals(cr1, "terrain")).toBe(cr1.terrain_horizon!.visibility_intervals);
  });

  it("each site's intervals come from its own file", () => {
    expect(strictIntervals(athena, "terrain")).not.toEqual(strictIntervals(cr1, "terrain"));
    expect(strictHorizon(athena, "terrain").elevation_deg).not.toEqual(strictHorizon(cr1, "terrain").elevation_deg);
  });
});

describe("site profiles and data-derived facts", () => {
  it("CR1 carries the required label and provisional wording; Athena does not", () => {
    expect(profileFor(byId["connecting-ridge-cr1"]).label).toBe("Connecting Ridge CR1 — NASA notional study point");
    expect(profileFor(byId["connecting-ridge-cr1"]).provisionalTerrain).toBe("Provisional: sensitive to terrain model");
    expect(profileFor(byId["im2-athena"]).provisionalTerrain).toBeNull();
  });

  it("no profile mentions the other site", () => {
    const a = JSON.stringify(PROFILES["im2-athena"]);
    const c = JSON.stringify(PROFILES["connecting-ridge-cr1"]);
    for (const w of ["CR1", "Connecting", "notional", "ACD-50044", "0.0235"]) expect(a).not.toContain(w);
    for (const w of ["Athena", "LROC", "Mons Mouton", "im2-athena", "0.0034", "2026-12-30"]) expect(c).not.toContain(w);
  });

  it("an unknown site gets neutral, data-only wording", () => {
    const fake = { ...byId["im2-athena"], site: { ...byId["im2-athena"].site, id: "test-site", name: "Test site" } };
    const p = profileFor(fake);
    expect(p.label).toBe("Test site");
    expect(JSON.stringify(p)).not.toMatch(/Athena|CR1|Connecting/);
    expect(p.provisionalTerrain).toBeNull();
  });

  it("model labels and terrain facts come from each file", () => {
    expect(terrainModelLabel(byId["connecting-ridge-cr1"])).toMatch(/^20 m LOLA model \(LDEM_80S_20M; LDEM_75S_60M beyond its edge\)$/);
    const f = terrainFacts(byId["connecting-ridge-cr1"])!;
    expect(f.nearFieldDominated).toBe(true);
    expect(f.settingDistanceM[0]).toBeCloseTo(50, 6);
    expect(f.settingDistanceM[2]).toBeCloseTo(480, 6);
    expect(f.zeroShot).toBe(881);
    const g = terrainFacts(byId["im2-athena"])!;
    expect(g.nearFieldDominated).toBe(false);
    expect(g.zeroShot).toBe(974);
  });

  it("locator geometry: LOLA polar convention and surface distance", () => {
    const e = polarXY(-89, 90);
    expect(e.x).toBeCloseTo(30.32, 1); // 90 E plots to the right
    expect(Math.abs(e.y)).toBeLessThan(1e-9);
    expect(polarXY(-89, 0).y).toBeGreaterThan(0); // 0 deg up
    const d = surfaceDistanceKm(byId["im2-athena"].site, byId["connecting-ridge-cr1"].site);
    expect(d).toBeGreaterThan(150);
    expect(d).toBeLessThan(200);
  });
});
