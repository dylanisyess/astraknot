"""Convention checks on the committed exported files (no network, no LOLA files).

- Two-site Sun-direction consistency (0.001 deg; see direction_check.py for
  what it does and does not detect) with mirrored / west-longitude / time-shift
  controls showing the test is sensitive.
- Cardinal directions: azimuth clockwise from north (Sun moves east -> north ->
  west, i.e. azimuth decreases), Earth in the expected azimuth bands, and the
  local north/east frame mapped onto LOLA polar stereographic map bearings
  (map bearing = east longitude + azimuth, 0 deg longitude up, 90 deg E right).
"""
import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import direction_check as dc  # noqa: E402
import terrain_horizon as th  # noqa: E402

A = dc.load("im2-athena")
C = dc.load("connecting-ridge-cr1")


def wrap180(a):
    return (a + 180.0) % 360.0 - 180.0


class TwoSiteSunDirection(unittest.TestCase):
    def test_sun_direction_agrees_within_0_001_deg(self):
        d = dc.separations(A, C, "sun")
        self.assertEqual(len(d), 8641)
        self.assertLessEqual(max(d), dc.SUN_TOLERANCE_DEG)
        # the residual is the expected parallax (174 km / 1.47e8 km = 6.8e-5 deg), not zero by construction
        self.assertGreater(max(d), 1e-5)

    def test_wrong_conventions_fail_by_degrees(self):
        self.assertGreater(min(dc.separations(A, C, "sun", mirror=True)), 20.0)
        self.assertGreater(min(dc.separations(A, C, "sun", west_lon=True)), 20.0)

    def test_one_site_shifted_by_one_sample_fails(self):
        shifted = dict(C, samples=[dict(y, time_utc=x["time_utc"]) for x, y in zip(C["samples"], C["samples"][1:])])
        a = dict(A, samples=A["samples"][:-1])
        self.assertGreater(min(dc.separations(a, shifted, "sun")), 0.05)  # 10 min ~ 0.085 deg

    def test_swapped_site_metadata_fails(self):
        swapped = dict(C, site=A["site"])
        self.assertGreater(min(dc.separations(A, swapped, "sun")), 1.0)

    def test_earth_parallax_implies_lunar_distance(self):
        d = dc.separations(A, C, "earth")
        self.assertTrue(0.005 < min(d) and max(d) < 0.03, (min(d), max(d)))
        dist = dc.implied_earth_distances_km(A, C)
        lo, hi = dc.EARTH_DISTANCE_KM_RANGE
        self.assertTrue(lo <= min(dist) and max(dist) <= hi, (min(dist), max(dist)))


class CardinalDirections(unittest.TestCase):
    def test_sun_azimuth_decreases_every_step_at_both_sites(self):
        # Facing north, the Sun moves right to left (E -> N -> W): one synodic turn
        # (29.53 d) in 10-minute steps is 360 / 4252 = 0.0847 deg per step.
        for d in (A, C):
            s = d["samples"]
            steps = [wrap180(y["sun_azimuth_deg"] - x["sun_azimuth_deg"]) for x, y in zip(s, s[1:])]
            self.assertTrue(all(-0.09 < v < -0.08 for v in steps), (d["site"]["id"], min(steps), max(steps)))

    def test_earth_stays_in_expected_azimuth_band(self):
        # Earth sits near the sub-Earth direction (ME +X, longitude 0); from each site
        # that is map-up in the LOLA polar map, i.e. azimuth = 360 - site longitude.
        for d, (lo, hi) in ((A, (322.0, 339.0)), (C, (129.0, 146.0))):
            az = [x["earth_azimuth_deg"] for x in d["samples"]]
            self.assertTrue(lo <= min(az) and max(az) <= hi, (d["site"]["id"], min(az), max(az)))
            centre = (360.0 - d["site"]["longitude_deg_east"]) % 360.0
            self.assertLessEqual(abs(wrap180((lo + hi) / 2 - centre)), 10.0)

    def test_local_frame_is_right_handed_with_north_toward_the_north_pole(self):
        for site in (A["site"], C["site"]):
            e, n, u = dc.enu(site["latitude_deg"], site["longitude_deg_east"])
            cross = (e[1] * n[2] - e[2] * n[1], e[2] * n[0] - e[0] * n[2], e[0] * n[1] - e[1] * n[0])
            for x, y in zip(cross, u):
                self.assertAlmostEqual(x, y, places=12)  # east x north = up
            self.assertGreater(n[2], 0.0)  # north points toward +Z (away from the south pole)
            # the independent helper and the terrain march use the same frame
            for x, y in zip((e, n, u), th.enu(site["latitude_deg"], site["longitude_deg_east"])):
                for p, q in zip(x, y):
                    self.assertAlmostEqual(p, q, places=12)

    def test_map_bearing_equals_longitude_plus_azimuth(self):
        # Step 50 m from the site along each azimuth in the local tangent plane and
        # project with the terrain code's polar stereographic mapping.
        for site in (A["site"], C["site"]):
            lat, lon = site["latitude_deg"], site["longitude_deg_east"]
            e, n, u = th.enu(lat, lon)
            x0, y0 = th.stereo_xy(u)
            for az in (0.0, 90.0, 180.0, 270.0, 137.4):
                a, k = math.radians(az), 50.0 / th.R
                p = [u[i] + k * (math.cos(a) * n[i] + math.sin(a) * e[i]) for i in range(3)]
                norm = math.sqrt(sum(c * c for c in p))
                x1, y1 = th.stereo_xy(tuple(c / norm for c in p))
                bearing = math.degrees(math.atan2(x1 - x0, y1 - y0)) % 360.0  # clockwise from map-up
                self.assertLess(abs(wrap180(bearing - (lon + az))), 0.01, (site["id"], az, bearing))
        # CR1 example from the review: 222.6 + 137.4 = 360 -> map-up, toward the Earth side
        self.assertAlmostEqual((C["site"]["longitude_deg_east"] + 137.4) % 360.0, 0.0, places=9)


if __name__ == "__main__":
    unittest.main()
