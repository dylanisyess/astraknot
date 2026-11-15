// Wide context terrain (display only): identity binding to the site and its detailed mesh,
// exact position reconstruction against the pipeline's reference points, joint culling
// without gaps, and no-data handling. Uses the committed app/public/render assets.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SiteData } from "../types";
import { type ContextMeta, contextIndices, contextMismatch, contextPositions, insideDistance, nearFootprint, tuckM } from "./contextTerrain";
import type { TerrainAssetMeta } from "./terrainAsset";

const pub = new URL("../../public/", import.meta.url);
const json = <T,>(p: string): T => JSON.parse(readFileSync(new URL(p, pub), "utf-8")) as T;
const bytes = (p: string) => readFileSync(new URL(p, pub));
const SITES = ["im2-athena", "connecting-ridge-cr1", "im1-odysseus", "apollo17-lm"];
const site = (id: string) => json<SiteData>(`data/lvn-2026-12-01-120d/${id}.json`);
const near = (id: string) => json<TerrainAssetMeta>(`render/${id}.terrain.json`);
const ctx = (id: string) => json<ContextMeta>(`render/${id}.context.json`);
const heights = (id: string, li: number) => {
  const m = ctx(id);
  const b = bytes(`render/${m.bin_file}`);
  const l = m.levels[li];
  return new Float32Array(b.buffer.slice(b.byteOffset + l.byte_offset, b.byteOffset + l.byte_offset + l.byte_length));
};
const nearOuter = (id: string) => {
  const m = near(id);
  const l = m.levels[m.levels.length - 1];
  const b = bytes(`render/${m.bin_file}`);
  const pos = new Float32Array(b.buffer.slice(b.byteOffset + l.byte_offset, b.byteOffset + l.byte_offset + l.byte_length));
  return { l, pos };
};

describe("context terrain assets", () => {
  it.each(SITES)("%s: belongs to its site and its exact detailed mesh; bytes match", (id) => {
    const m = ctx(id);
    expect(contextMismatch(m, site(id), near(id))).toBeNull();
    const b = bytes(`render/${m.bin_file}`);
    expect(b.byteLength).toBe(m.counts.bin_bytes);
    expect(createHash("sha256").update(b).digest("hex")).toBe(m.bin_sha256);
    // reaches well beyond the detailed mesh
    expect(m.outer_half_width_m).toBeGreaterThan(2.5 * near(id).sampling.outer_half_width_m);
    expect(m.outer_half_width_m).toBeGreaterThanOrEqual(90_000);
    expect(m.levels.every((l) => l.nodata_vertices === 0)).toBe(true);
  });
  it("is refused for another site, another detailed mesh or a broken layout", () => {
    const m = ctx("im1-odysseus");
    expect(contextMismatch(m, site("apollo17-lm"), near("apollo17-lm"))).toMatch(/belongs to im1-odysseus/);
    expect(contextMismatch(m, site("im1-odysseus"), { ...near("im1-odysseus"), bin_sha256: "0".repeat(64) })).toMatch(/different detailed mesh/);
    const bad = structuredClone(m);
    bad.levels[1].byte_offset += 4;
    expect(contextMismatch(bad, site("im1-odysseus"), near("im1-odysseus"))).toMatch(/layout/);
    expect(contextMismatch({ ...m, asset_version: "render-context-0" }, site("im1-odysseus"), near("im1-odysseus"))).toMatch(/unsupported/);
  });
  it.each(SITES)("%s: closed-form positions reproduce the pipeline's full-vector reference points", (id) => {
    const m = ctx(id);
    for (const c of m.check_points) {
      const l = m.levels[c.level];
      const pos = contextPositions(l, heights(id, c.level), m.observer.observer_radius_m, m.reference_radius_m);
      const k = 3 * (c.j * l.nx + c.i);
      for (let a = 0; a < 3; a++) expect(Math.abs(pos[k + a] - c.local_m[a])).toBeLessThan(0.05); // float32 storage
    }
    // the site point itself is the DEM surface below the eye
    const l0 = m.levels[0];
    const p0 = contextPositions(l0, heights(id, 0), m.observer.observer_radius_m);
    const c0 = 3 * (((l0.nx - 1) / 2) * l0.nx + (l0.nx - 1) / 2);
    expect(p0[c0 + 1]).toBeCloseTo(-m.observer.eye_above_dem_surface_m, 2);
  });
  it.each(SITES)("%s: joint culling leaves no gap outside the detailed mesh and draws nothing deep inside it", (id) => {
    const m = ctx(id);
    const { l, pos } = nearOuter(id);
    const fp = nearFootprint(l, pos);
    let drawn = 0;
    for (const lv of m.levels) {
      const p = contextPositions(lv, heights(id, lv.index), m.observer.observer_radius_m);
      const untucked = p.slice();
      const idx = contextIndices(lv, p, fp);
      const cells = new Set<number>();
      for (let t = 0; t < idx.length; t += 6) cells.add(Math.min(idx[t], idx[t + 1], idx[t + 2]));
      drawn += idx.length / 3;
      const n = lv.nx;
      const h = lv.hole_cells;
      for (let j = 0; j < n - 1; j += 3) {
        for (let i = 0; i < n - 1; i += 3) {
          if (h && i >= h[0] && i < h[1] && j >= h[2] && j < h[3]) continue;
          const v = j * n + i;
          const cx = (untucked[3 * v] + untucked[3 * (v + n + 1)]) / 2;
          const cz = (untucked[3 * v + 2] + untucked[3 * (v + n + 1) + 2]) / 2;
          const d = insideDistance(fp, cx, cz);
          if (d < 0) expect(cells.has(v)).toBe(true); // outside the detailed mesh: always drawn
          if (d > 2 * lv.spacing_m) expect(cells.has(v)).toBe(false); // deep inside: never drawn
        }
      }
      // tuck: only inside the footprint, and small
      for (let k = 0; k < n * n; k++) {
        const dy = untucked[3 * k + 1] - p[3 * k + 1];
        if (dy > 0) expect(dy).toBeLessThanOrEqual(tuckM(Math.hypot(untucked[3 * k], untucked[3 * k + 2])) + 1e-3);
      }
    }
    expect(drawn).toBeGreaterThan(50_000); // Athena's detailed mesh already reaches 30.7 km
  });
  it("never draws a cell with a no-data vertex", () => {
    const l = { nx: 5, spacing_m: 10, hole_cells: null };
    const h = new Float32Array(25).fill(100);
    h[12] = NaN;
    const idx = contextIndices(l, contextPositions(l, h, 1737400), null);
    expect(idx.length / 6).toBe(16 - 4);
    expect([...idx].includes(12)).toBe(false);
  });
  it("inside distance is positive inside a quad of either orientation", () => {
    const q: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    expect(insideDistance(q, 0, 0)).toBeCloseTo(1);
    expect(insideDistance([...q].reverse(), 0, 0)).toBeCloseTo(1);
    expect(insideDistance(q, 2, 0)).toBeCloseTo(-1);
  });
});
