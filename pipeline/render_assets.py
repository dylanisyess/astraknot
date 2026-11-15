"""Rendering assets for the 3D Explore view (milestone 5A). NOT scientific data.

Writes, per site:
  app/public/render/<site_id>.terrain.json   metadata, provenance, levels, mesh check summary
  app/public/render/<site_id>.terrain.bin    float32 little-endian x, y, z per vertex, level after level
  data/render/<site_id>_mesh_check.json      per-azimuth mesh silhouette vs the exported profile

Nothing here changes a visibility state, an interval, a horizon profile or a site
export. The app's status comes only from the exported data (app/src/status.ts);
these meshes are drawn for orientation.

Source and registration (the same as the terrain horizon):
  * DEM: LDEM_80S_20M (PDS LRO-L-LOLA-4-GDR-V1.0 V2.0), read through
    terrain_horizon.Raster (memory-mapped, size checked against the label),
    heights = DN x 0.5 m above the 1737.4 km sphere, bilinear between pixel
    centres (Raster.height_bilinear), pixel centres at I = X/s + N/2 + 0.5,
    J = -Y/s + N/2 + 0.5.
  * Observer: the exported terrain_horizon.observer point, r_o = 1737.4 km +
    Horizons site altitude, on the site's unit vector (terrain_horizon.site_observer).

Vertices:
  * Each level is a square grid in polar-stereographic map space, aligned to the
    DEM's own pixel centres (anchor = pixel centre nearest the site). Spacing is
    a fraction or multiple of the 20 m pixel. Sub-pixel vertices are bilinear
    interpolations of the DEM: they add no measured detail. Coarse levels use
    every k-th pixel centre (decimated overview geometry).
  * Map (X, Y) -> unit vector p by the exact inverse of terrain_horizon.stereo_xy;
    Moon-centred P = (1737.4 km + h) p in float64; d = P - r_o u; then
    x = d.east, y = d.up, z = -(d.north) in the observer's local frame
    (terrain_horizon.enu). Curvature is therefore in the positions exactly once
    (no separate drop is applied), negative elevations are kept, and there is
    no vertical exaggeration. Only the final observer-relative values are
    rounded to float32 (about 4 mm at 45 km).
  * Renderer convention: x = east, y = up, z = -north; a direction (az, el) is
    (cos el sin az, sin el, -cos el cos az).
  * Levels are nested. A coarser level omits the cells covered by the finer
    one. The outer boundary vertices of a finer level that fall between coarser
    vertices are moved onto the coarser edge (3D linear interpolation) so the
    rings meet without cracks; this is recorded and included in the check.
  * Triangulation (the app does the same): cell (i, j) with corners
    v00 = (i, j), v10 = (i+1, j), v01 = (i, j+1), v11 = (i+1, j+1) gives the
    triangles (v00, v01, v10) and (v10, v01, v11); vertex index = j * nx + i,
    i along +X (map), j along +J (map -Y).

Mesh check (rendering evidence, not source-data accuracy):
  For every profile azimuth (0.1 deg) the exact silhouette of the exported mesh
  seen from the observer is computed by intersecting each triangle with the
  vertical half-plane of that azimuth (the elevation angle along a straight
  segment is monotonic, so the maximum is at a segment end). Its difference from
  the exported terrain profile is reported separately for azimuths whose
  profile-setting point lies inside the meshed extent (representation error)
  and outside it (incomplete extent). 0.05 deg is a proposed rendering target,
  not a statement of source-data accuracy.

    python pipeline/render_assets.py --site connecting-ridge-cr1
    python pipeline/render_assets.py --site im2-athena
    python pipeline/render_assets.py --site connecting-ridge-cr1 --near-sub 1 --report-only   # 20 m control
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
import sys
import time
from array import array
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lola  # noqa: E402
import sites  # noqa: E402
import terrain_horizon as th  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
APP_DATA = REPO / "app" / "public" / "data"
OUT_APP = REPO / "app" / "public" / "render"
OUT_EVIDENCE = REPO / "data" / "render"
R = th.R
PRODUCT = "LDEM_80S_20M"
ASSET_VERSION = "render-terrain-1"
TARGET_DEG = 0.05
FINE = 8  # grid unit = 1/8 pixel (2.5 m)

# Per-site levels: (spacing in grid units of 1/8 px, half-width in grid units).
# Half-widths are multiples of the next level's spacing so rings align.
LEVELS = {
    # CR1: skyline set 50-480 m away. Fine 2.5 m interpolation to +-640 m, then 20 m, 80 m.
    "connecting-ridge-cr1": [(1, 256), (8, 1024), (32, 4096)],
    # Athena: skyline set 0.33-29.7 km away. 5 m to +-640 m, 20 m to +-2.56 km, 40 m to
    # +-10.24 km, 160 m to +-30.72 km (map-space square; covers every azimuth to >= 30.7 km).
    "im2-athena": [(2, 256), (8, 1024), (16, 4096), (64, 12288)],
}
# Fine reference march for the mesh check: (radial step m, max distance m).
FINE_REF = {"connecting-ridge-cr1": (0.25, 1000.0), "im2-athena": (1.0, 2000.0)}


# ------------------------------------------------------------------ geometry (pure, tested)

def stereo_inverse(X: float, Y: float) -> tuple[float, float, float]:
    """South polar stereographic map metres -> unit vector; exact inverse of terrain_horizon.stereo_xy."""
    q2 = (X * X + Y * Y) / (4 * R * R)
    k = 1.0 / (R * (q2 + 1.0))
    return (Y * k, X * k, (q2 - 1.0) / (q2 + 1.0))


class Frame:
    """Observer-relative local frame. Renderer axes: x = east, y = up, z = -north."""

    def __init__(self, lat: float, lon: float, r_obs: float):
        self.e, self.n, self.u = th.enu(lat, lon)
        self.o = tuple(r_obs * c for c in self.u)
        self.r_obs = r_obs

    def local(self, P: tuple[float, float, float]) -> tuple[float, float, float]:
        d = (P[0] - self.o[0], P[1] - self.o[1], P[2] - self.o[2])
        dot = lambda a: a[0] * d[0] + a[1] * d[1] + a[2] * d[2]  # noqa: E731
        return dot(self.e), dot(self.u), -dot(self.n)


def direction(az_deg: float, el_deg: float) -> tuple[float, float, float]:
    a, e = math.radians(az_deg), math.radians(el_deg)
    return math.cos(e) * math.sin(a), math.sin(e), -math.cos(e) * math.cos(a)


def az_el(x: float, y: float, z: float) -> tuple[float, float]:
    return math.degrees(math.atan2(x, -z)) % 360.0, math.degrees(math.atan2(y, math.hypot(x, z)))


# ------------------------------------------------------------------ grid construction

def build_levels(raster: th.Raster, frame: Frame, anchor: tuple[int, int], spec: list[tuple[int, int]]):
    """Return a list of level dicts with float64 local positions (flat list xyz)."""
    c = raster.n_full / 2 + 0.5
    s = raster.scale_m
    Ia, Ja = anchor
    levels = []
    for li, (step, half) in enumerate(spec):
        if half % step:
            raise ValueError("half-width must be a multiple of the spacing")
        n = 2 * half // step + 1
        pos = [0.0] * (3 * n * n)
        heights = [0.0] * (n * n)
        for j in range(n):
            b = -half + j * step
            J = Ja + b / FINE
            for i in range(n):
                a = -half + i * step
                I = Ia + a / FINE
                h = raster.height_bilinear(I, J)
                if h is None:
                    raise RuntimeError(f"level {li}: grid leaves {raster.name} at I={I}, J={J}")
                X, Y = (I - c) * s, -(J - c) * s
                p = stereo_inverse(X, Y)
                r = R + h
                x, y, z = frame.local((r * p[0], r * p[1], r * p[2]))
                k = 3 * (j * n + i)
                pos[k], pos[k + 1], pos[k + 2] = x, y, z
                heights[j * n + i] = h
        levels.append({"step": step, "half": half, "n": n, "pos": pos, "h": heights, "snapped": 0})
    # stitch: snap each finer level's boundary vertices onto the next level's edges
    for li in range(len(levels) - 1):
        f, g = levels[li], levels[li + 1]
        r = g["step"] // f["step"]
        if g["step"] % f["step"] or f["half"] % g["step"]:
            raise ValueError("levels are not aligned")
        n, P = f["n"], f["pos"]
        moved = 0

        def snap(idx_of):  # idx_of(t) -> vertex index along one edge, t = 0..n-1
            nonlocal moved
            for t in range(n):
                m = t % r
                if m == 0:
                    continue
                a, b = idx_of(t - m), idx_of(t - m + r)
                w = m / r
                k = 3 * idx_of(t)
                for q in range(3):
                    P[k + q] = P[3 * a + q] * (1 - w) + P[3 * b + q] * w
                moved += 1

        snap(lambda t: t)                     # j = 0
        snap(lambda t: (n - 1) * n + t)       # j = n-1
        snap(lambda t: t * n)                 # i = 0
        snap(lambda t: t * n + n - 1)         # i = n-1
        f["snapped"] = moved
    # holes: cells of level l+1 inside level l's square
    for li in range(1, len(levels)):
        g, f = levels[li], levels[li - 1]
        lo = (g["half"] - f["half"]) // g["step"]
        hi = lo + 2 * f["half"] // g["step"]
        g["hole"] = [lo, hi, lo, hi]  # cells i in [lo, hi), j in [lo, hi) are omitted
    levels[0]["hole"] = None
    return levels


def triangles(level):
    """Yield vertex-index triples; must match app/src/explore/terrainAsset.ts."""
    n, hole = level["n"], level["hole"]
    for j in range(n - 1):
        for i in range(n - 1):
            if hole and hole[0] <= i < hole[1] and hole[2] <= j < hole[3]:
                continue
            v00, v10, v01, v11 = j * n + i, j * n + i + 1, (j + 1) * n + i, (j + 1) * n + i + 1
            yield v00, v01, v10
            yield v10, v01, v11


# ------------------------------------------------------------------ mesh silhouette

NAZ = 3600
AZ_STEP = 0.1
MIN_EL = -5.0  # every exported skyline is above -1.5 deg; triangles entirely below this cannot set it


def _silhouette_chunk(args):
    pos, tris = args
    best = [-90.0] * NAZ
    reach = [0.0] * NAZ  # farthest horizontal distance of mesh in each azimuth plane
    dist = [None] * NAZ
    for (a, b, c) in tris:
        V = [(pos[3 * a], pos[3 * a + 1], pos[3 * a + 2]), (pos[3 * b], pos[3 * b + 1], pos[3 * b + 2]),
             (pos[3 * c], pos[3 * c + 1], pos[3 * c + 2])]
        az = [math.degrees(math.atan2(v[0], -v[2])) for v in V]
        hd = [math.hypot(v[0], v[2]) for v in V]
        if min(hd) < 1e-6:
            continue
        a0 = az[0]
        un = [a0] + [a0 + ((x - a0 + 180.0) % 360.0 - 180.0) for x in az[1:]]
        lo, hi = min(un), max(un)
        if hi - lo > 180.0:
            continue  # contains the vertical through the eye (only the cell under the observer)
        el_max = max(math.degrees(math.atan2(v[1], h)) for v, h in zip(V, hd))
        far = max(hd)
        k0, k1 = math.ceil(lo / AZ_STEP - 1e-9), math.floor(hi / AZ_STEP + 1e-9)
        for k in range(k0, k1 + 1):
            kk = k % NAZ
            if far > reach[kk]:
                reach[kk] = far
            if el_max <= best[kk]:
                continue
            A = math.radians(k * AZ_STEP)
            sa, ca = math.sin(A), math.cos(A)
            # plane through the vertical axis containing (sin A, 0, -cos A); normal (cos A, 0, sin A)
            sd = [v[0] * ca + v[2] * sa for v in V]
            pts = []
            for p in range(3):
                q = (p + 1) % 3
                if sd[p] == 0.0:
                    pts.append(V[p])
                if (sd[p] < 0.0 < sd[q]) or (sd[q] < 0.0 < sd[p]):
                    t = sd[p] / (sd[p] - sd[q])
                    pts.append(tuple(V[p][m] + t * (V[q][m] - V[p][m]) for m in range(3)))
            for (x, y, z) in pts:
                fwd = x * sa - z * ca
                if fwd <= 0.0:
                    continue
                e = math.degrees(math.atan2(y, fwd))
                if e > best[kk]:
                    best[kk] = e
                    dist[kk] = fwd
    return best, reach, dist


def mesh_silhouette(levels, workers: int | None = None):
    jobs = []
    for lv in levels:
        pos = array("d", lv["pos"])
        tri = []
        for t in triangles(lv):
            # cheap prefilter: skip triangles entirely below MIN_EL
            ok = False
            for v in t:
                x, y, z = pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]
                if math.degrees(math.atan2(y, math.hypot(x, z) or 1e-9)) > MIN_EL:
                    ok = True
                    break
            if ok:
                tri.append(t)
        size = max(1, len(tri) // 32 + 1)
        for i in range(0, len(tri), size):
            jobs.append((pos, tri[i:i + size]))
    best = [-90.0] * NAZ
    reach = [0.0] * NAZ
    dist = [None] * NAZ
    with ProcessPoolExecutor(max_workers=workers) as ex:
        for b, r, d in ex.map(_silhouette_chunk, jobs):
            for k in range(NAZ):
                if b[k] > best[k]:
                    best[k], dist[k] = b[k], d[k]
                if r[k] > reach[k]:
                    reach[k] = r[k]
    return best, reach, dist


def percentile(v, p):
    s = sorted(v)
    if not s:
        return None
    return s[min(len(s) - 1, int(math.ceil(p / 100 * len(s))) - 1)]


def compare(best, reach, dist, profile_el, setting_km):
    inside, beyond = [], []
    rows = []
    for k in range(NAZ):
        e, sd = profile_el[k], setting_km[k]
        if e is None or sd is None:
            rows.append(None)
            continue
        diff = best[k] - e
        covered = sd * 1000.0 <= reach[k]
        (inside if covered else beyond).append(diff)
        rows.append({"az": round(k * AZ_STEP, 1), "mesh_deg": round(best[k], 5), "profile_deg": e,
                     "diff_deg": round(diff, 5), "setting_km": sd, "mesh_reach_km": round(reach[k] / 1000, 3),
                     "mesh_setting_km": None if dist[k] is None else round(dist[k] / 1000, 4), "covered": covered})

    def stats(v):
        if not v:
            return {"n": 0}
        a = [abs(x) for x in v]
        return {"n": len(v), "signed_min_deg": round(min(v), 5), "signed_max_deg": round(max(v), 5),
                "signed_mean_deg": round(sum(v) / len(v), 5), "abs_median_deg": round(percentile(a, 50), 5),
                "abs_p95_deg": round(percentile(a, 95), 5), "abs_max_deg": round(max(a), 5),
                "n_abs_over_target": sum(x > TARGET_DEG for x in a)}
    return {
        "target_deg": TARGET_DEG,
        "target_note": "0.05 deg is a proposed rendering target, not a statement of source-data accuracy.",
        "azimuths": NAZ,
        "setting_point_inside_mesh": stats(inside),
        "setting_point_beyond_mesh": stats(beyond),
        "meets_target_inside_mesh": bool(inside) and max(abs(x) for x in inside) <= TARGET_DEG,
    }, rows


# ------------------------------------------------------------------ main

def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--site", required=True)
    ap.add_argument("--near-sub", type=int, default=None,
                    help="override the finest level's spacing in 1/8-pixel units (1 = 2.5 m, 2 = 5 m, 8 = 20 m)")
    ap.add_argument("--report-only", action="store_true", help="measure only; write nothing")
    ap.add_argument("--no-check", action="store_true", help="skip the mesh silhouette check")
    ap.add_argument("--no-rehash", action="store_true", help="do not re-hash the 1.85 GB DEM")
    args = ap.parse_args()
    cfg, site = th.load_site(args.site)
    sid = site["id"]
    spec = [tuple(x) for x in LEVELS[sid]]
    if args.near_sub:
        spec[0] = (args.near_sub, spec[0][1])

    export = json.loads((APP_DATA / f"{sid}.json").read_text("utf-8"))
    tb = export["terrain_horizon"]
    obs_exp = tb["observer"]
    obs = th.site_observer(site)
    if abs(obs.r_obs - obs_exp["observer_radius_m"]) > 1e-6:
        raise SystemExit(f"observer radius {obs.r_obs} differs from export {obs_exp['observer_radius_m']}")

    t0 = time.time()
    raster = th.Raster.from_files(PRODUCT, None)
    lbl = lola.load_label(PRODUCT)
    img = lola.RAW_DIR / PRODUCT.lower() / f"{PRODUCT.lower()}.img"
    prod = next(p for p in tb["products"] if p["name"] == PRODUCT)
    digest = None if args.no_rehash else sha256_file(img)
    if digest is not None and digest != prod["sha256"]:
        raise SystemExit(f"{img} sha256 {digest} differs from the exported product record {prod['sha256']}")

    u = obs.u
    fi, fj = raster.pixel_of(*th.stereo_xy(u))
    foot = raster.height_bilinear(fi, fj)
    eye = obs.r_obs - R - foot
    if abs(eye - obs_exp["eye_above_dem_surface_m"]) > 1e-6:
        raise SystemExit(f"eye height {eye} differs from export {obs_exp['eye_above_dem_surface_m']}")
    anchor = (round(fi), round(fj))
    frame = Frame(obs.lat, obs.lon, obs.r_obs)
    levels = build_levels(raster, frame, anchor, spec)
    t1 = time.time()

    meta_levels, blob, total_v, total_t = [], bytearray(), 0, 0
    for li, lv in enumerate(levels):
        ntri = sum(1 for _ in triangles(lv))
        nv = lv["n"] * lv["n"]
        off = len(blob)
        blob += struct.pack(f"<{3 * nv}f", *lv["pos"])
        sp = lv["step"] * lola.load_label(PRODUCT).map_scale_m / FINE
        meta_levels.append({
            "index": li, "spacing_m": sp, "spacing_px": lv["step"] / FINE, "half_width_m": lv["half"] * raster.scale_m / FINE,
            "nx": lv["n"], "ny": lv["n"], "vertex_count": nv, "triangle_count": ntri, "byte_offset": off,
            "byte_length": 12 * nv, "hole_cells": lv["hole"], "boundary_vertices_snapped": lv["snapped"],
            "kind": ("bilinear interpolation between pixel centres (no added measured detail)" if lv["step"] < FINE
                     else "DEM pixel centres" if lv["step"] == FINE else f"every {lv['step'] // FINE}th pixel centre (decimated overview)"),
            "height_range_m": [round(min(lv["h"]), 2), round(max(lv["h"]), 2)],
        })
        total_v += nv
        total_t += ntri
    xs = [lv["pos"][k] for lv in levels for k in range(0, len(lv["pos"]), 3)]
    zs = [lv["pos"][k] for lv in levels for k in range(2, len(lv["pos"]), 3)]
    ys = [lv["pos"][k] for lv in levels for k in range(1, len(lv["pos"]), 3)]

    check, rows = None, None
    if not args.no_check:
        best, reach, dist = mesh_silhouette(levels)
        check, rows = compare(best, reach, dist, tb["horizon"]["elevation_deg"], tb["setting_points"]["distance_km"])
        # Second reference: the same bilinear DEM marched at a much finer radial step (same observer,
        # same 5 m first sample), to separate triangulation error from the profile's own 5 m sampling.
        step_m, max_m = FINE_REF[sid]
        ref = th.profile(obs, [k * AZ_STEP for k in range(NAZ)], [(PRODUCT, None)],
                         th.GLOBAL_MAX_HEIGHT_M + th.H_MAX_MARGIN_M,
                         sched_kw={"near_step": step_m, "near_limit": max_m + step_m, "far_step": step_m,
                                   "d_min": th.D_MIN_M, "d_max": max_m + 2 * step_m}, max_dist=max_m)
        fine_d = []
        prof_d = []
        for k, rr in enumerate(ref):
            prow = rows[k]
            if prow is None or rr["elevation_deg"] is None:
                continue
            # only where both the profile and the fine march are set well inside max_m
            if prow["setting_km"] * 1000 <= max_m - 50 and rr["distance_m"] <= max_m - 50:
                prow["fine_ref_deg"] = round(rr["elevation_deg"], 5)
                fine_d.append(best[k] - rr["elevation_deg"])
                prof_d.append(rr["elevation_deg"] - prow["profile_deg"])

        def st(v):
            if not v:
                return {"n": 0}
            a = [abs(x) for x in v]
            return {"n": len(v), "signed_min_deg": round(min(v), 5), "signed_max_deg": round(max(v), 5),
                    "abs_median_deg": round(percentile(a, 50), 5), "abs_p95_deg": round(percentile(a, 95), 5),
                    "abs_max_deg": round(max(a), 5), "n_abs_over_target": sum(x > TARGET_DEG for x in a)}
        check["fine_reference"] = {
            "method": (f"terrain_horizon.march on the same {PRODUCT} bilinear surface and observer, radial step "
                       f"{step_m} m from {th.D_MIN_M} m to {max_m} m; azimuths whose profile and fine-march setting "
                       f"points both lie within {max_m - 50:.0f} m."),
            "mesh_minus_fine_reference": st(fine_d),
            "fine_reference_minus_profile": st(prof_d),
            "interpretation": ("mesh_minus_fine_reference isolates triangulation/stitching error; "
                               "fine_reference_minus_profile is the exported profile's own radial-sampling effect "
                               "(5 m steps cut under sharp crests). Neither is a terrain accuracy."),
        }
        check["method"] = ("Exact silhouette of the exported triangles (float64 positions before float32 rounding) from the "
                           "observer, per 0.1 deg azimuth, by triangle / vertical half-plane intersection; compared with "
                           "terrain_horizon.horizon.elevation_deg of the site export. 'inside' = the profile's setting point "
                           "lies within the meshed extent in that azimuth (representation error); 'beyond' = it lies outside "
                           "(incomplete extent).")
    t2 = time.time()

    half_outer = levels[-1]["half"] * raster.scale_m / FINE
    meta = {
        "asset_version": ASSET_VERSION,
        "is_rendering_asset": True,
        "note": ("Rendering geometry for 3D Explore. Not scientific data: visibility states come only from the site "
                 "export's intervals. Positions are observer-relative metres in the renderer frame x = east, y = up, "
                 "z = -north; curvature is in the positions once; no vertical exaggeration."),
        "site": {"id": sid, "name": site["name"], "latitude_deg": site["latitude_deg"],
                 "longitude_deg_east": site["longitude_deg_east"], "horizons_site_altitude_km": site["horizons_site_altitude_km"]},
        "observer": {"observer_radius_m": obs.r_obs, "dem_surface_at_site_m": foot, "eye_above_dem_surface_m": eye,
                     "ground_below_eye_local_y_m": -eye,
                     "source": "same point as the site export's terrain_horizon.observer (checked to 1e-6 m)"},
        "frame": {"axes": "x = east, y = up, z = -north (right-handed, Y-up), origin at the observer eye",
                  "direction_formula": "(cos el * sin az, sin el, -cos el * cos az)",
                  "local_frame": "zenith = site radial unit vector (sphere), east = d/dlon, north = d/dlat (terrain_horizon.enu)",
                  "body_frame": "Moon ME/DE421 as the LOLA labels (assumed for the site coordinate; see site export)"},
        "source_dem": {"product": PRODUCT, "file": str(img.relative_to(REPO)).replace("\\", "/"), "url": prod["url"],
                       "sha256": prod["sha256"], "sha256_verified_this_run": digest is not None,
                       "label_lines_samples": [lbl.lines, lbl.samples], "map_scale_m": lbl.map_scale_m,
                       "height": "DN x 0.5 m above the 1737.4 km sphere; bilinear between pixel centres",
                       "registration": "pixel centres at I = X/s + N/2 + 0.5, J = -Y/s + N/2 + 0.5 (lola.py, terrain_horizon.Raster)",
                       "anchor_pixel_1based": list(anchor), "site_fractional_pixel": [fi, fj]},
        "sampling": {"grid": "square grids in polar-stereographic map space aligned to DEM pixel centres; nested levels",
                     "triangulation": "cell (i,j): (v00, v01, v10) and (v10, v01, v11); index = j * nx + i",
                     "outer_half_width_m": half_outer,
                     "unmeshed": (f"Terrain beyond the outer square (half-width {half_outer / 1000:.2f} km in map space) is not "
                                  "meshed. The exported skyline profile is computed from terrain to hundreds of km.")},
        "levels": meta_levels,
        "counts": {"vertices": total_v, "triangles": total_t, "bin_bytes": len(blob)},
        "local_bounds_m": {"x": [min(xs), max(xs)], "y": [min(ys), max(ys)], "z": [min(zs), max(zs)]},
        "mesh_check": check,
        "reproduce": f"python pipeline/render_assets.py --site {sid}",
        "runtime_s": {"build": round(t1 - t0, 1), "check": round(t2 - t1, 1)},
    }
    print(json.dumps({k: meta[k] for k in ("counts", "mesh_check")}, indent=1))
    for lv in meta_levels:
        print(f" level {lv['index']}: {lv['spacing_m']} m, +-{lv['half_width_m']} m, {lv['vertex_count']} v, {lv['triangle_count']} t")
    if args.report_only:
        return 0
    OUT_APP.mkdir(parents=True, exist_ok=True)
    OUT_EVIDENCE.mkdir(parents=True, exist_ok=True)
    (OUT_APP / f"{sid}.terrain.bin").write_bytes(bytes(blob))
    meta["bin_file"] = f"{sid}.terrain.bin"
    meta["bin_sha256"] = hashlib.sha256(blob).hexdigest()
    (OUT_APP / f"{sid}.terrain.json").write_text(json.dumps(meta, indent=1) + "\n", "utf-8", newline="\n")
    if rows is not None:
        ev = {"site": sites.identity(site), "asset_bin_sha256": meta["bin_sha256"],
              "site_export_sha256": sites.sha256(APP_DATA / f"{sid}.json"), "summary": check, "per_azimuth": rows}
        (OUT_EVIDENCE / f"{sid}_mesh_check.json").write_text(json.dumps(ev, separators=(",", ":")) + "\n", "utf-8", newline="\n")
    print(f"wrote {OUT_APP / (sid + '.terrain.bin')} ({len(blob)} bytes) and metadata")
    return 0


if __name__ == "__main__":
    sys.exit(main())
