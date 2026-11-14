"""Projection / bounds tests for pipeline/lola.py (uses committed PDS labels;
no network). Orientation itself is verified against real data by
terrain_check.py (check 'orientation')."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import lola  # noqa: E402

LBL = lola.load_label("LDEM_80S_20M")  # cached label in data/terrain/labels/


class PolarProjection(unittest.TestCase):
    def test_round_trip(self):
        for lat, lon in [(-84.7906, 29.1957), (-89.9, 200.0), (-80.5, 359.5), (-76.0, 135.0)]:
            fi, fj = lola.polar_inverse(LBL, lat, lon)
            la, lo = lola.polar_forward(LBL, fi, fj)
            self.assertAlmostEqual(la, lat, places=9)
            self.assertAlmostEqual((lo - lon + 180) % 360 - 180, 0.0, places=9)

    def test_pole_is_centre(self):
        c = LBL.samples / 2 + 0.5
        lat, _ = lola.polar_forward(LBL, c, c)
        self.assertAlmostEqual(lat, -90.0)

    def test_orientation_matches_catalog_description(self):
        # "In the south, Longitude 0 extends straight up from the center, and
        #  Longitude 90 East extends to the right."
        c = LBL.samples / 2 + 0.5
        i0, j0 = lola.polar_inverse(LBL, -85.0, 0.0)
        i90, j90 = lola.polar_inverse(LBL, -85.0, 90.0)
        self.assertAlmostEqual(i0, c, places=6)
        self.assertLess(j0, c)        # up = smaller line number
        self.assertGreater(i90, c)    # right = larger sample number
        self.assertAlmostEqual(j90, c, places=6)

    def test_actual_bounds_of_80s_grid(self):
        b = lola.polar_bounds(LBL)
        self.assertAlmostEqual(b["map_half_width_km"], 304.0)
        self.assertAlmostEqual(b["lat_at_edge_midpoints_deg"], -80.0, delta=0.01)
        self.assertLess(b["lat_at_corners_deg"], -75.8)  # corners extend well past 80 S

    def test_site_inside_80s_and_85s_but_not_875s(self):
        for name, expect in [("LDEM_80S_20M", True), ("LDEM_85S_20M", True), ("LDEM_875S_20M", False)]:
            lbl = lola.load_label(name)
            fi, fj = lola.polar_inverse(lbl, -84.7906, 29.1957)
            inside = 0.5 <= fi <= lbl.samples + 0.5 and 0.5 <= fj <= lbl.lines + 0.5
            self.assertEqual(inside, expect, name)


class GridEdges(unittest.TestCase):
    def test_outside_file_is_none_not_flat(self):
        g = lola.Grid.__new__(lola.Grid)
        g.lbl = lola.load_label("LDEM_75S_240M")
        g.dn = [10] * (g.lbl.lines * g.lbl.samples)
        self.assertEqual(g.height_bilinear(2.0, 2.0), 5.0)
        self.assertIsNone(g.height_bilinear(0.6, 2.0))       # neighbour outside
        self.assertIsNone(g.height_bilinear(g.lbl.samples + 0.2, 5.0))


if __name__ == "__main__":
    unittest.main()
