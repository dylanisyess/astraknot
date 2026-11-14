"""Checks of the terrain horizon (pipeline/terrain_horizon.py) by other routes.

1. Pixel sweep (independently implemented algorithm and geometry, SAME DEM):
   every DEM pixel centre in a 1-degree wedge out to 200 km is turned into a 3D
   point, (R + h) * unit(lat, lon) with lat/lon from the documented forward
   projection (lola.polar_forward); its azimuth and elevation are computed
   from the vector observer -> point in a local frame whose north/east axes are
   obtained here by NUMERICAL differentiation. No great circles, no
   theta-based elevation formula, no bilinear interpolation. The wedge maximum
   is compared with the ray-march maximum over the same wedge (0.01 deg rays).
2. LOLA RDR laser shots: a CONSISTENCY check, not independent terrain
   validation. The LDEM was gridded from LOLA RDR shots through 2017-02-02 and
   96-100 % of the shots used here predate that cutoff. Shots within +/-250 m
   of the point that sets the horizon in a few directions are positioned from
   their own lat/lon/radius with the vector geometry of (1). Reported: the
   highest shot elevation in the azimuth window vs the DEM horizon there, and
   DEM - shot heights near the crest. Agreement shows the gridded surface,
   our reading of it and the ray geometry are consistent with the measurements
   it came from; it cannot reveal errors common to the shots and the DEM, and
   it says little where only a few shots fall in the window.
3. Azimuth convention vs Horizons (sanity check): the ME frame's +X axis is the
   mean Earth direction; its azimuth/elevation from the site is compared with
   the 60-day mean Horizons Earth direction. Limitations: libration moves Earth
   by several degrees, so the 60-day mean need not equal +X; it tests one
   direction only; the elevation is not compared closely (parallax, residual
   libration). It catches gross errors (mirrored or rotated azimuths, tens of
   degrees), not sub-degree offsets. Orientation at all four cardinal
   directions is tested separately with synthetic walls (tests/).

What these checks SHARE with the main method (so they cannot catch errors
in it): the LOLA DEM itself, the 1737.4 km reference radius and the
polar-stereographic projection constants (both verified separately against
LDEM_64 and LOLA shots), the site coordinates and their ME-frame assumption,
and the observer radius.

    python pipeline/horizon_crosscheck.py
Writes data/terrain/<site_id>_horizon_crosscheck.json. Requires the
downloaded products (fetch_terrain.py) and data/terrain/<site_id>_terrain_horizon.json.
The RDR queries are cached in data/terrain/lola_rdr/ (network on first run).
"""
from __future__ import annotations

import json
import math
import statistics
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sites
import lola  # noqa: E402
import site_elevation  # noqa: E402  (gds_points: cached ODE GDS LOLA RDR queries)
import terrain_check  # noqa: E402  (destination: spherical-trig great-circle formula)
import terrain_horizon as th  # noqa: E402  (only: Raster file access, profile() for the comparison side)

R = lola.R_REF_M
SWEEP_KM = 200.0
WEDGE_DEG = 1.0


# ---------------------------------------------------------- independent geometry

def xyz(lat, lon, r=1.0):
    p, l = math.radians(lat), math.radians(lon)
    return [r * math.cos(p) * math.cos(l), r * math.cos(p) * math.sin(l), r * math.sin(p)]


def _norm(v):
    m = math.sqrt(sum(x * x for x in v))
    return [x / m for x in v]


class LocalFrame:
    """North/east from numerical derivatives of the position on the sphere."""

    def __init__(self, lat, lon, r_obs):
        eps = 1e-5
        self.up = xyz(lat, lon)
        self.north = _norm([a - b for a, b in zip(xyz(lat + eps, lon), xyz(lat - eps, lon))])
        self.east = _norm([a - b for a, b in zip(xyz(lat, lon + eps), xyz(lat, lon - eps))])
        self.o = [r_obs * x for x in self.up]

    def az_el_dist(self, p):
        v = [a - b for a, b in zip(p, self.o)]
        e = sum(a * b for a, b in zip(v, self.east))
        n = sum(a * b for a, b in zip(v, self.north))
        u = sum(a * b for a, b in zip(v, self.up))
        hz = math.hypot(e, n)
        return math.degrees(math.atan2(e, n)) % 360.0, math.degrees(math.atan2(u, hz)), hz

    def direction_az_el(self, d):
        e = sum(a * b for a, b in zip(d, self.east))
        n = sum(a * b for a, b in zip(d, self.north))
        u = sum(a * b for a, b in zip(d, self.up))
        return math.degrees(math.atan2(e, n)) % 360.0, math.degrees(math.atan2(u, math.hypot(e, n)))


def in_wedge(az, a0, a1):
    return (az - a0) % 360.0 < (a1 - a0) % 360.0


# ---------------------------------------------------------- 1. pixel sweep

def wedge_lines(lbl, lat, lon, a0, a1, dmax_m, step_m):
    """line J -> [I_min, I_max] covering the wedge (with a 2-pixel margin).
    Used only to enumerate candidates; each pixel is then tested exactly."""
    rng: dict[int, list[int]] = {}
    d = 0.0
    while d <= dmax_m:
        pts = [lola.polar_inverse(lbl, *terrain_check.destination(lat, lon, a, max(d, 1.0))) for a in (a0, a1)]
        i_lo = math.floor(min(p[0] for p in pts)) - 2
        i_hi = math.ceil(max(p[0] for p in pts)) + 2
        for j in range(math.floor(min(p[1] for p in pts)) - 2, math.ceil(max(p[1] for p in pts)) + 3):
            r = rng.setdefault(j, [i_lo, i_hi])
            r[0], r[1] = min(r[0], i_lo), max(r[1], i_hi)
        d += step_m
    return rng


def sweep(frame: LocalFrame, lat, lon, a0, a1, near: th.Raster, far: th.Raster, near_lbl, far_lbl, sub=4):
    """Max elevation per sub-bin over all pixel centres in the wedge [a0, a1)."""
    width = (a1 - a0) % 360.0
    best = [(-90.0, None) for _ in range(sub)]
    n_px = 0
    for lbl, ra, other in ((near_lbl, near, None), (far_lbl, far, near_lbl)):
        lines = wedge_lines(lbl, lat, lon, a0, a1, SWEEP_KM * 1000, lbl.map_scale_m / 2)
        for j, (i_lo, i_hi) in lines.items():
            for i in range(max(1, i_lo), min(lbl.samples, i_hi) + 1):
                if not 1 <= j <= lbl.lines:
                    continue
                plat, plon = lola.polar_forward(lbl, i, j)
                if other is not None:  # far product only where the near product has no data
                    oi, oj = lola.polar_inverse(other, plat, plon)
                    if 1 <= oi <= other.samples and 1 <= oj <= other.lines:
                        continue
                dn = ra.dn_at(i, j)
                if dn is None:
                    continue
                az, el, dist = frame.az_el_dist(xyz(plat, plon, R + dn * lbl.scaling))
                if dist > SWEEP_KM * 1000 or not in_wedge(az, a0, a1):
                    continue
                n_px += 1
                k = min(sub - 1, int(((az - a0) % 360.0) / width * sub))
                if el > best[k][0]:
                    best[k] = (el, {"az": az, "dist_km": dist / 1000, "product": lbl.name, "pixel": [i, j],
                                    "height_m": dn * lbl.scaling})
    return best, n_px


# ---------------------------------------------------------- main

def main() -> int:
    ap = sites.parser(description=__doc__)
    args = ap.parse_args()
    cfg = json.loads(th.CONFIG.read_text("utf-8"))
    site = sites.cli_sites(ap, args, cfg)[0]
    horizon_path = sites.report_path(site["id"], "terrain_horizon")
    out_path = sites.report_path(site["id"], "horizon_crosscheck")
    rep_h = json.loads(horizon_path.read_text("utf-8"))
    sites.require_identity(rep_h.get("site", {}), site, str(horizon_path))
    site_data = sites.load_site_data(cfg, site)
    obs = th.site_observer(site)
    lat, lon = obs.lat, obs.lon
    frame = LocalFrame(lat, lon, obs.r_obs)
    t = cfg["terrain"]
    products = [(t["near_field_product"], t["near_field_counts"]), (t["far_field_product"], t["far_field_counts"])]
    near, far = th.Raster.from_files(*products[0]), th.Raster.from_files(*products[1])
    near_lbl, far_lbl = lola.load_label(products[0][0]), lola.load_label(products[1][0])
    rays = rep_h["rays"]
    h_max = rep_h["method"]["stopping_rule"]["h_max_m"]
    out: dict = {"generated_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                 "site": sites.identity(site),
                 "terrain_report_sha256": sites.sha256(horizon_path),
                 "shared_assumptions": ["LOLA LDEM heights (same files)",
                                        "LOLA RDR shots are the DEM's own source data (consistency, not independence)",
                                        "1737.4 km reference radius",
                                        "polar stereographic projection constants",
                                        "site coordinates (ME frame assumed)", "observer radius"]}

    # wedges: cardinal directions, every terrain crossing of the Sun/Earth paths, horizon extremes
    crossings = rep_h.get("sensitivity", {}).get("terrain_crossings", [])
    centres = [0.0, 90.0, 180.0, 270.0] + sorted({round(c["azimuth_deg"], 1) for c in crossings})
    el = [r["elevation_deg"] for r in rays]
    centres += [rays[el.index(max(el))]["azimuth_deg"], rays[el.index(min(el))]["azimuth_deg"]]
    seen, wedges = set(), []
    for c in centres:
        if round(c) not in seen:
            seen.add(round(c))
            wedges.append(c)

    rows = []
    for c in wedges:
        a0, a1 = (c - WEDGE_DEG / 2) % 360.0, (c + WEDGE_DEG / 2) % 360.0
        sub = 4
        best, n_px = sweep(frame, lat, lon, a0, a1, near, far, near_lbl, far_lbl, sub)
        ray_az = [round((a0 + k * 0.01) % 360.0, 6) for k in range(round(WEDGE_DEG / 0.01))]
        rr = th.profile(obs, ray_az, products, h_max)
        width = WEDGE_DEG / sub
        for k in range(sub):
            in_bin = [r for r in rr if int(((r["azimuth_deg"] - a0) % 360.0) / width) == k]
            rb = max(in_bin, key=lambda r: r["elevation_deg"])
            pe, pinfo = best[k]
            # Same-direction check: a ray at the exact azimuth of the highest pixel (azimuth
            # from the independent frame) passes through that pixel centre, where bilinear
            # = the pixel value, so its maximum must be >= the pixel's elevation (minus the
            # change over half a radial step) if both geometries agree.
            same = th.march(obs, pinfo["az"], [near, far], th.schedule(), h_max)
            rows.append({"bin_deg": [round((a0 + k * width) % 360, 3), round((a0 + (k + 1) * width) % 360, 3)],
                         "ray_march_max_deg": rb["elevation_deg"], "ray_setting_km": rb["distance_m"] / 1000,
                         "pixel_sweep_max_deg": pe, "pixel_setting_km": pinfo["dist_km"],
                         "pixel_az_deg": pinfo["az"], "pixel_product": pinfo["product"],
                         "diff_pixel_minus_ray_deg": pe - rb["elevation_deg"],
                         "ray_at_pixel_az_deg": same["elevation_deg"],
                         "ray_at_pixel_az_minus_pixel_deg": same["elevation_deg"] - pe})
        # stop-rule sufficiency of the 200 km sweep: highest possible terrain at 200 km
        e_lim = math.degrees(math.atan2((R + h_max) * math.cos(SWEEP_KM * 1000 / R) - obs.r_obs,
                                        (R + h_max) * math.sin(SWEEP_KM * 1000 / R)))
        print(f"wedge {c:7.2f}: {n_px:7d} px; pixel - ray per 0.25 deg bin: "
              + ", ".join(f"{r['diff_pixel_minus_ray_deg']:+.3f}" for r in rows[-sub:])
              + f"  (200 km limit elev {e_lim:+.2f} deg)", flush=True)
        for r in rows[-sub:]:
            r["sweep_extent_sufficient"] = e_lim < r["pixel_sweep_max_deg"]
    diffs = [r["diff_pixel_minus_ray_deg"] for r in rows]
    far_rows = [r for r in rows if r["ray_setting_km"] >= 2.0]
    out["pixel_sweep"] = {
        "method": "pixel centres in 1-degree wedges to 200 km, 3D vectors, numerical local frame, no interpolation; "
                  "compared per 0.25-degree bin with the max of 0.01-degree ray-march rays",
        "n_bins": len(rows), "wedge_centres_deg": wedges,
        "diff_deg_mean_maxabs": [statistics.fmean(diffs), max(map(abs, diffs))],
        "diff_deg_maxabs_where_ray_setting_ge_2km": max((abs(r["diff_pixel_minus_ray_deg"]) for r in far_rows), default=None),
        "all_sweeps_extent_sufficient": all(r["sweep_extent_sufficient"] for r in rows),
        "same_direction_ray_minus_pixel_deg_min_max": [min(r["ray_at_pixel_az_minus_pixel_deg"] for r in rows),
                                                       max(r["ray_at_pixel_az_minus_pixel_deg"] for r in rows)],
        "note": ("Where the horizon is set within ~1 km, a 0.25-degree bin is only metres wide and holds few "
                 "pixel centres, so the sweep can miss the crest (pixel < ray). The same-direction check "
                 "covers those bins."),
        "bins": rows,
    }
    print(f"pixel sweep: {len(rows)} bins, pixel - ray mean {statistics.fmean(diffs):+.4f} deg, "
          f"max |diff| {max(map(abs, diffs)):.4f} deg (setting >= 2 km: "
          f"{out['pixel_sweep']['diff_deg_maxabs_where_ray_setting_ge_2km']:.4f} deg); same-direction "
          f"ray - pixel {out['pixel_sweep']['same_direction_ray_minus_pixel_deg_min_max']}", flush=True)

    # 2. LOLA RDR shots near the setting points ---------------------------------
    by_az = {round(r["azimuth_deg"], 1): r for r in rays}
    pick = [0.0, 90.0, 180.0, 270.0] + [round(c["azimuth_deg"], 1) for c in crossings
                                         if c["body"] == "sun"][:2] + [round(c["azimuth_deg"], 1) for c in crossings
                                                                        if c["body"] == "earth"][:2]
    shot_rows = []
    for a in pick:
        r = by_az[round(a, 1)]
        dlat = 250.0 / (math.pi * R / 180)
        dlon = dlat / math.cos(math.radians(r["lat_deg"]))
        name = f"horizon_az{a:05.1f}_box_500m"
        pts, meta = site_elevation.gds_points(name, r["lat_deg"] - dlat, r["lat_deg"] + dlat,
                                              r["lon_deg"] - dlon, r["lon_deg"] + dlon, site_id=site["id"])
        valid = [p for p in pts if p["flag"] == 0]
        win = 0.1
        ray_az = [round((a - win + k * 0.01) % 360, 6) for k in range(round(2 * win / 0.01) + 1)]
        rr = th.profile(obs, ray_az, products, h_max, workers=4)
        dem_max = max(x["elevation_deg"] for x in rr)
        shots_in, resid = [], []
        for p in valid:
            az, elv, dist = frame.az_el_dist(xyz(p["lat"], p["lon"], p["radius_km"] * 1000))
            fi, fj = near.pixel_of(*th.stereo_xy(th.unit(p["lat"], p["lon"])))
            hd = near.height_bilinear(fi, fj)
            if hd is not None:
                resid.append(hd - (p["radius_km"] * 1000 - R))
            if abs(((az - a + 180) % 360) - 180) <= win:
                shots_in.append((elv, dist, p))
        top = max(shots_in, key=lambda s: s[0]) if shots_in else None
        row = {"azimuth_deg": a, "setting_point": {k: r[k] for k in ("distance_m", "lat_deg", "lon_deg", "height_m",
                                                                     "shot_count_nearest")},
               "query": meta.get("request_url"), "valid_shots_in_box": len(valid),
               "shots_within_az_window": len(shots_in), "az_window_deg": win,
               "dem_horizon_max_in_window_deg": dem_max,
               "max_shot_elevation_deg": top[0] if top else None,
               "max_shot_distance_km": top[1] / 1000 if top else None,
               "shot_minus_dem_deg": (top[0] - dem_max) if top else None,
               "dem_minus_shot_height_m": {"n": len(resid), "mean": statistics.fmean(resid) if resid else None,
                                           "sd": statistics.pstdev(resid) if len(resid) > 1 else None,
                                           "max_abs": max(map(abs, resid)) if resid else None}}
        shot_rows.append(row)
        print(f"RDR az {a:6.1f}: {len(valid)} shots in box, {len(shots_in)} within +/-{win} deg; "
              f"max shot elev {row['max_shot_elevation_deg']} vs DEM {dem_max:.3f}; "
              f"DEM-shot height mean {row['dem_minus_shot_height_m']['mean']}", flush=True)
    out["lola_rdr_shots"] = {"method": ("LOLA RDR shots (ODE GDS, flag 0) within +/-250 m of the horizon-setting "
                                        "point; az/el from each shot's own lat/lon/radius"),
                             "interpretation": ("Consistency check against the DEM's source data (LDEM gridded from "
                                                "RDR shots through 2017-02-02), not independent validation; "
                                                "windows with few shots give only lower bounds."),
                             "rows": shot_rows}

    # 3. azimuth convention vs Horizons -------------------------------------------
    s = site_data["samples"]
    eaz = [x["earth_azimuth_deg"] for x in s]
    mean_az = math.degrees(math.atan2(statistics.fmean(math.sin(math.radians(a)) for a in eaz),
                                      statistics.fmean(math.cos(math.radians(a)) for a in eaz))) % 360
    mean_el = statistics.fmean(x["earth_elevation_deg"] for x in s)
    paz, pel = frame.direction_az_el([1.0, 0.0, 0.0])
    maz = (360 - paz) % 360  # what a counter-clockwise (mirrored) azimuth would report
    out["azimuth_convention"] = {
        "method": "ME +X axis (mean Earth direction) seen from the site in the local frame vs mean Horizons Earth az/el",
        "predicted_az_el_deg": [paz, pel], "horizons_mean_az_el_deg": [mean_az, mean_el],
        "diff_az_deg": ((mean_az - paz + 180) % 360) - 180, "diff_el_deg": mean_el - pel,
        "mirrored_convention_would_predict_az_deg": maz,
        "note": ("Sanity check only. Libration moves Earth by several degrees, so the 60-day mean need not equal "
                 "the +X direction; one direction is tested; the elevation difference (parallax, residual "
                 "libration) is not analysed. Agreement within ~2 deg rules out a mirrored (counter-clockwise, "
                 "~60 deg off here) or grossly rotated azimuth, not sub-degree offsets."),
    }
    print(f"azimuth convention: ME +X predicted az {paz:.2f} el {pel:.2f}; Horizons mean az {mean_az:.2f} "
          f"el {mean_el:.2f}; mirrored would be {maz:.2f}", flush=True)

    out_path.write_text(json.dumps(out, indent=1) + "\n", "utf-8")
    print(f"wrote {out_path.relative_to(lola.REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(sites.run(main))
