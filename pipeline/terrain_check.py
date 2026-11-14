"""Verify LOLA DEM products against the site and choose terrain coverage.

Checks (all requests sequential; big files go to git-ignored data/raw/lola/):
  1. Labels vs actual files: dimensions x bytes/sample == HTTP Content-Length.
  2. Actual geographic extent of each square polar grid; site pixel; whether
     the site is inside; distance from the site to the file edge per azimuth.
  3. East/west orientation of the polar projection, verified against the
     global simple-cylindrical LDEM_64 (unambiguous lat/lon grid).
  4. Terrain and LOLA shot counts (LDEC) around the site at 20 m.
  5. Required horizon search distance per azimuth, from a ray march on
     LDEM_75S_240M with a rigorous stopping rule: stop only when terrain at
     the global lunar maximum height could no longer rise above the running
     horizon. Rays that leave the file first are UNKNOWN, never flat.

    python pipeline/terrain_check.py
Writes data/terrain/lola_coverage_report.json.
"""
from __future__ import annotations

import json
import math
import statistics
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lola  # noqa: E402

CONFIG = Path(__file__).resolve().parent / "config.json"
REPORT = lola.REPO_ROOT / "data" / "terrain" / "lola_coverage_report.json"

CANDIDATES = ["LDEM_875S_5M", "LDEM_875S_10M", "LDEM_875S_20M", "LDEM_85S_10M", "LDEM_85S_20M",
              "LDEM_85S_40M", "LDEM_80S_20M", "LDEM_80S_40M", "LDEM_80S_80M", "LDEM_75S_30M",
              "LDEM_75S_60M", "LDEM_75S_120M", "LDEM_75S_240M"]
COUNT_PRODUCTS = ["LDEC_80S_20M", "LDEC_75S_240M"]
AZ_STEP_DEG = 1.0
R = lola.R_REF_M


def destination(lat: float, lon: float, az_deg: float, dist_m: float) -> tuple[float, float]:
    """Great-circle destination on the reference sphere (az clockwise from north)."""
    p1, l1, a, d = math.radians(lat), math.radians(lon), math.radians(az_deg), dist_m / R
    p2 = math.asin(math.sin(p1) * math.cos(d) + math.cos(p1) * math.sin(d) * math.cos(a))
    l2 = l1 + math.atan2(math.sin(a) * math.sin(d) * math.cos(p1), math.cos(d) - math.sin(p1) * math.sin(p2))
    return math.degrees(p2), math.degrees(l2) % 360.0


def inside(lbl: lola.Label, fi: float, fj: float) -> bool:
    return 0.5 <= fi <= lbl.samples + 0.5 and 0.5 <= fj <= lbl.lines + 0.5


def edge_distance_km(lbl, lat, lon, az, step_m=500.0, max_m=2.0e6) -> float:
    """Distance from the site to the edge of a polar grid along an azimuth."""
    d = 0.0
    while d < max_m:
        fi, fj = lola.polar_inverse(lbl, *destination(lat, lon, az, d + step_m))
        if not inside(lbl, fi, fj):
            lo, hi = d, d + step_m
            for _ in range(30):
                mid = (lo + hi) / 2
                if inside(lbl, *lola.polar_inverse(lbl, *destination(lat, lon, az, mid))):
                    lo = mid
                else:
                    hi = mid
            return lo / 1000
        d += step_m
    return math.inf


def elev_angle(r_obs: float, r_tgt: float, theta: float) -> float:
    return math.atan2(r_tgt * math.cos(theta) - r_obs, r_tgt * math.sin(theta))


def main() -> int:
    cfg = json.loads(CONFIG.read_text("utf-8"))
    site = cfg["sites"][0]
    lat, lon = site["latitude_deg"], site["longitude_deg_east"]
    report: dict = {"generated_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "site": {"id": site["id"], "latitude_deg": lat, "longitude_deg_east": lon},
                    "source": {"archive": "PDS Geosciences Node", "data_set_id": "LRO-L-LOLA-4-GDR-V1.0",
                               "polar_dir": lola.POLAR_DIR, "projection_catalog": lola.PDS_BASE + "/catalog/dsmap_polar.cat"}}

    # 1-2. labels, sizes, bounds, site placement ---------------------------------
    products = {}
    print("product          grid         m/pix  bytes-ok  edge-lat  corner-lat  site-inside  min-edge-dist")
    for name in CANDIDATES + COUNT_PRODUCTS:
        lbl = lola.load_label(name)
        size = lola.head_size(lbl.url)
        b = lola.polar_bounds(lbl)
        fi, fj = lola.polar_inverse(lbl, lat, lon)
        ins = inside(lbl, fi, fj)
        edges = [edge_distance_km(lbl, lat, lon, az) for az in range(0, 360, 5)] if ins else []
        products[name] = {
            "img_url": lbl.url, "label_url": lbl.label_url,
            "product_version": lbl.fields.get("PRODUCT_VERSION_ID"),
            "lola_data_through": lbl.fields.get("STOP_TIME"),
            "lines": lbl.lines, "line_samples": lbl.samples,
            "sample_type": f"{lbl.sample_type} {lbl.sample_bits}-bit",
            "scaling_factor": lbl.scaling, "unit": lbl.fields.get("UNIT"),
            "height_reference": f"radius {lbl.offset_m:.0f} m sphere (label OFFSET)",
            "map_scale_m_per_pixel_at_pole": lbl.map_scale_m,
            "ground_pixel_m_at_site": lbl.map_scale_m / lola.stereo_scale_factor(lat),
            "frame": lbl.fields.get("COORDINATE_SYSTEM_NAME"),
            "latitude_type": lbl.fields.get("KEYWORD_LATITUDE_TYPE"),
            "missing_constant": lbl.fields.get("MISSING_CONSTANT"),
            "http_content_length": size, "label_implied_bytes": lbl.expected_bytes,
            "bytes_match": size == lbl.expected_bytes, **b,
            "site_pixel_1based": [fi, fj], "site_inside": ins,
            "site_to_edge_km_min": min(edges) if edges else None,
            "site_to_edge_km_max": max(edges) if edges else None,
        }
        p = products[name]
        print(f"{name:16} {lbl.lines:>5}x{lbl.samples:<5} {lbl.map_scale_m:>6.0f}  {str(p['bytes_match']):8}  "
              f"{b['lat_at_edge_midpoints_deg']:8.3f}  {b['lat_at_corners_deg']:10.3f}  {str(ins):11}  "
              f"{'' if not edges else f'{min(edges):.1f} km'}")
    report["products"] = products

    # 3. orientation check vs global cylindrical LDEM_64 --------------------------
    coarse_lbl = lola.load_label("LDEM_75S_240M")
    coarse = lola.Grid(coarse_lbl, lola.download_full(coarse_lbl)[0])
    cyl = lola.load_label("LDEM_64", kind="cylindrical")
    rms = {}
    pts = 0
    for east_right in (True, False):
        diffs = []
        for tlat in (-78.0, -82.0, -84.7906, -87.0):
            _, j = lola.cyl_pixel(cyl, tlat, 0.0)
            row = lola.read_window(cyl, 1, cyl.samples, j, j)[0]
            for tlon in range(0, 360, 3):
                i, _ = lola.cyl_pixel(cyl, tlat, tlon)
                h_cyl = row[i - 1] * cyl.scaling
                h_pol = coarse.height_bilinear(*lola.polar_inverse(coarse_lbl, tlat, tlon, east_right))
                if h_pol is not None:
                    diffs.append(h_pol - h_cyl)
        rms["east_right" if east_right else "east_left"] = math.sqrt(statistics.fmean(d * d for d in diffs))
        pts = len(diffs)
    ok = rms["east_right"] < rms["east_left"] / 5
    report["orientation_check"] = {
        "method": "LDEM_75S_240M (bilinear) vs global LDEM_64 (nearest) at 4 latitudes x 120 longitudes",
        "points": pts, "rms_m": rms,
        "verdict": "forward equations (90E to the right of the pole) confirmed" if ok else "INCONCLUSIVE",
    }
    print(f"\norientation: RMS vs LDEM_64 = {rms['east_right']:.0f} m (90E right) vs "
          f"{rms['east_left']:.0f} m (90E left) over {pts} points -> {'OK' if ok else 'INCONCLUSIVE'}")
    if not ok:
        print("Orientation not confirmed; stopping before any terrain use.", file=sys.stderr)
        REPORT.write_text(json.dumps(report, indent=1) + "\n", "utf-8")
        return 1

    # 4. terrain + shot counts at the site (20 m) ---------------------------------
    half = 50
    win = {}
    for name in ("LDEM_80S_20M", "LDEC_80S_20M"):
        lbl = lola.load_label(name)
        fi, fj = lola.polar_inverse(lbl, lat, lon)
        ci, cj = round(fi), round(fj)
        win[name] = (lbl, ci, cj, fi, fj, lola.read_window(lbl, ci - half, ci + half, cj - half, cj + half))
    dl, ci, cj, fi, fj, hdn = win["LDEM_80S_20M"]
    _, _, _, _, _, cnt = win["LDEC_80S_20M"]
    a, b = fi - math.floor(fi), fj - math.floor(fj)
    oi, oj = math.floor(fi) - (ci - half), math.floor(fj) - (cj - half)
    h_site = dl.scaling * (hdn[oj][oi] * (1 - a) * (1 - b) + hdn[oj][oi + 1] * a * (1 - b)
                           + hdn[oj + 1][oi] * (1 - a) * b + hdn[oj + 1][oi + 1] * a * b)
    flat_h = [v * dl.scaling for row in hdn for v in row]
    flat_c = [v for row in cnt for v in row]
    zero = [(abs(i - half), abs(j - half)) for j, row in enumerate(cnt) for i, v in enumerate(row) if v == 0]
    nonzero_d = min(math.hypot(i - half, j - half) for j, row in enumerate(cnt) for i, v in enumerate(row) if v > 0)
    report["site_terrain_20m"] = {
        "window": f"{2 * half + 1} x {2 * half + 1} px ({(2 * half + 1) * 20 / 1000:.2f} km) centred on site",
        "site_height_m_bilinear": h_site,
        "site_pixel_count": cnt[half][half],
        "window_height_min_max_m": [min(flat_h), max(flat_h)],
        "window_fraction_pixels_with_zero_lola_shots": len(zero) / len(flat_c),
        "window_max_count": max(flat_c),
        "nearest_measured_pixel_from_site_m": nonzero_d * 20.0,
    }
    print(f"site height (LDEM_80S_20M, bilinear): {h_site:.1f} m above 1737.4 km; "
          f"pixel count {cnt[half][half]}; {100 * len(zero) / len(flat_c):.1f}% of 2 km window has 0 shots")

    # 5. required horizon search distance -----------------------------------------
    cyl_max_m = lola._num(cyl.fields["MAXIMUM"]) * cyl.scaling
    h_max = cyl_max_m + 100.0  # margin: 64 px/deg grid can under-sample summits
    r_obs = R + h_site + site["observer_height_above_surface_m"]
    r_max = R + h_max
    step = coarse_lbl.map_scale_m
    edge80 = lola.load_label("LDEM_80S_20M")
    rays = []
    for k in range(int(360 / AZ_STEP_DEG)):
        az = k * AZ_STEP_DEG
        best, best_d, d, stop, exited = -math.pi / 2, None, step, None, None
        while True:
            theta = d / R
            if elev_angle(r_obs, r_max, theta) < best:
                stop = d
                break
            plat, plon = destination(lat, lon, az, d)
            h = coarse.height_bilinear(*lola.polar_inverse(coarse_lbl, plat, plon))
            if h is None:
                exited = d
                break
            e = elev_angle(r_obs, R + h, theta)
            if e > best:
                best, best_d = e, d
            d += step
        rays.append({"az_deg": az,
                     "required_search_km": None if stop is None else stop / 1000,
                     "exits_75S_file_before_stop_km": None if exited is None else exited / 1000,
                     "coarse_horizon_deg": math.degrees(best), "coarse_horizon_at_km": best_d / 1000,
                     "edge_80S_km": edge_distance_km(edge80, lat, lon, az)})
    req = [r["required_search_km"] for r in rays if r["required_search_km"] is not None]
    unknown = [r["az_deg"] for r in rays if r["required_search_km"] is None]
    beyond80 = [r["az_deg"] for r in rays if r["required_search_km"] is not None and r["required_search_km"] > r["edge_80S_km"]]

    # shot-count coverage along rays within the required distance (240 m)
    cnt_lbl = lola.load_label("LDEC_75S_240M")
    cgrid = lola.Grid(cnt_lbl, lola.download_full(cnt_lbl)[0])
    seen, zero240 = 0, 0
    for r in rays:
        dmax = (r["required_search_km"] or r["exits_75S_file_before_stop_km"]) * 1000
        d = step
        while d <= dmax:
            fi, fj = lola.polar_inverse(cnt_lbl, *destination(lat, lon, r["az_deg"], d))
            v = cgrid.dn_at(round(fi), round(fj))
            if v is not None:
                seen += 1
                zero240 += v == 0
            d += 4 * step

    report["horizon_search"] = {
        "method": ("Ray march on LDEM_75S_240M from the site at 240 m steps; stop when terrain at the "
                   "global maximum height (LDEM_64 label MAXIMUM, +100 m margin) at that distance would "
                   "lie below the running horizon (elevation of a fixed-height point decreases "
                   "monotonically with distance). Lunar curvature enters once, via exact sphere geometry."),
        "observer_radius_m": r_obs, "global_max_height_m_used": h_max,
        "azimuth_step_deg": AZ_STEP_DEG,
        "required_search_km_min_median_max": [min(req), statistics.median(req), max(req)] if req else None,
        "azimuths_unknown_ray_exits_75S_file": unknown,
        "azimuths_needing_terrain_beyond_80S_file": beyond80,
        "fraction_zero_shot_240m_pixels_along_rays": zero240 / seen if seen else None,
        "coarse_horizon_deg_min_max": [min(r["coarse_horizon_deg"] for r in rays), max(r["coarse_horizon_deg"] for r in rays)],
        "caveat": "coarse_horizon values are a 240 m diagnostic for coverage planning, NOT a validated horizon",
        "rays": rays,
    }
    print(f"\nrequired horizon search distance: min {min(req):.0f} km, median {statistics.median(req):.0f} km, "
          f"max {max(req):.0f} km (h_max {h_max:.0f} m)")
    print(f"azimuths where the ray leaves LDEM_75S_240M before the stop rule is met: {len(unknown)}")
    print(f"azimuths needing terrain beyond the LDEM_80S_20M file: {len(beyond80)} "
          f"{beyond80[:12]}{'...' if len(beyond80) > 12 else ''}")
    print(f"zero-shot fraction of 240 m pixels along rays: {100 * zero240 / seen:.1f}% of {seen}")
    print(f"coarse (240 m) horizon range: {report['horizon_search']['coarse_horizon_deg_min_max'][0]:.2f} deg "
          f"to {report['horizon_search']['coarse_horizon_deg_min_max'][1]:.2f} deg (diagnostic only)")

    # 6. seam consistency: LDEM_80S_20M vs LDEM_75S_240M near the 80S edge, in the
    #    sector where rays must continue into the 75S product.
    seam = []
    far = lola.load_label("LDEM_75S_60M")  # chosen far-field product: read directly
    for r in rays:
        if r["az_deg"] not in beyond80 or int(r["az_deg"]) % 3:
            continue
        for back_km in (10.0, 2.0):
            plat, plon = destination(lat, lon, r["az_deg"], (r["edge_80S_km"] - back_km) * 1000)
            fi, fj = lola.polar_inverse(edge80, plat, plon)
            i, j = round(fi), round(fj)
            h20 = lola.read_window(edge80, i, i, j, j)[0][0] * edge80.scaling
            h240 = coarse.height_bilinear(*lola.polar_inverse(coarse_lbl, plat, plon))
            fi6, fj6 = lola.polar_inverse(far, plat, plon)
            i6, j6 = round(fi6), round(fj6)
            h60 = lola.read_window(far, i6, i6, j6, j6)[0][0] * far.scaling
            seam.append({"az_deg": r["az_deg"], "dist_km": r["edge_80S_km"] - back_km,
                         "h_80S_20M_m": h20, "h_75S_60M_m": h60, "h_75S_240M_m": h240,
                         "diff_20m_minus_60m": h20 - h60, "diff_20m_minus_240m": h20 - h240})
    d60 = [s["diff_20m_minus_60m"] for s in seam]
    d240 = [s["diff_20m_minus_240m"] for s in seam]
    report["seam_check"] = {"points": seam,
                            "vs_75S_60M": {"mean_m": statistics.fmean(d60), "max_abs_m": max(map(abs, d60))},
                            "vs_75S_240M": {"mean_m": statistics.fmean(d240), "max_abs_m": max(map(abs, d240))}}
    print(f"seam check, {len(seam)} points near the 80S edge (nearest-pixel 20 m vs 60 m / bilinear 240 m):")
    print(f"  80S_20M - 75S_60M : mean {statistics.fmean(d60):+.1f} m, max |diff| {max(map(abs, d60)):.1f} m")
    print(f"  80S_20M - 75S_240M: mean {statistics.fmean(d240):+.1f} m, max |diff| {max(map(abs, d240)):.1f} m")

    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=1) + "\n", "utf-8")
    print(f"\nwrote {REPORT.relative_to(lola.REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
