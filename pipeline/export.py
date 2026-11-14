"""Export cached Horizons responses to the app data contract (v1.0).

Reads ONLY the cached raw responses (run fetch.py first); never contacts the
network and never fills gaps with synthetic values.

    python pipeline/export.py
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import horizons as hz  # noqa: E402
import visibility as vis  # noqa: E402

PIPELINE = Path(__file__).resolve().parent
CONFIG = PIPELINE / "config.json"
OUT_DIR = hz.REPO_ROOT / "app" / "public" / "data"
SCHEMA_VERSION = "1.0"

DOC_SOURCES = [
    {
        "id": "horizons-api-doc",
        "title": "JPL Horizons API documentation",
        "url": "https://ssd-api.jpl.nasa.gov/doc/horizons.html",
        "retrieved_at_utc": "2026-11-14",
        "product_version_or_filename": "doc page v1.3 (2025 June)",
        "notes": "Query parameters. Date consulted; time of day not recorded.",
    },
    {
        "id": "horizons-manual",
        "title": "JPL Horizons System Manual",
        "url": "https://ssd.jpl.nasa.gov/horizons/manual.html",
        "retrieved_at_utc": "2026-11-14",
        "product_version_or_filename": "online manual",
        "notes": ("Site coordinates on the Moon use the mean-Earth (DE421) frame with "
                  "east-positive longitude; altitude is relative to the reference "
                  "ellipsoid; after 1962 UT means UTC; no refraction for non-Earth sites. "
                  "Date consulted; time of day not recorded."),
    },
]


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_target(cfg: dict, site: dict, tgt: dict) -> tuple[hz.CachedResponse, list[hz.AzElRow]]:
    params = hz.build_params(site, tgt["command"], cfg["coverage_start_utc"],
                             cfg["coverage_end_utc"], cfg["sample_step_seconds"])
    r = hz.fetch(site["id"], tgt["key"], params, offline=True)
    return r, hz.parse_azel(r.payload["result"])


def export_site(cfg: dict, site: dict) -> dict:
    by_key: dict[str, list[hz.AzElRow]] = {}
    sources = []
    conventions = {}
    for tgt in cfg["targets"]:
        r, rows = load_target(cfg, site, tgt)
        by_key[tgt["key"]] = rows
        hdr = hz.header_fields(r.payload["result"])
        conventions[tgt["key"]] = hdr
        sources.append({
            "id": f"horizons-{tgt['key']}",
            "title": f"JPL Horizons observer table: {tgt['name']} seen from {site['name']}",
            "url": r.meta["request_url"],
            "retrieved_at_utc": r.meta["retrieved_at_utc"],
            "product_version_or_filename": (
                f"data/horizons/{r.meta['response_file']} "
                f"(API {r.payload['signature'].get('version')}, sha256 {r.meta['response_sha256'][:16]}...)"),
            "notes": "Airless apparent AZ/EL of target center (quantity 4), UT=UTC, CSV.",
            "horizons_query_params": r.meta["request_params"],
            "http_status": r.meta["http_status"],
            "http_response_headers": r.meta["response_headers"],
            "api_signature": r.meta["api_signature"],
            "ephemeris_header": hdr,
        })

    sun, earth = by_key["sun"], by_key["earth"]
    if [s.time_utc for s in sun] != [e.time_utc for e in earth]:
        raise SystemExit("Sun and Earth timestamps differ; refusing to merge.")

    samples = [{
        "time_utc": s.time_utc,
        "sun_azimuth_deg": None if s.azimuth_deg is None else vis.norm360(s.azimuth_deg),
        "sun_elevation_deg": s.elevation_deg,
        "earth_azimuth_deg": None if e.azimuth_deg is None else vis.norm360(e.azimuth_deg),
        "earth_elevation_deg": e.elevation_deg,
    } for s, e in zip(sun, earth)]

    if samples[0]["time_utc"] != cfg["coverage_start_utc"] or \
            samples[-1]["time_utc"] != cfg["coverage_end_utc"]:
        raise SystemExit("Samples do not span coverage_start_utc..coverage_end_utc inclusive.")

    horizon = vis.smooth_horizon(site["observer_height_above_surface_m"])
    meta = {k: site[k] for k in (
        "id", "name", "latitude_deg", "longitude_deg_east", "coordinate_frame",
        "coordinate_source_url", "observer_height_above_surface_m", "surface_elevation_m",
        "surface_elevation_reference", "horizons_site_altitude_km",
        "horizons_altitude_reference", "altitude_conversion_note", "horizon_model")}
    meta["longitude_deg_east"] = vis.norm360(meta["longitude_deg_east"])
    meta["is_synthetic"] = False

    site_source = {
        "id": "site-coordinates",
        "title": site["coordinate_source_title"],
        "url": site["coordinate_source_url"],
        "retrieved_at_utc": "2026-11-14",
        "product_version_or_filename": "LROC featured image 1408",
        "notes": "Point coordinates as published by the LROC team. Date consulted; time of day not recorded.",
    }

    return {
        "schema_version": SCHEMA_VERSION,
        "site": meta,
        "sources": [site_source, *sources, *DOC_SOURCES],
        "position_conventions": {
            "azimuth": "degrees clockwise from local north: N=0, E=90, S=180, W=270",
            "elevation": "degrees relative to the plane perpendicular to the reference-surface local zenith",
            "apparent": "airless apparent direction of target body center (light-time, gravitational deflection, stellar aberration)",
            "time_scale": "UTC (Horizons UT; after 1962 UT means UTC)",
            "observer_body": "Moon (301), MEAN_ME frame, east-longitude positive, reference sphere radius 1737.4 km",
            "horizons_quantity": "4 (Azimuth_(a-app), Elevation_(a-app))",
        },
        "samples": samples,
        "horizon": horizon,
        "visibility_method": vis.METHOD,
        "visibility_intervals": vis.classify(samples, horizon),
    }


def main() -> int:
    cfg = json.loads(CONFIG.read_text("utf-8"))
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    manifest_sites = []
    for site in cfg["sites"]:
        try:
            data = export_site(cfg, site)
        except hz.HorizonsError as e:
            print(f"Cannot export {site['id']}: {e}", file=sys.stderr)
            return 1
        fname = f"{site['id']}.json"
        (OUT_DIR / fname).write_text(json.dumps(data, indent=1) + "\n", "utf-8")
        manifest_sites.append({"id": site["id"], "name": site["name"], "file": fname})
        print(f"wrote app/public/data/{fname}: {len(data['samples'])} samples, "
              f"{len(data['visibility_intervals'])} visibility interval(s)")

    manifest = {
        "schema_version": SCHEMA_VERSION,
        "dataset_id": cfg["dataset_id"],
        "generated_at_utc": utc_now(),
        "coverage_start_utc": cfg["coverage_start_utc"],
        "coverage_end_utc": cfg["coverage_end_utc"],
        "sample_step_seconds": cfg["sample_step_seconds"],
        "sites": manifest_sites,
        "is_synthetic": False,
    }
    (OUT_DIR / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", "utf-8")
    print("wrote app/public/data/manifest.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
