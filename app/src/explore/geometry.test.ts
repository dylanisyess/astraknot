// Renderer axis mapping, handedness, camera orientation, triangulation and the exported assets.
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { SiteData } from "../types";
import { type Vec3, azDelta, azElFromVector, cross, directionFromAzEl, gridIndices, needsFlip, smoothNormals, stitchNormals } from "./geometry";
import { type TerrainAssetMeta, assetMismatch, terrainMatchesSite } from "./terrainAsset";

const pub = new URL("../../public/", import.meta.url);
const site = (id: string) => JSON.parse(readFileSync(new URL(`data/${id}.json`, pub), "utf-8")) as SiteData;
const meta = (id: string) => JSON.parse(readFileSync(new URL(`render/${id}.terrain.json`, pub), "utf-8")) as TerrainAssetMeta;
const close = (a: Vec3, b: Vec3, eps = 1e-12) => a.forEach((x, i) => expect(Math.abs(x - b[i])).toBeLessThan(eps));

describe("renderer axes: x = east, y = up, z = -north", () => {
  it("cardinal directions", () => {
    close(directionFromAzEl(0, 0), [0, 0, -1]);
    close(directionFromAzEl(90, 0), [1, 0, 0]);
    close(directionFromAzEl(180, 0), [0, 0, 1]);
    close(directionFromAzEl(270, 0), [-1, 0, 0]);
    close(directionFromAzEl(42, 90), [0, 1, 0]);
  });
  it("is right-handed and Y-up: east x north = up, x x y = z", () => {
    close(cross(directionFromAzEl(90, 0), directionFromAzEl(0, 0)), [0, 1, 0]);
    close(cross([1, 0, 0], [0, 1, 0]), [0, 0, 1]);
  });
  it("round-trips azimuth/elevation", () => {
    for (const az of [0, 0.05, 89.9, 180, 271.3, 359.95]) {
      for (const el of [-1.47, 0, 4.07, 60]) {
        const r = azElFromVector(directionFromAzEl(az, el));
        expect(Math.abs(azDelta(r.az, az))).toBeLessThan(1e-9);
        expect(Math.abs(r.el - el)).toBeLessThan(1e-9);
      }
    }
  });
  it("the observer-view camera (Euler YXZ: pitch, -yaw) looks along (yaw, pitch)", () => {
    const cam = new THREE.PerspectiveCamera();
    const v = new THREE.Vector3();
    for (const [yaw, pitch] of [[0, 0], [90, 0], [137.4, 1.2], [322, 6], [250, -10]]) {
      cam.rotation.set(THREE.MathUtils.degToRad(pitch), THREE.MathUtils.degToRad(-yaw), 0, "YXZ");
      cam.updateMatrixWorld();
      cam.getWorldDirection(v);
      close([v.x, v.y, v.z], directionFromAzEl(yaw, pitch), 1e-9);
    }
  });
  it("facing north, the Sun moves right to left (x falls) at both sites", () => {
    for (const id of ["im2-athena", "connecting-ridge-cr1"]) {
      const s = site(id).samples;
      let checked = 0;
      for (let k = 0; k + 1 < s.length; k++) {
        const a = s[k].sun_azimuth_deg!;
        if (Math.abs(azDelta(0, a)) > 45) continue;
        const x0 = directionFromAzEl(a, s[k].sun_elevation_deg!)[0];
        const x1 = directionFromAzEl(s[k + 1].sun_azimuth_deg!, s[k + 1].sun_elevation_deg!)[0];
        expect(x1).toBeLessThan(x0);
        checked++;
      }
      expect(checked).toBeGreaterThan(500);
    }
  });
  it("Earth stays in its documented azimuth band (Athena 322–339°, CR1 129–146°)", () => {
    for (const [id, lo, hi] of [["im2-athena", 322, 339], ["connecting-ridge-cr1", 129, 146]] as const) {
      for (const x of site(id).samples) {
        const { az } = azElFromVector(directionFromAzEl(x.earth_azimuth_deg!, x.earth_elevation_deg!));
        expect(az).toBeGreaterThanOrEqual(lo);
        expect(az).toBeLessThanOrEqual(hi);
      }
    }
  });
});

describe("grid triangulation matches pipeline/render_assets.py", () => {
  it("cells, diagonal and hole", () => {
    const idx = gridIndices(4, 4, [1, 2, 1, 2]);
    expect(idx.length).toBe(3 * 2 * 8);
    expect(Array.from(idx.slice(0, 6))).toEqual([0, 4, 1, 1, 4, 5]);
    const flipped = gridIndices(4, 4, null, true);
    expect(Array.from(flipped.slice(0, 6))).toEqual([0, 1, 4, 1, 5, 4]);
  });
  it("front faces of every exported level point up", () => {
    for (const id of ["im2-athena", "connecting-ridge-cr1"]) {
      const m = meta(id);
      const buf = readFileSync(new URL(`render/${m.bin_file}`, pub));
      for (const lv of m.levels) {
        const pos = new Float32Array(buf.buffer, buf.byteOffset + lv.byte_offset, 3 * lv.vertex_count);
        const idx = gridIndices(lv.nx, lv.ny, lv.hole_cells, needsFlip(pos, lv.nx));
        let down = 0;
        for (let t = 0; t < idx.length; t += 3 * 997) {
          const p = (v: number): Vec3 => [pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]];
          const a = p(idx[t]), b = p(idx[t + 1]), c = p(idx[t + 2]);
          const n = cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
          if (n[1] <= 0) down++;
        }
        expect(down).toBe(0);
      }
    }
  });
  it("shading helpers keep unit normals and change no positions", () => {
    const n = 5;
    const N = new Float32Array(3 * n * n);
    for (let k = 0; k < n * n; k++) N.set([Math.sin(k), 1, Math.cos(k)].map((x) => x / Math.hypot(Math.sin(k), 1, Math.cos(k))), 3 * k);
    smoothNormals(N, n, 1);
    for (let k = 0; k < N.length; k += 3) expect(Math.hypot(N[k], N[k + 1], N[k + 2])).toBeCloseTo(1, 6);
    const C = new Float32Array(3 * 9 * 9).fill(0);
    for (let k = 0; k < 81; k++) C[3 * k + 1] = 1;
    stitchNormals(N, n, C, 9, 2, 2);
    for (let k = 0; k < N.length; k += 3) expect(Math.hypot(N[k], N[k + 1], N[k + 2])).toBeCloseTo(1, 6);
  });
});

describe("rendering assets belong to exactly one site", () => {
  const A = site("im2-athena");
  const C = site("connecting-ridge-cr1");
  it("each asset matches its own site export (observer, eye, layout)", () => {
    expect(assetMismatch(meta("im2-athena"), A)).toBeNull();
    expect(assetMismatch(meta("connecting-ridge-cr1"), C)).toBeNull();
  });
  it("an asset is refused for the other site", () => {
    expect(assetMismatch(meta("im2-athena"), C)).toMatch(/belongs to im2-athena/);
    expect(assetMismatch(meta("connecting-ridge-cr1"), A)).toMatch(/belongs to connecting-ridge-cr1/);
  });
  it("a changed observer or layout is refused", () => {
    const m = meta("connecting-ridge-cr1");
    expect(assetMismatch({ ...m, observer: { ...m.observer, observer_radius_m: m.observer.observer_radius_m + 0.01 } }, C)).toMatch(/observer radius/);
    expect(assetMismatch({ ...m, counts: { ...m.counts, bin_bytes: m.counts.bin_bytes - 12 } }, C)).toMatch(/do not add up/);
  });
  it("terrain is drawn only when the loaded asset is the active site's", () => {
    expect(terrainMatchesSite(null, "im2-athena")).toBe(false);
    expect(terrainMatchesSite({ siteId: "im2-athena" }, "connecting-ridge-cr1")).toBe(false);
    expect(terrainMatchesSite({ siteId: "connecting-ridge-cr1" }, "connecting-ridge-cr1")).toBe(true);
  });
  it("records the mesh check honestly (target not claimed when missed)", () => {
    for (const id of ["im2-athena", "connecting-ridge-cr1"]) {
      const mc = meta(id).mesh_check!;
      const inside = mc.setting_point_inside_mesh;
      expect(mc.target_deg).toBe(0.05);
      expect(mc.meets_target_inside_mesh).toBe((inside.abs_max_deg ?? Infinity) <= 0.05);
    }
  });
});
