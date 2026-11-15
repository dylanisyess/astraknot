"""Independent spot checks from the 2026-11-14 science review (read-only).

Preserved from the reviewer's scratch script `spot.py`; the computations are
unchanged, with input checks added (label-derived grid constants, raster
presence and size, unknown horizon entries). It imports no pipeline module.

For each configured site:
1. Surface height under the observer (bilinear) and the eye height above it.
2. Ray march at seven azimuths, 1 m steps to 3 km then 5 m to 30 km, against
   the committed terrain horizon report. Agreement is expected within the
   pipeline's documented sampling convergence (Athena ~0.002 deg; CR1 up to
   ~0.024 deg, where 1 m steps resolve near-field relief the 5 m pipeline
   steps smooth over). Skylines set beyond 30 km are flagged, not compared.
3. Pixel registration: DEM minus LOLA shot height RMS for map shifts of
   +/-40 m in 5 m steps, using every cached valid shot of the site. The best
   fit should be (0, 0) with every half-pixel shift worse. These shots are the
   DEM's own source data, so this confirms how the product is read, not
   terrain accuracy.
4. Mirrored-X control: reading the map with east to the left must be grossly worse.

Inputs: see _dem.py (needs data/raw/lola/ldem_80s_20m/ldem_80s_20m.img).
Runtime ~10 s. Run: python pipeline/review/spot_checks.py
"""
from __future__ import annotations

import csv
import glob
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _dem import REPO, R, Dem, config, dest, elev, xy  # noqa: E402

AZIMUTHS = (0.0, 45.0, 90.0, 137.4, 180.0, 270.0, 337.5)


def main() -> int:
    dem = Dem()
    for site in config()["sites"]:
        sid, lat, lon = site["id"], site["latitude_deg"], site["longitude_deg_east"]
        r_o = R + site["horizons_site_altitude_km"] * 1000
        foot = dem.h(*xy(lat, lon))
        print(f"\n== {sid}: independent bilinear foot {foot:.6f} m; eye {r_o - R - foot:.6f} m")
        rep = json.loads((REPO / "data" / "terrain" / f"{sid}_terrain_horizon.json").read_text("utf-8"))
        rays = {round(r["azimuth_deg"], 1): r for r in rep["rays"]}
        for az in AZIMUTHS:
            best, bd = -9e9, None
            d = 1.0
            while d <= 30000:
                la, lo = dest(lat, lon, az, d)
                e = elev(R + dem.h(*xy(la, lo)), r_o, d)
                if e > best:
                    best, bd = e, d
                d += 1.0 if d < 3000 else 5.0
            r = rays[az]
            if r["elevation_deg"] is None:
                print(f"  az {az:6.1f}: independent {best:8.4f} deg at {bd:7.0f} m | pipeline horizon unknown")
                continue
            far = r["distance_m"] > 30000
            print(f"  az {az:6.1f}: independent(1 m steps, <=30 km) {best:8.4f} deg at {bd:7.0f} m | pipeline "
                  f"{r['elevation_deg']:8.4f} deg at {r['distance_m']:7.0f} m | diff {best - r['elevation_deg']:+.4f}"
                  + ("  (pipeline skyline beyond 30 km)" if far else ""))

        pts = []
        for p in glob.glob(str(REPO / "data" / "terrain" / "lola_rdr" / f"{sid}__*_pts.csv")):
            with open(p, encoding="latin-1") as fh:
                rows = list(csv.reader(fh))
            head = [c.strip() for c in rows[0]]
            ix = {k: head.index(k) for k in ("Pt_Longitude", "Pt_Latitude", "Pt_Radius", "Flg", "Coordinated_Universal_Time")}
            for r in rows[1:]:
                if r and int(r[ix["Flg"]]) == 0:
                    pts.append((r[ix["Coordinated_Universal_Time"]].strip(), float(r[ix["Pt_Latitude"]]),
                                float(r[ix["Pt_Longitude"]]), float(r[ix["Pt_Radius"]]) * 1000 - R))
        pts = sorted(set(pts))
        if not pts:
            print("  registration: no cached LOLA shots for this site")
            continue
        P = [(xy(la, lo), h) for _, la, lo, h in pts]
        res = {}
        for sx in range(-40, 41, 5):
            for sy in range(-40, 41, 5):
                dd = [dem.h(x + sx, y + sy) - h for (x, y), h in P]
                m = sum(dd) / len(dd)
                res[(sx, sy)] = (math.sqrt(sum((v - m) ** 2 for v in dd) / len(dd)), m)
        best = min(res, key=lambda k: res[k][0])
        print(f"  registration ({len(P)} unique valid shots): RMS about mean at (0,0) = {res[(0, 0)][0]:.3f} m "
              f"(mean {res[(0, 0)][1]:+.3f}); best trial shift {best} m -> {res[best][0]:.3f} m; half-pixel "
              f"(10,10) -> {res[(10, 10)][0]:.3f}, (-10,-10) -> {res[(-10, -10)][0]:.3f}, (10,-10) -> "
              f"{res[(10, -10)][0]:.3f}, (-10,10) -> {res[(-10, 10)][0]:.3f}; one pixel (20,0) -> "
              f"{res[(20, 0)][0]:.3f}, (0,20) -> {res[(0, 20)][0]:.3f}")
        dd = [dem.h(-x, y) - h for (x, y), h in P]
        m = sum(dd) / len(dd)
        print(f"  mirrored-X control: mean {m:+.1f} m, RMS about mean {math.sqrt(sum((v - m) ** 2 for v in dd) / len(dd)):.1f} m")
    return 0


if __name__ == "__main__":
    sys.exit(main())
