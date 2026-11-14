"""Cache-only preparation: no requests, downloads or invented seam statistics."""
import struct
import sys
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import lola
import terrain_check


class CachedTerrain(unittest.TestCase):
    def test_local_img_subwindow_matches_signed_and_unsigned_pixels(self):
        base = lola.load_label("LDEM_80S_20M")
        with tempfile.TemporaryDirectory() as directory, patch.object(lola, "RAW_DIR", Path(directory)), \
                patch.object(lola, "OFFLINE", True), patch.object(lola, "_get") as network:
            for name, bits, values, fmt in (("LDEM_TEST", 16, [-5, -2, 0, 1, 2, 3], "<6h"),
                                            ("LDEC_TEST", 8, [0, 128, 255, 3, 4, 5], "6B")):
                with self.subTest(name=name):
                    label = replace(base, name=name, samples=3, lines=2, sample_bits=bits)
                    path = Path(directory) / name.lower() / f"{name.lower()}.img"
                    path.parent.mkdir()
                    path.write_bytes(struct.pack(fmt, *values))
                    self.assertEqual(lola.read_window(label, 2, 3, 1, 2), [values[1:3], values[4:6]])
            network.assert_not_called()
            self.assertFalse((Path(directory) / "windows").exists())

    def test_missing_offline_range_and_head_fail_without_network(self):
        label = lola.load_label("LDEM_80S_20M")
        with tempfile.TemporaryDirectory() as directory, patch.object(lola, "RAW_DIR", Path(directory)), \
                patch.object(lola, "OFFLINE", True), patch.object(lola.urllib.request, "urlopen") as network:
            with self.assertRaisesRegex(RuntimeError, "Offline"):
                lola.read_window(label, 1, 2, 1, 2)
            with self.assertRaisesRegex(RuntimeError, "Offline"):
                lola.head_size(label.url)
            network.assert_not_called()

    def test_incomplete_local_img_is_rejected_without_download(self):
        label = replace(lola.load_label("LDEM_80S_20M"), samples=3, lines=2)
        with tempfile.TemporaryDirectory() as directory, patch.object(lola, "RAW_DIR", Path(directory)), \
                patch.object(lola, "_get") as network:
            path = Path(directory) / label.name.lower() / f"{label.name.lower()}.img"
            path.parent.mkdir()
            path.write_bytes(b"short")
            with self.assertRaisesRegex(RuntimeError, "Incomplete local raster"):
                lola.read_window(label, 1, 2, 1, 2)
            network.assert_not_called()

    def test_no_seam_is_not_a_zero_difference_measurement(self):
        result = terrain_check.seam_summary([])
        self.assertEqual(result["points"], [])
        self.assertIsNone(result["vs_75S_60M"])
        self.assertIsNone(result["vs_75S_240M"])

    def test_existing_seam_statistics_remain_unchanged(self):
        result = terrain_check.seam_summary([
            {"diff_20m_minus_60m": -2, "diff_20m_minus_240m": 4},
            {"diff_20m_minus_60m": 6, "diff_20m_minus_240m": -2}])
        self.assertEqual(result["vs_75S_60M"], {"mean_m": 2, "max_abs_m": 6})
        self.assertEqual(result["vs_75S_240M"], {"mean_m": 1, "max_abs_m": 4})
