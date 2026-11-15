"""Shared read-only helpers for the science-review checks (pipeline/review/).

Deliberately independent of the pipeline modules (lola.py, terrain_horizon.py,
visibility.py): the projection, interpolation and ray geometry are written out
again here so these checks are a second implementation, not a re-run.

Input requirements
- The committed repository files (pipeline/config.json, app/public/data/*.json,
  data/terrain/*_terrain_horizon.json, data/terrain/lola_rdr/*_pts.csv,
  data/terrain/labels/ldem_80s_20m.lbl).
- The LOLA raster data/raw/lola/ldem_80s_20m/ldem_80s_20m.img (1 848 320 000
  bytes, git-ignored). Get it with `python pipeline/fetch_terrain.py --site
  im2-athena`; verify with `--check --rehash`. Only the size is checked here.
"""
from __future__ import annotations

import json
import math
import re
import struct
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
R = 1737400.0
PRODUCT = "ldem_80s_20m"


def fail(msg: str) -> "NoReturn":  # type: ignore[name-defined]
    print(f"ERROR: {msg}", file=sys.stderr)
    raise SystemExit(2)


def _label_value(text: str, key: str) -> str:
    m = re.search(rf"^\s*{key}\s*=\s*([^\s<]+)", text, re.M)
    if not m:
        fail(f"{PRODUCT}.lbl has no {key}")
    return m.group(1).strip('"')


class Dem:
    """Bilinear (and two-triangle) heights from LDEM_80S_20M, pixel centres at
    integer 1-based (sample I, line J): I = X/s + N/2 + 0.5, J = -Y/s + N/2 + 0.5."""

    def __init__(self, repo: Path = REPO):
        lbl = (repo / "data" / "terrain" / "labels" / f"{PRODUCT}.lbl").read_text("latin-1")
        self.n = int(_label_value(lbl, "LINES"))
        if int(_label_value(lbl, "LINE_SAMPLES")) != self.n:
            fail("non-square grid")
        self.s = float(_label_value(lbl, "MAP_SCALE"))
        self.scale = float(_label_value(lbl, "SCALING_FACTOR"))
        checks = {"SAMPLE_TYPE": "LSB_INTEGER", "SAMPLE_BITS": "16", "OFFSET": "1737400.",
                  "A_AXIS_RADIUS": "1737.4", "MAP_PROJECTION_TYPE": "POLAR"}
        for k, v in checks.items():
            if not _label_value(lbl, k).startswith(v):
                fail(f"{PRODUCT}.lbl {k} is not {v}")
        if float(_label_value(lbl, "LINE_PROJECTION_OFFSET")) != self.n / 2 - 0.5:
            fail("unexpected projection offset (pixel-centre convention)")
        img = repo / "data" / "raw" / "lola" / PRODUCT / f"{PRODUCT}.img"
        if not img.exists():
            fail(f"{img} is missing. It is a 1.85 GB git-ignored download: run "
                 "`python pipeline/fetch_terrain.py --site im2-athena` first.")
        if img.stat().st_size != self.n * self.n * 2:
            fail(f"{img} has {img.stat().st_size} bytes, label implies {self.n * self.n * 2}")
        self.f = open(img, "rb")
        self._c: dict[tuple[int, int], float] = {}

    def height(self, i: int, j: int) -> float:
        """Height (m above 1737.4 km) of 1-based pixel (sample i, line j)."""
        if (i, j) not in self._c:
            self.f.seek(((j - 1) * self.n + (i - 1)) * 2)
            self._c[(i, j)] = struct.unpack("<h", self.f.read(2))[0] * self.scale
        return self._c[(i, j)]

    def h(self, x: float, y: float, mode: str = "bilinear") -> float:
        fi, fj = x / self.s + self.n / 2 + 0.5, -y / self.s + self.n / 2 + 0.5
        i0, j0 = math.floor(fi), math.floor(fj)
        a, b = fi - i0, fj - j0
        q00, q10 = self.height(i0, j0), self.height(i0 + 1, j0)
        q01, q11 = self.height(i0, j0 + 1), self.height(i0 + 1, j0 + 1)
        if mode == "bilinear":
            return q00 * (1 - a) * (1 - b) + q10 * a * (1 - b) + q01 * (1 - a) * b + q11 * a * b
        if mode == "tri_a":  # diagonal q00-q11
            return q00 + (q10 - q00) * a + (q11 - q10) * b if a >= b else q00 + (q11 - q01) * a + (q01 - q00) * b
        if mode == "tri_b":  # diagonal q10-q01
            return (q00 + (q10 - q00) * a + (q01 - q00) * b if a + b <= 1
                    else q11 + (q01 - q11) * (1 - a) + (q10 - q11) * (1 - b))
        raise ValueError(mode)


def xy(lat: float, lon: float) -> tuple[float, float]:
    """South polar stereographic map metres: 0 deg longitude up (+Y), 90 deg E right (+X)."""
    r = 2 * R * math.tan(math.radians(90 + lat) / 2)
    return r * math.sin(math.radians(lon)), r * math.cos(math.radians(lon))


def dest(lat: float, lon: float, az: float, d: float) -> tuple[float, float]:
    """Great-circle destination point (spherical trigonometry), az clockwise from north."""
    p, l, a, th = math.radians(lat), math.radians(lon), math.radians(az), d / R
    p2 = math.asin(math.sin(p) * math.cos(th) + math.cos(p) * math.sin(th) * math.cos(a))
    l2 = l + math.atan2(math.sin(a) * math.sin(th) * math.cos(p), math.cos(th) - math.sin(p) * math.sin(p2))
    return math.degrees(p2), math.degrees(l2) % 360


def elev(r_t: float, r_o: float, d: float) -> float:
    """Apparent elevation (deg) of a point at radius r_t, surface distance d, from radius r_o."""
    th = d / R
    return math.degrees(math.atan2(r_t * math.cos(th) - r_o, r_t * math.sin(th)))


def config(repo: Path = REPO) -> dict:
    return json.loads((repo / "pipeline" / "config.json").read_text("utf-8"))
