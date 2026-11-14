"""Terrain-horizon geometry tests with SYNTHETIC terrain (no network, no LOLA
files). They test the ray march, projection hand-off, stopping rule and
orientation; they do not validate real lunar terrain.

Synthetic rasters reuse the real LDEM_80S_20M / LDEM_75S_60M grid geometry
(polar stereographic, 20 m / 60 m at the pole) around the real site, but hold
invented heights. Walls are placed with plain latitude/longitude arithmetic
and an independent inverse projection written here, not with the march's
own vector formulas.
"""
import array
import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import lola  # noqa: E402
import terrain_horizon as th  # noqa: E402
import visibility as vis  # noqa: E402

R = lola.R_REF_M
SITE_LAT, SITE_LON = -84.7906, 29.1957


def pixel_center_latlon(n_full, s, i, j):
    """Independent inverse of the polar grid (dsmap_polar.cat forward equations)."""
    x = (i - n_full / 2 - 0.5) * s
    y = -(j - n_full / 2 - 0.5) * s
    lat = -90.0 + math.degrees(2 * math.atan(0.5 * math.hypot(x, y) / R))
    return lat, math.degrees(math.atan2(x, y)) % 360.0


def gc_dist(lat1, lon1, lat2, lon2):
    p1, p2, dl = math.radians(lat1), math.radians(lat2), math.radians(lon2 - lon1)
    c = math.sin(p1) * math.sin(p2) + math.cos(p1) * math.cos(p2) * math.cos(dl)
    return R * math.acos(max(-1.0, min(1.0, c)))


def make_raster(name, n_full, s, half_px, walls=(), center=(SITE_LAT, SITE_LON), ramp=None):
    """Zero-height window around `center`; walls = [(lat, lon, radius_m, height_m)];
    ramp = (slope_deg, length_m): plane rising toward north from the centre."""
    lbl = lola.load_label("LDEM_80S_20M")  # only for its polar_inverse formula
    fi, fj = lola.polar_inverse(lbl, *center)
    fi = (fi - 15200.5) * (lbl.map_scale_m / s) + n_full / 2 + 0.5  # rescale to this grid
    fj = (fj - 15200.5) * (lbl.map_scale_m / s) + n_full / 2 + 0.5
    i_first, j_first = round(fi) - half_px, round(fj) - half_px
    w = h = 2 * half_px + 1
    dn = array.array("h", bytes(2 * w * h))
    for (wlat, wlon, rad, height) in walls:
        wi, wj = lola.polar_inverse(lbl, wlat, wlon)
        wi = (wi - 15200.5) * (lbl.map_scale_m / s) + n_full / 2 + 0.5
        wj = (wj - 15200.5) * (lbl.map_scale_m / s) + n_full / 2 + 0.5
        rp = int(rad / s) + 3
        for j in range(round(wj) - rp, round(wj) + rp + 1):
            for i in range(round(wi) - rp, round(wi) + rp + 1):
                c, r = i - i_first, j - j_first
                if 0 <= c < w and 0 <= r < h:
                    plat, plon = pixel_center_latlon(n_full, s, i, j)
                    if gc_dist(plat, plon, wlat, wlon) <= rad:
                        dn[r * w + c] = round(height / 0.5)
    if ramp:
        slope, length = ramp
        for r in range(h):
            for c in range(w):
                plat, _ = pixel_center_latlon(n_full, s, c + i_first, r + j_first)
                north = (plat - center[0]) * math.pi / 180 * R  # metres north of centre
                dn[r * w + c] = round(math.tan(math.radians(slope)) * max(-length, min(length, north)) / 0.5)
    return th.Raster(name=name, n_full=n_full, scale_m=s, scaling=0.5, dn=dn, width=w, height=h,
                     i_first=i_first, j_first=j_first)


def north_of(lat, lon, d):
    return lat + math.degrees(d / R), lon


def obs_at(height_m, lat=SITE_LAT, lon=SITE_LON):
    return th.Observer(lat, lon, R + height_m)


class Projection(unittest.TestCase):
    def test_vector_projection_equals_lola_polar_inverse(self):
        lbl = lola.load_label("LDEM_80S_20M")
        ra = th.Raster(name="x", n_full=lbl.samples, scale_m=lbl.map_scale_m, scaling=0.5, dn=[], width=0, height=0)
        for lat, lon in [(SITE_LAT, SITE_LON), (-80.1, 300.0), (-89.99, 10.0), (-76.0, 135.0), (-85.0, 359.99)]:
            a = ra.pixel_of(*th.stereo_xy(th.unit(lat, lon)))
            b = lola.polar_inverse(lbl, lat, lon)
            self.assertAlmostEqual(a[0], b[0], places=6)
            self.assertAlmostEqual(a[1], b[1], places=6)

    def test_schedule(self):
        d = th.schedule()
        self.assertEqual(d[0], th.D_MIN_M)
        self.assertAlmostEqual(d[1] - d[0], th.NEAR_STEP_M)
        self.assertAlmostEqual(d[-1] - d[-2], th.FAR_STEP_M)
        self.assertTrue(all(b > a for a, b in zip(d, d[1:])))


class SphereDip(unittest.TestCase):
    """Smooth sphere: horizon must equal -arccos(R / (R + H)) (curvature once)."""

    def test_sphere_dip_matches_analytic(self):
        ra = make_raster("SYN20", 30400, 20.0, 450)  # +/- 9 km of zero height
        dists = th.schedule()
        for H in (1.0, 10.0):
            exp = th.sphere_dip_deg(R + H)
            for az in (0.0, 45.0, 90.0, 135.0, 180.0, 225.0, 270.0, 315.0):
                r = th.march(obs_at(H), az, [ra], dists, h_max=0.0)
                self.assertEqual(r["status"], "stopped")
                self.assertAlmostEqual(r["elevation_deg"], exp, delta=2e-5, msg=f"H={H} az={az}")
                # tangent point at sqrt(2 R H)
                self.assertAlmostEqual(r["distance_m"], math.sqrt(2 * R * H), delta=25.0)
        # 1 m observer: 0.0615 deg; counting curvature twice would give about 0.087 deg
        self.assertAlmostEqual(th.sphere_dip_deg(R + 1.0), -0.06148, places=4)

    def test_negative_horizon_not_clamped(self):
        ra = make_raster("SYN20", 30400, 20.0, 300)
        r = th.march(obs_at(1.0), 10.0, [ra], th.schedule(), h_max=0.0)
        self.assertLess(r["elevation_deg"], 0.0)

    def test_unknown_when_ray_leaves_every_raster(self):
        ra = make_raster("SYN20", 30400, 20.0, 100)  # +/- 2 km only
        r = th.march(obs_at(1.0), 0.0, [ra], th.schedule(), h_max=10873.0)
        self.assertEqual(r["status"], "exited")
        self.assertIsNone(r["elevation_deg"])


class Obstruction(unittest.TestCase):
    def test_wall_direction_angle_and_distance(self):
        # In wall-free directions the stopping rule for h_max = 100 m needs ~20.5 km of
        # terrain (a 100 m point drops below the -0.06 deg sphere dip), so the raster
        # spans +/- 23 km.
        d0, rad, hw = 2000.0, 150.0, 100.0
        wlat, wlon = north_of(SITE_LAT, SITE_LON, d0)
        ra = make_raster("SYN20", 30400, 20.0, 1150, walls=[(wlat, wlon, rad, hw)])
        dists = th.schedule()
        r = th.march(obs_at(1.0), 0.0, [ra], dists, h_max=hw)
        # Analytic: the nearest wall edge at d0 - rad. The rasterised edge (pixel centres
        # inside the radius) plus the one-pixel bilinear ramp, on a grid rotated ~29 deg
        # from local north, can move the full-height point by up to ~1.5 px (30 m).
        near = d0 - rad
        hi = th.elevation_deg(R + 1.0, R + hw, (near - 30) / R)
        lo = th.elevation_deg(R + 1.0, R + hw, (near + 30) / R)
        self.assertTrue(lo <= r["elevation_deg"] <= hi, (lo, r["elevation_deg"], hi))
        self.assertAlmostEqual(r["distance_m"], near, delta=35.0)
        self.assertAlmostEqual(r["lon_deg"], SITE_LON, places=6)
        self.assertGreater(r["lat_deg"], SITE_LAT)  # north = away from the south pole
        # outside the wall's angular half-width (atan(150/2000) = 4.3 deg) only the sphere remains
        for az in (10.0, 90.0, 180.0, 270.0, 350.0):
            e = th.march(obs_at(1.0), az, [ra], dists, h_max=hw)["elevation_deg"]
            self.assertAlmostEqual(e, th.sphere_dip_deg(R + 1.0), delta=1e-4, msg=f"az {az}")

    def test_cardinal_orientation(self):
        """Walls placed by lat/lon only: N = higher latitude, S = toward the pole,
        E = larger east longitude at the same latitude, W = smaller."""
        d0 = 2000.0  # 60 m walls: the stopping rule needs ~16.3 km, raster spans +/- 19 km
        dlon = math.degrees(d0 / (R * math.cos(math.radians(SITE_LAT))))
        cases = {"N": (north_of(SITE_LAT, SITE_LON, d0), 0.0),
                 "S": (north_of(SITE_LAT, SITE_LON, -d0), 180.0),
                 "E": ((SITE_LAT, SITE_LON + dlon), 90.0),
                 "W": ((SITE_LAT, SITE_LON - dlon), 270.0)}
        dists = th.schedule()
        for name, ((wlat, wlon), expect) in cases.items():
            ra = make_raster("SYN20", 30400, 20.0, 950, walls=[(wlat, wlon, 100.0, 60.0)])
            prof = [(az, th.march(obs_at(1.0), az, [ra], dists, h_max=60.0)["elevation_deg"])
                    for az in range(0, 360, 2)]
            self.assertTrue(all(e is not None for _, e in prof), name)
            best = max(prof, key=lambda p: p[1])[0]
            off = (best - expect + 180) % 360 - 180
            # a parallel of latitude bends toward the pole, so E/W sit a little off 90/270
            self.assertLessEqual(abs(off), 3.0, f"{name}: max at {best}, expected {expect}")

    def test_seam_359_to_0(self):
        wlat, wlon = north_of(SITE_LAT, SITE_LON, 2000.0)
        ra = make_raster("SYN20", 30400, 20.0, 950, walls=[(wlat, wlon, 100.0, 60.0)])
        dists = th.schedule()
        azs = [0.0, 0.1, 0.2, 359.8, 359.9, 6.0, 354.0]
        e = {az: th.march(obs_at(1.0), az, [ra], dists, h_max=60.0)["elevation_deg"] for az in azs}
        # symmetric about north to within the wall's 20 m pixel quantisation (~0.03 deg here)
        self.assertAlmostEqual(e[0.1], e[359.9], delta=0.06)
        self.assertAlmostEqual(e[0.2], e[359.8], delta=0.06)
        self.assertGreater(e[0.0], 1.5)
        self.assertAlmostEqual(e[6.0], th.sphere_dip_deg(R + 1.0), delta=1e-4)  # clear of the wall
        self.assertAlmostEqual(e[354.0], th.sphere_dip_deg(R + 1.0), delta=1e-4)
        prof_az = sorted(e)
        h = vis.horizon_elevation(359.95, prof_az, [e[a] for a in prof_az])
        self.assertAlmostEqual(h, (e[359.9] + e[0.0]) / 2, places=9)


class ProductTransition(unittest.TestCase):
    def test_near_field_priority_then_far_field(self):
        # near: 20 m grid, +/- 2 km of zeros. far: 60 m grid, +/- 18 km with two 60 m walls:
        #  - 6 km north (outside the near grid): must be found in the far product;
        #  - 1 km south (inside the near grid): must be ignored, near data has priority.
        wn = north_of(SITE_LAT, SITE_LON, 6000.0)
        ws = north_of(SITE_LAT, SITE_LON, -1000.0)
        near = make_raster("NEAR20", 30400, 20.0, 100)
        far = make_raster("FAR60", 15248, 60.0, 300, walls=[(*wn, 300.0, 60.0), (*ws, 200.0, 60.0)])
        dists = th.schedule()
        rn = th.march(obs_at(1.0), 0.0, [near, far], dists, h_max=60.0)
        self.assertEqual(rn["product"], "FAR60")
        self.assertAlmostEqual(rn["distance_m"], 6000.0 - 300.0, delta=70.0)
        rs = th.march(obs_at(1.0), 180.0, [near, far], dists, h_max=60.0)
        self.assertEqual(rs["status"], "stopped")
        self.assertLess(rs["elevation_deg"], 0.0)  # the far-grid wall inside the near grid is not used


class ObserverCell(unittest.TestCase):
    def test_sloped_ground_no_false_obstruction(self):
        """Plane rising 2 deg toward north for 1 km, observer 1 m above it. The first
        samples (5 m) are below the eye, so the observer's own cell sets nothing; the
        uphill horizon approaches the slope from below, set at the ramp top."""
        slope, length = 2.0, 1000.0
        ra = make_raster("SYN20", 30400, 20.0, 120, ramp=(slope, length))
        top = math.tan(math.radians(slope)) * length
        dists = th.schedule(d_max=2300.0)
        up = th.march(obs_at(1.0), 0.0, [ra], dists, h_max=top + 1)
        self.assertGreater(up["distance_m"], 900.0)
        exp = math.degrees(math.atan((top - 1.0) / length))  # ignoring 0.03 deg of curvature
        self.assertAlmostEqual(up["elevation_deg"], exp, delta=0.06)
        for az in range(0, 360, 15):
            r = th.march(obs_at(1.0), float(az), [ra], dists, h_max=top + 1)
            if r["elevation_deg"] is not None:
                self.assertGreater(r["distance_m"], 20.0, f"az {az} set inside the observer's cell")


class HorizonLookup(unittest.TestCase):
    def test_bisect_lookup_equals_linear_reference(self):
        import random
        rnd = random.Random(4)
        az = [round(0.1 * k, 1) for k in range(3600)]
        el = [rnd.uniform(-2, 4) for _ in az]
        el[17] = None
        for _ in range(3000):
            a = rnd.uniform(0, 360)
            self.assertEqual(vis.horizon_elevation(a, az, el), vis._horizon_elevation_linear(a, az, el))
        for a in (0.0, 359.95, 359.999999, 1.75, 0.05):
            self.assertEqual(vis.horizon_elevation(a, az, el), vis._horizon_elevation_linear(a, az, el))
        # Exactly on a profile azimuth the sample's own value is used, even when a
        # neighbouring sample is unknown (the old linear scan returned None at 1.8).
        self.assertEqual(vis.horizon_elevation(1.8, az, el), el[18])
        self.assertEqual(vis.horizon_elevation(1.6, az, el), el[16])  # next sample unknown
        self.assertIsNone(vis.horizon_elevation(1.7, az, el))
        self.assertIsNone(vis.horizon_elevation(1.65, az, el))
        self.assertIsNone(vis.horizon_elevation(1.75, az, el))


if __name__ == "__main__":
    unittest.main()
