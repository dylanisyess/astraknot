// Rendering-asset loader for 3D Explore (pipeline/render_assets.py output).
// These meshes are for orientation only: no visibility state is ever derived from them.
// The loader refuses an asset that does not belong to the site it is asked for, so one
// site's terrain can never be drawn with another site's observer, profile or status.

import type { SiteData } from "../types";

export const ASSET_VERSION = "render-terrain-1";
const R_REF_M = 1737400;

export interface TerrainLevelMeta {
  index: number;
  spacing_m: number;
  spacing_px: number;
  half_width_m: number;
  nx: number;
  ny: number;
  vertex_count: number;
  triangle_count: number;
  byte_offset: number;
  byte_length: number;
  hole_cells: [number, number, number, number] | null;
  boundary_vertices_snapped: number;
  kind: string;
  height_range_m: [number, number];
}

export interface MeshCheckStats {
  n: number;
  signed_min_deg?: number;
  signed_max_deg?: number;
  signed_mean_deg?: number;
  abs_median_deg?: number;
  abs_p95_deg?: number;
  abs_max_deg?: number;
  n_abs_over_target?: number;
}

export interface TerrainAssetMeta {
  asset_version: string;
  is_rendering_asset: true;
  note: string;
  site: { id: string; name: string; latitude_deg: number; longitude_deg_east: number; horizons_site_altitude_km: number };
  observer: { observer_radius_m: number; dem_surface_at_site_m: number; eye_above_dem_surface_m: number; ground_below_eye_local_y_m: number };
  frame: { axes: string; direction_formula: string };
  source_dem: { product: string; url: string; sha256: string; map_scale_m: number };
  sampling: { outer_half_width_m: number; unmeshed: string; triangulation: string };
  levels: TerrainLevelMeta[];
  counts: { vertices: number; triangles: number; bin_bytes: number };
  local_bounds_m: { x: [number, number]; y: [number, number]; z: [number, number] };
  mesh_check: {
    target_deg: number;
    target_note: string;
    setting_point_inside_mesh: MeshCheckStats;
    setting_point_beyond_mesh: MeshCheckStats;
    meets_target_inside_mesh: boolean;
    fine_reference?: { method: string; mesh_minus_fine_reference: MeshCheckStats; fine_reference_minus_profile: MeshCheckStats };
  } | null;
  reproduce: string;
  bin_file: string;
  bin_sha256: string;
}

export interface TerrainAsset {
  siteId: string;
  meta: TerrainAssetMeta;
  levels: { meta: TerrainLevelMeta; positions: Float32Array }[];
}

export class AssetError extends Error {}

/** Why this asset must not be drawn for this site, or null when it matches. */
export function assetMismatch(meta: TerrainAssetMeta, site: SiteData): string | null {
  if (meta.asset_version !== ASSET_VERSION) return `unsupported asset version ${meta.asset_version}`;
  if (meta.is_rendering_asset !== true) return "file is not marked as a rendering asset";
  const s = site.site;
  if (meta.site.id !== s.id) return `asset belongs to ${meta.site.id}, not ${s.id}`;
  if (meta.site.latitude_deg !== s.latitude_deg || meta.site.longitude_deg_east !== s.longitude_deg_east) return "asset coordinates differ from the site";
  if (meta.site.horizons_site_altitude_km !== s.horizons_site_altitude_km) return "asset observer altitude differs from the site";
  const rObs = site.terrain_horizon?.observer?.observer_radius_m ?? R_REF_M + s.horizons_site_altitude_km * 1000;
  if (Math.abs(meta.observer.observer_radius_m - rObs) > 1e-6) return "asset observer radius differs from the site export";
  const eye = site.terrain_horizon?.observer?.eye_above_dem_surface_m;
  if (eye !== undefined && Math.abs(meta.observer.eye_above_dem_surface_m - eye) > 1e-6) return "asset eye height differs from the site export";
  let bytes = 0;
  for (const l of meta.levels) {
    if (l.byte_offset !== bytes || l.byte_length !== 12 * l.nx * l.ny || l.vertex_count !== l.nx * l.ny) return "asset level layout is inconsistent";
    bytes += l.byte_length;
  }
  if (bytes !== meta.counts.bin_bytes) return "asset level sizes do not add up";
  return null;
}

async function sha256Hex(buf: ArrayBuffer): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null; // not a secure context: size and identity checks still apply
  const d = new Uint8Array(await subtle.digest("SHA-256", buf));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function loadTerrainAsset(base: string, site: SiteData, signal?: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<TerrainAsset> {
  const id = site.site.id;
  const r = await fetchImpl(`${base}render/${id}.terrain.json`, { signal });
  if (!r.ok) throw new AssetError(`terrain metadata for ${id} could not be loaded (HTTP ${r.status})`);
  const meta = (await r.json()) as TerrainAssetMeta;
  const bad = assetMismatch(meta, site);
  if (bad) throw new AssetError(bad);
  const b = await fetchImpl(`${base}render/${meta.bin_file}`, { signal });
  if (!b.ok) throw new AssetError(`terrain geometry for ${id} could not be loaded (HTTP ${b.status})`);
  const buf = await b.arrayBuffer();
  if (buf.byteLength !== meta.counts.bin_bytes) throw new AssetError(`terrain geometry for ${id} has ${buf.byteLength} bytes, expected ${meta.counts.bin_bytes}`);
  const digest = await sha256Hex(buf);
  if (digest !== null && digest !== meta.bin_sha256) throw new AssetError(`terrain geometry for ${id} failed its checksum`);
  return {
    siteId: id,
    meta,
    levels: meta.levels.map((l) => ({ meta: l, positions: new Float32Array(buf, l.byte_offset, 3 * l.vertex_count) })),
  };
}

/** The scene may draw terrain only when the loaded asset is the active site's. */
export function terrainMatchesSite(asset: Pick<TerrainAsset, "siteId"> | null, activeSiteId: string): boolean {
  return asset !== null && asset.siteId === activeSiteId;
}
