"""Context terrain (display-only wide rings): geometry, crack-free nesting and committed assets."""
import hashlib
import json
import math
import struct
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import context_terrain as ct  # noqa: E402
import render_assets as render  # noqa: E402
import terrain_horizon as th  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
RENDER = ROOT / "app/public/render"
SITES = ["im2-athena", "connecting-ridge-cr1", "im1-odysseus", "apollo17-lm"]


class Geometry(unittest.TestCase):
    def test_closed_form_matches_observer_frame(self):
        for lat, lon in ((-84.79, 29.2), (20.19, 30.77), (-89.47, 222.6)):
            frame = render.Frame(lat, lon, th.R + 1234.5)
            for x, z, h in ((0, 0, 1233.5), (7680, -1920, 900.0), (-92160, 92160, -3600.0)):
                p = ct.unit_at((frame.e, frame.n, frame.u), x, z)
                ref = frame.local(tuple((th.R + h) * v for v in p))
                got = ct.local_position(x, z, h, th.R + 1234.5)
                self.assertLess(max(abs(a - b) for a, b in zip(ref, got)), 1e-6)

    def test_rim_snaps_to_the_coarser_edge(self):
        n_out, ratio, lo = 9, 4, 3  # inner 9x9 covers outer cells 3..5
        h_out = [float(i * 10 + j) for j in range(n_out) for i in range(n_out)]
        n_in = 2 * ratio + 1
        h_in = [0.0] * (n_in * n_in)
        snapped = ct.snap_to_outer(h_in, n_in, h_out, n_out, ratio, lo)
        self.assertEqual(snapped, 4 * (n_in - 1) - 8)  # rim vertices not on an outer vertex
        # midpoint of the bottom edge: halfway between outer (3,3) and (4,3)
        self.assertAlmostEqual(h_in[0 * n_in + 2], (h_out[3 * n_out + 3] + h_out[3 * n_out + 4]) / 2)
        # left edge, three quarters along
        self.assertAlmostEqual(h_in[3 * n_in + 0], h_out[3 * n_out + 3] + 0.75 * (h_out[4 * n_out + 3] - h_out[3 * n_out + 3]))
        self.assertEqual(h_in[n_in * n_in // 2], 0.0)  # interior untouched


class CommittedAssets(unittest.TestCase):
    def test_each_site_is_bound_to_its_detailed_mesh_and_complete(self):
        for sid in SITES:
            m = json.loads((RENDER / f"{sid}.context.json").read_text("utf-8"))
            nearm = json.loads((RENDER / f"{sid}.terrain.json").read_text("utf-8"))
            blob = (RENDER / m["bin_file"]).read_bytes()
            self.assertEqual(hashlib.sha256(blob).hexdigest(), m["bin_sha256"])
            self.assertEqual(m["detailed_mesh"]["bin_sha256"], nearm["bin_sha256"])
            self.assertEqual(m["site"], nearm["site"])
            self.assertEqual(m["observer"]["observer_radius_m"], nearm["observer"]["observer_radius_m"])
            self.assertEqual(len(blob), m["counts"]["bin_bytes"])
            for lv, (spacing, half) in zip(m["levels"], ct.LEVELS):
                self.assertEqual((lv["spacing_m"], lv["half_width_m"]), (spacing, half))
                self.assertEqual(lv["nodata_vertices"], 0)
                h = struct.unpack_from(f"<{lv['vertex_count']}f", blob, lv["byte_offset"])
                self.assertTrue(all(math.isfinite(v) for v in h))
                c = (lv["nx"] - 1) // 2
                # the site point is the DEM surface under the observer
                self.assertAlmostEqual(h[c * lv["nx"] + c], nearm["observer"]["dem_surface_at_site_m"], places=2)


if __name__ == "__main__":
    unittest.main()
