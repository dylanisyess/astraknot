"""Export cached Horizons responses to the app data contract (v1.0).

Reads ONLY the cached raw responses (run fetch.py first); never contacts the
network and never fills gaps with synthetic values.

    python pipeline/export.py
"""
from __future__ import annotations

import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sites
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


def load_target(cfg: dict, site: dict, tgt: dict) -> tuple[list[hz.CachedResponse], list[hz.AzElRow]]:
    """All cached chunks for one target, merged (boundary samples verified identical)."""
    responses, chunks = [], []
    for _, params in hz.site_queries(cfg, site, tgt):
        r = hz.fetch(site["id"], tgt["key"], params, offline=True)
        responses.append(r)
        chunks.append(hz.parse_azel(r.payload["result"]))
    return responses, hz.merge_chunks(chunks)


def export_site(cfg: dict, site: dict) -> dict:
    by_key: dict[str, list[hz.AzElRow]] = {}
    sources = []
    for tgt in cfg["targets"]:
        responses, rows = load_target(cfg, site, tgt)
        by_key[tgt["key"]] = rows
        for n, r in enumerate(responses, 1):
            hdr = hz.header_fields(r.payload["result"])
            p = r.meta["request_params"]
            sources.append({
                "id": f"horizons-{tgt['key']}-{n}",
                "title": (f"JPL Horizons observer table: {tgt['name']}, "
                          f"{p['START_TIME'].strip(chr(39))} to {p['STOP_TIME'].strip(chr(39))} UTC"),
                "url": r.meta["request_url"],
                "retrieved_at_utc": r.meta["retrieved_at_utc"],
                "product_version_or_filename": (
                    f"data/horizons/{r.meta['response_file']} "
                    f"(API {r.payload['signature'].get('version')}, sha256 {r.meta['response_sha256'][:16]}...)"),
                "notes": "Airless apparent AZ/EL of target center (quantity 4), UT=UTC, CSV.",
                "horizons_query_params": p,
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
    terrain, terrain_sources, terrain_reason = terrain_block(cfg, site, samples)
    meta = {k: site[k] for k in (
        "id", "name", "latitude_deg", "longitude_deg_east", "coordinate_frame",
        "coordinate_source_url", "observer_height_above_surface_m", "surface_elevation_m",
        "surface_elevation_reference", "horizons_site_altitude_km",
        "horizons_altitude_reference", "altitude_conversion_note", "horizon_model")}
    meta["longitude_deg_east"] = vis.norm360(meta["longitude_deg_east"])
    meta["is_synthetic"] = False
    meta["available_horizon_models"] = ["smooth", "terrain"] if terrain else ["smooth"]
    if not terrain:
        print(f"terrain horizon NOT exported for {site['id']}: {terrain_reason}", file=sys.stderr)

    site_source = {
        "id": "site-coordinates",
        "title": site["coordinate_source_title"],
        "url": site["coordinate_source_url"],
        "retrieved_at_utc": site["coordinate_source_retrieved_at_utc"],
        "product_version_or_filename": site.get("coordinate_source_product", site["coordinate_source_url"]),
        "notes": "Point coordinates as published by the cited source. Date consulted; time of day not recorded.",
    }

    out = {
        "schema_version": SCHEMA_VERSION,
        "site": meta,
        "sources": [site_source, *sources, *terrain_sources, *DOC_SOURCES],
        "position_conventions": {
            "azimuth": "degrees clockwise from local north: N=0, E=90, S=180, W=270",
            "elevation": "degrees relative to the plane perpendicular to the reference-surface local zenith",
            "apparent": "airless apparent direction of target body center (light-time, gravitational deflection, stellar aberration)",
            "time_scale": "UTC (Horizons UT; after 1962 UT means UTC)",
            "observer_body": "Moon (301), MEAN_ME frame, east-longitude positive, reference sphere radius 1737.4 km",
            "observer_altitude": ("site altitude above the 1737.4 km sphere = LOLA surface elevation + observer "
                                  "height above surface (see site.altitude_conversion_note)"),
            "horizons_quantity": "4 (Azimuth_(a-app), Elevation_(a-app))",
        },
        "samples": samples,
        "horizon": horizon,
        "visibility_method": vis.METHOD,
        "visibility_intervals": vis.classify(samples, horizon),
    }
    if terrain:
        out["terrain_horizon"] = terrain
    return out


# ------------------------------------------------------------------ terrain horizon

LOLA_POLAR_DIR = "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/polar/img"


def _r(v, nd):
    return None if v is None else round(v, nd)


def terrain_block(cfg: dict, site: dict, samples: list[dict]) -> tuple[dict | None, list[dict], str]:
    """Terrain horizon + its own visibility intervals, or (None, [], reason).

    Built only from the selected site's terrain_horizon report (terrain_horizon.py)
    after the independent check (horizon_crosscheck.py) has been run; never from
    anything else. Values are rounded first and the intervals are classified
    from the rounded profile, so the app gets exactly what was classified."""
    if site.get("prepared_terrain"):
        import prepared_export
        return prepared_export.terrain_block(site, samples)
    terrain_report = sites.report_path(site["id"], "terrain_horizon")
    terrain_crosscheck = sites.report_path(site["id"], "horizon_crosscheck")
    if not terrain_report.exists():
        return None, [], f"{terrain_report.name} missing (run pipeline/terrain_horizon.py)"
    if not terrain_crosscheck.exists():
        return None, [], f"{terrain_crosscheck.name} missing (run pipeline/horizon_crosscheck.py)"
    rep, xc = sites.load_terrain_reports(site)
    rays = rep["rays"]
    m = rep["method"]
    step = m["azimuth_step_deg"]
    az = [r["azimuth_deg"] for r in rays]
    if az != [round(k * step, 6) for k in range(round(360 / step))]:
        return None, [], "terrain report azimuths are not the expected uniform grid"
    if any(r["status"] not in ("stopped", "exited") for r in rays):
        return None, [], "terrain report has rays that neither met the stopping rule nor left the data"
    if any((r["status"] == "exited") != (r["elevation_deg"] is None) for r in rays):
        return None, [], "terrain report: unknown elevations do not match exited rays"
    if (abs(rep["site"]["latitude_deg"] - site["latitude_deg"]) > 1e-12
            or abs(rep["site"]["longitude_deg_east"] - site["longitude_deg_east"]) > 1e-12
            or rep["site"]["horizons_site_altitude_km"] != site["horizons_site_altitude_km"]):
        return None, [], "terrain report was computed for a different site or altitude"

    summ = rep["summary"]
    sens = {v["name"]: v for v in rep.get("sensitivity", {}).get("variants", [])}
    ps = xc["pixel_sweep"]
    rs = m["radial_sampling"]
    sr = m["stopping_rule"]

    products, sources = [], []
    roles = (("near field", m["products_priority"][0], "heights"),
             ("near field", m["count_products"][0], "LOLA shot counts"),
             ("far field", m["products_priority"][1], "heights"),
             ("far field", m["count_products"][1], "LOLA shot counts"))
    for role, name, kind in roles:
        dmeta_path = hz.REPO_ROOT / "data" / "raw" / "lola" / name.lower() / "download.meta.json"
        dmeta = json.loads(dmeta_path.read_text("utf-8")) if dmeta_path.exists() else {}
        lbl_text = (hz.REPO_ROOT / "data" / "terrain" / "labels" / f"{name.lower()}.lbl").read_text("latin-1")
        scale = float(lbl_text.split("MAP_SCALE")[1].split("=")[1].split("<")[0])
        url = f"{LOLA_POLAR_DIR}/{name.lower()}.img"
        products.append({"name": name, "role": role, "content": kind, "map_scale_m_at_pole": scale,
                         "url": url, "sha256": dmeta.get("sha256"), "bytes": dmeta.get("bytes")})
        sources.append({
            "id": f"lola-{name.lower().replace('_', '-')}",
            "title": f"LOLA {name} ({kind}, {scale:g} m/pixel polar stereographic, {role})",
            "url": url,
            "retrieved_at_utc": dmeta.get("retrieved_at_utc", "not recorded in this checkout"),
            "product_version_or_filename": (f"{name.lower()}.img, PDS LRO-L-LOLA-4-GDR-V1.0 V2.0"
                                            + (f", sha256 {dmeta['sha256'][:16]}..." if dmeta.get("sha256") else "")),
            "notes": ("Heights = DN x 0.5 m above the 1737.4 km sphere; frame MEAN EARTH/POLAR AXIS OF DE421; "
                      "no missing-data value (gaps between ground tracks are interpolated)."
                      if kind == "heights" else
                      "Number of LOLA shots per pixel; 0 = the matching LDEM pixel is interpolated."),
        })

    def vmax(name):
        v = sens.get(name)
        return None if not v else _r(v["angular"].get("max_abs_deg"), 3)

    stop = summ["stop_distance_km_min_median_max"]
    elr = summ["elevation_deg_min_median_max"]
    setd = summ["setting_distance_km_min_median_max"]
    shift = max(vmax(f"site_shift_100m_{d}") or 0 for d in "NESW")
    dmin_max = max((vmax(f"d_min_{x}m") or 0) for x in (20, 50, 100, 300))
    pix = {p["name"]: p["map_scale_m_at_pole"] for p in products if p["content"] == "heights"}
    # polar stereographic true at the pole: ground pixel = map scale / k, k = 2 / (1 + sin|lat|)
    k_site = 2.0 / (1.0 + math.sin(math.radians(abs(site["latitude_deg"]))))
    near_pix = round(pix[m["products_priority"][0]] / k_site, 2)
    shift_rows = []
    for d, word in (("N", "north"), ("E", "east"), ("S", "south"), ("W", "west")):
        v = sens.get(f"site_shift_100m_{d}")
        if not v:
            continue
        deltas = v["visibility"]["demo_metric_deltas_pp_or_h"]
        shift_rows.append({
            "direction": word,
            "description": v["description"],
            "skyline_max_abs_change_deg": _r(v["angular"]["max_abs_deg"], 3),
            "skyline_max_change_at_azimuth_deg": v["angular"]["at_azimuth_deg"],
            "skyline_median_abs_change_deg": _r(v["angular"]["median_abs_deg"], 3),
            "demo_windows": list(deltas.keys()),
            "sun_pct_change_pp": [_r(x["sun_pct"], 2) for x in deltas.values()],
            "earth_pct_change_pp": [_r(x["earth_pct"], 2) for x in deltas.values()],
            "longest_dark_change_h": [_r(x["longest_dark_h"], 2) for x in deltas.values()],
            "sun_steps_changed_60d": v["visibility"]["sun_steps_changed"],
            "earth_steps_changed_60d": v["visibility"]["earth_steps_changed"],
        })
    earth_worst = min((min(r["earth_pct_change_pp"]) for r in shift_rows), default=0)
    sun_worst = max((x for r in shift_rows for x in r["sun_pct_change_pp"] if x is not None), key=abs, default=0)
    dark_worst = max((x for r in shift_rows for x in r["longest_dark_change_h"] if x is not None), key=abs, default=0)
    # Sun changes are summarised only where they are material (> 1 pp); Athena's are <= 0.05 pp.
    sun_txt = (f"; Sun-visible share up to {sun_worst:+.1f} percentage points and longest darkness up to "
               f"{dark_worst:+.1f} h" if abs(sun_worst) > 1 else "")
    ge2 = ps["diff_deg_maxabs_where_ray_setting_ge_2km"]
    same = ps["same_direction_ray_minus_pixel_deg_min_max"]
    sweep_txt = (f"agrees within {ge2:.3f} deg where the horizon is set >= 2 km away" if ge2 is not None else
                 f"has no comparison bin where the horizon is set >= 2 km away (the skyline is set within "
                 f"{setd[2] * 1000:.0f} m, where a 0.25 deg bin holds few pixel centres); its same-direction "
                 f"check (ray at the azimuth of the highest pixel minus that pixel) gives {same[0]:+.3f} to "
                 f"{same[1]:+.3f} deg")
    nfb = xc.get("near_field_bilinear")
    if nfb and nfb["diff_deg_maxabs_where_set_within_near_km"] is not None:
        sweep_txt += (f"; a separately written near-field check (bilinear surface within 1 km, spherical-trig "
                      f"positions, vector geometry) reproduces the {nfb['n_azimuths_set_within_near_km']} azimuths "
                      f"set there within {nfb['diff_deg_maxabs_where_set_within_near_km']:.1e} deg. That checks "
                      f"the implementation, not the DEM")
    eye = rep["site"]["eye_above_dem_surface_m"]
    pre = xc["lola_rdr_shots"].get("pct_shots_on_or_before_dem_cutoff_min_max")
    # Reports written before this field existed (Athena, milestone 3) were measured at 96.7-99.5 %
    # from the same cached RDR files; the rounded wording below is unchanged for them.
    lo_hi = None if pre is None else (math.floor(pre[0]), math.ceil(pre[1]))
    pre_txt = ("96-100 %" if lo_hi is None else f"{lo_hi[0]} %" if lo_hi[0] == lo_hi[1]
               else f"{lo_hi[0]}-{lo_hi[1]} %")
    notes = (
        f"Terrain horizon (Stage 2) from LOLA {m['products_priority'][0]} (pixel spacing 20 m at the pole, "
        f"{near_pix:.2f} m at the site) and {m['products_priority'][1]} (60 m pixels, used only where a ray leaves the "
        f"20 m product). Observer {site['observer_height_above_surface_m']} m (nominal) above the LOLA surface: "
        f"Horizons altitude {site['horizons_site_altitude_km']} km above the 1737.4 km sphere, formed from the "
        f"surface rounded to 0.1 m, so the eye is {rep['site']['eye_above_dem_surface_m']:.4f} m above the bilinear "
        f"DEM surface; the skyline uses that same point. Geometry: great-circle rays "
        f"every {step} deg in the Moon-fixed ME frame; apparent elevation atan2(r_t cos(theta) - r_o, r_t sin(theta)) "
        f"with exact sphere geometry, so lunar curvature is counted once; negative horizons are kept. Ray sampling "
        f"(distinct from the DEM pixel spacing): the DEM is bilinearly interpolated at points every "
        f"{rs['near_step_m']:g} m along the ray to {rs['near_limit_m'] / 1000:g} km, then every {rs['far_step_m']:g} m; "
        f"sampling finer than a pixel follows the interpolated surface and adds no terrain detail. Observer cell: the "
        f"observer's foot is the same bilinear surface that is sampled (eye {eye:.2f} m above it) and the first sample is "
        f"at {rs['d_min_m']:g} m; no skyline point was found closer than {setd[0] * 1000:.0f} m, and ignoring terrain "
        f"within 20-300 m changed the skyline by at most {dmin_max:.3f} deg. This is a statement about the DEM surface "
        f"only: ground relief smaller than the DEM resolves, rocks and the lander are not represented. Search "
        f"extent: each ray stops only when terrain at {sr['h_max_m']:.0f} m ({sr['basis']}) could no longer rise "
        f"above the running maximum; stop distances {stop[0]:.0f}-{stop[2]:.0f} km. A ray that leaves both products "
        f"first gives null (unknown), never flat: {summ['n_unknown']} of {summ['n_azimuths']} azimuths are unknown. "
        f"Horizon {elr[0]:.2f} to {elr[2]:.2f} deg, set by terrain {setd[0]:.2f}-{setd[2]:.1f} km away. Numerical "
        f"sensitivity (max |change|): 0.02 deg azimuth step {vmax('azimuth_step_0.02')} deg; 2.5/5 m ray sampling "
        f"{vmax('radial_2.5m_5m')} deg; 60 m product everywhere {vmax('far_product_only')} deg. Site-position "
        f"sensitivity scenarios (observer moved 100 m due north, east, south and west of the published point; "
        f"scenarios, not a measured coordinate uncertainty or confidence interval): skyline change up to {shift} deg "
        f"in one direction; demo-window Earth-visible share up to {earth_worst:+.1f} percentage points{sun_txt} relative to "
        f"the nominal point. An independently implemented pixel-sweep check on the same DEM {sweep_txt}. "
        + (f"Every azimuth's skyline is set by DEM relief within {setd[2] * 1000:.0f} m of the point (a few "
           f"{near_pix:.0f} m pixels), so this horizon is NOT robust: it depends strongly on the DEM resolution, "
           f"on interpolated pixels and on the exact position (see the scenarios above). "
           if setd[2] < 2.0 else "") +
        f"Comparisons with LOLA laser shots are consistency checks against the DEM's own source data, not "
        f"independent terrain validation. Shot counts (LDEC) are quality indicators, not accuracy guarantees. "
        f"Regional DEM-based visibility for the published coordinate, not actual lander operating conditions. "
        f"Details: {terrain_report.relative_to(hz.REPO_ROOT).as_posix()} and {terrain_crosscheck.relative_to(hz.REPO_ROOT).as_posix()}."
    )
    horizon = {
        "model": "terrain",
        "azimuth_deg": az,
        "elevation_deg": [_r(r["elevation_deg"], 5) for r in rays],
        "observer_height_above_surface_m": site["observer_height_above_surface_m"],
        "interpolation": "linear_periodic",
        "processing_notes": notes,
        "search_extent": {
            "stopping_rule": sr["rule"], "h_max_m": sr["h_max_m"], "h_max_basis": sr["basis"],
            "stop_distance_km_min_median_max": [_r(x, 2) for x in stop],
            "unknown_azimuths": summ["n_unknown"],
        },
        "resolution": {
            "azimuth_step_deg": step, "radial_step_m": [rs["near_step_m"], rs["far_step_m"]],
            "radial_step_change_km": rs["near_limit_m"] / 1000, "first_sample_m": rs["d_min_m"],
            "dem_pixel_m": pix,
            "near_dem_pixel_m_at_site": near_pix,
            "note": ("radial_step_m is the ray sampling distance; dem_pixel_m is the terrain pixel spacing. "
                     "Heights between pixel centres are bilinear interpolation, so the terrain detail is set by "
                     "the pixel spacing (and by LOLA ground-track density), not by the ray sampling."),
        },
    }
    prod_names = [p["name"] for p in products if p["content"] == "heights"]
    setting = {
        "note": ("Terrain sample that sets each azimuth's horizon. shot_count = LOLA shots in the nearest DEM "
                 "pixel (LDEC); 0 means that height is interpolated between ground tracks. Shot counts are "
                 "quality indicators, not accuracy guarantees."),
        "products": prod_names,
        "distance_km": [None if r.get("distance_m") is None else round(r["distance_m"] / 1000, 3) for r in rays],
        "height_m": [_r(r.get("height_m"), 1) for r in rays],
        "lat_deg": [_r(r.get("lat_deg"), 5) for r in rays],
        "lon_deg_east": [_r(r.get("lon_deg"), 5) for r in rays],
        "product_index": [prod_names.index(r["product"]) if r.get("product") else None for r in rays],
        "shot_count": [r.get("shot_count_nearest") for r in rays],
    }
    block = {
        "horizon": horizon,
        "setting_points": setting,
        "products": products,
        "observer": {k: rep["site"][k] for k in ("observer_radius_m", "dem_surface_at_site_m", "eye_above_dem_surface_m")},
        "checks": {
            "pixel_sweep_max_abs_diff_deg_setting_ge_2km": _r(ps["diff_deg_maxabs_where_ray_setting_ge_2km"], 4),
            "pixel_sweep_same_direction_min_deg": _r(ps["same_direction_ray_minus_pixel_deg_min_max"][0], 4),
            "lola_shots_note": ("Consistency check: the LDEM was gridded from LOLA RDR shots through 2017-02-02, "
                                f"and {pre_txt} of these shots predate that cutoff, so this is not independent "
                                "terrain validation."),
            "lola_shots": [{"azimuth_deg": r["azimuth_deg"], "shots_in_window": r["shots_within_az_window"],
                            "shot_minus_dem_deg": _r(r["shot_minus_dem_deg"], 4)}
                           for r in xc["lola_rdr_shots"]["rows"]],
            "azimuth_convention_diff_deg": _r(xc["azimuth_convention"]["diff_az_deg"], 2),
            "azimuth_convention_note": ("Sanity check only: one direction (ME +X) vs the 60-day mean Horizons Earth "
                                        "azimuth, which libration moves by several degrees. It rules out gross "
                                        "errors (mirrored or rotated azimuths, tens of degrees), not sub-degree "
                                        "offsets."),
            "near_field": {"min_setting_distance_m": round(setd[0] * 1000), "first_sample_m": rs["d_min_m"],
                           "max_change_ignoring_terrain_within_20_to_300m_deg": dmin_max},
            "sensitivity_max_abs_deg": {k: vmax(k) for k in sens},
            "site_shift_scenarios": {
                "note": ("Sensitivity scenarios, not a measured coordinate uncertainty or confidence interval: the "
                         "observer moved 100 m due north, east, south and west of the published point (eye kept "
                         f"{eye:.2f} m above the DEM at the new point). Changes are relative to the nominal point, for "
                         "the fixed demo windows (14 days from 2026-12-05 + 0/1/3/7 d), terrain mode."),
                "rows": shift_rows,
            },
        },
        "visibility_method": vis.METHOD,
    }
    block["visibility_intervals"] = vis.classify(samples, horizon)
    return block, sources, ""


def _compact(obj, ind=1, lvl=0) -> str:
    """JSON with indentation, but every list of scalars on a single line."""
    pad, pad1 = " " * (ind * lvl), " " * (ind * (lvl + 1))
    if isinstance(obj, dict):
        if not obj:
            return "{}"
        items = [f"{pad1}{json.dumps(k)}: {_compact(v, ind, lvl + 1)}" for k, v in obj.items()]
        return "{\n" + ",\n".join(items) + "\n" + pad + "}"
    if isinstance(obj, list):
        if all(not isinstance(x, (dict, list)) for x in obj):
            return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
        return "[\n" + ",\n".join(pad1 + _compact(x, ind, lvl + 1) for x in obj) + "\n" + pad + "]"
    return json.dumps(obj, ensure_ascii=False)


def dump_site(data: dict) -> str:
    """JSON with one sample / interval per line: compact but still diffable.
    The terrain block keeps each per-azimuth array on one line."""
    data = dict(data)
    terrain = data.pop("terrain_horizon", None)
    head = json.dumps({k: v for k, v in data.items() if k not in ("samples", "visibility_intervals")},
                      indent=1, ensure_ascii=False)

    def rows(items, pad: str) -> str:
        return ",\n".join(pad + json.dumps(x, separators=(",", ":")) for x in items)

    out = (head[:-2] + ',\n "samples": [\n' + rows(data["samples"], "  ") + '\n ],\n "visibility_intervals": [\n'
           + rows(data["visibility_intervals"], "  ") + "\n ]")
    if terrain is not None:
        terrain = dict(terrain)
        t_iv = terrain.pop("visibility_intervals")
        t = _compact(terrain, 1, 1)  # "{\n  ...\n }"
        out += (',\n "terrain_horizon": ' + t[:-2] + ',\n  "visibility_intervals": [\n'
                + rows(t_iv, "   ") + "\n  ]\n }")
    return out + "\n}\n"


def main() -> int:
    ap = sites.parser(description=__doc__)
    sites.add_config_arg(ap, CONFIG)
    args = ap.parse_args()
    cfg = sites.load_config(args.config)
    selected = sites.cli_sites(ap, args, cfg, batch=True)
    OUT_DIR = sites.dataset_dir(cfg)
    rel = OUT_DIR.relative_to(sites.REPO_ROOT).as_posix()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    manifest_sites = []
    prepared = [(site, export_site(cfg, site)) for site in selected]
    manifest_path = OUT_DIR / "manifest.json"
    selected_ids = {s["id"] for s in selected}
    retained = []
    if args.site and manifest_path.exists():
        previous = json.loads(manifest_path.read_text("utf-8"))
        for entry in previous["sites"]:
            if entry["id"] not in selected_ids:
                other = sites.select_sites(cfg, entry["id"])[0]
                sites.load_site_data(cfg, other, OUT_DIR, previous)
                retained.append(entry)
    for site, data in prepared:
        sites.require_identity(data["site"], site, "prepared export")
        fname = f"{site['id']}.json"
        (OUT_DIR / fname).write_text(dump_site(data), "utf-8")
        manifest_sites.append({"id": site["id"], "name": site["name"], "file": fname})
        json.loads((OUT_DIR / fname).read_text("utf-8"))  # the hand-formatted file must parse
        print(f"wrote {rel}/{fname}: {len(data['samples'])} samples, "
              f"{len(data['visibility_intervals'])} smooth-horizon interval(s)"
              + (f", {len(data['terrain_horizon']['visibility_intervals'])} terrain-horizon interval(s)"
                 if "terrain_horizon" in data else ", no terrain horizon"))

    manifest = {
        "schema_version": SCHEMA_VERSION,
        "dataset_id": cfg["dataset_id"],
        "generated_at_utc": utc_now(),
        "coverage_start_utc": cfg["coverage_start_utc"],
        "coverage_end_utc": cfg["coverage_end_utc"],
        "sample_step_seconds": cfg["sample_step_seconds"],
        "sites": sorted(manifest_sites + retained, key=lambda e: [s["id"] for s in cfg["sites"]].index(e["id"])),
        "is_synthetic": False,
    }
    (OUT_DIR / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", "utf-8")
    print(f"wrote {rel}/manifest.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(sites.run(main))
