"""Terrain hazard screening slope (pipeline/slope.py): synthetic geometry, units and spacing,
nodata/boundary handling, threshold semantics, statistics, and the exported assets.

The geometry tests are synthetic (no LOLA file needed). The asset tests read the committed
app/public/screening, app/public/render and app/public/data files. One cross-check against
an independent planar implementation needs the 1.85 GB LDEM_80S_20M raster and is skipped
without it.
"""
import json
import math
import sys
import unittest
from array import array
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import lola  # noqa: E402
import slope as sl  # noqa: E402
import terrain_horizon as th  # noqa: E402

REPO = Path(__file__).resolve().parent.parent.parent
R = th.R
SITES = {"im2-athena": (-84.7906, 29.1957), "connecting-ridge-cr1": (-89.468, 222.6)}
N_FULL, SCALE = 30400, 20.0


def synthetic(lat, lon, height_fn, half=8, scaling=1.0):
    """A small window of a 30 400 px / 20 m polar grid around (lat, lon). height_fn(i, j, p) -> metres."""
    probe = th.Raster(name="probe", n_full=N_FULL, scale_m=SCALE, scaling=scaling, dn=[], width=0, height=0)
    fi, fj = probe.pixel_of(*th.stereo_xy(th.unit(lat, lon)))
    ci, cj = round(fi), round(fj)
    i_first, j_first = ci - half, cj - half
    w = 2 * half + 1
    dn = array("d", [0] * (w * w))
    for r in range(w):
        for c in range(w):
            i, j = i_first + c, j_first + r
            p = sl.pixel_unit(probe, i, j)
            dn[r * w + c] = height_fn(i, j, p) / scaling
    ras = th.Raster(name="synthetic", n_full=N_FULL, scale_m=SCALE, scaling=scaling, dn=dn, width=w, height=w,
                    i_first=i_first, j_first=j_first)
    return ras, (ci, cj)


def plane_heights(ras_probe_lat, lon, slope_deg, downslope_az_deg, h0=1000.0):
    """Heights of a true plane through the reference pixel centre, tilted by slope_deg relative
    to that pixel's local lunar horizontal, falling toward downslope_az_deg."""
    probe = th.Raster(name="probe", n_full=N_FULL, scale_m=SCALE, scaling=1.0, dn=[], width=0, height=0)
    fi, fj = probe.pixel_of(*th.stereo_xy(th.unit(ras_probe_lat, lon)))
    u0 = sl.pixel_unit(probe, round(fi), round(fj))
    lat0, lon0 = th.latlon(u0)
    e, n, _ = th.enu(lat0, lon0)
    s, a = math.radians(slope_deg), math.radians(downslope_az_deg)
    m = tuple(math.cos(s) * u0[k] + math.sin(s) * (math.cos(a) * n[k] + math.sin(a) * e[k]) for k in range(3))
    P0 = tuple((R + h0) * c for c in u0)
    mp0 = sum(m[k] * P0[k] for k in range(3))

    def f(i, j, p):
        return mp0 / sum(m[k] * p[k] for k in range(3)) - R
    return f


class Geometry(unittest.TestCase):
    def test_flat_sphere_is_zero_slope_at_both_latitudes(self):
        for lat, lon in SITES.values():
            ras, (ci, cj) = synthetic(lat, lon, lambda i, j, p: 1234.0)
            for di, dj in ((0, 0), (5, -3), (-6, 6)):
                s, _ = sl.cell_slope(ras, ci + di, cj + dj)
                self.assertLess(s, 1e-6, "curvature must not count as slope")

    def test_planar_terrain_known_slope_and_orientation(self):
        for lat, lon in SITES.values():
            for slope_deg in (0.5, 5.0, 15.0, 30.0):
                for az in (0.0, 37.0, 90.0, 181.5, 300.0):
                    ras, (ci, cj) = synthetic(lat, lon, plane_heights(lat, lon, slope_deg, az), half=3)
                    s, a = sl.cell_slope(ras, ci, cj)
                    self.assertAlmostEqual(s, slope_deg, delta=1e-6)
                    self.assertAlmostEqual(((a - az + 180) % 360) - 180, 0.0, delta=1e-4)

    def test_plane_off_centre_differs_only_by_curvature(self):
        lat, lon = SITES["im2-athena"]
        ras, (ci, cj) = synthetic(lat, lon, plane_heights(lat, lon, 12.0, 45.0), half=8)
        for di, dj in ((6, 0), (0, -6), (-6, 6)):
            s, _ = sl.cell_slope(ras, ci + di, cj + dj)
            # the local vertical tilts by (ground distance / R) rad between pixels
            tilt = math.degrees(math.hypot(di, dj) * SCALE / R)
            self.assertLess(abs(s - 12.0), tilt + 1e-6)

    def test_units_and_spacing(self):
        """DN x scaling metres; true ground spacing (projection scale k) rather than 20 m per pixel."""
        lat, lon = SITES["im2-athena"]
        f = plane_heights(lat, lon, 15.0, 120.0, h0=0.0)
        ras, (ci, cj) = synthetic(lat, lon, f, half=3, scaling=0.5)
        s, _ = sl.cell_slope(ras, ci, cj)
        self.assertAlmostEqual(s, 15.0, delta=1e-6)
        # Ignoring the 0.5 m DN scale would be grossly wrong
        wrong = th.Raster(name="x", n_full=N_FULL, scale_m=SCALE, scaling=1.0, dn=ras.dn, width=ras.width,
                          height=ras.height, i_first=ras.i_first, j_first=ras.j_first)
        self.assertGreater(abs(sl.cell_slope(wrong, ci, cj)[0] - 15.0), 10.0)
        # A naive planar Horn with 20 m map spacing misses the projection scale k (1.0021 at Athena)
        k = lola.stereo_scale_factor(lat)
        self.assertGreater(k, 1.002)
        z = lambda di, dj: ras.dn_at(ci + di, cj + dj) * ras.scaling  # noqa: E731
        gx = ((z(1, -1) + 2 * z(1, 0) + z(1, 1)) - (z(-1, -1) + 2 * z(-1, 0) + z(-1, 1))) / (8 * SCALE)
        gy = ((z(-1, 1) + 2 * z(0, 1) + z(1, 1)) - (z(-1, -1) + 2 * z(0, -1) + z(1, -1))) / (8 * SCALE)
        naive = math.degrees(math.atan(math.hypot(gx, gy)))
        self.assertGreater(abs(naive - 15.0), 0.02)
        self.assertLess(abs(naive - 15.0), 0.1)

    def test_nodata_and_boundary_cells_are_invalid_never_flat(self):
        lat, lon = SITES["connecting-ridge-cr1"]
        ras, (ci, cj) = synthetic(lat, lon, plane_heights(lat, lon, 8.0, 10.0), half=6)
        # boundary: the stencil leaves the window
        self.assertIsNone(sl.cell_slope(ras, ras.i_first, cj))
        self.assertIsNone(sl.cell_slope(ras, ci, ras.j_first + ras.height - 1))
        self.assertIsNotNone(sl.cell_slope(ras, ras.i_first + 1, cj))
        # explicit nodata: every cell whose 3x3 includes it is invalid
        ras2, _ = synthetic(lat, lon, plane_heights(lat, lon, 8.0, 10.0), half=6)
        hole = (ci + 2, cj - 1)
        ras2.dn[(hole[1] - ras2.j_first) * ras2.width + (hole[0] - ras2.i_first)] = -32768
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                self.assertIsNone(sl.cell_slope(ras2, hole[0] + di, hole[1] + dj, nodata_dn=-32768))
        self.assertAlmostEqual(sl.cell_slope(ras2, hole[0] + 2, hole[1], nodata_dn=-32768)[0], 8.0, delta=0.01)
        # in a grid: invalid cells are excluded from the valid statistics and reported
        g = sl.build_grid(ras2, lat, lon, (ci, cj), 80.0, nodata_dn=-32768)
        st = sl.grid_stats(g)
        self.assertEqual(st["cells_invalid"], sum(1 for s in g["state"] if s == sl.INVALID))
        self.assertGreater(st["cells_invalid"], 0)
        self.assertEqual(st["cells_valid"] + st["cells_invalid"], st["cells_in_footprint"])
        self.assertLess(st["valid_fraction"], 1.0)
        for k, s in enumerate(g["state"]):
            if s != sl.VALID:
                self.assertIsNone(g["slope"][k])
        # the plane is ~8 deg everywhere valid; nodata never pulled a value toward 0
        self.assertGreater(st["min_deg"], 7.9)


class Statistics(unittest.TestCase):
    def test_threshold_equality_is_not_an_exceedance(self):
        self.assertEqual(sl.exceed_fraction([1500, 1501, 1499], 15.0), 1 / 3)
        self.assertEqual(sl.exceed_fraction([1500], 15.0), 0.0)
        self.assertEqual(sl.exceed_fraction([29, 30], 0.29), 0.5)  # 0.29*100 is not exact in binary
        self.assertIsNone(sl.exceed_fraction([], 15.0))

    def test_nearest_rank_percentiles(self):
        v = list(range(1, 101))
        self.assertEqual(sl.nearest_rank(v, 50), 50)
        self.assertEqual(sl.nearest_rank(v, 95), 95)
        self.assertEqual(sl.nearest_rank([7], 95), 7)
        self.assertEqual(sl.nearest_rank([1, 2, 3, 4], 50), 2)
        self.assertIsNone(sl.nearest_rank([], 50))

    def test_area_weighted_denominator_is_valid_area_only(self):
        self.assertEqual(sl.exceed_fraction([1000, 2000], 15.0, [1.0, 3.0]), 0.75)

    def test_affine_fit_recovers_a_known_map(self):
        pts = [(x, z, 3 + 0.05 * x - 0.01 * z, -2 + 0.02 * x + 0.04 * z) for x in range(-5, 6) for z in range(-5, 6)]
        ca, cb = sl.fit_affine(pts)
        for got, want in zip(ca + cb, [3, 0.05, -0.01, -2, 0.02, 0.04]):
            self.assertAlmostEqual(got, want, places=9)


ASSETS = {s: REPO / "app" / "public" / "screening" / f"{s}.slope.json" for s in SITES}


@unittest.skipUnless(all(p.exists() for p in ASSETS.values()), "screening assets not exported")
class ExportedAssets(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.a = {s: json.loads(p.read_text("utf-8")) for s, p in ASSETS.items()}
        cls.cfg = json.loads(th.CONFIG.read_text("utf-8"))

    def test_identity_matches_config_export_and_render_asset(self):
        for sid, a in self.a.items():
            site = next(s for s in self.cfg["sites"] if s["id"] == sid)
            for k in ("id", "latitude_deg", "longitude_deg_east", "horizons_site_altitude_km"):
                self.assertEqual(a["site"][k], site[k])
            exp = json.loads((REPO / "app" / "public" / "data" / f"{sid}.json").read_text("utf-8"))
            self.assertAlmostEqual(a["observer"]["observer_radius_m"], exp["terrain_horizon"]["observer"]["observer_radius_m"], delta=1e-6)
            prod = next(p for p in exp["terrain_horizon"]["products"] if p["name"] == "LDEM_80S_20M")
            self.assertEqual(a["source_dem"]["sha256"], prod["sha256"])
            rm = json.loads((REPO / "app" / "public" / "render" / f"{sid}.terrain.json").read_text("utf-8"))
            self.assertEqual(a["source_dem"]["anchor_pixel_1based"], rm["source_dem"]["anchor_pixel_1based"])

    def test_consistent_footprints_and_method(self):
        a, b = self.a["im2-athena"], self.a["connecting-ridge-cr1"]
        self.assertEqual(a["footprint"]["radius_m"], 500.0)
        self.assertEqual(a["footprint"]["radius_m"], b["footprint"]["radius_m"])
        self.assertEqual(a["method"]["name"], b["method"]["name"])
        self.assertEqual(a["method"]["exceedance"], b["method"]["exceedance"])
        self.assertEqual(a["source_dem"]["product"], b["source_dem"]["product"])
        self.assertEqual(a["default_threshold_deg"], b["default_threshold_deg"])
        for x in (a, b):
            area = math.pi * x["footprint"]["radius_m"] ** 2
            cell = x["method"]["cell_ground_m"] ** 2
            self.assertLess(abs(x["footprint"]["cells_in_footprint"] - area / cell), 0.01 * area / cell)
            self.assertAlmostEqual(x["method"]["baseline_m"], 2 * x["method"]["cell_ground_m"], places=2)

    def test_grid_states_values_and_stats_agree(self):
        for sid, a in self.a.items():
            g = a["grid"]
            n = g["nx"]
            self.assertEqual(len(g["state"]), n * n)
            self.assertEqual(len(g["slope_centideg"]), n * n)
            vals = []
            for st, v in zip(g["state"], g["slope_centideg"]):
                self.assertIn(st, (0, 1, 2))
                if st == 1:
                    self.assertIsInstance(v, int)
                    self.assertGreaterEqual(v, 0)
                    vals.append(v)
                else:
                    self.assertIsNone(v)
            self.assertEqual(len(vals), a["footprint"]["cells_valid"])
            vals.sort()
            self.assertEqual(sl.nearest_rank(vals, 50) / 100, a["stats"]["median_deg"])
            self.assertEqual(sl.nearest_rank(vals, 95) / 100, a["stats"]["p95_deg"])
            # the footprint is centred on the observer cell, and state 0 means outside 500 m
            h = n // 2
            self.assertEqual(a["observer_cell"]["cell"], [h, h])
            self.assertEqual(g["state"][h * n + h], 1)
            self.assertEqual(g["state"][0], 0)

    def test_mapping_and_rings(self):
        for sid, a in self.a.items():
            m = a["grid"]["local_to_cell"]
            self.assertLess(m["max_residual_cells"], 0.01)  # < 0.2 m
            for cp in a["grid"]["check_points"]:
                x, _, z = cp["local_xyz"]
                ca = m["a"][0] + m["a"][1] * x + m["a"][2] * z
                cb = m["b"][0] + m["b"][1] * x + m["b"][2] * z
                self.assertEqual([round(ca), round(cb)], cp["cell"])
            rings = {r["radius_m"]: r for r in a["rings"]}
            self.assertEqual(sorted(rings), [100.0, 250.0, 500.0])
            self.assertTrue(rings[500.0]["is_analysis_boundary"])
            r_o = a["observer"]["observer_radius_m"]
            for rr, ring in rings.items():
                self.assertEqual(len(ring["points"]), 180)
                for x, y, z in ring["points"]:
                    # great-circle ground distance on the 1737.4 km sphere (the footprint's definition);
                    # the local horizontal distance is larger by about h/R (0.3 % at Athena)
                    self.assertLess(abs(R * math.atan2(math.hypot(x, z), r_o + y) - rr), 0.01)

    def test_evidence_matches_asset(self):
        for sid, a in self.a.items():
            ev = json.loads((REPO / "data" / "screening" / f"{sid}_slope_report.json").read_text("utf-8"))
            self.assertEqual(ev["asset_sha256"], __import__("sites").sha256(ASSETS[sid]))
            self.assertEqual(ev["stats"]["median_deg"], a["stats"]["median_deg"])
            for e in ev["stats"]["exceedance"]:
                self.assertLess(e["abs_difference"], 1e-3)  # equal-area weighting is justified


RASTER = lola.RAW_DIR / "ldem_80s_20m" / "ldem_80s_20m.img"


@unittest.skipUnless(RASTER.exists() and all(p.exists() for p in ASSETS.values()), "needs the LDEM_80S_20M raster")
class IndependentPlanarCrossCheck(unittest.TestCase):
    """A planar Horn on raw DN with ground spacing s/k must agree up to the terrain-radius
    factor (1 + h/R), which the 3D method includes and a planar method on the sphere does not."""

    def test_against_planar_horn(self):
        ras = th.Raster.from_files("LDEM_80S_20M", None)
        for sid, a in ASSETS.items():
            a = json.loads(a.read_text("utf-8"))
            g = a["grid"]
            n, I0, J0 = g["nx"], g["i0_pixel_1based"], g["j0_pixel_1based"]
            d = SCALE / lola.stereo_scale_factor(a["site"]["latitude_deg"])
            worst = 0.0
            for b in range(0, n, 3):
                for c in range(0, n, 3):
                    if g["state"][b * n + c] != 1:
                        continue
                    i, j = I0 + c, J0 + b
                    z = lambda di, dj: ras.dn_at(i + di, j + dj) * 0.5  # noqa: E731
                    gx = ((z(1, -1) + 2 * z(1, 0) + z(1, 1)) - (z(-1, -1) + 2 * z(-1, 0) + z(-1, 1))) / (8 * d)
                    gy = ((z(-1, 1) + 2 * z(0, 1) + z(1, 1)) - (z(-1, -1) + 2 * z(0, -1) + z(1, -1))) / (8 * d)
                    hc = z(0, 0)
                    planar = math.degrees(math.atan(math.hypot(gx, gy) * R / (R + hc)))
                    worst = max(worst, abs(planar - g["slope_centideg"][b * n + c] / 100))
            self.assertLess(worst, 0.011, sid)  # stored values are rounded to 0.01 deg


if __name__ == "__main__":
    unittest.main()
