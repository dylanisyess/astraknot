"""Rendering-asset exporter (pipeline/render_assets.py): axes, observer-relative transform,
curvature counted once, triangulation, and (when the exported assets exist) their identity.

No LOLA raster is needed except for nothing: geometry tests are synthetic; the asset checks
read only the committed app/public/render and app/public/data files.
"""
import json
import math
import struct
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import render_assets as ra  # noqa: E402
import terrain_horizon as th  # noqa: E402

R = th.R
SITES = {"im2-athena": (-84.7906, 29.1957, 5.3229), "connecting-ridge-cr1": (-89.468, 222.6, 1.9428)}


def point_at(lat, lon, az_deg, d_m, radius):
    """Moon-centred point at ground distance d along azimuth az (great circle), at `radius`."""
    e, n, u = th.enu(lat, lon)
    a = math.radians(az_deg)
    t = [math.cos(a) * n[k] + math.sin(a) * e[k] for k in range(3)]
    th_ = d_m / R
    return tuple(radius * (math.cos(th_) * u[k] + math.sin(th_) * t[k]) for k in range(3))


class Axes(unittest.TestCase):
    def test_direction_formula_and_cardinals(self):
        for az, want in ((0, (0, 0, -1)), (90, (1, 0, 0)), (180, (0, 0, 1)), (270, (-1, 0, 0))):
            got = ra.direction(az, 0)
            for g, w in zip(got, want):
                self.assertAlmostEqual(g, w, places=12)
        self.assertAlmostEqual(ra.direction(123, 90)[1], 1.0, places=12)
        for az in (0.0, 37.5, 181.2, 359.9):
            for el in (-1.4, 0.0, 3.2):
                a, e = ra.az_el(*ra.direction(az, el))
                self.assertAlmostEqual(a, az, places=9)
                self.assertAlmostEqual(e, el, places=9)

    def test_right_handed_y_up(self):
        e, n, u = ra.direction(90, 0), ra.direction(0, 0), (0.0, 1.0, 0.0)
        cross = (e[1] * n[2] - e[2] * n[1], e[2] * n[0] - e[0] * n[2], e[0] * n[1] - e[1] * n[0])
        for c, w in zip(cross, u):  # east x north = up
            self.assertAlmostEqual(c, w, places=12)


class Transform(unittest.TestCase):
    def test_stereographic_inverse_round_trip(self):
        for X, Y in ((0.0, 1.0), (-15_000.0, 158_000.0), (16_150.0, -1_234.5), (250_000.0, 250_000.0)):
            p = ra.stereo_inverse(X, Y)
            self.assertAlmostEqual(math.hypot(*p), 1.0, places=14)
            X2, Y2 = th.stereo_xy(p)
            self.assertAlmostEqual(X2, X, delta=1e-6)
            self.assertAlmostEqual(Y2, Y, delta=1e-6)

    def test_observer_is_origin_and_cardinals_map_to_axes(self):
        for sid, (lat, lon, alt) in SITES.items():
            r_o = R + alt * 1000
            f = ra.Frame(lat, lon, r_o)
            o = f.local(f.o)
            self.assertTrue(all(abs(c) < 1e-9 for c in o), sid)
            n = f.local(point_at(lat, lon, 0, 500, r_o))
            e = f.local(point_at(lat, lon, 90, 500, r_o))
            self.assertLess(n[2], -499.0)  # north is -z
            self.assertGreater(e[0], 499.0)  # east is +x
            self.assertLess(abs(e[2]), 1e-6)
            self.assertLess(abs(n[0]), 1e-6)

    def test_curvature_counted_once(self):
        lat, lon, alt = SITES["im2-athena"]
        r_o = R + alt * 1000
        f = ra.Frame(lat, lon, r_o)
        for d in (2_000.0, 10_000.0, 30_000.0):
            for az in (0.0, 137.4, 250.0):
                x, y, z = f.local(point_at(lat, lon, az, d, r_o))  # same radius as the eye
                # exact drop of a point at the eye's radius: r_o (cos theta - 1) ~ -d^2 / 2R, once
                self.assertAlmostEqual(y, r_o * (math.cos(d / R) - 1), delta=1e-6)
                self.assertAlmostEqual(y, -d * d / (2 * r_o), delta=0.01 * d * d / (2 * r_o))
                a, e = ra.az_el(x, y, z)
                self.assertAlmostEqual(a, az, places=6)
                # the same elevation the terrain-horizon ray march uses (atan2(r cos t - r_o, r sin t))
                self.assertAlmostEqual(e, th.elevation_deg(r_o, r_o, d / R), places=9)
        # 10 km drop is ~29 m (0.16 deg); counting it twice would give ~58 m
        y10 = f.local(point_at(lat, lon, 0, 10_000, r_o))[1]
        self.assertTrue(-29.5 < y10 < -28.5, y10)

    def test_terrain_point_elevation_matches_profile_geometry_and_keeps_negatives(self):
        lat, lon, alt = SITES["connecting-ridge-cr1"]
        r_o = R + alt * 1000
        f = ra.Frame(lat, lon, r_o)
        for h in (1930.0, 1941.0, 1960.0):
            for d in (50.0, 480.0, 3_000.0):
                e = ra.az_el(*f.local(point_at(lat, lon, 222.0, d, R + h)))[1]
                self.assertAlmostEqual(e, th.elevation_deg(r_o, R + h, d / R), places=9)
        self.assertLess(ra.az_el(*f.local(point_at(lat, lon, 10.0, 3000.0, R + 1930.0)))[1], 0)


class Triangulation(unittest.TestCase):
    def test_cells_and_hole(self):
        lv = {"n": 4, "hole": [1, 2, 1, 2]}
        tris = list(ra.triangles(lv))
        self.assertEqual(len(tris), 2 * (9 - 1))
        self.assertEqual(tris[0], (0, 4, 1))
        self.assertEqual(tris[1], (1, 4, 5))
        flat = {v for t in tris for v in t}
        self.assertIn(5, flat)  # hole cell (1,1) skipped, its corners still used by neighbours
        self.assertNotIn((5, 9, 6), tris)


ASSETS = Path(__file__).resolve().parents[2] / "app" / "public" / "render"
DATA = Path(__file__).resolve().parents[2] / "app" / "public" / "data"


@unittest.skipUnless((ASSETS / "im2-athena.terrain.json").exists(), "render assets not exported")
class ExportedAssets(unittest.TestCase):
    def test_identity_layout_and_check(self):
        for sid in SITES:
            meta = json.loads((ASSETS / f"{sid}.terrain.json").read_text("utf-8"))
            site = json.loads((DATA / f"{sid}.json").read_text("utf-8"))
            ob = site["terrain_horizon"]["observer"]
            self.assertEqual(meta["site"]["id"], sid)
            self.assertAlmostEqual(meta["observer"]["observer_radius_m"], ob["observer_radius_m"], delta=1e-6)
            self.assertAlmostEqual(meta["observer"]["eye_above_dem_surface_m"], ob["eye_above_dem_surface_m"], delta=1e-6)
            blob = (ASSETS / meta["bin_file"]).read_bytes()
            self.assertEqual(len(blob), meta["counts"]["bin_bytes"])
            off = 0
            for lv in meta["levels"]:
                self.assertEqual(lv["byte_offset"], off)
                off += 12 * lv["nx"] * lv["ny"]
            self.assertEqual(off, len(blob))
            # ground under the eye: the finest-level vertex nearest the observer's vertical lies
            # about one eye height below it (the grid is anchored on the nearest DEM pixel centre)
            l0 = meta["levels"][0]
            best = min((struct.unpack_from("<3f", blob, 12 * k) for k in range(l0["nx"] * l0["ny"])),
                       key=lambda p: math.hypot(p[0], p[2]))
            self.assertLess(math.hypot(best[0], best[2]), l0["spacing_m"])
            self.assertAlmostEqual(best[1], -meta["observer"]["eye_above_dem_surface_m"], delta=0.5)
            mc = meta["mesh_check"]
            self.assertEqual(mc["setting_point_inside_mesh"]["n"] + mc["setting_point_beyond_mesh"]["n"], 3600)
            self.assertEqual(mc["target_deg"], 0.05)


if __name__ == "__main__":
    unittest.main()
