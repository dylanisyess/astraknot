"""Read-only numbers behind the 3D-view requirements (2026-11-14 science review).

Preserved from the reviewer's scratch script `design_numbers.py`. The
computations are unchanged except: the horizon lookup now refuses unknown
(null) entries and non-uniform grids instead of silently using them, and
section 3 also lists every sample time where the instantaneous state differs
from the 10-minute midpoint interval state, for both horizon models (the
original covered the terrain model and printed counts only). It imports no
pipeline module.

Per site:
1. Direction and rate of Sun/Earth azimuth motion (Sun: azimuth falls ~0.085
   deg per 10 min, i.e. right to left facing north).
2. Linear-interpolation error between samples (predict sample i from i-1, i+1).
3. Disk-versus-center statistics with NOMINAL disk radii (Sun 0.27 deg, Earth
   0.95 deg; the dataset holds no angular diameters) and the instantaneous vs
   midpoint disagreements.
4. Distances at which the skyline is set, and curvature drop with distance.
5. A 20 m two-triangle mesh vs bilinear surface: skyline change within 1 km
   (720 azimuths, 1 m steps) and the surface change under the observer. This
   is the reason the 3D view must sample heights bilinearly near the observer.

Inputs: see _dem.py (section 5 needs data/raw/lola/ldem_80s_20m/ldem_80s_20m.img;
pass --no-mesh to skip it). Runtime ~20 s.
Run: python pipeline/review/design_numbers.py [--no-mesh]
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _dem import REPO, R, Dem, config, dest, elev, fail, xy  # noqa: E402

NOMINAL_RADIUS_DEG = {"sun": 0.27, "earth": 0.95}


def make_hz(A: list[float], E: list[float | None]):
    n = len(A)
    step = 360 / n
    if any(abs(a - k * step) > 1e-9 for k, a in enumerate(A)):
        fail("horizon azimuths are not a uniform grid from 0")

    def hz_at(az: float) -> float:
        k = int(math.floor((az % 360) / step)) % n
        fr = ((az % 360) - A[k]) / step
        e0, e1 = E[k], E[(k + 1) % n]
        if e0 is None or e1 is None:
            raise ValueError(f"horizon unknown at azimuth {az:.3f}")
        return e0 + (e1 - e0) * fr
    return hz_at


def ipaz(a0: float, a1: float, t: float) -> float:
    return (a0 + t * (((a1 - a0 + 180) % 360) - 180)) % 360


def main() -> int:
    mesh = "--no-mesh" not in sys.argv[1:]
    dem = Dem() if mesh else None
    for site in config()["sites"]:
        sid, lat, lon = site["id"], site["latitude_deg"], site["longitude_deg_east"]
        D = json.loads((REPO / "app" / "public" / "data" / f"{sid}.json").read_text("utf-8"))
        s = D["samples"]
        T = D["terrain_horizon"]
        A, E = T["horizon"]["azimuth_deg"], T["horizon"]["elevation_deg"]
        hz_at = make_hz(A, E)
        print(f"\n==== {sid}")
        # 1 direction of motion, 2 interpolation error
        for b in ("sun", "earth"):
            d = [((y[f"{b}_azimuth_deg"] - x[f"{b}_azimuth_deg"] + 180) % 360) - 180 for x, y in zip(s, s[1:])]
            az = [x[f"{b}_azimuth_deg"] for x in s]
            el = [x[f"{b}_elevation_deg"] for x in s]
            print(f" {b}: az step/10min min {min(d):+.4f} max {max(d):+.4f} deg; az range {min(az):.2f}..{max(az):.2f}; "
                  f"el range {min(el):.3f}..{max(el):.3f}")
            ea = max(abs((((s[i][f"{b}_azimuth_deg"] - ipaz(s[i - 1][f"{b}_azimuth_deg"], s[i + 1][f"{b}_azimuth_deg"], .5))
                           + 180) % 360) - 180) for i in range(1, len(s) - 1))
            ee = max(abs(s[i][f"{b}_elevation_deg"] - (s[i - 1][f"{b}_elevation_deg"] + s[i + 1][f"{b}_elevation_deg"]) / 2)
                     for i in range(1, len(s) - 1))
            print(f"   linear-interp error over a 20-min chord: az {ea:.2e} deg, el {ee:.2e} deg (10-min chord ~1/4 of this)")
        # 3 disk straddle (terrain model, nominal radii)
        for b, rad in NOMINAL_RADIUS_DEG.items():
            n = len(s) - 1
            strad = tiny = mism = 0
            for i in range(n):
                x, y = s[i], s[i + 1]
                m_mid = (x[f"{b}_elevation_deg"] + y[f"{b}_elevation_deg"]) / 2 - hz_at(ipaz(x[f"{b}_azimuth_deg"], y[f"{b}_azimuth_deg"], .5))
                m_ins = x[f"{b}_elevation_deg"] - hz_at(x[f"{b}_azimuth_deg"])
                strad += abs(m_mid) < rad
                tiny += abs(m_mid) < 0.05
                mism += (m_mid > 0) != (m_ins > 0)
            part = 0
            for i in range(n):
                x, y = s[i], s[i + 1]
                azm = ipaz(x[f"{b}_azimuth_deg"], y[f"{b}_azimuth_deg"], .5)
                elm = (x[f"{b}_elevation_deg"] + y[f"{b}_elevation_deg"]) / 2
                if elm > hz_at(azm):
                    continue
                k = -rad
                while k <= rad + 1e-9:
                    chord = math.sqrt(max(0.0, rad * rad - k * k))
                    if elm + chord > hz_at(azm + k / max(1e-9, math.cos(math.radians(elm)))):
                        part += 1
                        break
                    k += 0.05
            print(f" {b}: centre within one nominal disc radius ({rad} deg) of the skyline in {100 * strad / n:.1f} % of steps; "
                  f"within 0.05 deg in {100 * tiny / n:.1f} %; centre hidden but part of the disc above the skyline in "
                  f"{100 * part / n:.1f} % of steps; instant-vs-midpoint state differs at {mism} of {n} sample times")
        # 3b every instantaneous-vs-interval disagreement, both models (what the app's
        #    "Near estimated crossing" explanation covers)
        for model, hz in (("smooth", lambda az: 0.0), ("terrain", hz_at)):
            rows = []
            for b in ("sun", "earth"):
                for i in range(len(s) - 1):
                    x, y = s[i], s[i + 1]
                    m_mid = (x[f"{b}_elevation_deg"] + y[f"{b}_elevation_deg"]) / 2 - hz(ipaz(x[f"{b}_azimuth_deg"], y[f"{b}_azimuth_deg"], .5))
                    m_ins = x[f"{b}_elevation_deg"] - hz(x[f"{b}_azimuth_deg"])
                    if (m_mid > 0) != (m_ins > 0):
                        rows.append(f"{b} {x['time_utc']} interval {'visible' if m_mid > 0 else 'not visible'}, "
                                    f"instant clearance {m_ins:+.5f} deg")
            print(f" {model} model: {len(rows)} instant-vs-interval disagreement(s)" + "".join(f"\n   {r}" for r in rows))
        # 4 setting distances
        dk = sorted(v for v in T["setting_points"]["distance_km"] if v is not None)
        q = lambda p: dk[min(len(dk) - 1, int(p * len(dk)))]  # noqa: E731
        print(f" skyline setting distance km: min {dk[0]} p10 {q(.1)} median {q(.5)} p90 {q(.9)} max {dk[-1]}; share beyond "
              f"2 km {100 * sum(v > 2 for v in dk) / len(dk):.0f} %, beyond 10 km {100 * sum(v > 10 for v in dk) / len(dk):.0f} %, "
              f"beyond 50 km {100 * sum(v > 50 for v in dk) / len(dk):.0f} %")
        for km in (0.5, 2, 5, 10, 30, 100):
            print(f"   curvature drop at {km} km: {(km * 1000) ** 2 / (2 * R):8.2f} m = {math.degrees(km * 1000 / (2 * R)):.4f} deg", end=";")
        print()
        for b in ("sun", "earth"):
            ds = [T["setting_points"]["distance_km"][int(round(x[f"{b}_azimuth_deg"] * 10)) % 3600] for x in s]
            print(f" under the {b}'s path: skyline set {min(ds)}..{max(ds)} km away")
        if not mesh:
            continue
        # 5 mesh interpolation: bilinear vs two-triangle surface, skyline within 1 km
        r_o = R + site["horizons_site_altitude_km"] * 1000
        worst = {"tri_a": (0, None), "tri_b": (0, None)}
        diffs: dict[str, list[float]] = {"tri_a": [], "tri_b": []}
        for k in range(720):
            az = k * 0.5
            best = {"bilinear": -9e9, "tri_a": -9e9, "tri_b": -9e9}
            d = 2.0
            while d <= 1000:
                X, Y = xy(*dest(lat, lon, az, d))
                for m in best:
                    best[m] = max(best[m], elev(R + dem.h(X, Y, m), r_o, d))
                d += 1.0
            for m in ("tri_a", "tri_b"):
                dd = best[m] - best["bilinear"]
                diffs[m].append(abs(dd))
                if abs(dd) > worst[m][0]:
                    worst[m] = (abs(dd), az)
        X0, Y0 = xy(lat, lon)
        foot = {m: dem.h(X0, Y0, m) for m in ("bilinear", "tri_a", "tri_b")}
        for m in ("tri_a", "tri_b"):
            v = sorted(diffs[m])
            print(f" 20 m two-triangle mesh ({m}) vs bilinear, terrain within 1 km, eye at the same radius: skyline |diff| "
                  f"median {v[len(v) // 2]:.3f} max {worst[m][0]:.3f} deg (az {worst[m][1]}); surface under the observer "
                  f"differs by {foot[m] - foot['bilinear']:+.3f} m")
    return 0


if __name__ == "__main__":
    sys.exit(main())
