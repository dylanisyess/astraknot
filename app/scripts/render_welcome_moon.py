"""Welcome-screen Moon image (display only; never used for status, metrics or skylines).

Renders a static orthographic view of the near side (centre 0 deg N, 0 deg E, north up, as seen
from Earth) from NASA's CGI Moon Kit colour map, which NASA's Scientific Visualization Studio
adapted from the LRO LROC WAC Hapke-normalized mosaic (643/566/415 nm; poles filled from LOLA
albedo). https://svs.gsfc.nasa.gov/4720/  Credit: NASA's Scientific Visualization Studio.

No displacement or relief exaggeration is used: brightness is the map's albedo under a gentle,
fixed light from slightly upper left (Lommel-Seeliger/Lambert mix), so maria and highlands read
naturally. Colour is partly desaturated for the page's restrained palette. It is an illustration,
not a photograph of a particular date.

The equirectangular map is centred on 0 deg longitude (east to the right) and spans 90N..90S.
The texture is downloaded separately (not stored in the repository):

    curl -o lroc_color_poles_4k.tif https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_poles_4k.tif
    python app/scripts/render_welcome_moon.py --texture lroc_color_poles_4k.tif
"""

import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / "app/public/welcome"
OUT_META = ROOT / "app/src/welcome/moonImage.json"
SOURCE_URL = "https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_poles_4k.tif"
LAT0, LON0 = 0.0, 0.0  # sub-Earth view
WIDTHS = [560, 960, 1400]  # shipped square sizes (px)
RENDER = 2800  # supersampled render, downsampled for anti-aliasing
LIGHT = np.array([-0.16, 0.11, 1.0])  # view frame: x right, y up, z toward the viewer
SATURATION = 0.45
BACKGROUND = (5, 5, 6)  # page background, for the opaque JPEG fallback


def srgb_to_linear(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--texture", required=True, type=Path)
    args = ap.parse_args()
    tex_bytes = args.texture.read_bytes()
    tex = Image.open(args.texture).convert("RGB")
    W, H = tex.size
    assert W == 2 * H, "expected a 2:1 equirectangular map"
    t = np.asarray(tex, dtype=np.float32) / 255.0

    n = RENDER
    u = (np.arange(n) + 0.5) / n * 2 - 1
    x, y = np.meshgrid(u, -u)
    rho2 = x * x + y * y
    inside = rho2 < 1.0
    z = np.sqrt(np.clip(1 - rho2, 0, 1))  # sphere normal toward the viewer (= cos emission)
    # inverse orthographic projection (centre LAT0, LON0)
    p0 = math.radians(LAT0)
    lat = np.degrees(np.arcsin(np.clip(y * math.cos(p0) + z * math.sin(p0), -1, 1)))
    lon = LON0 + np.degrees(np.arctan2(x, z * math.cos(p0) - y * math.sin(p0)))
    # map pixel coordinates: column 0 = 180 W, centre = 0 deg; row 0 = 90 N (pixel centres at +0.5)
    cx = np.mod((lon + 180.0) / 360.0 * W - 0.5, W)
    cy = np.clip((90.0 - lat) / 180.0 * H - 0.5, 0, H - 1)
    x0, y0 = np.floor(cx).astype(int), np.floor(cy).astype(int)
    fx, fy = (cx - x0)[..., None], (cy - y0)[..., None]
    x1, y1 = (x0 + 1) % W, np.minimum(y0 + 1, H - 1)
    alb = (t[y0, x0] * (1 - fx) * (1 - fy) + t[y0, x1] * fx * (1 - fy) + t[y1, x0] * (1 - fx) * fy + t[y1, x1] * fx * fy)

    lin = srgb_to_linear(alb)
    L = LIGHT / np.linalg.norm(LIGHT)
    mu0 = np.clip(x * L[0] + y * L[1] + z * L[2], 0, 1)
    ls = 2 * mu0 / (mu0 + np.maximum(z, 1e-4))  # Lommel-Seeliger, 1 at the centre of a full disc
    shade = 0.14 + 0.86 * (0.7 * ls + 0.3 * mu0)  # small ambient floor: the far limb never reads as a shadow
    lin = lin * shade[..., None] * 1.05
    grey = (lin * np.array([0.2126, 0.7152, 0.0722])).sum(axis=-1, keepdims=True)
    lin = grey + (lin - grey) * SATURATION
    rgb = linear_to_srgb(lin)
    rgb[~inside] = 0
    edge = np.clip((1 - np.sqrt(rho2)) * n / 2, 0, 1)  # one-pixel anti-aliased limb
    rgba = np.dstack([rgb, edge]).astype(np.float32)
    big = Image.fromarray((rgba * 255 + 0.5).astype(np.uint8), "RGBA")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    files = []
    for w in WIDTHS:
        im = big.resize((w, w), Image.LANCZOS)
        for ext, kw in (("avif", {"quality": 60, "speed": 4}), ("webp", {"quality": 80, "method": 6})):
            p = OUT_DIR / f"moon-{w}.{ext}"
            im.save(p, ext.upper(), **kw)
            files.append(p)
    fb = Image.new("RGB", big.size, BACKGROUND)
    fb.paste(big, mask=big.split()[3])
    jp = OUT_DIR / "moon-960.jpg"
    fb.resize((960, 960), Image.LANCZOS).save(jp, "JPEG", quality=82, optimize=True, progressive=True)
    files.append(jp)

    meta = {
        "files": {p.name: {"bytes": p.stat().st_size, "sha256": hashlib.sha256(p.read_bytes()).hexdigest()} for p in files},
        "widths": WIDTHS,
        "fallback": jp.name,
        "projection": {"type": "orthographic", "center_lat_deg": LAT0, "center_lon_deg_east": LON0, "north_up": True},
        "source": {
            "name": "CGI Moon Kit colour map (2019), lroc_color_poles_4k.tif, 4096x2048",
            "page": "https://svs.gsfc.nasa.gov/4720/",
            "url": SOURCE_URL,
            "sha256": hashlib.sha256(tex_bytes).hexdigest(),
            "derived_from": "LRO LROC WAC Hapke-normalized mosaic (643, 566, 415 nm); polar fill from LOLA albedo",
            "credit": "NASA's Scientific Visualization Studio",
        },
        "rendering": f"Static orthographic near side; no displacement; fixed gentle light (Lommel-Seeliger/Lambert mix); saturation {SATURATION:g}. Illustration, not a photograph of a particular date.",
        "reproduce": "python app/scripts/render_welcome_moon.py --texture lroc_color_poles_4k.tif",
    }
    OUT_META.write_text(json.dumps(meta, indent=2) + "\n")
    for p in files:
        print(p.name, p.stat().st_size)


if __name__ == "__main__":
    main()
