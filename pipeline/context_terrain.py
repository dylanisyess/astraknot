"""Wide context terrain for 3D Explore: coarse rings around each site's detailed mesh.

Run from the repository root:
    python pipeline/context_terrain.py                # every site with a published render mesh
    python pipeline/context_terrain.py --site im1-odysseus

Writes app/public/render/<id>.context.json and <id>.context.bin. Reads the cached local
DEMs through the same source registry and bilinear sampler as the terrain horizon
(pipeline/terrain_sources.py). It changes no existing file: the detailed meshes, slope
assets, site exports and prepared bundles are only read.

Display only. Nothing here enters a visibility status, metric, skyline or observer; the
Horizon view still clips all terrain to the exported skyline profile.

Format (render-context-1): per level a square local gnomonic grid (x east, z = -north,
metres in the tangent plane at the site), stored as little-endian float32 heights above
the 1737.4 km sphere, row-major (index = j * nx + i, x = (i - c) * spacing,
z = (j - c) * spacing, c = (nx - 1) / 2); NaN = no local DEM. The renderer reconstructs
the observer-frame position exactly (see `local_position`), so no positions are stored.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ProcessPoolExecutor
import hashlib
import json
import math
from pathlib import Path
import struct
import sys

import terrain_horizon as th
import terrain_sources as ts

VERSION = "render-context-1"
ROOT = ts.ROOT
RENDER = ROOT / "app/public/render"
# (spacing m, half-width m). Each level's hole is exactly the previous level's square.
LEVELS = [(60, 7680), (240, 30720), (960, 92160)]


def enu(lat: float, lon: float):
    return th.enu(lat, lon)


def unit_at(frame, x: float, z: float):
    """Same gnomonic construction as prepare_site.local_unit (copied so that module stays unmodified)."""
    e, n, u = frame
    p = tuple(u[k] + e[k] * x / th.R - n[k] * z / th.R for k in range(3))
    s = math.sqrt(sum(v * v for v in p))
    return tuple(v / s for v in p)


def local_position(x: float, z: float, h: float, r_obs: float):
    """Observer-frame position (x east, y up, z -north) of height h at gnomonic (x, z).
    Equal to Frame.local((R + h) * unit_at(x, z)); the renderer uses this closed form."""
    q = math.sqrt(1 + (x * x + z * z) / (th.R * th.R))
    r = th.R + h
    return r * x / (th.R * q), r / q - r_obs, r * z / (th.R * q)


_terrain = None
_frame = None


def _init(registry: str, lat: float, lon: float):
    global _terrain, _frame
    _terrain = ts.Terrain(Path(registry))
    _frame = enu(lat, lon)


def _row(task):
    spacing, n, j = task
    c = (n - 1) // 2
    out, used, missing = [], set(), 0
    z = (j - c) * spacing
    for i in range(n):
        p = unit_at(_frame, (i - c) * spacing, z)
        try:
            h, src = _terrain.sample(*th.latlon(p), local=True)
            out.append(h)
            used.add(src.id)
        except ts.CoverageError:
            out.append(float("nan"))
            missing += 1
    return j, out, sorted(used), missing


def snap_to_outer(h_in: list[float], n_in: int, h_out: list[float], n_out: int, ratio: int, lo: int):
    """Set the inner level's boundary heights to the outer level's edge (linear between its
    vertices) so the two meshes meet without cracks. Chord sagitta is millimetres."""
    last = n_in - 1

    def outer(i: int, j: int) -> float:
        return h_out[(lo + j) * n_out + (lo + i)]

    rim = {(t, 0) for t in range(n_in)} | {(t, last) for t in range(n_in)} | {(0, t) for t in range(n_in)} | {(last, t) for t in range(n_in)}
    snapped = 0
    for (i, j) in sorted(rim):
        if i % ratio == 0 and j % ratio == 0:
            continue  # coincides with an outer vertex: unchanged
        if j in (0, last):  # on a row edge: interpolate along i
            a, f = divmod(i, ratio)
            v0, v1 = outer(a, j // ratio), outer(a + 1, j // ratio)
        else:  # on a column edge: interpolate along j
            a, f = divmod(j, ratio)
            v0, v1 = outer(i // ratio, a), outer(i // ratio, a + 1)
        k = j * n_in + i
        h_in[k] = float("nan") if math.isnan(v0) or math.isnan(v1) else v0 + (v1 - v0) * f / ratio
        snapped += 1
    return snapped


def build(site_id: str, workers: int = 4) -> dict:
    near_path = RENDER / f"{site_id}.terrain.json"
    near = json.loads(near_path.read_text("utf-8"))
    near_bin = (RENDER / near["bin_file"]).read_bytes()
    if hashlib.sha256(near_bin).hexdigest() != near["bin_sha256"]:
        raise SystemExit(f"{near['bin_file']} does not match its metadata; refusing to build context terrain")
    site = near["site"]
    obs = near["observer"]
    r_obs = obs["observer_radius_m"]
    if abs(r_obs - (th.R + site["horizons_site_altitude_km"] * 1000)) > 1e-6:
        raise SystemExit("near mesh observer radius differs from its site altitude")
    lat, lon = site["latitude_deg"], site["longitude_deg_east"]
    levels_h, level_meta = [], []
    with ProcessPoolExecutor(max_workers=workers, initializer=_init, initargs=(str(ts.REGISTRY), lat, lon)) as pool:
        for li, (spacing, half) in enumerate(LEVELS):
            n = 2 * half // spacing + 1
            rows = [None] * n
            used, missing = set(), 0
            for j, out, u, m in pool.map(_row, [(spacing, n, j) for j in range(n)], chunksize=4):
                rows[j] = out
                used.update(u)
                missing += m
            h = [v for r in rows for v in r]
            hole = None
            if li:
                ps, phalf = LEVELS[li - 1]
                c = (n - 1) // 2
                k = phalf // spacing
                hole = [c - k, c + k, c - k, c + k]
            levels_h.append(h)
            level_meta.append(dict(index=li, spacing_m=spacing, half_width_m=half, nx=n, ny=n, hole_cells=hole,
                                   nodata_vertices=missing, sources_used=sorted(used)))
            print(f"  {site_id} level {li}: {n}x{n} at {spacing} m to {half / 1000:.2f} km; sources {sorted(used)}; nodata {missing}", flush=True)
    # crack-free nesting: each inner level's rim follows the next level's edge
    for li in range(len(LEVELS) - 1):
        n_in, n_out = level_meta[li]["nx"], level_meta[li + 1]["nx"]
        ratio = LEVELS[li + 1][0] // LEVELS[li][0]
        lo = level_meta[li + 1]["hole_cells"][0]
        level_meta[li]["rim_vertices_snapped"] = snap_to_outer(levels_h[li], n_in, levels_h[li + 1], n_out, ratio, lo)
    level_meta[-1]["rim_vertices_snapped"] = 0
    blob, offset = bytearray(), 0
    for m, h in zip(level_meta, levels_h):
        b = struct.pack(f"<{len(h)}f", *h)
        m.update(byte_offset=offset, byte_length=len(b), vertex_count=len(h))
        finite = [v for v in h if not math.isnan(v)]
        m["height_range_m"] = [min(finite), max(finite)] if finite else None
        blob += b
        offset += len(b)
    # reference positions through the full vector construction (renderer self-check)
    frame = enu(lat, lon)
    checks = []
    for li, m in enumerate(level_meta):
        n, s = m["nx"], m["spacing_m"]
        c = (n - 1) // 2
        for (i, j) in ((0, 0), (n - 1, c), (c, n - 1), (n // 7, n // 3)):
            h = levels_h[li][j * n + i]
            if math.isnan(h):
                continue
            x, z = (i - c) * s, (j - c) * s
            p = unit_at(frame, x, z)
            P = tuple((th.R + h) * v for v in p)
            o = tuple(r_obs * v for v in frame[2])
            d = tuple(P[k] - o[k] for k in range(3))
            dot = lambda a: sum(a[k] * d[k] for k in range(3))  # noqa: E731
            ref = (dot(frame[0]), dot(frame[2]), -dot(frame[1]))
            closed = local_position(x, z, h, r_obs)
            assert max(abs(a - b) for a, b in zip(ref, closed)) < 1e-6, (ref, closed)
            checks.append(dict(level=li, i=i, j=j, local_m=[round(v, 4) for v in ref]))
    reg = ts.REGISTRY.read_bytes()
    bin_name = f"{site_id}.context.bin"
    used_all = sorted({s for m in level_meta for s in m["sources_used"]})
    meta = dict(
        asset_version=VERSION, is_rendering_asset=True,
        note=("Wide context terrain for orientation: coarse rings around the detailed mesh, sampled bilinearly from the "
              "cached local DEMs (<=100 m pixels) by source priority. No invented detail, no vertical exaggeration; "
              "curvature once. Never used for visibility, metrics or the skyline; Horizon view clips it to the exported profile."),
        site=site, observer=dict(observer_radius_m=r_obs, eye_above_dem_surface_m=obs["eye_above_dem_surface_m"]),
        reference_radius_m=th.R,
        frame=dict(axes="x = east, y = up, z = -north, origin at the observer eye (same frame as the detailed mesh)",
                   grid="local gnomonic plane at the site: unit = normalize(up + east * x / R - north * z / R), R = 1737.4 km",
                   position=("q = sqrt(1 + (x^2 + z^2) / R^2); position = ((R + h) x / (R q), (R + h) / q - observer_radius_m, "
                             "(R + h) z / (R q))"),
                   heights="float32 little-endian, metres above the 1737.4 km sphere, row-major j * nx + i, x = (i - c) * spacing, z = (j - c) * spacing, c = (nx - 1) / 2; NaN = no local DEM"),
        sources_used=used_all,
        source_registry_sha256=hashlib.sha256(reg).hexdigest(),
        source_sha256={s.id: s.digest for s in ts.Terrain().sources if s.id in used_all},
        detailed_mesh=dict(file=near_path.name, bin_sha256=near["bin_sha256"], outer_half_width_m=near["sampling"]["outer_half_width_m"],
                           relation="The renderer omits context cells lying inside the detailed mesh and keeps the detailed mesh on top where they meet."),
        levels=level_meta,
        counts=dict(vertices=sum(m["vertex_count"] for m in level_meta), bin_bytes=len(blob)),
        outer_half_width_m=LEVELS[-1][1],
        check_points=checks,
        reproduce=f"python pipeline/context_terrain.py --site {site_id}",
        bin_file=bin_name, bin_sha256=hashlib.sha256(blob).hexdigest(),
    )
    (RENDER / bin_name).write_bytes(bytes(blob))
    (RENDER / f"{site_id}.context.json").write_text(json.dumps(meta, indent=1, allow_nan=False) + "\n", "utf-8", newline="\n")
    return meta


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--site", action="append", help="site id (repeatable); default: every site with a render mesh")
    ap.add_argument("--workers", type=int, default=4)
    a = ap.parse_args()
    ids = a.site or sorted(p.name[: -len(".terrain.json")] for p in RENDER.glob("*.terrain.json"))
    for sid in ids:
        m = build(sid, a.workers)
        print(f"WROTE render/{sid}.context.json + .bin: {m['counts']['vertices']} vertices, {m['counts']['bin_bytes']} bytes, sources {m['sources_used']}")


if __name__ == "__main__":
    sys.exit(main())
