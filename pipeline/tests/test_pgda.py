"""SYNTHETIC GeoTIFF tests for pipeline/pgda.py: header parsing, pixel-centre convention
and the mapping onto terrain_horizon.Raster's pole-centred grid. Code behaviour only."""
import struct
import sys
import tempfile
import unittest
from array import array
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import pgda  # noqa: E402
import terrain_horizon as th  # noqa: E402


def write_tiff(path: Path, w: int, h: int, values: list[float], x0: float, y0: float, s: float,
               raster_type: int = 1) -> None:
    """Minimal little-endian, uncompressed float32, one-row-per-strip GeoTIFF."""
    data = array("f", values).tobytes()
    geokeys = [1, 1, 0, 2, 1024, 0, 1, 1, 1025, 0, 1, raster_type]
    entries = []  # (tag, type, count, payload bytes)
    row = w * 4
    n_entries = 13
    ifd_size = 2 + 12 * n_entries + 4
    extra_start = 8 + ifd_size
    extra = b""

    def put(tag, typ, fmt, vals):
        nonlocal extra
        raw = struct.pack("<" + fmt * len(vals), *vals)
        if len(raw) <= 4:
            entries.append((tag, typ, len(vals), raw.ljust(4, b"\0")))
        else:
            entries.append((tag, typ, len(vals), struct.pack("<I", extra_start + len(extra))))
            extra += raw
            if len(extra) % 2:
                extra += b"\0"

    data_off_placeholder = len(entries)
    put(256, 3, "H", [w]); put(257, 3, "H", [h]); put(258, 3, "H", [32]); put(259, 3, "H", [1])
    put(262, 3, "H", [1]); put(273, 4, "I", [0] * h); put(277, 3, "H", [1]); put(278, 3, "H", [1])
    put(279, 4, "I", [row] * h); put(339, 3, "H", [3]); put(33550, 12, "d", [s, s, 0.0])
    put(33922, 12, "d", [0, 0, 0, x0, y0, 0]); put(34735, 3, "H", geokeys)
    data_start = extra_start + len(extra)
    # patch strip offsets now that the data start is known
    strip_entry = entries[5]
    off = struct.unpack("<I", strip_entry[3])[0] - extra_start
    extra = extra[:off] + struct.pack("<" + "I" * h, *[data_start + k * row for k in range(h)]) + extra[off + 4 * h:]
    del data_off_placeholder
    ifd = struct.pack("<H", n_entries) + b"".join(struct.pack("<HHI", t, ty, c) + p for t, ty, c, p in entries) + b"\0" * 4
    path.write_bytes(b"II" + struct.pack("<HI", 42, 8) + ifd + extra + data)


class GeoTiffReader(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "t.tif"
        # 4 x 3 grid, value = 10 * row + col, tiepoint (outer corner) at X0 = -100, Y0 = -40, 5 m pixels
        self.vals = [10.0 * r + c for r in range(3) for c in range(4)]
        write_tiff(self.path, 4, 3, self.vals, -100.0, -40.0, 5.0)

    def tearDown(self):
        self.tmp.cleanup()

    def test_header_and_pixel_centres(self):
        g = pgda.GeoTiff(self.path)
        self.assertEqual((g.width, g.height, g.code, g.raster_type, g.dc), (4, 3, "f", 1, 0.5))
        self.assertEqual(g.centre(0, 0), (-97.5, -42.5))  # PixelIsArea: centre = corner + half a pixel
        self.assertEqual(g.at(3, 2), 23.0)
        c, r = g.frac_index(-97.5 + 5 * 2, -42.5 - 5 * 1)
        self.assertAlmostEqual(c, 2.0)
        self.assertAlmostEqual(r, 1.0)
        g.close()

    def test_pole_grid_reproduces_centres_in_ray_march_raster(self):
        g = pgda.GeoTiff(self.path)
        n, i1, j1 = pgda._pole_grid(g.x0, g.y0, g.sx, g.dc, g.width, g.height)
        ra = th.Raster(name="t", n_full=n, scale_m=5.0, scaling=1.0, dn=array("f", self.vals), width=4,
                       height=3, i_first=i1, j_first=j1)
        for r in range(3):
            for c in range(4):
                X, Y = g.centre(c, r)
                v = ra.height_bilinear(*ra.pixel_of(X, Y))
                if c == 3 or r == 2:  # bilinear stencil needs the next column/row: outside -> None
                    self.assertIsNone(v)
                else:
                    self.assertAlmostEqual(v, 10.0 * r + c, places=9)
        # midway between columns 1 and 2 of row 0
        X, Y = g.centre(1.5, 0)
        self.assertAlmostEqual(ra.height_bilinear(*ra.pixel_of(X, Y)), 1.5, places=9)
        g.close()

    def test_off_lattice_grid_rejected(self):
        with self.assertRaises(ValueError):
            pgda._pole_grid(-101.0, -40.0, 5.0, 0.5, 4, 3)


if __name__ == "__main__":
    unittest.main()
