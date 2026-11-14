"""LOLA gridded DEM helpers (PDS3 polar stereographic and simple cylindrical).

Standard library only. Authoritative source: PDS Geosciences Node,
LRO-L-LOLA-4-GDR-V1.0 (volume LROLOL_1XXX).
  Polar products:   .../data/lola_gdr/polar/img/
  Projection text:  .../catalog/dsmap_polar.cat

Missing data: these LDEM products have NO missing-data constant. Every pixel
is filled by GMT 'surface' interpolation between LOLA ground tracks. Where a
pixel was actually measured is recorded separately in the LDEC count products
(0 = no LOLA shot in that pixel; the LDEM value there is interpolated).
"""
from __future__ import annotations

import array
import hashlib
import json
import math
import re
import sys
import time
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
PDS_BASE = "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx"
POLAR_DIR = PDS_BASE + "/data/lola_gdr/polar/img"
CYL_DIR = PDS_BASE + "/data/lola_gdr/cylindrical/img"
LABEL_DIR = REPO_ROOT / "data" / "terrain" / "labels"      # committed (small)
RAW_DIR = REPO_ROOT / "data" / "raw" / "lola"               # git-ignored (large)
USER_AGENT = "lunar-visibility-pipeline/0.1 (python urllib)"
PAUSE_S = 0.5
R_REF_M = 1737400.0  # LOLA reference sphere (labels: OFFSET, A/B/C_AXIS_RADIUS)


def _utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _get(url: str, byte_range: tuple[int, int] | None = None) -> tuple[bytes, dict]:
    headers = {"User-Agent": USER_AGENT}
    if byte_range:
        headers["Range"] = f"bytes={byte_range[0]}-{byte_range[1]}"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=300) as r:
        body = r.read()
        info = {"status": r.status, "headers": dict(r.headers.items())}
    if byte_range:
        want = byte_range[1] - byte_range[0] + 1
        if info["status"] != 206 or len(body) != want:
            raise RuntimeError(f"range request not honoured: HTTP {info['status']}, {len(body)} of {want} bytes")
    time.sleep(PAUSE_S)  # sequential and courteous
    return body, info


def head_size(url: str) -> int:
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=120) as r:
        size = int(r.headers["Content-Length"])
    time.sleep(PAUSE_S)
    return size


# ------------------------------------------------------------------ labels

@dataclass
class Label:
    name: str          # e.g. LDEM_80S_20M
    url: str           # .IMG url
    label_url: str
    text: str
    lines: int
    samples: int
    sample_bits: int
    sample_type: str
    scaling: float
    offset_m: float
    map_scale_m: float
    projection: str
    fields: dict[str, str]

    @property
    def row_bytes(self) -> int:
        return self.samples * self.sample_bits // 8

    @property
    def expected_bytes(self) -> int:
        return self.lines * self.row_bytes


def _field(text: str, key: str) -> str | None:
    m = re.search(rf"^\s*{re.escape(key)}\s*=\s*(.+?)\s*$", text, re.M)
    return m.group(1).strip().strip('"') if m else None


def _num(v: str | None) -> float:
    if v is None:
        raise ValueError("missing label field")
    return float(re.sub(r"<.*?>", "", v).strip().rstrip("."))


LABEL_KEYS = ("PRODUCT_VERSION_ID", "DATA_SET_ID", "START_TIME", "STOP_TIME",
              "PRODUCT_CREATION_TIME", "LINES", "LINE_SAMPLES", "SAMPLE_TYPE", "SAMPLE_BITS",
              "UNIT", "SCALING_FACTOR", "OFFSET", "DERIVED_MINIMUM", "DERIVED_MAXIMUM",
              "MINIMUM", "MAXIMUM", "MISSING_CONSTANT", "MAP_PROJECTION_TYPE",
              "KEYWORD_LATITUDE_TYPE", "MAP_RESOLUTION", "MAP_SCALE", "A_AXIS_RADIUS",
              "POSITIVE_LONGITUDE_DIRECTION", "CENTER_LATITUDE", "CENTER_LONGITUDE",
              "MAXIMUM_LATITUDE", "MINIMUM_LATITUDE", "LINE_PROJECTION_OFFSET",
              "SAMPLE_PROJECTION_OFFSET", "COORDINATE_SYSTEM_NAME")


def load_label(name: str, kind: str = "polar") -> Label:
    """Fetch (or read cached) PDS label for e.g. 'LDEM_80S_20M'."""
    base = POLAR_DIR if kind == "polar" else CYL_DIR
    lower = name.lower()
    label_url, img_url = f"{base}/{lower}.lbl", f"{base}/{lower}.img"
    path = LABEL_DIR / f"{lower}.lbl"
    if not path.exists():
        body, _ = _get(label_url)
        LABEL_DIR.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
    text = path.read_text("latin-1")
    fields = {k: v for k in LABEL_KEYS if (v := _field(text, k)) is not None}
    return Label(
        name=name.upper(), url=img_url, label_url=label_url, text=text,
        lines=int(_num(fields["LINES"])), samples=int(_num(fields["LINE_SAMPLES"])),
        sample_bits=int(_num(fields["SAMPLE_BITS"])), sample_type=fields["SAMPLE_TYPE"],
        scaling=_num(fields.get("SCALING_FACTOR", "1")), offset_m=_num(fields.get("OFFSET", "0")),
        map_scale_m=_num(fields["MAP_SCALE"]), projection=fields["MAP_PROJECTION_TYPE"], fields=fields,
    )


# ---------------------------------------------------- polar stereographic
#
# dsmap_polar.cat (2022-01-15 revision) gives, for image size N, scale s:
#   forward  X = (I - N/2 - 0.5)*s,  Y = (J - N/2 - 0.5)*s*NS  (NS = -1 south)
#            LON = atan2(X, Y),  LAT = -90 + 2*atan(0.5*R/1737400)   [south]
# and describes "In the south, Longitude 0 extends straight up from the
# center, and Longitude 90 East extends to the right." We implement these
# forward equations and their exact algebraic inverse.
#
# Note: when we read the catalog's separately printed lat/lon -> line/sample
# equations literally (sample 1 at the left, line 1 at the top), they would
# place 90 E to the LEFT of the pole. We have not established whether that is
# an error in the text or in our reading, so we do not rely on them. What IS
# independently checked is the mapping we use: it matches the global
# cylindrical LDEM_64 (terrain_check.py) and individual LOLA RDR laser shots
# (site_elevation.py: DEM - shot mean -0.26 m over 1131 shots), while the
# east/west-mirrored mapping is off by ~5.9 km in height at the same points.

def polar_forward(lbl: Label, i: float, j: float, east_right: bool = True) -> tuple[float, float]:
    """1-based (sample I, line J) -> (planetocentric lat, east lon [0,360)), south pole maps."""
    n, s = lbl.samples, lbl.map_scale_m
    x = (i - n / 2 - 0.5) * s
    y = -(j - n / 2 - 0.5) * s
    if not east_right:
        x = -x
    r = math.hypot(x, y)
    lat = -90.0 + math.degrees(2 * math.atan(0.5 * r / R_REF_M))
    lon = math.degrees(math.atan2(x, y)) % 360.0
    return lat, lon


def polar_inverse(lbl: Label, lat: float, lon: float, east_right: bool = True) -> tuple[float, float]:
    """(lat, east lon) -> fractional 1-based (sample I, line J); pixel centres are integers."""
    n, s = lbl.samples, lbl.map_scale_m
    r = 2 * R_REF_M * math.tan(math.radians(90.0 - abs(lat)) / 2)
    x = r * math.sin(math.radians(lon))
    y = r * math.cos(math.radians(lon))
    if not east_right:
        x = -x
    return x / s + n / 2 + 0.5, -y / s + n / 2 + 0.5


def polar_bounds(lbl: Label) -> dict:
    """Actual extent of a square polar grid (outer pixel edges)."""
    n, s = lbl.samples, lbl.map_scale_m
    half = n * s / 2
    edge_lat = -90.0 + math.degrees(2 * math.atan(0.5 * half / R_REF_M))
    corner_lat = -90.0 + math.degrees(2 * math.atan(0.5 * half * math.sqrt(2) / R_REF_M))
    return {
        "map_half_width_km": half / 1000,
        "lat_at_edge_midpoints_deg": edge_lat,
        "lat_at_corners_deg": corner_lat,
        "label_maximum_latitude": lbl.fields.get("MAXIMUM_LATITUDE"),
    }


def stereo_scale_factor(lat: float) -> float:
    """Polar stereographic scale k (map/ground) true at the pole: k = 2/(1+sin|lat|)."""
    return 2.0 / (1.0 + math.sin(math.radians(abs(lat))))


# ---------------------------------------------------------- simple cylindrical

def cyl_pixel(lbl: Label, lat: float, lon: float) -> tuple[int, int]:
    """Nearest 1-based (sample, line) in a global simple-cylindrical LDEM."""
    res = _num(lbl.fields["MAP_RESOLUTION"])
    line_off = _num(lbl.fields["LINE_PROJECTION_OFFSET"])
    samp_off = _num(lbl.fields["SAMPLE_PROJECTION_OFFSET"])
    clon = _num(lbl.fields["CENTER_LONGITUDE"])
    j = line_off - lat * res + 1
    d = ((lon - clon + 180.0) % 360.0) - 180.0
    i = samp_off + d * res + 1
    return int(round(i)), int(round(j))


# ----------------------------------------------------------- reading data

def _decode(lbl: Label, raw: bytes) -> array.array:
    if lbl.sample_type != "LSB_INTEGER":
        raise ValueError(f"unsupported SAMPLE_TYPE {lbl.sample_type}")
    code = {16: "h", 8: "B"}[lbl.sample_bits]
    a = array.array(code)
    a.frombytes(raw)
    if sys.byteorder != "little" and lbl.sample_bits > 8:
        a.byteswap()
    return a


def download_full(lbl: Label) -> tuple[Path, dict]:
    """Download a whole IMG into its own directory under data/raw/lola/."""
    d = RAW_DIR / lbl.name.lower()
    path = d / f"{lbl.name.lower()}.img"
    meta_path = d / "download.meta.json"
    if path.exists() and meta_path.exists():
        return path, json.loads(meta_path.read_text("utf-8"))
    body, info = _get(lbl.url)
    if len(body) != lbl.expected_bytes:
        raise RuntimeError(f"{lbl.name}: {len(body)} bytes, label implies {lbl.expected_bytes}")
    d.mkdir(parents=True, exist_ok=True)
    path.write_bytes(body)
    meta = {"url": lbl.url, "retrieved_at_utc": _utc_now(), "http_status": info["status"],
            "response_headers": info["headers"], "bytes": len(body),
            "sha256": hashlib.sha256(body).hexdigest()}
    meta_path.write_text(json.dumps(meta, indent=2) + "\n", "utf-8")
    return path, meta


class Grid:
    """In-memory DN array for a fully downloaded product."""

    def __init__(self, lbl: Label, path: Path):
        self.lbl = lbl
        self.dn = _decode(lbl, path.read_bytes())
        if len(self.dn) != lbl.lines * lbl.samples:
            raise RuntimeError("decoded size does not match label")

    def dn_at(self, i: int, j: int) -> int | None:
        """1-based sample i, line j; None outside the file (never a default value)."""
        if 1 <= i <= self.lbl.samples and 1 <= j <= self.lbl.lines:
            return self.dn[(j - 1) * self.lbl.samples + (i - 1)]
        return None

    def height_bilinear(self, fi: float, fj: float) -> float | None:
        """Height (m, relative to 1737.4 km) at fractional pixel; None if any of
        the four neighbours lies outside the file."""
        i0, j0 = math.floor(fi), math.floor(fj)
        a, b = fi - i0, fj - j0
        q = [self.dn_at(i0, j0), self.dn_at(i0 + 1, j0), self.dn_at(i0, j0 + 1), self.dn_at(i0 + 1, j0 + 1)]
        if any(v is None for v in q):
            return None
        v = (q[0] * (1 - a) * (1 - b) + q[1] * a * (1 - b) + q[2] * (1 - a) * b + q[3] * a * b)
        return v * self.lbl.scaling


class Window:
    """A rectangular block of a polar product read with one range request."""

    def __init__(self, lbl: Label, ci: int, cj: int, half: int):
        self.lbl, self.i0, self.j0 = lbl, ci - half, cj - half
        self.rows = read_window(lbl, ci - half, ci + half, cj - half, cj + half)

    def dn(self, i: int, j: int) -> int | None:
        r, c = j - self.j0, i - self.i0
        if 0 <= r < len(self.rows) and 0 <= c < len(self.rows[0]):
            return self.rows[r][c]
        return None

    def bilinear(self, fi: float, fj: float) -> dict | None:
        """Bilinear height (m) at fractional 1-based pixel, with the pixels and
        weights used (pixel centres at integer coordinates)."""
        i0, j0 = math.floor(fi), math.floor(fj)
        a, b = fi - i0, fj - j0
        px = [(i0, j0, (1 - a) * (1 - b)), (i0 + 1, j0, a * (1 - b)),
              (i0, j0 + 1, (1 - a) * b), (i0 + 1, j0 + 1, a * b)]
        vals = [self.dn(i, j) for i, j, _ in px]
        if any(v is None for v in vals):
            return None
        h = sum(v * w for v, (_, _, w) in zip(vals, px)) * self.lbl.scaling
        return {"height_m": h, "pixels": [{"sample": i, "line": j, "dn": v, "height_m": v * self.lbl.scaling,
                                            "weight": w} for (i, j, w), v in zip(px, vals)]}


def read_window(lbl: Label, i0: int, i1: int, j0: int, j1: int) -> list[list[int]]:
    """Read lines j0..j1 (1-based, inclusive) with ONE contiguous range request,
    return the sample columns i0..i1. Cached under data/raw/lola/windows/."""
    if not (1 <= i0 <= i1 <= lbl.samples and 1 <= j0 <= j1 <= lbl.lines):
        raise ValueError("window outside file")
    start = (j0 - 1) * lbl.row_bytes
    end = j1 * lbl.row_bytes - 1
    cache = RAW_DIR / "windows" / f"{lbl.name.lower()}_{start}_{end}.bin"
    if cache.exists():
        raw = cache.read_bytes()
    else:
        raw, _ = _get(lbl.url, (start, end))
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_bytes(raw)
    a = _decode(lbl, raw)
    return [list(a[(j - j0) * lbl.samples + (i0 - 1):(j - j0) * lbl.samples + i1]) for j in range(j0, j1 + 1)]
