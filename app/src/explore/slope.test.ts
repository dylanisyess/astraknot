// Terrain hazard screening (5C): asset identity, statistics against the pipeline evidence,
// threshold semantics, mapping onto the displayed mesh, inspection, and independence from
// visibility. Uses the committed app/public files and data/screening evidence.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SiteData } from "../types";
import {
  LEGEND_MAX_DEG,
  SLOPE_STOPS,
  type SlopeAsset,
  cellOf,
  clampThreshold,
  coverageNote,
  groundDistanceM,
  inspect,
  nearestRank,
  screeningAlert,
  slopeAssetProblem,
  slopeColor,
  slopeSummary,
  thresholdCentideg,
} from "./slope";
import type { TerrainAssetMeta } from "./terrainAsset";

const pub = new URL("../../public/", import.meta.url);
const repo = new URL("../../../", import.meta.url);
const IDS = ["im2-athena", "connecting-ridge-cr1"] as const;
const site = (id: string) => JSON.parse(readFileSync(new URL(`data/${id}.json`, pub), "utf-8")) as SiteData;
export const slopeAssetOf = (id: string) => JSON.parse(readFileSync(new URL(`screening/${id}.slope.json`, pub), "utf-8")) as SlopeAsset;
const evidence = (id: string) => JSON.parse(readFileSync(new URL(`data/screening/${id}_slope_report.json`, repo), "utf-8"));
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** A tiny synthetic asset (3 x 3 grid) for semantics tests. */
function tiny(values: (number | null)[], states: number[]): SlopeAsset {
  const a = clone(slopeAssetOf("im2-athena"));
  a.grid.nx = a.grid.ny = 3;
  a.grid.state = states;
  a.grid.slope_centideg = values;
  a.observer_cell.cell = [1, 1];
  a.grid.local_to_cell = { a: [1, 1 / 20, 0], b: [1, 0, 1 / 20], max_residual_cells: 0 };
  return a;
}

describe("screening assets belong to exactly one site", () => {
  it("each asset matches its own site export and is refused for the other", () => {
    for (const id of IDS) expect(slopeAssetProblem(slopeAssetOf(id), site(id))).toBeNull();
    expect(slopeAssetProblem(slopeAssetOf("im2-athena"), site("connecting-ridge-cr1"))).toMatch(/not connecting-ridge-cr1/);
  });
  it("refuses changed observers, broken grids and values without a valid state", () => {
    const a = clone(slopeAssetOf("connecting-ridge-cr1"));
    a.observer.observer_radius_m += 0.01;
    expect(slopeAssetProblem(a, site("connecting-ridge-cr1"))).toMatch(/observer/);
    const b = clone(slopeAssetOf("connecting-ridge-cr1"));
    b.grid.state.pop();
    expect(slopeAssetProblem(b, site("connecting-ridge-cr1"))).toMatch(/grid size/);
    const c = clone(slopeAssetOf("connecting-ridge-cr1"));
    const k = c.grid.state.indexOf(0);
    c.grid.slope_centideg[k] = 0; // a value outside the footprint would be fabricated data
    expect(slopeAssetProblem(c, site("connecting-ridge-cr1"))).toMatch(/states/);
  });
});

describe("statistics agree with the pipeline evidence", () => {
  for (const id of IDS) {
    it(`${id}: median, 95th percentile, coverage and exceedance at every reported threshold`, () => {
      const a = slopeAssetOf(id);
      const ev = evidence(id);
      const s = slopeSummary(a, 15);
      expect(s.medianDeg).toBe(ev.stats.median_deg);
      expect(s.p95Deg).toBe(ev.stats.p95_deg);
      expect(s.maxDeg).toBe(ev.stats.max_deg);
      expect(s.cellsInFootprint).toBe(ev.stats.cells_in_footprint);
      expect(s.cellsValid).toBe(ev.stats.cells_valid);
      expect(s.validFraction).toBe(ev.stats.valid_fraction);
      expect(s.observerCellDeg).toBe(a.observer_cell.slope_deg);
      for (const e of ev.stats.exceedance) {
        const t = slopeSummary(a, e.threshold_deg);
        expect(t.cellsAbove).toBe(e.cells_above);
        expect(t.aboveFraction).toBeCloseTo(e.fraction_equal_weight, 12);
      }
    });
  }
  it("the threshold changes classifications, never the measured values", () => {
    const a = slopeAssetOf("connecting-ridge-cr1");
    const before = JSON.stringify(a.grid.slope_centideg);
    const s10 = slopeSummary(a, 10);
    const s20 = slopeSummary(a, 20);
    expect(JSON.stringify(a.grid.slope_centideg)).toBe(before);
    expect([s10.medianDeg, s10.p95Deg, s10.cellsValid]).toEqual([s20.medianDeg, s20.p95Deg, s20.cellsValid]);
    expect(s10.cellsAbove).toBeGreaterThan(s20.cellsAbove);
  });
  it("matched footprints: same radius, method, DEM and one fixed color scale at both sites", () => {
    const [a, b] = IDS.map(slopeAssetOf);
    expect(a.footprint.radius_m).toBe(500);
    expect(b.footprint.radius_m).toBe(a.footprint.radius_m);
    expect(b.method.name).toBe(a.method.name);
    expect(b.method.exceedance).toBe(a.method.exceedance);
    expect(b.source_dem.product).toBe(a.source_dem.product);
    expect(Math.abs(a.method.baseline_m - b.method.baseline_m)).toBeLessThan(0.2);
    expect(SLOPE_STOPS[SLOPE_STOPS.length - 1].deg).toBe(LEGEND_MAX_DEG);
    expect(slopeColor(45)).toEqual(slopeColor(LEGEND_MAX_DEG)); // clamped, never rescaled per site
  });
});

describe("threshold and denominator semantics", () => {
  it("equal to the threshold is not an exceedance; 0.01° resolution", () => {
    const a = tiny([1500, 1501, 1499, null, 200, 300, 400, 500, 600], [1, 1, 1, 0, 1, 1, 1, 1, 1]);
    const s = slopeSummary(a, 15);
    expect(s.cellsAbove).toBe(1);
    expect(s.aboveFraction).toBe(1 / 8);
    expect(thresholdCentideg(0.29)).toBe(29); // 0.29 * 100 is not exact in binary
    expect(slopeSummary(tiny([29, 30, 0, 0, 0, 0, 0, 0, 0], Array(9).fill(1)), 0.29).cellsAbove).toBe(1);
    expect(clampThreshold(0)).toBe(1);
    expect(clampThreshold(90)).toBe(45);
    expect(clampThreshold(15.04)).toBe(15);
  });
  it("invalid and outside cells are excluded from the valid-area denominator and reported", () => {
    const a = tiny([2000, null, null, 100, 100, 100, null, 100, 100], [1, 2, 0, 1, 1, 1, 2, 1, 1]);
    const s = slopeSummary(a, 15);
    expect(s.cellsInFootprint).toBe(8);
    expect(s.cellsValid).toBe(6);
    expect(s.cellsInvalid).toBe(2);
    expect(s.aboveFraction).toBe(1 / 6);
    expect(coverageNote(s)).toMatch(/Incomplete coverage: 75\.0 %/);
    expect(coverageNote(slopeSummary(slopeAssetOf("im2-athena"), 15))).toBeNull();
  });
  it("nearest-rank percentiles (the pipeline's definition)", () => {
    const v = Array.from({ length: 100 }, (_, k) => k + 1);
    expect(nearestRank(v, 50)).toBe(50);
    expect(nearestRank(v, 95)).toBe(95);
    expect(nearestRank([1, 2, 3, 4], 50)).toBe(2);
    expect(nearestRank([], 50)).toBeNull();
  });
  it("alerts use computed values only and never call terrain safe", () => {
    const cr1 = screeningAlert(slopeSummary(slopeAssetOf("connecting-ridge-cr1"), 15));
    expect(cr1.text).toBe("5.3 % of analyzed terrain exceeds the 15° screening threshold within 500 m of the modeled observer.");
    const ath = screeningAlert(slopeSummary(slopeAssetOf("im2-athena"), 15));
    expect(ath.text).toBe("No threshold exceedances detected at this DEM scale.");
    for (const t of [cr1.text, ath.text]) expect(t.toLowerCase()).not.toContain("safe");
    expect(screeningAlert(slopeSummary(tiny(Array(9).fill(null), [2, 2, 2, 2, 2, 2, 2, 2, 2]), 15)).tone).toBe("nodata");
  });
});

describe("slope cells map onto the displayed terrain", () => {
  const level = (id: string, li: number) => {
    const m = JSON.parse(readFileSync(new URL(`render/${id}.terrain.json`, pub), "utf-8")) as TerrainAssetMeta;
    const buf = readFileSync(new URL(`render/${m.bin_file}`, pub));
    const L = m.levels[li];
    const pos = new Float32Array(buf.buffer.slice(buf.byteOffset + L.byte_offset, buf.byteOffset + L.byte_offset + L.byte_length));
    return { m, L, pos, anchor: (m.source_dem as unknown as { anchor_pixel_1based: [number, number] }).anchor_pixel_1based };
  };
  for (const id of IDS) {
    it(`${id}: check points and every mesh vertex at a footprint pixel centre map to that cell`, () => {
      const a = slopeAssetOf(id);
      for (const cp of a.grid.check_points) expect(cellOf(a, cp.local_xyz[0], cp.local_xyz[2])).toEqual({ a: cp.cell[0], b: cp.cell[1] });
      const g = a.grid as SlopeAsset["grid"] & { i0_pixel_1based: number; j0_pixel_1based: number };
      for (const li of [0, 1]) {
        const { L, pos, anchor } = level(id, li);
        const per = Math.round(1 / L.spacing_px); // vertices per pixel
        const half = (L.nx - 1) / 2;
        let checked = 0;
        for (let b = 0; b < g.ny; b++) {
          for (let c = 0; c < g.nx; c++) {
            if (g.state[b * g.nx + c] === 0) continue;
            const i = (g.i0_pixel_1based + c - anchor[0]) * per + half;
            const j = (g.j0_pixel_1based + b - anchor[1]) * per + half;
            const k = 3 * (j * L.nx + i);
            expect(cellOf(a, pos[k], pos[k + 2])).toEqual({ a: c, b });
            checked++;
          }
        }
        expect(checked).toBe(a.footprint.cells_in_footprint);
      }
    });
    it(`${id}: sub-pixel render vertices take their containing cell's value (no interpolated slope)`, () => {
      const a = slopeAssetOf(id);
      const { L, pos, anchor } = level(id, 0);
      const per = Math.round(1 / L.spacing_px);
      const half = (L.nx - 1) / 2;
      const g = a.grid as SlopeAsset["grid"] & { i0_pixel_1based: number; j0_pixel_1based: number };
      const ci = (g.i0_pixel_1based + a.observer_cell.cell[0] - anchor[0]) * per + half;
      const cj = (g.j0_pixel_1based + a.observer_cell.cell[1] - anchor[1]) * per + half;
      for (let d = -per; d <= per; d++) {
        const k = 3 * (cj * L.nx + ci + d);
        const f = d / per; // pixel offset of this vertex along +I
        const want = Math.abs(f) < 0.5 ? a.observer_cell.cell[0] : a.observer_cell.cell[0] + Math.sign(f);
        if (Math.abs(Math.abs(f) - 0.5) < 1e-9) continue; // exactly on a cell edge
        expect(cellOf(a, pos[k], pos[k + 2])?.a).toBe(want);
      }
    });
  }
});

describe("terrain inspection reads slope only", () => {
  const a = slopeAssetOf("connecting-ridge-cr1");
  it("inside the footprint: the containing cell's value, threshold class and ground distance", () => {
    const cp = a.grid.check_points.find((c) => c.cell[0] === a.observer_cell.cell[0] && c.cell[1] === a.observer_cell.cell[1])!;
    const r = inspect(a, cp.local_xyz, 15);
    expect(r.kind).toBe("valid");
    if (r.kind !== "valid") return;
    expect(r.slopeDeg).toBe(a.observer_cell.slope_deg);
    expect(r.above).toBe(false);
    expect(r.distanceM).toBeLessThan(15);
    expect(inspect(a, cp.local_xyz, 0.5).kind === "valid" && (inspect(a, cp.local_xyz, 0.5) as { above: boolean }).above).toBe(true);
  });
  it("outside the footprint or the grid: no slope value is reported", () => {
    const corner = a.grid.check_points.find((c) => c.cell[0] === 0 && c.cell[1] === 0)!;
    expect(inspect(a, corner.local_xyz, 15).kind).toBe("outside");
    const far = inspect(a, [2400, -30, -1800], 15);
    expect(far.kind).toBe("outside");
    expect(far.distanceM).toBeGreaterThan(2900);
    expect("slopeDeg" in far).toBe(false);
  });
  it("an invalid cell inside the footprint reports no slope data", () => {
    const t = tiny([100, 100, 100, 100, null, 100, 100, 100, 100], [1, 1, 1, 1, 2, 1, 1, 1, 1]);
    expect(inspect(t, [0, 0, 0], 15).kind).toBe("invalid");
  });
  it("ground distance is the footprint's great-circle definition", () => {
    const ring = a.rings.find((r) => r.radius_m === 250)!;
    for (const p of ring.points.slice(0, 20)) expect(Math.abs(groundDistanceM(p, a.observer.observer_radius_m) - 250)).toBeLessThan(0.01);
  });
});
