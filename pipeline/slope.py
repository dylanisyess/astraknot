"""DEM-derived terrain slope for terrain hazard screening (milestone 5C).

A SCREENING ASSET, not visibility data and not a landing-safety assessment. Nothing here
changes a visibility state, an interval, a horizon profile, a site export or a rendering
mesh. It answers one bounded question: how steep is the LOLA 20 m DEM, at its own
measurement scale, within a fixed radius of each modeled observer?

Writes, per site:
  app/public/screening/<site_id>.slope.json   lazy-loaded by the app (slope grid, rings, stats)
  data/screening/<site_id>_slope_report.json  evidence (method, coverage, stats, checks)

Source and registration (the same as the terrain horizon and the 3D mesh):
  * DEM: LDEM_80S_20M (PDS LRO-L-LOLA-4-GDR-V1.0 V2.0), read through terrain_horizon.Raster
    (memory-mapped, size checked against the label). Height = DN x 0.5 m above the
    1737.4 km sphere (vertical unit metres). Pixel centres at I = X/s + N/2 + 0.5,
    J = -Y/s + N/2 + 0.5 (1-based), s = 20 m of map distance.
  * Heights are the DN values at pixel centres. No bilinear interpolation, no render mesh,
    no shading normals and no 2.5 m / 5 m render subdivision is used.

Slope method (Horn 1981 3x3 weighted gradient, evaluated on true 3D positions):
  * Each pixel centre (I, J) of the 3x3 neighbourhood is placed at its true Moon-centred
    position P = (1737.4 km + h) p(X, Y), with p the exact inverse stereographic unit vector.
    Horizontal distances therefore include the projection scale factor k = 2/(1 + sin|lat|)
    (map/ground; 1.0021 at Athena, 1.00002 at CR1) and the terrain radius exactly: nothing
    assumes 20 m of ground per pixel.
  * Horn tangents: T_I = sum_w [P(I+1, J+d) - P(I-1, J+d)], T_J = sum_w [P(I+d, J+1) - P(I+d, J-1)]
    with weights w = 1, 2, 1 for d = -1, 0, +1. Normal n = T_I x T_J, oriented upward.
  * Slope = angle between n and the local lunar vertical at the centre pixel (its radial
    unit vector on the sphere): the local lunar horizontal at that pixel. Because the
    differences are symmetric about the centre, the sphere's curvature cancels (flat ground
    on the sphere gives ~1e-9 deg), so curvature is not counted as steepness.
  * Aspect (downslope azimuth, clockwise from north) = azimuth of n's horizontal part in the
    centre pixel's east/north frame. Used by the tests; not exported to the app.
  * Measurement scale: the gradient is a difference across +-1 pixel, i.e. a 40 m ground
    baseline (39.92 m at Athena), from a 3 x 3 neighbourhood covering 60 m x 60 m. Each
    value is the slope of the 20 m DEM cell, not of anything smaller. The DEM itself is
    interpolated where no laser shot fell (LDEC count 0); the share is reported.
  * Invalid: any neighbourhood pixel missing (outside the raster, or equal to an explicit
    nodata DN; LOLA LDEMs have none). Invalid cells carry no slope and are excluded from
    every statistic; they are never treated as flat.

Footprint: pixel centres whose great-circle ground distance on the 1737.4 km sphere from
the site's unit vector (the modeled observer's vertical) is <= 500 m. Same radius, method,
DEM and threshold semantics at both sites. The exported grid is the footprint's bounding
square on the DEM's own pixels, anchored at the pixel centre nearest the site (the same
anchor as app/public/render/<site>.terrain.json, checked).

Area weighting: each pixel's planimetric ground area is (s / k)^2. Within 500 m, k varies by
< 3e-5 relative, so equal-area weighting is used; the weighted and unweighted statistics
are both computed and their difference is recorded in the evidence.

Statistics: nearest-rank percentiles on the stored 0.01 deg values (value at rank
ceil(p/100 * n) of the sorted valid cells), the same definition as the app. A cell exceeds
a threshold T when its stored slope is strictly greater than T (equal is not an exceedance).

    python pipeline/slope.py --site im2-athena
    python pipeline/slope.py --site connecting-ridge-cr1
    python pipeline/slope.py                  # both sites
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lola  # noqa: E402
import sites  # noqa: E402
import terrain_horizon as th  # noqa: E402
from render_assets import Frame, sha256_file, stereo_inverse  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
APP_DATA = REPO / "app" / "public" / "data"
RENDER = REPO / "app" / "public" / "render"
OUT_APP = REPO / "app" / "public" / "screening"
OUT_EVIDENCE = REPO / "data" / "screening"
R = th.R
PRODUCT = "LDEM_80S_20M"
COUNTS = "LDEC_80S_20M"
ASSET_VERSION = "slope-1"
RADIUS_M = 500.0
RING_RADII_M = (100.0, 250.0, 500.0)
RING_STEP_DEG = 2.0
DEFAULT_THRESHOLD_DEG = 15.0
REPORT_THRESHOLDS = (5.0, 10.0, 15.0, 20.0, 25.0, 30.0)
HORN = ((-1, 1), (0, 2), (1, 1))  # (offset, weight)

# Cell states in the exported grid.
OUTSIDE, VALID, INVALID = 0, 1, 2


# ------------------------------------------------------------------ geometry (pure, tested)

def _sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def pixel_xy(raster: th.Raster, i: float, j: float) -> tuple[float, float]:
    c = raster.n_full / 2 + 0.5
    return (i - c) * raster.scale_m, -(j - c) * raster.scale_m


def pixel_unit(raster: th.Raster, i: float, j: float) -> tuple[float, float, float]:
    return stereo_inverse(*pixel_xy(raster, i, j))


def pixel_point(raster: th.Raster, i: int, j: int, h: float) -> tuple[float, float, float]:
    p = pixel_unit(raster, i, j)
    r = R + h
    return (r * p[0], r * p[1], r * p[2])


def horn_slope(P: dict, up: tuple[float, float, float]) -> tuple[float, float, tuple]:
    """Slope and downslope azimuth from the 8 neighbour positions P[(di, dj)] (Moon-centred).

    `up` is the centre pixel's radial unit vector. Returns (slope_deg, aspect_deg, normal);
    the aspect is meaningless (returned as 0) when the slope is 0."""
    tI = [0.0, 0.0, 0.0]
    tJ = [0.0, 0.0, 0.0]
    for d, w in HORN:
        a = _sub(P[(1, d)], P[(-1, d)])
        b = _sub(P[(d, 1)], P[(d, -1)])
        for k in range(3):
            tI[k] += w * a[k]
            tJ[k] += w * b[k]
    n = _cross(tuple(tI), tuple(tJ))
    if _dot(n, up) < 0:
        n = (-n[0], -n[1], -n[2])
    nu = _dot(n, up)
    horiz = (n[0] - nu * up[0], n[1] - nu * up[1], n[2] - nu * up[2])
    hmag = math.sqrt(_dot(horiz, horiz))
    slope = math.degrees(math.atan2(hmag, nu))
    lat, lon = th.latlon(up)
    e, nn, _ = th.enu(lat, lon)
    aspect = math.degrees(math.atan2(_dot(horiz, e), _dot(horiz, nn))) % 360.0 if hmag > 0 else 0.0
    return slope, aspect, n


def cell_slope(raster: th.Raster, i: int, j: int, nodata_dn: int | None = None):
    """(slope_deg, aspect_deg) of pixel (i, j) from its 3x3 DEM neighbourhood, or None if any
    neighbour is missing (outside the raster or equal to nodata_dn). Never treats a gap as flat."""
    P = {}
    for di in (-1, 0, 1):
        for dj in (-1, 0, 1):
            dn = raster.dn_at(i + di, j + dj)
            if dn is None or (nodata_dn is not None and dn == nodata_dn):
                return None
            if di or dj:
                P[(di, dj)] = pixel_point(raster, i + di, j + dj, dn * raster.scaling)
    s, a, _ = horn_slope(P, pixel_unit(raster, i, j))
    return s, a


def ground_distance_m(u: tuple, p: tuple) -> float:
    """Great-circle distance on the 1737.4 km sphere between two unit vectors."""
    return R * math.atan2(math.sqrt(_dot(_cross(u, p), _cross(u, p))), _dot(u, p))


def destination(u: tuple, lat: float, lon: float, az_deg: float, d_m: float) -> tuple:
    """Unit vector at ground distance d along the great circle leaving u at azimuth az."""
    e, n, _ = th.enu(lat, lon)
    a = math.radians(az_deg)
    t = tuple(math.cos(a) * n[k] + math.sin(a) * e[k] for k in range(3))
    q = d_m / R
    return tuple(math.cos(q) * u[k] + math.sin(q) * t[k] for k in range(3))


def nearest_rank(sorted_vals: list, p: float):
    """Value at rank ceil(p/100 * n) (1-based) of an ascending list; None when empty."""
    if not sorted_vals:
        return None
    k = max(1, math.ceil(p / 100.0 * len(sorted_vals)))
    return sorted_vals[min(len(sorted_vals), k) - 1]


def exceed_fraction(cdeg: list, threshold_deg: float, weights: list | None = None) -> float | None:
    """Share of valid cells whose stored slope (0.01 deg units) is strictly above the threshold."""
    if not cdeg:
        return None
    t = round(threshold_deg * 100)
    if weights is None:
        return sum(1 for v in cdeg if v > t) / len(cdeg)
    tot = sum(weights)
    return sum(w for v, w in zip(cdeg, weights) if v > t) / tot


def fit_affine(samples: list[tuple[float, float, float, float]]):
    """Least-squares a, b = c0 + c1 x + c2 z for samples (x, z, a, b). Returns (ca, cb)."""
    S = [[0.0] * 3 for _ in range(3)]
    ra, rb = [0.0] * 3, [0.0] * 3
    for x, z, a, b in samples:
        v = (1.0, x, z)
        for r in range(3):
            for c in range(3):
                S[r][c] += v[r] * v[c]
            ra[r] += v[r] * a
            rb[r] += v[r] * b

    def solve(M, y):
        A = [row[:] + [y[k]] for k, row in enumerate(M)]
        for c in range(3):
            p = max(range(c, 3), key=lambda r: abs(A[r][c]))
            A[c], A[p] = A[p], A[c]
            for r in range(3):
                if r != c:
                    f = A[r][c] / A[c][c]
                    for k in range(c, 4):
                        A[r][k] -= f * A[c][k]
        return [A[k][3] / A[k][k] for k in range(3)]

    return solve(S, ra), solve(S, rb)


# ------------------------------------------------------------------ grid

def build_grid(raster: th.Raster, lat: float, lon: float, anchor: tuple[int, int], radius_m: float,
               nodata_dn: int | None = None) -> dict:
    """Slope of every DEM pixel whose centre lies within radius_m (ground) of the site."""
    u = th.unit(lat, lon)
    k_site = lola.stereo_scale_factor(lat)
    half = math.ceil(radius_m * k_site / raster.scale_m) + 1
    Ia, Ja = anchor
    n = 2 * half + 1
    state = [OUTSIDE] * (n * n)
    slope = [None] * (n * n)
    aspect = [None] * (n * n)
    dist = [0.0] * (n * n)
    weight = [0.0] * (n * n)
    for b in range(n):
        J = Ja - half + b
        for a in range(n):
            I = Ia - half + a
            p = pixel_unit(raster, I, J)
            d = ground_distance_m(u, p)
            idx = b * n + a
            dist[idx] = d
            if d > radius_m:
                continue
            k = 2.0 / (1.0 - p[2])  # stereographic map/ground scale at this pixel (true at the pole)
            weight[idx] = (raster.scale_m / k) ** 2
            r = cell_slope(raster, I, J, nodata_dn)
            if r is None:
                state[idx] = INVALID
            else:
                state[idx] = VALID
                slope[idx], aspect[idx] = r
    return {"half": half, "n": n, "I0": Ia - half, "J0": Ja - half, "state": state, "slope": slope,
            "aspect": aspect, "dist": dist, "weight": weight}


def grid_stats(grid: dict) -> dict:
    st = grid["state"]
    valid = [k for k, s in enumerate(st) if s == VALID]
    inside = [k for k, s in enumerate(st) if s != OUTSIDE]
    cdeg = [round(grid["slope"][k] * 100) for k in valid]
    w = [grid["weight"][k] for k in valid]
    srt = sorted(cdeg)
    out = {
        "cells_in_footprint": len(inside),
        "cells_valid": len(valid),
        "cells_invalid": len(inside) - len(valid),
        "valid_fraction": (len(valid) / len(inside)) if inside else None,
        "valid_area_m2": round(sum(w), 1),
        "footprint_area_m2": round(sum(grid["weight"][k] for k in inside), 1),
        "median_deg": None if not srt else nearest_rank(srt, 50) / 100,
        "p95_deg": None if not srt else nearest_rank(srt, 95) / 100,
        "max_deg": None if not srt else srt[-1] / 100,
        "min_deg": None if not srt else srt[0] / 100,
        "mean_deg_weighted": None if not w else round(sum(c * x for c, x in zip(cdeg, w)) / sum(w) / 100, 4),
        "exceedance": [],
    }
    for t in REPORT_THRESHOLDS:
        fu, fw = exceed_fraction(cdeg, t), exceed_fraction(cdeg, t, w)
        out["exceedance"].append({"threshold_deg": t, "cells_above": sum(1 for v in cdeg if v > round(t * 100)),
                                  "fraction_equal_weight": fu, "fraction_area_weighted": fw,
                                  "abs_difference": None if fu is None else abs(fu - fw)})
    if w:
        out["area_weight_max_over_min"] = max(w) / min(w)
    return out


# ------------------------------------------------------------------ main

def run_site(site: dict, rehash: bool) -> dict:
    t0 = time.time()
    sid = site["id"]
    export = json.loads((APP_DATA / f"{sid}.json").read_text("utf-8"))
    tb = export["terrain_horizon"]
    obs = th.site_observer(site)
    if abs(obs.r_obs - tb["observer"]["observer_radius_m"]) > 1e-6:
        raise SystemExit(f"{sid}: observer radius differs from the site export")
    render_meta = json.loads((RENDER / f"{sid}.terrain.json").read_text("utf-8"))

    raster = th.Raster.from_files(PRODUCT, COUNTS)
    img = lola.RAW_DIR / PRODUCT.lower() / f"{PRODUCT.lower()}.img"
    prod = next(p for p in tb["products"] if p["name"] == PRODUCT)
    digest = sha256_file(img) if rehash else None
    if digest is not None and digest != prod["sha256"]:
        raise SystemExit(f"{img} sha256 {digest} differs from the exported product record {prod['sha256']}")
    lbl = lola.load_label(PRODUCT)

    u = obs.u
    fi, fj = raster.pixel_of(*th.stereo_xy(u))
    anchor = (round(fi), round(fj))
    if list(anchor) != render_meta["source_dem"]["anchor_pixel_1based"]:
        raise SystemExit(f"{sid}: anchor {anchor} differs from the render asset's {render_meta['source_dem']['anchor_pixel_1based']}")
    grid = build_grid(raster, obs.lat, obs.lon, anchor, RADIUS_M)
    stats = grid_stats(grid)
    n, half = grid["n"], grid["half"]
    frame = Frame(obs.lat, obs.lon, obs.r_obs)

    # local renderer positions of every grid pixel centre (exact DN heights) -> affine map to grid cells
    samples, local = [], []
    for b in range(n):
        for a in range(n):
            I, J = grid["I0"] + a, grid["J0"] + b
            h = raster.dn_at(I, J) * raster.scaling
            x, y, z = frame.local(pixel_point(raster, I, J, h))
            samples.append((x, z, float(a), float(b)))
            local.append((x, y, z))
    ca, cb = fit_affine(samples)
    resid = max(math.hypot(ca[0] + ca[1] * x + ca[2] * z - a, cb[0] + cb[1] * x + cb[2] * z - b) for x, z, a, b in samples)

    # observer cell and shot-count quality
    centre = half * n + half
    obs_slope = grid["slope"][centre]
    counts_in, no_shot_stencil = 0, 0
    inside = [k for k, s in enumerate(grid["state"]) if s != OUTSIDE]
    for k in inside:
        a, b = k % n, k // n
        I, J = grid["I0"] + a, grid["J0"] + b
        if (raster.count_at(I, J) or 0) > 0:
            counts_in += 1
        if all((raster.count_at(I + di, J + dj) or 0) == 0 for di in (-1, 0, 1) for dj in (-1, 0, 1)):
            no_shot_stencil += 1

    # labelled ground-distance rings: true great-circle distance, bilinear DEM height (as the mesh)
    rings = []
    for rr in RING_RADII_M:
        pts = []
        for k in range(int(round(360 / RING_STEP_DEG))):
            p = destination(u, obs.lat, obs.lon, k * RING_STEP_DEG, rr)
            pi, pj = raster.pixel_of(*th.stereo_xy(p))
            h = raster.height_bilinear(pi, pj)
            r = R + h
            pts.append([round(c, 3) for c in frame.local((r * p[0], r * p[1], r * p[2]))])
        rings.append({"radius_m": rr, "is_analysis_boundary": rr == RADIUS_M, "points": pts})

    # check points for the app's mapping test: corners, centre, and the footprint's extreme cells
    checks = []
    for (a, b) in [(0, 0), (n - 1, 0), (0, n - 1), (n - 1, n - 1), (half, half), (half, 1), (1, half), (n - 2, half), (half, n - 2)]:
        k = b * n + a
        checks.append({"cell": [a, b], "local_xyz": [round(c, 4) for c in local[k]]})

    ground_px = [raster.scale_m / lola.stereo_scale_factor(obs.lat)]
    cdeg = [None if grid["state"][k] != VALID else round(grid["slope"][k] * 100) for k in range(n * n)]
    method = {
        "name": "Horn (1981) 3x3 weighted finite difference on true 3D pixel-centre positions",
        "neighbourhood": "3 x 3 DEM pixels (weights 1-2-1); centre pixel height not used",
        "baseline_m": round(2 * ground_px[0], 3),
        "neighbourhood_extent_m": round(3 * ground_px[0], 3),
        "cell_ground_m": round(ground_px[0], 4),
        "horizontal": ("true ground distances: pixel centres placed at (1737.4 km + h) x exact inverse stereographic "
                       "unit vector, so the projection scale k = 2/(1+sin|lat|) and the terrain radius are included"),
        "vertical_reference": ("local lunar horizontal at each pixel = plane normal to that pixel's radial unit vector "
                               "(sphere); symmetric differences cancel curvature, so curvature is not counted as slope"),
        "heights": "DN x 0.5 m at pixel centres (no interpolation, no render mesh, no shading normals)",
        "invalid": "a cell is invalid if any 3x3 neighbour is outside the raster or nodata (LOLA LDEMs have no nodata value)",
        "stored_resolution_deg": 0.01,
        "percentiles": "nearest rank on stored values: value at rank ceil(p/100 * n) of the sorted valid cells",
        "exceedance": "stored slope strictly greater than the threshold (equal is not an exceedance), threshold at 0.01 deg",
        "area_weighting": (f"equal-area: planimetric pixel area (s/k)^2 varies by a factor {stats.get('area_weight_max_over_min', 1):.7f} "
                           "within the footprint; weighted and unweighted exceedance differ by at most "
                           f"{max(e['abs_difference'] or 0 for e in stats['exceedance']):.2e}"),
        "scale_note": ("Each value is the slope of a 20 m DEM cell measured across about 40 m. It is not a slope at "
                       "a smaller scale: boulders, small craters, the lander footprint and local roughness are not "
                       "resolved, and the DEM is interpolated where no laser shot fell."),
    }
    footprint = {
        "radius_m": RADIUS_M,
        "centre": "the site coordinate (vertical of the modeled observer)",
        "distance": "great-circle ground distance on the 1737.4 km sphere between pixel centres and the site unit vector",
        "membership": "pixel centre within the radius",
        **{k: stats[k] for k in ("cells_in_footprint", "cells_valid", "cells_invalid", "valid_fraction",
                                 "valid_area_m2", "footprint_area_m2")},
        "halo": "the 3x3 stencil reads one pixel beyond the footprint; every footprint stencil lies inside the raster",
    }
    shots = {
        "cells_with_lola_shot": counts_in,
        "fraction_cells_with_lola_shot": counts_in / len(inside),
        "cells_with_no_shot_in_3x3": no_shot_stencil,
        "note": "LDEC_80S_20M counts; a quality indicator for the interpolated DEM, not an accuracy guarantee",
    }
    asset = {
        "asset_version": ASSET_VERSION,
        "is_screening_asset": True,
        "note": ("Terrain hazard screening asset. DEM-derived slope at the 20 m DEM's measurement scale within "
                 f"{RADIUS_M:.0f} m of the modeled observer. Not visibility data, not a landing-safety assessment."),
        "site": {"id": sid, "name": site["name"], "latitude_deg": site["latitude_deg"],
                 "longitude_deg_east": site["longitude_deg_east"], "horizons_site_altitude_km": site["horizons_site_altitude_km"]},
        "observer": {"observer_radius_m": obs.r_obs},
        "source_dem": {"product": PRODUCT, "sha256": prod["sha256"], "sha256_verified_this_run": digest is not None,
                       "url": prod["url"], "map_scale_m": lbl.map_scale_m, "horizontal_unit": "m (polar stereographic map)",
                       "vertical_unit": "m above the 1737.4 km sphere (DN x 0.5)", "counts_product": COUNTS,
                       "anchor_pixel_1based": list(anchor)},
        "method": method,
        "footprint": footprint,
        "grid": {"nx": n, "ny": n, "i0_pixel_1based": grid["I0"], "j0_pixel_1based": grid["J0"],
                 "cell_order": "row-major, index = b * nx + a; a along +I (map +X), b along +J (map -Y)",
                 "state_codes": {"0": "outside the footprint", "1": "valid slope", "2": "in the footprint, no slope (invalid)"},
                 "state": grid["state"], "slope_centideg": cdeg,
                 "local_to_cell": {"a": [round(c, 9) for c in ca], "b": [round(c, 9) for c in cb],
                                   "form": "a = c0 + c1 x + c2 z (renderer frame, metres); nearest cell = round(a), round(b)",
                                   "max_residual_cells": resid},
                 "check_points": checks},
        "observer_cell": {"cell": [half, half], "slope_deg": None if obs_slope is None else round(obs_slope * 100) / 100,
                          "note": "slope of the DEM cell containing the site coordinate (20 m cell, about 40 m baseline)"},
        "stats": {k: stats[k] for k in ("median_deg", "p95_deg", "max_deg", "min_deg")},
        "default_threshold_deg": DEFAULT_THRESHOLD_DEG,
        "shot_quality": shots,
        "rings": rings,
        "reproduce": f"python pipeline/slope.py --site {sid}",
    }
    OUT_APP.mkdir(parents=True, exist_ok=True)
    OUT_EVIDENCE.mkdir(parents=True, exist_ok=True)
    app_path = OUT_APP / f"{sid}.slope.json"
    app_path.write_text(json.dumps(asset, separators=(",", ":")) + "\n", "utf-8", newline="\n")
    asset_sha = sites.sha256(app_path)
    t1 = time.time()
    evidence = {
        "site": sites.identity(site),
        "asset": str(app_path.relative_to(REPO)).replace("\\", "/"),
        "asset_sha256": asset_sha,
        "asset_bytes": app_path.stat().st_size,
        "site_export_sha256": sites.sha256(APP_DATA / f"{sid}.json"),
        "render_asset_anchor_checked": True,
        "method": method,
        "footprint": footprint,
        "stats": stats,
        "observer_cell": asset["observer_cell"],
        "shot_quality": shots,
        "mapping": {"max_residual_cells": resid,
                    "note": "affine fit of renderer-frame (x, z) of every grid pixel centre to its cell indices"},
        "aspect_summary_deg": None,
        "runtime_s": round(t1 - t0, 2),
        "reproduce": asset["reproduce"],
    }
    asp = [grid["aspect"][k] for k, s in enumerate(grid["state"]) if s == VALID]
    if asp:
        cs = sum(math.cos(math.radians(a)) for a in asp) / len(asp)
        sn = sum(math.sin(math.radians(a)) for a in asp) / len(asp)
        evidence["aspect_summary_deg"] = {"circular_mean_downslope_az": round(math.degrees(math.atan2(sn, cs)) % 360, 2),
                                          "resultant_length": round(math.hypot(cs, sn), 4)}
    (OUT_EVIDENCE / f"{sid}_slope_report.json").write_text(json.dumps(evidence, indent=1) + "\n", "utf-8", newline="\n")
    print(json.dumps({"site": sid, "bytes": evidence["asset_bytes"], "cells": stats["cells_in_footprint"],
                      "valid": stats["valid_fraction"], "median": stats["median_deg"], "p95": stats["p95_deg"],
                      "max": stats["max_deg"], "observer_cell": asset["observer_cell"]["slope_deg"],
                      "exceed15": next(e for e in stats["exceedance"] if e["threshold_deg"] == 15.0)["fraction_equal_weight"],
                      "mapping_resid_cells": resid, "runtime_s": evidence["runtime_s"]}))
    return evidence


def main() -> int:
    ap = sites.parser(description=__doc__.split("\n")[0])
    ap.add_argument("--no-rehash", action="store_true", help="do not re-hash the 1.85 GB DEM")
    args = ap.parse_args()
    cfg = json.loads(th.CONFIG.read_text("utf-8"))
    for site in sites.cli_sites(ap, args, cfg, batch=True):
        run_site(site, rehash=not args.no_rehash)
    return 0


if __name__ == "__main__":
    sys.exit(sites.run(main))
