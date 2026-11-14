"""Verify the LOLA surface elevation at the site and derive the Horizons altitude.

Consistency check: individual LOLA RDR laser shots (planetocentric lat/lon and
radius from the Moon's center, in km) from the PDS Geosciences ODE GDS service
are compared with the gridded LDEM_80S_20M value interpolated at each shot.
This tests our DN scaling, 1737.4 km reference, projection orientation, pixel
selection and interpolation together. The mirrored east/west projection is
evaluated as a control. The LDEM was gridded from these shots, so this is not
an independent check of the terrain heights themselves.

Also compares the site value across LOLA products and estimates how sensitive
the elevation is to the site-coordinate uncertainty (local slope).

    python pipeline/site_elevation.py
Writes data/terrain/site_elevation_report.json; caches the RDR query
responses in data/terrain/lola_rdr/.
"""
from __future__ import annotations

import csv
import io
import json
import math
import statistics
import sys
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lola  # noqa: E402

CONFIG = Path(__file__).resolve().parent / "config.json"
RDR_DIR = lola.REPO_ROOT / "data" / "terrain" / "lola_rdr"
REPORT = lola.REPO_ROOT / "data" / "terrain" / "site_elevation_report.json"
GDS_URL = "https://oderest.rsl.wustl.edu/livegds/"
KM_PER_DEG = math.pi * lola.R_REF_M / 180 / 1000  # 30.32 km


def gds_points(name: str, minlat: float, maxlat: float, wlon: float, elon: float) -> tuple[list[dict], dict]:
    """LOLA RDR points in a lat/lon box (valid shots only, per the GDS label).
    Query JSON, point CSV and its label are cached byte-for-byte."""
    q = {"query": "lolardr", "results": "v", "output": "JSON", "minlat": f"{minlat:.6f}",
         "maxlat": f"{maxlat:.6f}", "westernlon": f"{wlon:.6f}", "easternlon": f"{elon:.6f}"}
    qpath, cpath, lpath = (RDR_DIR / f"{name}.query.json", RDR_DIR / f"{name}_pts.csv",
                           RDR_DIR / f"{name}_pts.lbl")
    meta_path = RDR_DIR / f"{name}.meta.json"
    if not (qpath.exists() and cpath.exists() and lpath.exists()):
        url = GDS_URL + "?" + urllib.parse.urlencode(q)
        body, info = lola._get(url)
        res = json.loads(body)["GDSResults"]
        if res.get("Status") != "Success":
            raise RuntimeError(f"GDS query failed: {res}")
        files = {f["URL"].rsplit("_", 2)[-2] + "_" + f["URL"].rsplit("_", 1)[-1]: f["URL"]
                 for f in res["ResultFiles"]["ResultFile"]}
        csv_url = next(u for k, u in files.items() if k == "pts_csv.csv")
        lbl_url = next(u for k, u in files.items() if k == "pts_csv.lbl")
        csv_body, _ = lola._get(csv_url)
        lbl_body, _ = lola._get(lbl_url)
        RDR_DIR.mkdir(parents=True, exist_ok=True)
        qpath.write_bytes(body)
        cpath.write_bytes(csv_body)
        lpath.write_bytes(lbl_body)
        meta_path.write_text(json.dumps({"request_url": url, "params": q, "http_status": info["status"],
                                         "retrieved_at_utc": lola._utc_now(), "csv_url": csv_url,
                                         "label_url": lbl_url}, indent=2) + "\n", "utf-8")
    rows = list(csv.reader(io.StringIO(cpath.read_text("latin-1"))))
    head = [h.strip() for h in rows[0]]
    ix = {k: head.index(k) for k in ("Coordinated_Universal_Time", "Pt_Longitude", "Pt_Latitude", "Pt_Radius", "Flg")}
    pts = []
    for r in rows[1:]:
        if not r:
            continue
        pts.append({"utc": r[ix["Coordinated_Universal_Time"]].strip(),
                    "lon": float(r[ix["Pt_Longitude"]]), "lat": float(r[ix["Pt_Latitude"]]),
                    "radius_km": float(r[ix["Pt_Radius"]]), "flag": int(r[ix["Flg"]])})
    return pts, json.loads(meta_path.read_text("utf-8"))


def ground_dist_m(lat1, lon1, lat2, lon2) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    c = math.sin(p1) * math.sin(p2) + math.cos(p1) * math.cos(p2) * math.cos(dl)
    return lola.R_REF_M * math.acos(max(-1.0, min(1.0, c)))


def stats(v: list[float]) -> dict:
    return {"n": len(v), "mean_m": statistics.fmean(v), "sd_m": statistics.pstdev(v),
            "max_abs_m": max(abs(x) for x in v)}


def main() -> int:
    cfg = json.loads(CONFIG.read_text("utf-8"))
    site = cfg["sites"][0]
    lat, lon = site["latitude_deg"], site["longitude_deg_east"]
    rep: dict = {"generated_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                 "site": {"latitude_deg": lat, "longitude_deg_east": lon}}

    # Gridded product: LDEM_80S_20M, 101 x 101 px window, plus the mirrored control.
    dem = lola.load_label("LDEM_80S_20M")
    fi, fj = lola.polar_inverse(dem, lat, lon)
    win = lola.Window(dem, round(fi), round(fj), 50)
    site_b = win.bilinear(fi, fj)
    nearest = win.dn(round(fi), round(fj)) * dem.scaling
    mfi, mfj = lola.polar_inverse(dem, lat, lon, east_right=False)
    mwin = lola.Window(dem, round(mfi), round(mfj), 50)

    # LOLA RDR shots (the DEM's source data): ~90 m box and ~600 m box around the site.
    dlat_s, dlon_s = 0.0015, 0.015
    dlat_m, dlon_m = 0.0100, 0.100
    small, small_meta = gds_points("site_box_90m", lat - dlat_s, lat + dlat_s, lon - dlon_s, lon + dlon_s)
    med, med_meta = gds_points("site_box_600m", lat - dlat_m, lat + dlat_m, lon - dlon_m, lon + dlon_m)

    def residuals(points, w, east_right):
        out = []
        for p in points:
            if p["flag"] != 0:
                continue
            b = w.bilinear(*lola.polar_inverse(dem, p["lat"], p["lon"], east_right=east_right))
            if b is None:
                continue
            out.append(b["height_m"] - (p["radius_km"] * 1000 - lola.R_REF_M))
        return out

    res_ok = residuals(med, win, True)
    res_mirror = residuals(med, mwin, False)
    near = sorted(((ground_dist_m(lat, lon, p["lat"], p["lon"]), p) for p in small), key=lambda t: t[0])
    within = [p["radius_km"] * 1000 - lola.R_REF_M for d, p in near if d <= 30.0]
    rep["lola_rdr_check"] = {
        "source": "PDS Geosciences Node ODE GDS, query=lolardr (LOLA RDR, valid shots only: flag 0)",
        "small_box": {**small_meta, "points": len(small)},
        "medium_box": {**med_meta, "points": len(med)},
        "dem_minus_shot_height_forward_orientation": stats(res_ok),
        "dem_minus_shot_height_mirrored_control": stats(res_mirror),
        "nearest_shot_to_site_m": near[0][0],
        "shots_within_30m_of_site": len(within),
        "shot_heights_within_30m_m": [min(within), statistics.fmean(within), max(within)] if within else None,
    }

    # Pixel selection detail and local slope / sensitivity.
    s = dem.map_scale_m / lola.stereo_scale_factor(lat)
    gi = (win.dn(round(fi) + 1, round(fj)) - win.dn(round(fi) - 1, round(fj))) * dem.scaling / (2 * s)
    gj = (win.dn(round(fi), round(fj) + 1) - win.dn(round(fi), round(fj) - 1)) * dem.scaling / (2 * s)
    slope = math.degrees(math.atan(math.hypot(gi, gj)))

    def ring_range(rad_m):
        vals = []
        for k in range(36):
            a = math.radians(k * 10)
            plat = lat + (rad_m * math.cos(a)) / 1000 / KM_PER_DEG
            plon = lon + (rad_m * math.sin(a)) / 1000 / (KM_PER_DEG * math.cos(math.radians(lat)))
            b = win.bilinear(*lola.polar_inverse(dem, plat, plon))
            vals.append(b["height_m"])
        return [min(vals) - site_b["height_m"], max(vals) - site_b["height_m"]]

    rep["ldem_80s_20m_at_site"] = {
        "fractional_pixel_1based": {"sample": fi, "line": fj},
        "bilinear_height_m": site_b["height_m"], "pixels_used": site_b["pixels"],
        "nearest_pixel_height_m": nearest,
        "ground_pixel_m": s,
        "local_slope_deg": slope,
        "height_change_on_30m_ring_m": ring_range(30.0),
        "height_change_on_100m_ring_m": ring_range(100.0),
        "scaling": f"height = DN x {dem.scaling} m relative to {dem.offset_m:.0f} m sphere",
    }

    # Cross-product comparison at the site.
    comp = {}
    for name in ("LDEM_80S_40M", "LDEM_85S_20M", "LDEM_85S_10M", "LDEM_75S_60M"):
        l2 = lola.load_label(name)
        f2i, f2j = lola.polar_inverse(l2, lat, lon)
        w2 = lola.Window(l2, round(f2i), round(f2j), 2)
        comp[name] = w2.bilinear(f2i, f2j)["height_m"]
    cyl = lola.load_label("LDEM_64", kind="cylindrical")
    ci, cj = lola.cyl_pixel(cyl, lat, lon)
    comp["LDEM_64 (nearest, ~474 m lat spacing)"] = lola.read_window(cyl, ci, ci, cj, cj)[0][0] * cyl.scaling
    rep["site_height_by_product_m"] = {"LDEM_80S_20M": site_b["height_m"], **comp}

    # Altitude to submit to Horizons.
    obs_h = 1.0
    surf = round(site_b["height_m"], 1)
    rep["horizons_altitude"] = {
        "surface_elevation_m": surf,
        "surface_elevation_reference": "height above the 1737.4 km LOLA reference sphere (LDEM_80S_20M, bilinear)",
        "observer_height_above_surface_m": obs_h,
        "horizons_site_altitude_km": round((surf + obs_h) / 1000, 4),
        "convention": ("Horizons GEODETIC altitude is height above the reference ellipsoid; for the Moon the "
                       "response header reports a 1737.4 km sphere, the same reference as LOLA heights. "
                       "Checked in each response via |Center cylindric| = 1737.4 km + altitude."),
    }

    print(f"LDEM_80S_20M at site: bilinear {site_b['height_m']:.2f} m, nearest pixel {nearest:.1f} m "
          f"(pixel {fi:.2f}, {fj:.2f}); slope {slope:.2f} deg")
    r = rep["lola_rdr_check"]
    print(f"RDR shots: {r['small_box']['points']} in ~90 m box, {r['medium_box']['points']} in ~600 m box; "
          f"nearest shot {r['nearest_shot_to_site_m']:.1f} m from site; {r['shots_within_30m_of_site']} within 30 m "
          f"(heights {r['shot_heights_within_30m_m']})")
    a, b = r["dem_minus_shot_height_forward_orientation"], r["dem_minus_shot_height_mirrored_control"]
    print(f"DEM - shot (forward orientation): n={a['n']} mean {a['mean_m']:+.2f} m sd {a['sd_m']:.2f} m max {a['max_abs_m']:.2f} m")
    print(f"DEM - shot (mirrored control):    n={b['n']} mean {b['mean_m']:+.2f} m sd {b['sd_m']:.2f} m max {b['max_abs_m']:.2f} m")
    for k, v in rep["site_height_by_product_m"].items():
        print(f"  {k:40s} {v:9.2f} m")
    print(f"height change within 30 m ring: {rep['ldem_80s_20m_at_site']['height_change_on_30m_ring_m']}, "
          f"100 m ring: {rep['ldem_80s_20m_at_site']['height_change_on_100m_ring_m']}")
    print(f"Horizons altitude: {rep['horizons_altitude']['horizons_site_altitude_km']} km")
    REPORT.write_text(json.dumps(rep, indent=1) + "\n", "utf-8")
    print(f"wrote {REPORT.relative_to(lola.REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
