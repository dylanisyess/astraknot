// Wide context terrain for 3D Explore (pipeline/context_terrain.py output).
// Coarse rings around the detailed mesh so nearby craters and massifs are visible. Display
// only: nothing here enters a status, metric or skyline, and the Horizon view clips every
// mesh to the exported profile. Like the detailed mesh, an asset is refused unless it
// belongs to the active site and to the exact detailed mesh it surrounds.

import type { SiteData } from "../types";
import type { TerrainAssetMeta } from "./terrainAsset";

export const CONTEXT_VERSION = "render-context-1";
export const R_REF_M = 1737400;

export interface ContextLevelMeta {
  index: number;
  spacing_m: number;
  half_width_m: number;
  nx: number;
  ny: number;
  hole_cells: [number, number, number, number] | null;
  nodata_vertices: number;
  sources_used: string[];
  rim_vertices_snapped: number;
  byte_offset: number;
  byte_length: number;
  vertex_count: number;
  height_range_m: [number, number] | null;
}

export interface ContextMeta {
  asset_version: string;
  is_rendering_asset: true;
  note: string;
  site: { id: string; name: string; latitude_deg: number; longitude_deg_east: number; horizons_site_altitude_km: number };
  observer: { observer_radius_m: number; eye_above_dem_surface_m: number };
  reference_radius_m: number;
  sources_used: string[];
  detailed_mesh: { file: string; bin_sha256: string; outer_half_width_m: number; relation: string };
  levels: ContextLevelMeta[];
  counts: { vertices: number; bin_bytes: number };
  outer_half_width_m: number;
  check_points: { level: number; i: number; j: number; local_m: [number, number, number] }[];
  reproduce: string;
  bin_file: string;
  bin_sha256: string;
}

export interface ContextAsset {
  siteId: string;
  meta: ContextMeta;
  levels: { meta: ContextLevelMeta; heights: Float32Array }[];
}

export type ContextState =
  | { state: "loading" }
  | { state: "ready"; meta: ContextMeta }
  | { state: "error"; message: string };

/** Why this context asset must not be drawn around this site's detailed mesh, or null. */
export function contextMismatch(meta: ContextMeta, site: SiteData, near: TerrainAssetMeta): string | null {
  if (meta.asset_version !== CONTEXT_VERSION) return `unsupported context asset version ${meta.asset_version}`;
  if (meta.is_rendering_asset !== true) return "file is not marked as a rendering asset";
  const s = site.site;
  if (meta.site.id !== s.id) return `context terrain belongs to ${meta.site.id}, not ${s.id}`;
  if (meta.site.latitude_deg !== s.latitude_deg || meta.site.longitude_deg_east !== s.longitude_deg_east) return "context terrain coordinates differ from the site";
  if (meta.site.horizons_site_altitude_km !== s.horizons_site_altitude_km) return "context terrain observer altitude differs from the site";
  if (Math.abs(meta.observer.observer_radius_m - near.observer.observer_radius_m) > 1e-6) return "context terrain observer radius differs from the detailed mesh";
  if (meta.reference_radius_m !== R_REF_M) return "context terrain uses a different reference sphere";
  if (meta.detailed_mesh.bin_sha256 !== near.bin_sha256) return "context terrain was built around a different detailed mesh";
  let bytes = 0;
  for (const l of meta.levels) {
    if (l.nx !== l.ny || l.nx % 2 !== 1 || l.byte_offset !== bytes || l.byte_length !== 4 * l.nx * l.ny || l.vertex_count !== l.nx * l.ny) return "context level layout is inconsistent";
    bytes += l.byte_length;
  }
  if (bytes !== meta.counts.bin_bytes) return "context level sizes do not add up";
  return null;
}

/**
 * Observer-frame positions (x east, y up, z -north; origin at the eye) of one level, from
 * its heights on the local gnomonic grid. Exact sphere geometry, curvature once:
 * q = sqrt(1 + (x² + z²)/R²), p = ((R+h) x/(R q), (R+h)/q − r_obs, (R+h) z/(R q)).
 * NaN heights stay NaN (no substitute surface).
 */
export function contextPositions(l: Pick<ContextLevelMeta, "nx" | "spacing_m">, heights: Float32Array, rObs: number, R = R_REF_M): Float32Array {
  const n = l.nx;
  const c = (n - 1) / 2;
  const out = new Float32Array(3 * n * n);
  for (let j = 0; j < n; j++) {
    const z = (j - c) * l.spacing_m;
    for (let i = 0; i < n; i++) {
      const x = (i - c) * l.spacing_m;
      const k = j * n + i;
      const r = R + heights[k];
      const q = Math.sqrt(1 + (x * x + z * z) / (R * R));
      out[3 * k] = (r * x) / (R * q);
      out[3 * k + 1] = r / q - rObs;
      out[3 * k + 2] = (r * z) / (R * q);
    }
  }
  return out;
}

/** The detailed mesh's footprint in the local x/z plane: its outer level's four corners. */
export function nearFootprint(outer: { nx: number; ny: number }, positions: Float32Array): [number, number][] {
  const at = (i: number, j: number): [number, number] => {
    const k = 3 * (j * outer.nx + i);
    return [positions[k], positions[k + 2]];
  };
  return [at(0, 0), at(outer.nx - 1, 0), at(outer.nx - 1, outer.ny - 1), at(0, outer.ny - 1)];
}

/** Signed distance (m) inside a convex quad (positive inside), in x/z. */
export function insideDistance(quad: [number, number][], x: number, z: number): number {
  // orientation-independent: use the sign of the quad's area
  let area = 0;
  for (let k = 0; k < 4; k++) {
    const [ax, az] = quad[k];
    const [bx, bz] = quad[(k + 1) % 4];
    area += ax * bz - bx * az;
  }
  const s = area > 0 ? 1 : -1;
  let d = Infinity;
  for (let k = 0; k < 4; k++) {
    const [ax, az] = quad[k];
    const [bx, bz] = quad[(k + 1) % 4];
    const ex = bx - ax;
    const ez = bz - az;
    const len = Math.hypot(ex, ez);
    d = Math.min(d, (s * (ex * (z - az) - ez * (x - ax))) / len);
  }
  return d;
}

/**
 * Display-only tuck: context vertices inside (or on the edge of) the detailed mesh's
 * footprint are lowered slightly, so where the two overlap the detailed mesh is always the
 * visible surface and no gap opens at their joint. Never more than 0.05 % of the distance
 * plus 1 m (about 2 m at 2 km); those cells lie under the detailed mesh.
 */
export const tuckM = (distanceM: number) => 1 + 0.0005 * distanceM;

/**
 * Triangle indices for one level: skips its hole (the next finer level), cells with a NaN
 * vertex (no local DEM), and cells lying entirely inside the detailed mesh's footprint
 * (shrunk by one cell, so the two overlap by about one cell instead of leaving a gap).
 * Lowers the context vertices inside the footprint by `tuckM` (positions are modified in place).
 */
export function contextIndices(
  l: Pick<ContextLevelMeta, "nx" | "spacing_m" | "hole_cells">,
  positions: Float32Array,
  footprint: [number, number][] | null,
  flip = false,
): Uint32Array {
  const n = l.nx;
  const inside = new Uint8Array(n * n); // 1: inside the footprint, 2: deep inside (cull)
  if (footprint) {
    for (let k = 0; k < n * n; k++) {
      const x = positions[3 * k];
      const z = positions[3 * k + 2];
      const d = insideDistance(footprint, x, z);
      if (d >= -0.01 * l.spacing_m) {
        inside[k] = d > l.spacing_m ? 2 : 1;
        if (Number.isFinite(positions[3 * k + 1])) positions[3 * k + 1] -= tuckM(Math.hypot(x, z));
      }
    }
  }
  const h = l.hole_cells;
  const out: number[] = [];
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      if (h && i >= h[0] && i < h[1] && j >= h[2] && j < h[3]) continue;
      const v00 = j * n + i;
      const v10 = v00 + 1;
      const v01 = v00 + n;
      const v11 = v01 + 1;
      if (inside[v00] === 2 && inside[v10] === 2 && inside[v01] === 2 && inside[v11] === 2) continue;
      if (!(Number.isFinite(positions[3 * v00 + 1]) && Number.isFinite(positions[3 * v10 + 1]) && Number.isFinite(positions[3 * v01 + 1]) && Number.isFinite(positions[3 * v11 + 1]))) continue;
      if (flip) out.push(v00, v10, v01, v10, v11, v01);
      else out.push(v00, v01, v10, v10, v01, v11);
    }
  }
  return new Uint32Array(out);
}

async function sha256Hex(buf: ArrayBuffer): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null; // not a secure context: size and identity checks still apply
  const d = new Uint8Array(await subtle.digest("SHA-256", buf));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function loadContextAsset(base: string, site: SiteData, near: TerrainAssetMeta, signal?: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<ContextAsset> {
  const id = site.site.id;
  const r = await fetchImpl(`${base}render/${id}.context.json`, { signal });
  if (!r.ok) throw new Error(`context terrain for ${id} could not be loaded (HTTP ${r.status})`);
  const meta = (await r.json()) as ContextMeta;
  const bad = contextMismatch(meta, site, near);
  if (bad) throw new Error(bad);
  const b = await fetchImpl(`${base}render/${meta.bin_file}`, { signal });
  if (!b.ok) throw new Error(`context terrain heights for ${id} could not be loaded (HTTP ${b.status})`);
  const buf = await b.arrayBuffer();
  if (buf.byteLength !== meta.counts.bin_bytes) throw new Error(`context terrain for ${id} has ${buf.byteLength} bytes, expected ${meta.counts.bin_bytes}`);
  const digest = await sha256Hex(buf);
  if (digest !== null && digest !== meta.bin_sha256) throw new Error(`context terrain for ${id} failed its checksum`);
  return { siteId: id, meta, levels: meta.levels.map((l) => ({ meta: l, heights: new Float32Array(buf, l.byte_offset, l.vertex_count) })) };
}
