"""Unit tests with SYNTHETIC fixtures. They test code behaviour only and do not
validate real lunar conditions.

    python -m unittest discover -s pipeline/tests -v
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import horizons as hz  # noqa: E402
import visibility as vis  # noqa: E402

FLAT = vis.smooth_horizon(0)


def sample(t, saz, sel, eaz, eel):
    return {"time_utc": t, "sun_azimuth_deg": saz, "sun_elevation_deg": sel,
            "earth_azimuth_deg": eaz, "earth_elevation_deg": eel}


T = ["2030-01-01T00:00:00Z", "2030-01-01T00:10:00Z", "2030-01-01T00:20:00Z", "2030-01-01T00:30:00Z"]


class Azimuth(unittest.TestCase):
    def test_359_to_1_crosses_zero(self):
        self.assertAlmostEqual(vis.interp_azimuth(359.0, 1.0, 0.5), 0.0)
        self.assertAlmostEqual(vis.interp_azimuth(1.0, 359.0, 0.5), 0.0)
        self.assertAlmostEqual(vis.interp_azimuth(359.0, 1.0, 0.25), 359.5)

    def test_horizon_wraps_across_north(self):
        h_az, h_el = [10.0, 350.0], [2.0, 4.0]
        self.assertAlmostEqual(vis.horizon_elevation(0.0, h_az, h_el), 3.0)
        self.assertAlmostEqual(vis.horizon_elevation(180.0, h_az, h_el), 3.0)

    def test_unknown_sector(self):
        self.assertIsNone(vis.horizon_elevation(45.0, [0.0, 90.0], [0.0, None]))


class Intervals(unittest.TestCase):
    def test_all_visible_merges_to_one(self):
        s = [sample(t, 100, 5, 200, 5) for t in T]
        iv = vis.classify(s, FLAT)
        self.assertEqual(len(iv), 1)
        self.assertEqual((iv[0]["start_utc"], iv[0]["end_utc"]), (T[0], T[-1]))
        self.assertTrue(iv[0]["sun_visible"] and iv[0]["earth_visible"])

    def test_all_dark(self):
        iv = vis.classify([sample(t, 100, -5, 200, -5) for t in T], FLAT)
        self.assertEqual(len(iv), 1)
        self.assertIs(iv[0]["sun_visible"], False)

    def test_unknown_not_merged_into_dark(self):
        s = [sample(T[0], 100, -5, 200, 5), sample(T[1], 100, -5, 200, 5),
             sample(T[2], None, None, 200, 5), sample(T[3], 100, -5, 200, 5)]
        iv = vis.classify(s, FLAT)
        self.assertEqual([x["sun_visible"] for x in iv], [False, None])
        self.assertEqual(iv[1]["start_utc"], T[1])
        self.assertEqual(iv[-1]["end_utc"], T[-1])

    def test_midpoint_strictly_above(self):
        # midpoint elevation exactly 0 -> not visible
        iv = vis.classify([sample(T[0], 0, -1, 0, 1), sample(T[1], 0, 1, 0, 1)], FLAT)
        self.assertIs(iv[0]["sun_visible"], False)

    def test_step(self):
        s = [sample(t, 0, 0, 0, 0) for t in T]
        self.assertTrue(vis.step_ok(s, 600))
        self.assertFalse(vis.step_ok(s[:2] + s[3:], 600))


SYNTH = """header text
*******************************************************************************
 Date__(UT)__HR:MN:SS, , ,Azimuth_(a-app), Elevation_(a-app),
*************************************************************
$$SOE
 2030-Jan-01 00:00:00,*,i,  359.900000000,      -0.500000000,
 2030-Jan-01 00:10:00, , ,       n.a.,       n.a.,
$$EOE
"""


class Parsing(unittest.TestCase):
    def test_parse(self):
        rows = hz.parse_azel(SYNTH)
        self.assertEqual([r.time_utc for r in rows], ["2030-01-01T00:00:00Z", "2030-01-01T00:10:00Z"])
        self.assertEqual(rows[0].azimuth_deg, 359.9)
        self.assertEqual(rows[0].elevation_deg, -0.5)
        self.assertIsNone(rows[1].azimuth_deg)  # n.a. -> None, never 0

    def test_rejects_refracted(self):
        with self.assertRaises(hz.HorizonsError):
            hz.parse_azel(SYNTH.replace("a-app", "r-app"))

    def test_time(self):
        self.assertEqual(hz.parse_cal_time("2026-Dec-02 00:00:00.000"), "2026-12-02T00:00:00Z")
        with self.assertRaises(ValueError):
            hz.parse_cal_time("2026-Dec-02 00:00:00.500")



class Chunking(unittest.TestCase):
    def test_chunks_tile_the_interval_with_shared_endpoints(self):
        c = hz.chunk_ranges("2026-12-01T00:00:00Z", "2027-01-30T00:00:00Z", 10)
        self.assertEqual(len(c), 6)
        self.assertEqual(c[0][0], "2026-12-01T00:00:00Z")
        self.assertEqual(c[-1][1], "2027-01-30T00:00:00Z")
        for a, b in zip(c, c[1:]):
            self.assertEqual(a[1], b[0])

    def test_uneven_last_chunk(self):
        c = hz.chunk_ranges("2030-01-01T00:00:00Z", "2030-01-25T00:00:00Z", 10)
        self.assertEqual(c[-1], ("2030-01-21T00:00:00Z", "2030-01-25T00:00:00Z"))

    def _rows(self, times, el):
        return [hz.AzElRow(t, 10.0, e, f"{t},{e}") for t, e in zip(times, el)]

    def test_merge_drops_identical_boundary_duplicate(self):
        a = self._rows(["T0", "T1"], [1.0, 2.0])
        b = self._rows(["T1", "T2"], [2.0, 3.0])
        self.assertEqual([r.time_utc for r in hz.merge_chunks([a, b])], ["T0", "T1", "T2"])

    def test_merge_refuses_conflicting_boundary(self):
        a = self._rows(["T0", "T1"], [1.0, 2.0])
        b = self._rows(["T1", "T2"], [2.5, 3.0])  # same time, different value
        with self.assertRaises(hz.HorizonsError):
            hz.merge_chunks([a, b])

    def test_merge_refuses_gap(self):
        a = self._rows(["T0", "T1"], [1.0, 2.0])
        b = self._rows(["T2", "T3"], [3.0, 4.0])
        with self.assertRaises(hz.HorizonsError):
            hz.merge_chunks([a, b])


class Retry(unittest.TestCase):
    def test_retry_policy_only_for_transient_codes(self):
        self.assertTrue({429, 503}.issubset(hz.RETRY_STATUS))
        self.assertNotIn(400, hz.RETRY_STATUS)  # bad request is deterministic: never retried


class CylindricEcho(unittest.TestCase):
    """Echo strings copied from the cached Horizons responses (header text, not ephemeris data)."""

    def test_echo_equals_submitted_point_at_printed_precision(self):
        import validate
        athena = {"latitude_deg": -84.7906, "horizons_site_altitude_km": 5.3229}
        cr1 = {"latitude_deg": -89.468, "horizons_site_altitude_km": 1.9428}
        ok, detail = validate.cylindric_echo_matches(
            "29.1957, 158.23221, -1735.5246 {E-lon(deg),Dxy(km),Dz(km)}", athena)
        self.assertTrue(ok, detail)
        # near the pole Dz is printed to 1e-3 km: |r| is 177 mm off, yet the echo is exact to its digits
        ok, detail = validate.cylindric_echo_matches(
            "222.6, 16.14983, -1739.268      {E-lon(deg),Dxy(km),Dz(km)}", cr1)
        self.assertTrue(ok, detail)

    def test_wrong_altitude_detected(self):
        import validate
        ok, _ = validate.cylindric_echo_matches(
            "222.6, 16.14983, -1739.268 {E-lon(deg),Dxy(km),Dz(km)}",
            {"latitude_deg": -89.468, "horizons_site_altitude_km": 1.9418})  # 1 m lower
        self.assertFalse(ok)


if __name__ == "__main__":
    unittest.main()
