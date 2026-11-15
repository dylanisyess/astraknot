"""Bounded assessment of a 5 m/pix PGDA LOLA product (Barker et al. 2021) for a site's
near-field terrain horizon, compared with the existing LDEM_80S_20M result.

Products (pgda.py): PGDA_SITE01_5M (surface + LDEC), PGDA_SITE01_5M_B4 (the same surface
block-averaged 4 x 4 to 20 m, which falls exactly on LDEM_80S_20M's pixel-centre grid).
Rays use the 5 m tile where its bilinear stencil fits and continue in the validated
LDEM_80S_20M / LDEM_75S_60M beyond it (same priority rule as terrain_horizon.py).

Sections of the report:
  metadata     GeoTIFF facts, NaN count, coverage of the point and margins
  alignment    5 m vs 20 m heights: vertical offset (height reference) and a horizontal
               shift search (registration), whole tile and near the point
  edge         5 m vs 20 m heights just inside the tile edge, and how far below each
               azimuth's horizon any terrain beyond the tile lies
  observer     surfaces at the point, eye heights for a fixed absolute radius and for the
               nominal height above each surface (never below a surface)
  profiles     horizons + 60-day steps + demo-window metrics + Sun/Earth transitions for:
               numerical convergence, observer location, removed nearby terrain, product
               change, sampling (5 m vs its own 20 m block mean), product at equal sampling
  uncertainty  PGDA total-Z RMS error at the setting points as elevation angles

    python pipeline/terrain_5m.py --site connecting-ridge-cr1
Writes data/terrain/<site_id>_terrain_5m_assessment.json. Requires data/raw/pgda/site01/
(python pipeline/pgda.py fetch Site01 surf ldec toterr) and the LOLA products.
"""
from __future__ import annotations

import json
import math
import statistics
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sites  # noqa: E402
import pgda  # noqa: E402
import terrain_horizon as th  # noqa: E402
import terrain_sensitivity as ts  # noqa: E402

SITE_TILE = {"connecting-ridge-cr1": "Site01"}
R = th.R
BASE5 = {"d_min": 1.25, "near_step": 1.25, "near_limit": 2000.0, "far_step": 5.0}


def bil(ra: th.Raster, X: float, Y: float):
    v = ra.height_bilinear(*ra.pixel_of(X, Y))
    return None if v is None or v != v else v


def stats(v: list[float]) -> dict:
    v = sorted(v)
    q = lambda p: v[min(len(v) - 1, int(p * len(v)))]  # noqa: E731
    return {"n": len(v), "mean": statistics.fmean(v), "median": statistics.median(v),
            "sd": statistics.pstdev(v), "p05": q(0.05), "p95": q(0.95), "min": v[0], "max": v[-1]}


def main() -> int:
    t0 = time.time()
    ap = sites.parser(description=__doc__)
    args = ap.parse_args()
    cfg = json.loads(th.CONFIG.read_text("utf-8"))
    site = sites.cli_sites(ap, args, cfg)[0]
    tile = SITE_TILE[site["id"]]
    P5, PB = f"PGDA_{tile.upper()}_5M", f"PGDA_{tile.upper()}_5M_B{pgda.BLOCK}"
    t = cfg["terrain"]
    prod20 = [(t["near_field_product"], t["near_field_counts"]), (t["far_field_product"], t["far_field_counts"])]
    prod5, prodB = [(P5, None)] + prod20, [(PB, None)] + prod20
    rep20_path = sites.report_path(site["id"], "terrain_horizon")
    rep20 = json.loads(rep20_path.read_text("utf-8"))
    sites.require_identity(rep20["site"], site, str(rep20_path))
    h_max = rep20["method"]["stopping_rule"]["h_max_m"]
    out: dict = {"generated_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                 "site": sites.identity(site), "terrain_report_20m_sha256": sites.sha256(rep20_path),
                 "pgda_downloads": pgda.load_meta(tile)}

    # ------------------------------------------------------------ metadata
    surf, ldec, terr = (pgda.GeoTiff(pgda.path_of(tile, x)) for x in ("surf", "ldec", "toterr"))
    for g in (ldec, terr):
        if (g.width, g.height, g.x0, g.y0, g.sx, g.dc) != (surf.width, surf.height, surf.x0, surf.y0, surf.sx, surf.dc):
            raise ValueError("PGDA layers are not on the same grid")
    nan = {name: sum(1 for v in g.data if v != v) for name, g in (("surf", surf), ("ldec", ldec), ("toterr", terr))}
    obs20 = th.site_observer(site)
    X, Y = th.stereo_xy(obs20.u)
    ci, ri = surf.frac_index(X, Y)
    x_lo, x_hi = surf.x0, surf.x0 + surf.width * surf.sx
    y_hi, y_lo = surf.y0, surf.y0 - surf.height * surf.sy
    near5 = th.Raster.from_files(P5, None)
    l20 = th.Raster.from_files(*prod20[0])
    hdr = surf.header
    out["metadata"] = {
        "grid": {"width": surf.width, "height": surf.height, "pixel_m": surf.sx, "sample_type": surf.code,
                 "compression": hdr["tags"]["Compression"], "x_range_m": [x_lo, x_hi], "y_range_m": [y_lo, y_hi]},
        "registration": {"GTRasterType": surf.raster_type, "tiepoint_is": "outer corner of pixel (0,0)",
                         "pixel_centre_offset_m": surf.dc * surf.sx,
                         "gmt_history": [l for l in hdr["tags"]["GDAL_METADATA"].splitlines() if "history" in l
                                         or "node_offset" in l]},
        "projection_geokeys": hdr["geokeys"],
        "nodata": {"GDAL_NODATA": hdr["tags"].get("GDAL_NODATA"), "nan_counts": nan},
        "point_map_xy_m": [X, Y],
        "point_fractional_col_row": [ci, ri],
        "point_edge_distance_m": {"west": X - x_lo, "east": x_hi - X, "north_y_hi": y_hi - Y, "south_y_lo": Y - y_lo},
        "ldem20_vs_tile_pixel_lattice": ("4 x 4 block centres coincide with LDEM_80S_20M pixel centres"
                                         if abs(((x_lo + 2 * surf.sx) - 10) % 20) < 1e-9 else "not coincident"),
    }
    print(f"metadata: {surf.width}x{surf.height} {surf.sx} m; NaN {nan}; point {X:.1f}, {Y:.1f} m; "
          f"edge margins {min(out['metadata']['point_edge_distance_m'].values()):.0f} m", flush=True)

    # local quality at the point
    def ring(g: pgda.GeoTiff, radius_m: float) -> list[float]:
        n = int(radius_m / surf.sx) + 1
        vals = []
        for dr in range(-n, n + 1):
            for dc_ in range(-n, n + 1):
                c, r = round(ci) + dc_, round(ri) + dr
                cx, cy = surf.centre(c, r)
                if math.hypot(cx - X, cy - Y) <= radius_m:
                    v = g.at(c, r)
                    if v is not None and v == v:
                        vals.append(v)
        return vals

    l100, l500 = ring(ldec, 100), ring(ldec, 500)
    out["metadata"]["point_quality"] = {
        "ldec_nearest": ldec.at(round(ci), round(ri)),
        "ldec_zero_fraction_within_100m": sum(v == 0 for v in l100) / len(l100),
        "ldec_zero_fraction_within_500m": sum(v == 0 for v in l500) / len(l500),
        "toterr_bilinear_at_point_m": bil(_terr_raster(tile, terr), X, Y),
        "toterr_within_500m_m": stats(ring(terr, 500)),
    }

    # ------------------------------------------------------------ alignment / height reference
    bm = pgda.load_meta(tile).get(f"block{pgda.BLOCK}")
    if not bm or bm["source_sha256"] != pgda.load_meta(tile)["surf"]["sha256"] or not pgda.block_mean_path(tile).exists():
        pgda.build_block_mean(tile)
    blk = th.Raster.from_files(PB, None)
    diffs_tile, diffs_near = [], []
    for br in range(blk.height):
        for bc in range(blk.width):
            I, J = bc + blk.i_first, br + blk.j_first
            v5 = blk.dn_at(I, J)
            cx, cy = (I - blk.n_full / 2 - 0.5) * blk.scale_m, -(J - blk.n_full / 2 - 0.5) * blk.scale_m
            fi, fj = l20.pixel_of(cx, cy)
            if abs(fi - round(fi)) > 1e-6 or abs(fj - round(fj)) > 1e-6:
                raise ValueError("block centres are not on the LDEM_80S_20M lattice")
            v20 = l20.dn_at(round(fi), round(fj))
            if v5 != v5 or v20 is None:
                continue
            d = v5 - v20 * l20.scaling
            diffs_tile.append(d)
            if math.hypot(cx - X, cy - Y) <= 1000:
                diffs_near.append(d)

    def shift_rms(radius_m: float, stride: int, max_shift: float = 40.0, step: float = 5.0) -> dict:
        pts = []
        for r in range(0, surf.height, stride):
            for c in range(0, surf.width, stride):
                cx, cy = surf.centre(c, r)
                if math.hypot(cx - X, cy - Y) <= radius_m:
                    v = surf.at(c, r)
                    if v == v:
                        pts.append((cx, cy, v))
        k = int(max_shift / step)
        grid = []
        for iy in range(-k, k + 1):
            for ix in range(-k, k + 1):
                dx, dy = ix * step, iy * step
                res = [v - h for (cx, cy, v) in pts if (h := bil(l20, cx + dx, cy + dy)) is not None]
                m = statistics.fmean(res)
                grid.append({"dx_m": dx, "dy_m": dy, "mean_m": m,
                             "rms_about_mean_m": math.sqrt(statistics.fmean((x - m) ** 2 for x in res))})
        best = min(grid, key=lambda g: g["rms_about_mean_m"])
        zero = next(g for g in grid if g["dx_m"] == 0 and g["dy_m"] == 0)
        return {"n_points": len(pts), "radius_m": radius_m, "shift_step_m": step, "max_shift_m": max_shift,
                "zero_shift": zero, "best": best,
                "note": "5 m surface at its pixel centres minus LDEM_80S_20M bilinear at the shifted position"}

    out["alignment"] = {
        "block_mean_minus_ldem20_m": {"whole_tile": stats(diffs_tile), "within_1km": stats(diffs_near)},
        "shift_search_within_1km": shift_rms(1000.0, 2),
        "shift_search_within_6km": shift_rms(6000.0, 24),
    }
    a = out["alignment"]
    print(f"alignment: block-mean - LDEM20 tile mean {a['block_mean_minus_ldem20_m']['whole_tile']['mean']:+.3f} m "
          f"(sd {a['block_mean_minus_ldem20_m']['whole_tile']['sd']:.2f}); near 1 km mean "
          f"{a['block_mean_minus_ldem20_m']['within_1km']['mean']:+.3f} m; best shift 1 km "
          f"{a['shift_search_within_1km']['best']['dx_m']:+.0f},{a['shift_search_within_1km']['best']['dy_m']:+.0f} m "
          f"rms {a['shift_search_within_1km']['best']['rms_about_mean_m']:.3f} vs zero "
          f"{a['shift_search_within_1km']['zero_shift']['rms_about_mean_m']:.3f}; 6 km "
          f"{a['shift_search_within_6km']['best']['dx_m']:+.0f},{a['shift_search_within_6km']['best']['dy_m']:+.0f}",
          flush=True)

    # ------------------------------------------------------------ edge of the tile
    inset = 25.0
    edge = []
    s = 100.0
    xs = [x_lo + inset + k * s for k in range(int((x_hi - x_lo - 2 * inset) / s) + 1)]
    ys = [y_lo + inset + k * s for k in range(int((y_hi - y_lo - 2 * inset) / s) + 1)]
    perim = ([(x, y_lo + inset) for x in xs] + [(x, y_hi - inset) for x in xs]
             + [(x_lo + inset, y) for y in ys] + [(x_hi - inset, y) for y in ys])
    for (ex, ey) in perim:
        h5, h20 = bil(near5, ex, ey), bil(l20, ex, ey)
        if h5 is None or h20 is None:
            continue
        dist = math.hypot(ex - X, ey - Y)  # map distance ~ ground distance this near the pole
        edge.append((h5 - h20, math.degrees(math.atan2(h5 - h20, dist))))
    out["edge"] = {"inset_m": inset, "spacing_m": s, "dh_5m_minus_20m_m": stats([e[0] for e in edge]),
                   "elevation_angle_effect_deg_maxabs": max(abs(e[1]) for e in edge)}

    # ------------------------------------------------------------ observer
    h20 = rep20["site"]["dem_surface_at_site_m"]
    h5 = bil(near5, X, Y)
    hb = bil(blk, X, Y)
    r_fixed = obs20.r_obs
    nominal = site["observer_height_above_surface_m"]
    alt5_km = round((round(h5, 1) + nominal) / 1000, 7)
    r_nom5 = R + alt5_km * 1000
    out["observer"] = {
        "surface_m": {"ldem20_bilinear": h20, "pgda5_bilinear": h5, "pgda5_block20_bilinear": hb,
                      "pgda5_minus_ldem20": h5 - h20},
        "fixed_radius": {"r_m": r_fixed, "horizons_altitude_km": site["horizons_site_altitude_km"],
                         "eye_above_ldem20_m": r_fixed - R - h20, "eye_above_pgda5_m": r_fixed - R - h5,
                         "eye_above_block20_m": r_fixed - R - hb,
                         "meaning": "same point in space as the fetched Horizons positions"},
        "nominal_on_pgda5": {"surface_rounded_m": round(h5, 1), "horizons_altitude_km": alt5_km, "r_m": r_nom5,
                             "eye_above_pgda5_m": r_nom5 - R - h5,
                             "meaning": ("pipeline convention (surface rounded to 0.1 m + 1 m) applied to the 5 m "
                                         "surface; would require new Horizons positions at this altitude")},
    }
    for k, v in out["observer"]["fixed_radius"].items():
        if k.startswith("eye") and v <= 0:
            raise ValueError(f"fixed-radius observer is at or below a surface ({k} = {v:.3f} m)")
    print(f"observer: surfaces LDEM20 {h20:.3f}, 5 m {h5:.3f}, block {hb:.3f} m; fixed-radius eye above 5 m "
          f"{r_fixed - R - h5:.3f} m; nominal-on-5m altitude {alt5_km} km", flush=True)

    # ------------------------------------------------------------ profiles
    samples = ts.load_samples(cfg, site)
    az = [round(k * th.AZ_STEP_DEG, 6) for k in range(round(360 / th.AZ_STEP_DEG))]
    obs_fixed = th.Observer(obs20.lat, obs20.lon, r_fixed)
    obs_nom5 = th.Observer(obs20.lat, obs20.lon, r_nom5)
    base20_el = [r["elevation_deg"] for r in rep20["rays"]]
    profiles: dict[str, dict] = {}

    def run(name, desc, obs, products, sched=BASE5, azs=az, **kw):
        t1 = time.time()
        rays = th.profile(obs, azs, products, h_max, sched, **kw)
        el = [r["elevation_deg"] for r in rays]
        profiles[name] = {"description": desc, "rays": rays, "az": azs, "el": el,
                          "states": ts.step_states(samples, ts.horizon_dict(azs, el)),
                          "runtime_s": round(time.time() - t1, 1)}
        print(f"  {name:28s} {time.time() - t1:5.0f} s", flush=True)
        return rays

    profiles["L20"] = {"description": "existing LDEM_80S_20M result (5/10 m ray sampling), fixed radius",
                       "rays": rep20["rays"], "az": az, "el": base20_el,
                       "states": ts.step_states(samples, ts.horizon_dict(az, base20_el)), "runtime_s": None}
    print("profiles:", flush=True)
    run("F5_fixed", "5 m tile, base sampling, fixed radius (same point as the Horizons positions)", obs_fixed, prod5)
    run("F5_nominal", "5 m tile, base sampling, nominal 1 m above the 5 m surface (rounded convention)", obs_nom5, prod5)
    run("B4_fixed", "5 m surface block-averaged to 20 m (LDEM_80S_20M grid), same sampling, fixed radius",
        obs_fixed, prodB)
    run("L20_fixed_base5", "LDEM_80S_20M with the 5 m run's sampling, fixed radius", obs_fixed, prod20)
    # numerical convergence (5 m)
    run("F5_radial_0.625_2.5", "5 m tile, radial 0.625 m (<2 km) / 2.5 m", obs_fixed, prod5,
        {"d_min": 0.625, "near_step": 0.625, "near_limit": 2000.0, "far_step": 2.5})
    run("F5_radial_2.5_5", "5 m tile, radial 2.5 m (<2 km) / 5 m", obs_fixed, prod5,
        {"d_min": 2.5, "near_step": 2.5, "near_limit": 2000.0, "far_step": 5.0})
    run("F5_radial_5_10", "5 m tile, radial 5 m / 10 m (the 20 m run's sampling)", obs_fixed, prod5,
        {"d_min": 5.0, "near_step": 5.0, "near_limit": 2000.0, "far_step": 10.0})
    run("F5_az_0.05", "5 m tile, 0.05 deg azimuth step", obs_fixed, prod5,
        azs=[round(k * 0.05, 6) for k in range(7200)])
    # removing real nearby terrain
    for dmin in (20.0, 50.0, 100.0, 300.0):
        run(f"F5_ignore_lt_{dmin:g}m", f"5 m tile, ignore terrain closer than {dmin:g} m", obs_fixed, prod5,
            {**BASE5, "d_min": dmin})
    run("F5_only_beyond_tile", "terrain beyond 8.5 km only (beyond the 5 m tile in every direction)", obs_fixed,
        prod5, {**BASE5, "d_min": 8500.0})
    # observer location (nominal eye kept above the 5 m surface at each displaced point)
    eye5 = r_nom5 - R - h5
    e_v, n_v, u = th.enu(obs20.lat, obs20.lon)
    shifts = {}
    for nm, a_deg in (("N", 0), ("E", 90), ("S", 180), ("W", 270)):
        a_ = math.radians(a_deg)
        tv = [math.cos(a_) * n_v[i] + math.sin(a_) * e_v[i] for i in range(3)]
        q = 100.0 / R
        p = [math.cos(q) * u[i] + math.sin(q) * tv[i] for i in range(3)]
        lat, lon = th.latlon(p)
        f2 = bil(near5, *th.stereo_xy(p))
        f20 = bil(l20, *th.stereo_xy(p))
        shifts[nm] = {"surface_5m_m": f2, "surface_20m_m": f20}
        run(f"F5_shift_100m_{nm}", f"5 m tile, observer 100 m {nm}, eye {eye5:.3f} m above the 5 m surface",
            th.Observer(lat, lon, R + f2 + eye5), prod5)

    # ------------------------------------------------------------ comparisons
    def summary(name: str) -> dict:
        p = profiles[name]
        el = [e for e in p["el"] if e is not None]
        known = [r for r in p["rays"] if r["elevation_deg"] is not None]
        tr = ts.transitions(samples, p["states"])
        sun = [x[0] for x in p["states"]]
        best = cur = 0
        best_end = None
        for k, v in enumerate(sun):
            cur = cur + 1 if v is False else 0
            if cur > best:
                best, best_end = cur, k
        return {
            "description": p["description"], "runtime_s": p["runtime_s"],
            "n_unknown": sum(e is None for e in p["el"]),
            "elevation_deg_min_median_max": [min(el), statistics.median(el), max(el)],
            "setting_distance_m_min_median_max": [min(r["distance_m"] for r in known),
                                                  statistics.median(r["distance_m"] for r in known),
                                                  max(r["distance_m"] for r in known)],
            "setting_points_by_product": {q: sum(r["product"] == q for r in known)
                                          for q in sorted({r["product"] for r in known})},
            "sun_visible_pct_60d": 100 * sum(bool(x[0]) for x in p["states"]) / len(p["states"]),
            "earth_visible_pct_60d": 100 * sum(bool(x[1]) for x in p["states"]) / len(p["states"]),
            "longest_dark_60d_h": best / 6,
            "longest_dark_60d_end_utc": None if best_end is None else samples[best_end + 1]["time_utc"],
            "sun_transitions": [(x["time_utc"], "rise" if x["to"] else "set", round(x["azimuth_deg"], 2))
                                for x in tr if x["body"] == "sun"],
            "earth_transitions": [(x["time_utc"], "rise" if x["to"] else "set", round(x["azimuth_deg"], 2))
                                  for x in tr if x["body"] == "earth"],
            "demo": ts.demo_metrics(samples, p["states"]),
        }

    def compare(a: str, b: str, what: str) -> dict:
        pa, pb = profiles[a], profiles[b]
        ang = ts.angular_diff(pa["az"], pa["el"], pb["az"], pb["el"])
        da, db = ts.demo_metrics(samples, pa["states"]), ts.demo_metrics(samples, pb["states"])
        return {"a": a, "b": b, "category": what, "angular_b_minus_a": ang,
                "sun_steps_changed": sum(x[0] != y[0] for x, y in zip(pa["states"], pb["states"])),
                "earth_steps_changed": sum(x[1] != y[1] for x, y in zip(pa["states"], pb["states"])),
                "demo_delta_b_minus_a": {w: {f: (None if da[w][f] is None or db[w][f] is None else db[w][f] - da[w][f])
                                             for f in da[w]} for w in da}}

    comps = [
        compare("F5_fixed", "F5_radial_0.625_2.5", "numerical convergence"),
        compare("F5_fixed", "F5_radial_2.5_5", "numerical convergence"),
        compare("F5_fixed", "F5_radial_5_10", "numerical convergence"),
        compare("F5_fixed", "F5_az_0.05", "numerical convergence"),
        compare("L20", "L20_fixed_base5", "numerical convergence (20 m product, 5 m run's sampling)"),
        *[compare("F5_fixed", f"F5_shift_100m_{d}", "observer location (scenario, not an uncertainty)")
          for d in "NESW"],
        *[compare("F5_fixed", f"F5_ignore_lt_{x:g}m", "removing real nearby terrain") for x in (20, 50, 100, 300)],
        compare("L20_fixed_base5", "F5_fixed", "terrain product change (20 m LDEM -> 5 m PGDA), fixed radius"),
        compare("L20", "F5_nominal", "terrain product change with each product's own nominal observer"),
        compare("F5_fixed", "F5_nominal", "observer convention on the 5 m surface (fixed radius vs nominal)"),
        compare("F5_fixed", "B4_fixed", "sampling: 5 m surface vs its own 20 m block mean"),
        compare("L20_fixed_base5", "B4_fixed", "product at equal 20 m sampling (LDEM_80S_20M vs PGDA block mean)"),
    ]
    for c in comps:
        g = c["angular_b_minus_a"]
        print(f"  {c['a']:>16s} -> {c['b']:24s} max|d| {g.get('max_abs_deg', 0):.4f} med {g.get('median_abs_deg', 0):.4f}"
              f"  sun/earth steps {c['sun_steps_changed']}/{c['earth_steps_changed']}  [{c['category']}]", flush=True)

    # beyond-tile margin: how far below the horizon is the highest terrain beyond the tile
    beyond = profiles["F5_only_beyond_tile"]["el"]
    margins = [e - b for e, b in zip(profiles["F5_fixed"]["el"], beyond) if e is not None and b is not None]
    out["edge"]["beyond_tile_terrain_below_horizon_deg_min"] = min(margins)
    out["edge"]["setting_points_outside_tile"] = sum(r["product"] != P5 for r in profiles["F5_fixed"]["rays"]
                                                     if r["elevation_deg"] is not None)

    # ------------------------------------------------------------ uncertainty at the setting points
    terr_r = _terr_raster(tile, terr)
    ue = []
    for r in profiles["F5_fixed"]["rays"]:
        if r["elevation_deg"] is None or r["product"] != P5:
            continue
        sx_, sy_ = th.stereo_xy(th.unit(r["lat_deg"], r["lon_deg"]))
        sig = bil(terr_r, sx_, sy_)
        if sig is not None:
            ue.append((sig, math.degrees(math.atan2(sig, r["distance_m"]))))
    el5 = profiles["F5_fixed"]["el"]
    illus = {}
    for sign in (+1, -1):
        shifted = [None if e is None else e + sign * d for e, (_, d) in zip(el5, ue)] if len(ue) == len(el5) else None
        if shifted:
            st = ts.step_states(samples, ts.horizon_dict(az, shifted))
            illus["plus_1sigma" if sign > 0 else "minus_1sigma"] = {
                "sun_steps_changed": sum(x[0] != y[0] for x, y in zip(profiles["F5_fixed"]["states"], st)),
                "demo": ts.demo_metrics(samples, st)}
    out["uncertainty"] = {
        "source": "PGDA *_toterr.tif: total Z uncertainty, formally RMS error from 100 statistical clones",
        "toterr_at_setting_points_m": stats([x[0] for x in ue]),
        "as_elevation_angle_deg": stats([x[1] for x in ue]),
        "coherent_1sigma_shift_illustration": illus,
        "note": ("Illustration only: every setting point moved by its own 1-sigma at once (fully correlated), "
                 "which is not a statistical result; the clone ensemble was not used (out of scope)."),
    }

    out["profiles"] = {k: summary(k) for k in profiles}
    out["comparisons"] = comps
    out["displaced_surfaces_m"] = shifts
    out["horizon_profiles_deg"] = {"azimuth_deg": az, **{k: [None if e is None else round(e, 5) for e in profiles[k]["el"]]
                                                          for k in ("L20", "F5_fixed", "F5_nominal", "B4_fixed")}}
    out["setting_points_F5_fixed"] = {
        "distance_m": [r.get("distance_m") for r in profiles["F5_fixed"]["rays"]],
        "shot_count": [r.get("shot_count_nearest") for r in profiles["F5_fixed"]["rays"]],
        "product": [r.get("product") for r in profiles["F5_fixed"]["rays"]]}
    out["runtime_s"] = round(time.time() - t0)
    path = sites.report_path(site["id"], "terrain_5m_assessment")
    path.write_text(json.dumps(out, indent=1, default=float) + "\n", "utf-8", newline="\n")
    print(f"wrote {path.relative_to(sites.REPO_ROOT)} ({out['runtime_s']} s)")
    return 0


def _terr_raster(tile: str, terr: pgda.GeoTiff) -> th.Raster:
    n, i1, j1 = pgda._pole_grid(terr.x0, terr.y0, terr.sx, terr.dc, terr.width, terr.height)
    return th.Raster(name=f"PGDA_{tile.upper()}_TOTERR", n_full=n, scale_m=terr.sx, scaling=1.0, dn=terr.data,
                     width=terr.width, height=terr.height, i_first=i1, j_first=j1, _keep=[terr])


if __name__ == "__main__":
    raise SystemExit(sites.run(main))
