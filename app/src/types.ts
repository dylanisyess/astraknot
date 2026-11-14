// Types mirroring docs/DATA_CONTRACT.md (schema 1.0).

export interface Manifest {
  schema_version: string;
  dataset_id: string;
  generated_at_utc: string;
  coverage_start_utc: string;
  coverage_end_utc: string;
  sample_step_seconds: number;
  sites: { id: string; name: string; file: string }[];
  is_synthetic: boolean;
}

export interface SiteMeta {
  id: string;
  name: string;
  latitude_deg: number;
  longitude_deg_east: number;
  coordinate_frame: string;
  coordinate_source_url: string;
  observer_height_above_surface_m: number;
  surface_elevation_m: number | null;
  surface_elevation_reference: string | null;
  horizons_site_altitude_km: number;
  horizons_altitude_reference: string;
  altitude_conversion_note?: string;
  horizon_model: "smooth" | "terrain";
  /** Added in milestone 3; absent in older files (= ["smooth"]). */
  available_horizon_models?: ("smooth" | "terrain")[];
  is_synthetic: boolean;
}

export interface Source {
  id: string;
  title: string;
  url: string;
  retrieved_at_utc: string;
  product_version_or_filename: string;
  notes: string;
}

export interface Sample {
  time_utc: string;
  sun_azimuth_deg: number | null;
  sun_elevation_deg: number | null;
  earth_azimuth_deg: number | null;
  earth_elevation_deg: number | null;
}

export interface Horizon {
  model: "smooth" | "terrain";
  azimuth_deg: number[];
  elevation_deg: (number | null)[];
  observer_height_above_surface_m: number;
  interpolation: "linear_periodic";
  processing_notes: string;
}

export interface VisibilityInterval {
  start_utc: string;
  end_utc: string;
  sun_visible: boolean | null;
  earth_visible: boolean | null;
}

export interface TerrainHorizonBlock {
  horizon: Horizon & {
    search_extent: {
      stopping_rule: string;
      h_max_m: number;
      h_max_basis: string;
      stop_distance_km_min_median_max: [number, number, number];
      unknown_azimuths: number;
    };
    resolution: {
      azimuth_step_deg: number;
      radial_step_m: [number, number];
      radial_step_change_km: number;
      first_sample_m: number;
      dem_pixel_m: Record<string, number>;
    };
  };
  /** Per-azimuth columns, parallel to horizon.azimuth_deg; null where the horizon is unknown. */
  setting_points: {
    note: string;
    products: string[];
    distance_km: (number | null)[];
    height_m: (number | null)[];
    lat_deg: (number | null)[];
    lon_deg_east: (number | null)[];
    product_index: (number | null)[];
    shot_count: (number | null)[];
  };
  products: { name: string; role: string; content: string; map_scale_m_at_pole: number; url: string; sha256: string | null }[];
  observer?: { observer_radius_m: number; dem_surface_at_site_m: number; eye_above_dem_surface_m: number };
  checks: {
    near_field?: { min_setting_distance_m: number; first_sample_m: number; max_change_ignoring_terrain_within_20_to_300m_deg: number };
    /** Sensitivity scenarios (observer moved 100 m), not a measured uncertainty. Deltas vs the nominal point. */
    site_shift_scenarios?: {
      note: string;
      rows: {
        direction: string;
        description: string;
        skyline_max_abs_change_deg: number;
        skyline_max_change_at_azimuth_deg: number;
        skyline_median_abs_change_deg: number;
        demo_windows: string[];
        sun_pct_change_pp: (number | null)[];
        earth_pct_change_pp: number[];
        longest_dark_change_h: (number | null)[];
      }[];
    };
    [k: string]: unknown;
  };
  visibility_method: string;
  visibility_intervals: VisibilityInterval[];
}

export interface SiteData {
  schema_version: string;
  site: SiteMeta;
  sources: Source[];
  samples: Sample[];
  horizon: Horizon;
  visibility_method: string;
  visibility_intervals: VisibilityInterval[];
  /** Milestone 3, additive: terrain horizon and its own intervals. */
  terrain_horizon?: TerrainHorizonBlock;
}

export type HorizonMode = "smooth" | "terrain";

export interface Dataset {
  manifest: Manifest;
  site: SiteData;
  /** Parsed sample times in epoch milliseconds, same order as samples. */
  times: number[];
  /** Why the terrain horizon cannot be offered (missing or failed a loader check), or null. */
  terrainProblem: string | null;
}
