"""SLDEM2015 tiles (LOLA + SELENE TC, Barker et al. 2016): label, download, surface lookup.

Release 6 uses SLDEM2015 only for the SURFACE HEIGHT AT A SITE POINT (to form the
observer altitude submitted to Horizons for a non-polar, Smooth-only site). No terrain
horizon, mesh or slope is computed from it in this release.

Product (PDS label, verified on read):
  * float32 little-endian (PC_REAL), values in km relative to a 1737.4 km sphere;
  * SIMPLE CYLINDRICAL, MAP_RESOLUTION pixels/degree, CENTER_LONGITUDE 180,
    MEAN EARTH/POLAR AXIS OF DE421, east-positive longitude; no MISSING_CONSTANT;
  * 1-based pixel centres: J = LINE_PROJECTION_OFFSET - lat * res + 1,
    I = SAMPLE_PROJECTION_OFFSET + (lon - CENTER_LONGITUDE) * res + 1
    (the tile's corner latitudes/longitudes fall exactly on pixel edges; checked below).

    python pipeline/sldem.py fetch sldem2015_512_00n_30n_000_045_float
    python pipeline/sldem.py height sldem2015_512_00n_30n_000_045_float LAT LON_E
    python pipeline/sldem.py site apollo17-lm sldem2015_512_00n_30n_000_045_float
Raw files go to git-ignored data/raw/sldem/<name>/.
"""
from __future__ import annotations

import hashlib
import json
import math
import mmap
import re
import sys
import time
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = REPO_ROOT / "data" / "raw" / "sldem"
BASE_URL = "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/sldem2015/tiles/float_img"
R_REF_KM = 1737.4
# Independent published elevations at the site points (different shape models; for comparison only).
LROC_COMPARISON = {
    "apollo17-lm": {"source": "LROC page 938 table (GLD100 elevation)", "elevation_m": -2626.0},
}
UA = {"User-Agent": "lunar-visibility-navigator-pipeline/1.0 (educational; python urllib)"}


@dataclass
class Label:
    name: str
    lines: int
    samples: int
    res: float
    lpo: float
    spo: float
    center_lon: float
    max_lat: float
    min_lat: float
    west_lon: float
    east_lon: float
    offset_km: float
    text: str

    @property
    def expected_bytes(self) -> int:
        return self.lines * self.samples * 4


def _f(text: str, key: str) -> str:
    m = re.search(rf"^\s*{key}\s*=\s*(.+?)\s*$", text, re.M)
    if not m:
        raise RuntimeError(f"label key {key} missing")
    return m.group(1).strip().strip('"')


def _n(v: str) -> float:
    return float(re.sub(r"<.*?>", "", v).strip())


def parse_label(name: str, text: str) -> Label:
    checks = {"SAMPLE_TYPE": "PC_REAL", "SAMPLE_BITS": "32", "UNIT": "KILOMETER", "MAP_PROJECTION_TYPE": "SIMPLE CYLINDRICAL",
              "COORDINATE_SYSTEM_NAME": "MEAN EARTH/POLAR AXIS OF DE421", "POSITIVE_LONGITUDE_DIRECTION": "EAST"}
    for k, want in checks.items():
        if _f(text, k) != want:
            raise RuntimeError(f"{name}: {k} = {_f(text, k)!r}, expected {want!r}")
    if re.search(r"MISSING_CONSTANT", text):
        raise RuntimeError(f"{name}: label declares a MISSING_CONSTANT; nodata handling would be required")
    lbl = Label(name=name, lines=int(_n(_f(text, "LINES"))), samples=int(_n(_f(text, "LINE_SAMPLES"))), res=_n(_f(text, "MAP_RESOLUTION")),
                lpo=_n(_f(text, "LINE_PROJECTION_OFFSET")), spo=_n(_f(text, "SAMPLE_PROJECTION_OFFSET")), center_lon=_n(_f(text, "CENTER_LONGITUDE")),
                max_lat=_n(_f(text, "MAXIMUM_LATITUDE")), min_lat=_n(_f(text, "MINIMUM_LATITUDE")), west_lon=_n(_f(text, "WESTERNMOST_LONGITUDE")),
                east_lon=_n(_f(text, "EASTERNMOST_LONGITUDE")), offset_km=_n(_f(text, "OFFSET")), text=text)
    if abs(lbl.offset_km - R_REF_KM) > 1e-9 or abs(_n(_f(text, "A_AXIS_RADIUS")) - R_REF_KM) > 1e-9:
        raise RuntimeError(f"{name}: height reference is not the 1737.4 km sphere")
    # corner latitudes / longitudes must fall on pixel edges (registration check)
    j_top, j_bot = pixel_of(lbl, lbl.max_lat, lbl.west_lon)[1], pixel_of(lbl, lbl.min_lat, lbl.east_lon)[1]
    i_w, i_e = pixel_of(lbl, lbl.max_lat, lbl.west_lon)[0], pixel_of(lbl, lbl.min_lat, lbl.east_lon)[0]
    if max(abs(j_top - 0.5), abs(j_bot - (lbl.lines + 0.5)), abs(i_w - 0.5), abs(i_e - (lbl.samples + 0.5))) > 1e-6:
        raise RuntimeError(f"{name}: tile corners do not fall on pixel edges with the assumed registration")
    return lbl


def pixel_of(lbl: Label, lat: float, lon: float) -> tuple[float, float]:
    """(I, J) fractional 1-based, pixel centres at integers."""
    return lbl.spo + (lon - lbl.center_lon) * lbl.res + 1.0, lbl.lpo - lat * lbl.res + 1.0


def _get(url: str, headers: dict | None = None):
    req = urllib.request.Request(url, headers={**UA, **(headers or {})})
    return urllib.request.urlopen(req, timeout=120)


def load_label(name: str, offline: bool = False) -> Label:
    d = RAW_DIR / name
    p = d / f"{name}.lbl"
    if not p.exists():
        if offline:
            raise FileNotFoundError(f"{p} missing (run: python pipeline/sldem.py fetch {name})")
        d.mkdir(parents=True, exist_ok=True)
        with _get(f"{BASE_URL}/{name}.lbl") as r:
            p.write_bytes(r.read())
    return parse_label(name, p.read_text("latin-1"))


def fetch(name: str, max_attempts: int = 6) -> dict:
    """Stream the IMG to <name>.img.part with Range resume; rename only when the size equals the label."""
    lbl = load_label(name)
    d = RAW_DIR / name
    img, part, meta_p = d / f"{name}.img", d / f"{name}.img.part", d / "download.meta.json"
    if img.exists() and meta_p.exists() and img.stat().st_size == lbl.expected_bytes:
        return json.loads(meta_p.read_text("utf-8"))
    url = f"{BASE_URL}/{name}.img"
    t0 = time.time()
    for attempt in range(1, max_attempts + 1):
        have = part.stat().st_size if part.exists() else 0
        if have >= lbl.expected_bytes:
            break
        try:
            with _get(url, {"Range": f"bytes={have}-"} if have else None) as r, open(part, "ab") as f:
                if have and r.status != 206:
                    raise RuntimeError(f"server ignored the Range request (HTTP {r.status})")
                while True:
                    b = r.read(8 << 20)
                    if not b:
                        break
                    f.write(b)
            break
        except (OSError, RuntimeError) as e:
            print(f"  attempt {attempt} interrupted at {part.stat().st_size if part.exists() else 0} bytes: {e}", file=sys.stderr)
            time.sleep(min(30, 2 ** attempt))
    size = part.stat().st_size
    if size != lbl.expected_bytes:
        raise RuntimeError(f"{name}: downloaded {size} bytes, label implies {lbl.expected_bytes}")
    h = hashlib.sha256()
    with open(part, "rb") as f:
        for b in iter(lambda: f.read(16 << 20), b""):
            h.update(b)
    part.replace(img)
    meta = {"name": name, "url": url, "label_url": f"{BASE_URL}/{name}.lbl", "bytes": size, "sha256": h.hexdigest(),
            "retrieved_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "seconds": round(time.time() - t0, 1)}
    meta_p.write_text(json.dumps(meta, indent=2) + "\n", "utf-8")
    return meta


class Tile:
    """Memory-mapped float32 tile; heights in metres above the 1737.4 km sphere."""

    def __init__(self, name: str):
        self.lbl = load_label(name, offline=True)
        p = RAW_DIR / name / f"{name}.img"
        if not p.exists() or p.stat().st_size != self.lbl.expected_bytes:
            raise FileNotFoundError(f"{p} missing or wrong size (run: python pipeline/sldem.py fetch {name})")
        self._f = open(p, "rb")
        self._mm = mmap.mmap(self._f.fileno(), 0, access=mmap.ACCESS_READ)
        if sys.byteorder != "little":
            raise RuntimeError("PC_REAL little-endian reader needs a little-endian host")
        self.v = memoryview(self._mm).cast("f")

    def value_m(self, i: int, j: int) -> float | None:
        """Pixel (1-based) height in metres, or None outside the tile."""
        if 1 <= i <= self.lbl.samples and 1 <= j <= self.lbl.lines:
            x = self.v[(j - 1) * self.lbl.samples + (i - 1)]
            if not math.isfinite(x):
                raise RuntimeError(f"non-finite value at pixel ({i}, {j})")
            return x * 1000.0
        return None

    def bilinear_m(self, lat: float, lon: float) -> float | None:
        fi, fj = pixel_of(self.lbl, lat, lon)
        i0, j0 = math.floor(fi), math.floor(fj)
        q = [self.value_m(i0, j0), self.value_m(i0 + 1, j0), self.value_m(i0, j0 + 1), self.value_m(i0 + 1, j0 + 1)]
        if any(x is None for x in q):
            return None
        a, b = fi - i0, fj - j0
        return q[0] * (1 - a) * (1 - b) + q[1] * a * (1 - b) + q[2] * (1 - a) * b + q[3] * a * b

    def pixel_ground_m(self, lat: float) -> tuple[float, float]:
        """(east-west, north-south) pixel size in metres on the 1737.4 km sphere at a latitude."""
        ns = math.radians(1 / self.lbl.res) * R_REF_KM * 1000
        return ns * math.cos(math.radians(lat)), ns


def site_report(site_id: str, tile_name: str, comparison: dict | None = None) -> dict:
    """Surface at a configured site point from one SLDEM2015 tile, with local relief rings.
    Writes data/terrain/<site_id>_site_elevation_report.json (same rounding rule as site_elevation.py)."""
    cfg = json.loads((REPO_ROOT / "pipeline" / "config.json").read_text("utf-8"))
    site = next(s for s in cfg["sites"] if s["id"] == site_id)
    lat, lon = site["latitude_deg"], site["longitude_deg_east"]
    t = Tile(tile_name)
    h = t.bilinear_m(lat, lon)
    if h is None:
        raise RuntimeError(f"{site_id} is not inside {tile_name}")
    fi, fj = pixel_of(t.lbl, lat, lon)
    R = R_REF_KM * 1000

    def ring(d: float) -> list[float]:
        out = []
        for k in range(36):
            a = math.radians(10 * k)
            v = t.bilinear_m(lat + math.degrees(d * math.cos(a) / R), lon + math.degrees(d * math.sin(a) / (R * math.cos(math.radians(lat)))))
            out.append(v - h)
        return [min(out), max(out)]

    surf = round(h, 1)
    obs_h = site["observer_height_above_surface_m"]
    meta = json.loads((RAW_DIR / tile_name / "download.meta.json").read_text("utf-8"))
    rep = {
        "generated_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "site": {k: site[k] for k in ("id", "latitude_deg", "longitude_deg_east", "observer_height_above_surface_m")},
        "dem": {"product": tile_name, "url": meta["url"], "sha256": meta["sha256"], "bytes": meta["bytes"],
                "projection": "SIMPLE CYLINDRICAL, MEAN EARTH/POLAR AXIS OF DE421, east longitude", "resolution_pix_per_deg": t.lbl.res,
                "pixel_ground_m_east_north": list(t.pixel_ground_m(lat)), "height_reference": "km relative to the 1737.4 km sphere (label OFFSET)",
                "missing_data": "label declares no MISSING_CONSTANT; values checked finite at the four interpolation pixels",
                "registration": "J = LINE_PROJECTION_OFFSET - lat*res + 1, I = SAMPLE_PROJECTION_OFFSET + (lon - 180)*res + 1; tile corners on pixel edges (checked)"},
        "site_surface": {"bilinear_m": h, "pixel_1based": [fi, fj], "nearest_pixel_m": t.value_m(round(fi), round(fj))},
        "local_relief_m": {"ring_30m_min_max": ring(30.0), "ring_100m_min_max": ring(100.0),
                           "note": "height changes relative to the point; local relief, not coordinate uncertainty or accuracy"},
        "comparison": comparison or {},
        "horizons_altitude": {
            "surface_elevation_m": surf,
            "surface_elevation_reference": f"height above the 1737.4 km sphere ({tile_name}, bilinear)",
            "observer_height_above_surface_m": obs_h,
            "horizons_site_altitude_km": round((surf + obs_h) / 1000, 4),
            "eye_above_bilinear_dem_m": surf + obs_h - h,
            "rule": "surface rounded to 0.1 m, plus the nominal observer height (same rule as site_elevation.py)",
        },
        "use": "observer altitude for Horizons positions only; no terrain horizon, mesh or slope is derived from this DEM in release 6",
    }
    out = REPO_ROOT / "data" / "terrain" / f"{site_id}_site_elevation_report.json"
    out.write_text(json.dumps(rep, indent=2) + "\n", "utf-8")
    return rep


def main() -> int:
    if len(sys.argv) >= 3 and sys.argv[1] == "fetch":
        print(json.dumps(fetch(sys.argv[2]), indent=2))
        return 0
    if len(sys.argv) == 5 and sys.argv[1] == "height":
        t = Tile(sys.argv[2])
        print(f"{t.bilinear_m(float(sys.argv[3]), float(sys.argv[4])):.4f} m above 1737.4 km")
        return 0
    if len(sys.argv) == 4 and sys.argv[1] == "site":
        r = site_report(sys.argv[2], sys.argv[3], LROC_COMPARISON.get(sys.argv[2]))
        print(json.dumps({k: r[k] for k in ("site_surface", "local_relief_m", "horizons_altitude", "comparison")}, indent=2))
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
