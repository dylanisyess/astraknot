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

export interface SiteData {
  schema_version: string;
  site: SiteMeta;
  sources: Source[];
  samples: Sample[];
  horizon: Horizon;
  visibility_method: string;
  visibility_intervals: {
    start_utc: string;
    end_utc: string;
    sun_visible: boolean | null;
    earth_visible: boolean | null;
  }[];
}

export interface Dataset {
  manifest: Manifest;
  site: SiteData;
  /** Parsed sample times in epoch milliseconds, same order as samples. */
  times: number[];
}
