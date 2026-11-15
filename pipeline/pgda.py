"""NASA GSFC PGDA high-resolution LOLA products (Barker et al. 2021): download and
GeoTIFF access, standard library only.

Product page: https://pgda.gsfc.nasa.gov/products/78 (south pole sites, 5 m/pix)
README:       https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/README
README states: south polar stereographic X/Y in metres, MOON_ME frame of DE421,
GMT pixel-registered (X/Y are pixel centres); *_surf.tif = surface height Z (m)
with interpolation filling empty pixels; *_ldec.tif = LOLA returns per pixel;
*_toterr.tif = total Z uncertainty (m, formally the RMS error, from 100 clones).
The README does NOT state the height reference sphere or a nodata value: both are
checked from the data here (see terrain_5m.py), never assumed.

    python pipeline/pgda.py fetch Site01 surf ldec toterr   # sequential downloads
    python pipeline/pgda.py info  Site01 surf               # GeoTIFF header
Files go to the git-ignored data/raw/pgda/<site>/ with download.meta.json
(url, bytes = Content-Length, sha256, times).
"""
from __future__ import annotations

import hashlib
import json
import mmap
import struct
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = REPO_ROOT / "data" / "raw" / "pgda"
BASE_URL = "https://pgda.gsfc.nasa.gov/data/LOLA_5mpp"
USER_AGENT = "lunar-visibility-pipeline/0.1 (python urllib)"


def _utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def url_of(site: str, layer: str) -> str:
    return f"{BASE_URL}/{site}/{site}_final_adj_5mpp_{layer}.tif"


def path_of(site: str, layer: str) -> Path:
    return RAW_DIR / site.lower() / f"{site}_final_adj_5mpp_{layer}.tif"


def _meta_path(site: str) -> Path:
    return RAW_DIR / site.lower() / "download.meta.json"


def load_meta(site: str) -> dict:
    p = _meta_path(site)
    return json.loads(p.read_text("utf-8")) if p.exists() else {}


def fetch(site: str, layer: str, max_attempts: int = 5) -> tuple[Path, dict]:
    """Stream one GeoTIFF to disk (resumable), check size = Content-Length, record sha256."""
    path, url = path_of(site, layer), url_of(site, layer)
    meta_all = load_meta(site)
    if path.exists() and layer in meta_all and path.stat().st_size == meta_all[layer]["bytes"]:
        return path, meta_all[layer]
    path.parent.mkdir(parents=True, exist_ok=True)
    head = urllib.request.Request(url, method="HEAD", headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(head, timeout=60) as r:
        want = int(r.headers["Content-Length"])
        last_mod = r.headers.get("Last-Modified")
    part = path.with_suffix(".tif.part")
    started = _utc()
    for attempt in range(1, max_attempts + 1):
        have = part.stat().st_size if part.exists() else 0
        if have == want:
            break
        hdr = {"User-Agent": USER_AGENT, **({"Range": f"bytes={have}-"} if have else {})}
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=hdr), timeout=300) as r:
                if have and r.status != 206:
                    raise RuntimeError(f"resume not honoured (HTTP {r.status})")
                with open(part, "ab") as f:
                    while chunk := r.read(8 << 20):
                        f.write(chunk)
        except (OSError, RuntimeError) as e:
            print(f"  {path.name}: attempt {attempt} interrupted: {e}", file=sys.stderr, flush=True)
            time.sleep(5 * attempt)
    if not part.exists() or part.stat().st_size != want:
        raise RuntimeError(f"{path.name}: incomplete after {max_attempts} attempts")
    h = hashlib.sha256()
    with open(part, "rb") as f:
        while b := f.read(8 << 20):
            h.update(b)
    part.replace(path)
    meta = {"url": url, "bytes": want, "last_modified": last_mod, "sha256": h.hexdigest(),
            "download_started_utc": started, "retrieved_at_utc": _utc()}
    meta_all[layer] = meta
    _meta_path(site).write_text(json.dumps(meta_all, indent=2) + "\n", "utf-8")
    return path, meta


# ------------------------------------------------------------------ GeoTIFF

TYPES = {1: ("B", 1), 2: ("s", 1), 3: ("H", 2), 4: ("I", 4), 5: ("II", 8), 6: ("b", 1), 7: ("B", 1),
         8: ("h", 2), 9: ("i", 4), 10: ("ii", 8), 11: ("f", 4), 12: ("d", 8), 16: ("Q", 8)}
TAGS = {256: "ImageWidth", 257: "ImageLength", 258: "BitsPerSample", 259: "Compression",
        262: "Photometric", 273: "StripOffsets", 277: "SamplesPerPixel", 278: "RowsPerStrip",
        279: "StripByteCounts", 284: "PlanarConfig", 317: "Predictor", 322: "TileWidth", 323: "TileLength",
        324: "TileOffsets", 325: "TileByteCounts", 339: "SampleFormat", 33550: "ModelPixelScale",
        33922: "ModelTiepoint", 34264: "ModelTransformation", 34735: "GeoKeyDirectory",
        34736: "GeoDoubleParams", 34737: "GeoAsciiParams", 42112: "GDAL_METADATA", 42113: "GDAL_NODATA"}
GEOKEYS = {1024: "GTModelType", 1025: "GTRasterType", 2048: "GeographicType", 2050: "GeogGeodeticDatum",
           2054: "GeogAngularUnits", 2056: "GeogEllipsoid", 2057: "GeogSemiMajorAxis",
           2058: "GeogSemiMinorAxis", 2059: "GeogInvFlattening", 3072: "ProjectedCSType",
           3074: "Projection", 3075: "ProjCoordTrans", 3076: "ProjLinearUnits", 3080: "ProjNatOriginLong",
           3081: "ProjNatOriginLat", 3082: "ProjFalseEasting", 3083: "ProjFalseNorthing",
           3088: "ProjCenterLong", 3089: "ProjCenterLat", 3092: "ProjScaleAtNatOrigin",
           3094: "ProjStraightVertPoleLong", 1026: "GTCitation", 2049: "GeogCitation", 3073: "PCSCitation",
           4096: "VerticalCSType", 4099: "VerticalUnits"}


def read_header(path: Path) -> dict:
    """First IFD of a classic (little/big-endian) TIFF: tags, decoded GeoKeys."""
    with open(path, "rb") as f:
        head = f.read(8)
        bo = {b"II": "<", b"MM": ">"}[head[:2]]
        magic, ifd = struct.unpack(bo + "HI", head[2:8])
        if magic != 42:
            raise ValueError(f"{path.name}: not a classic TIFF (magic {magic})")
        f.seek(ifd)
        (n,) = struct.unpack(bo + "H", f.read(2))
        tags: dict = {}
        for _ in range(n):
            tag, typ, cnt, val = struct.unpack(bo + "HHI4s", f.read(12))
            fmt, size = TYPES[typ]
            total = size * cnt
            here = f.tell()
            if total <= 4:
                raw = val[:total]
            else:
                f.seek(struct.unpack(bo + "I", val)[0])
                raw = f.read(total)
                f.seek(here)
            if typ == 2:
                v = raw.rstrip(b"\0").decode("latin-1")
            else:
                v = list(struct.unpack(bo + fmt[0] * (cnt * len(fmt)), raw))
                if typ in (5, 10):
                    v = [v[i] / v[i + 1] for i in range(0, len(v), 2)]
            tags[TAGS.get(tag, str(tag))] = v
    gk = {}
    d = tags.get("GeoKeyDirectory")
    if d:
        for k in range(d[3]):
            key, loc, cnt, off = d[4 + 4 * k: 8 + 4 * k]
            name = GEOKEYS.get(key, str(key))
            if loc == 0:
                gk[name] = off
            elif loc == 34736:
                gk[name] = tags["GeoDoubleParams"][off:off + cnt]
            elif loc == 34737:
                gk[name] = tags["GeoAsciiParams"][off:off + cnt]
    return {"byte_order": bo, "tags": {k: (v if not isinstance(v, list) or len(v) <= 16 else
                                           f"[{len(v)} values]") for k, v in tags.items()},
            "geokeys": gk, "_offsets": tags.get("StripOffsets") or tags.get("TileOffsets"),
            "_tags_full": tags}


class GeoTiff:
    """Uncompressed, single-band, contiguous-strip GeoTIFF, memory-mapped.

    Pixel (c, r), 0-based column/row, has centre at
        X = X0 + (c + dc) * sx,  Y = Y0 - (r + dc) * sy
    where (X0, Y0) is the tiepoint of raster point (0, 0) and dc = 0.5 for
    GTRasterType = PixelIsArea (tiepoint at the pixel's outer corner) or 0 for
    PixelIsPoint (tiepoint at the pixel centre)."""

    def __init__(self, path: Path):
        h = read_header(path)
        t = h["_tags_full"]
        if t.get("Compression", [1])[0] != 1:
            raise ValueError(f"{path.name}: compressed TIFF not supported (Compression {t['Compression']})")
        if t.get("SamplesPerPixel", [1])[0] != 1 or "TileOffsets" in t:
            raise ValueError(f"{path.name}: expected single-band stripped TIFF")
        self.width, self.height = t["ImageWidth"][0], t["ImageLength"][0]
        bits, fmt = t["BitsPerSample"][0], t.get("SampleFormat", [1])[0]
        self.code = {(32, 3): "f", (64, 3): "d", (16, 2): "h", (16, 1): "H", (8, 1): "B", (32, 1): "I",
                     (32, 2): "i"}[(bits, fmt)]
        self.itemsize = bits // 8
        offs, counts = t["StripOffsets"], t["StripByteCounts"]
        row_bytes = self.width * self.itemsize
        # contiguous strips: each strip directly follows the previous one
        if any(offs[i + 1] != offs[i] + counts[i] for i in range(len(offs) - 1)):
            raise ValueError(f"{path.name}: strips are not contiguous")
        if sum(counts) != row_bytes * self.height:
            raise ValueError(f"{path.name}: strip bytes {sum(counts)} != {row_bytes * self.height}")
        if h["byte_order"] != "<" or sys.byteorder != "little":
            raise ValueError(f"{path.name}: expected little-endian data on a little-endian host")
        self.header = h
        sx, sy = t["ModelPixelScale"][:2]
        tp = t["ModelTiepoint"]
        if tp[0] != 0 or tp[1] != 0:
            raise ValueError(f"{path.name}: tiepoint not at raster (0, 0)")
        self.sx, self.sy, self.x0, self.y0 = sx, sy, tp[3], tp[4]
        self.raster_type = h["geokeys"].get("GTRasterType")  # 1 = PixelIsArea, 2 = PixelIsPoint
        self.dc = 0.5 if self.raster_type in (None, 1) else 0.0
        nd = t.get("GDAL_NODATA")
        self.nodata = None if nd is None else float(nd)
        self._f = open(path, "rb")
        self._mm = mmap.mmap(self._f.fileno(), 0, access=mmap.ACCESS_READ)
        self.data = memoryview(self._mm)[offs[0]: offs[0] + row_bytes * self.height].cast(self.code)

    def close(self) -> None:
        self.data.release()
        self._mm.close()
        self._f.close()

    def centre(self, c: float, r: float) -> tuple[float, float]:
        return self.x0 + (c + self.dc) * self.sx, self.y0 - (r + self.dc) * self.sy

    def frac_index(self, X: float, Y: float) -> tuple[float, float]:
        """Map metres -> fractional 0-based (column, row) in pixel-centre coordinates."""
        return (X - self.x0) / self.sx - self.dc, (self.y0 - Y) / self.sy - self.dc

    def at(self, c: int, r: int):
        if 0 <= c < self.width and 0 <= r < self.height:
            return self.data[r * self.width + c]
        return None


# ------------------------------------------------------------------ rasters for the ray march

BLOCK = 4  # 5 m -> 20 m block mean; lands on LDEM_80S_20M's pixel-centre grid for Site01


def _pole_grid(x0: float, y0: float, s: float, dc: float, w: int, h: int) -> tuple[int, int, int]:
    """(n_full, i_first, j_first) so that terrain_horizon.Raster's pole-centred 1-based
    convention X = (I - n/2 - 0.5) s, Y = -(J - n/2 - 0.5) s reproduces the GeoTIFF's
    pixel centres exactly. Raises if the GeoTIFF grid is not on such a lattice."""
    a = x0 / s + dc + 0.5        # i_first - n/2
    b = -y0 / s + dc + 0.5       # j_first - n/2
    if abs(a - round(a)) > 1e-9 or abs(b - round(b)) > 1e-9:
        raise ValueError("GeoTIFF pixel centres are not on a pole-centred lattice")
    n = 2 * (int(max(abs(a), abs(b))) + w + h + 2)
    return n, int(round(a)) + n // 2, int(round(b)) + n // 2


def block_mean_path(site: str) -> Path:
    return RAW_DIR / site.lower() / f"{site}_5mpp_surf_block{BLOCK}.f32"


def build_block_mean(site: str) -> Path:
    """Derived cache: BLOCK x BLOCK mean of the surface (NaN if any input is NaN), float32 raw."""
    import array
    src = GeoTiff(path_of(site, "surf"))
    w, h = src.width // BLOCK, src.height // BLOCK
    out = array.array("f", bytes(4 * w * h))
    d, W = src.data, src.width
    for br in range(h):
        rows = [(br * BLOCK + k) * W for k in range(BLOCK)]
        for bc in range(w):
            c0 = bc * BLOCK
            vals = [d[r + c0 + k] for r in rows for k in range(BLOCK)]
            out[br * w + bc] = sum(vals) / len(vals)  # NaN propagates
    p = block_mean_path(site)
    p.write_bytes(out.tobytes())
    meta = load_meta(site)
    meta[f"block{BLOCK}"] = {"derived_from": path_of(site, "surf").name, "source_sha256": meta["surf"]["sha256"],
                             "width": w, "height": h, "pixel_m": src.sx * BLOCK,
                             "sha256": hashlib.sha256(p.read_bytes()).hexdigest(), "created_utc": _utc()}
    _meta_path(site).write_text(json.dumps(meta, indent=2) + "\n", "utf-8")
    return p


def raster(name: str):
    """terrain_horizon.Raster for a PGDA product name:
    PGDA_<SITE>_5M     surface + LDEC counts (memory-mapped GeoTIFFs)
    PGDA_<SITE>_5M_B4  4 x 4 block mean of the same surface (20 m), no counts."""
    import terrain_horizon as th
    parts = name.split("_")
    site = parts[1].capitalize()  # SITE01 -> Site01
    g = GeoTiff(path_of(site, "surf"))
    if name.endswith("_5M"):
        c = GeoTiff(path_of(site, "ldec"))
        if (c.width, c.height, c.x0, c.y0, c.sx) != (g.width, g.height, g.x0, g.y0, g.sx):
            raise ValueError(f"{name}: LDEC grid differs from the surface grid")
        n, i1, j1 = _pole_grid(g.x0, g.y0, g.sx, g.dc, g.width, g.height)
        return th.Raster(name=name, n_full=n, scale_m=g.sx, scaling=1.0, dn=g.data, width=g.width,
                         height=g.height, i_first=i1, j_first=j1, counts=c.data, counts_name=name + "_LDEC",
                         _keep=[g, c])
    if name.endswith(f"_5M_B{BLOCK}"):
        meta = load_meta(site).get(f"block{BLOCK}")
        p = block_mean_path(site)
        if not meta or not p.exists() or meta["source_sha256"] != load_meta(site)["surf"]["sha256"]:
            raise FileNotFoundError(f"{p} missing or stale; run terrain_5m.py")
        f = open(p, "rb")
        mm = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
        s = g.sx * BLOCK
        # block centre = corner + (BLOCK/2) fine pixels = corner + 0.5 coarse pixel
        n, i1, j1 = _pole_grid(g.x0, g.y0, s, 0.5, meta["width"], meta["height"])
        return th.Raster(name=name, n_full=n, scale_m=s, scaling=1.0, dn=memoryview(mm).cast("f"),
                         width=meta["width"], height=meta["height"], i_first=i1, j_first=j1,
                         counts=None, counts_name=None, _keep=[f, mm, g])
    raise ValueError(f"unknown PGDA product {name}")


def main() -> int:
    cmd, site, *layers = sys.argv[1:]
    for layer in layers:
        if cmd == "fetch":
            t0 = time.time()
            p, m = fetch(site, layer)
            print(f"{p.relative_to(REPO_ROOT)}: {m['bytes']:,} bytes, sha256 {m['sha256'][:16]}... "
                  f"({time.time() - t0:.0f} s)", flush=True)
        elif cmd == "info":
            h = read_header(path_of(site, layer))
            print(json.dumps({k: v for k, v in h.items() if not k.startswith("_")}, indent=1, default=str))
        else:
            raise SystemExit(f"unknown command {cmd}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
