"""Terrain horizon for a lunar surface point from LOLA polar DEMs (Stage 2).

Geometry (Moon-fixed, MEAN EARTH/POLAR AXIS of DE421, as Horizons MOON_ME):
  * Observer: unit vector u of the site (planetocentric lat, east lon) at
    radius r_o = 1737.4 km + Horizons site altitude (LOLA surface + 1 m), i.e.
    the same point Horizons computed the Sun/Earth directions for.
  * Local frame: zenith = u (sphere: geodetic = radial, as Horizons uses for a
    spherical body), north N = d u / d lat, east E = d u / d lon (normalised).
    Azimuth is clockwise from north (N=0, E=90), like Horizons.
  * A ray at azimuth A is the great circle that leaves the site with tangent
    t = cos A N + sin A E. Every point p(theta) = cos(theta) u + sin(theta) t on
    it lies in the vertical plane of azimuth A, so its azimuth is exactly A.
    Ground distance d = R * theta on the 1737.4 km sphere.
  * Terrain radius r_t = 1737.4 km + LDEM height (bilinear) at p.
    Apparent elevation of that point: e = atan2(r_t cos(theta) - r_o, r_t sin(theta)).
    This is exact sphere geometry: lunar curvature enters exactly once, and no
    separate "curvature drop" is applied.
  * Horizon(A) = max e over the ray. Negative values are kept (no clamping).

Raster lookup: p -> south polar stereographic map coordinates without trig,
  X = 2R p_y / (1 - p_z),  Y = 2R p_x / (1 - p_z)
which is the same projection as lola.polar_inverse (r = 2R tan(colat/2),
X = r sin lon, Y = r cos lon), then I = X/s + N/2 + 0.5, J = -Y/s + N/2 + 0.5.

Products: the near-field product is used wherever the bilinear stencil fits
inside it; elsewhere the far-field product. If neither covers a sample before
the stopping rule is met, that azimuth is UNKNOWN (None), never flat.

Stopping rule (re-applied per ray in this calculation): stop at distance d once
even terrain at H_MAX above the reference sphere could not appear above the
running maximum: e(R + H_MAX, theta) < e_best. e(r, theta) of a point with
fixed r > r_o decreases monotonically with theta, so nothing beyond d can
raise the horizon. H_MAX = global LOLA maximum (LDEM_64 label) + 100 m.

    python pipeline/terrain_horizon.py               # profile + sensitivity
    python pipeline/terrain_horizon.py --profile-only
Writes data/terrain/<site_id>_terrain_horizon.json.
"""
from __future__ import annotations

import json
import math
import mmap
import os
import statistics
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sites
import lola  # noqa: E402

R = lola.R_REF_M
CONFIG = Path(__file__).resolve().parent / "config.json"

# Global LOLA maximum height from the LDEM_64 label (MAXIMUM 21546 DN x 0.5 m),
# plus a margin because a 64 px/deg grid can under-sample summits.
GLOBAL_MAX_HEIGHT_M = 10773.0
H_MAX_MARGIN_M = 100.0

# Default radial sampling: quarter of a 20 m pixel within 2 km, half beyond.
NEAR_STEP_M = 5.0
NEAR_LIMIT_M = 2000.0
FAR_STEP_M = 10.0
D_MIN_M = 5.0             # first sample; see "observer cell" notes in main()
MAX_SEARCH_M = 400_000.0  # hard cap; reaching it is reported, never silently accepted
AZ_STEP_DEG = 0.1


# ------------------------------------------------------------------ rasters

@dataclass
class Raster:
    """A square polar-stereographic product, or a rectangular part of one.

    n_full, scale_m define the projection grid (pole at I = J = n_full/2 + 0.5,
    1-based). The data block holds lines j_first..j_first+height-1 and samples
    i_first..i_first+width-1. dn/counts are flat, row-major, indexable (a
    memoryview over a memory-mapped file, or an array for synthetic tests)."""
    name: str
    n_full: int
    scale_m: float
    scaling: float
    dn: object
    width: int
    height: int
    i_first: int = 1
    j_first: int = 1
    counts: object | None = None
    counts_name: str | None = None
    _keep: list = field(default_factory=list, repr=False)  # keeps mmaps alive

    @classmethod
    def from_files(cls, dem_name: str, count_name: str | None) -> "Raster":
        lbl = lola.load_label(dem_name)
        if lbl.sample_type != "LSB_INTEGER" or lbl.sample_bits != 16 or sys.byteorder != "little":
            raise RuntimeError(f"{dem_name}: expected LSB int16 on a little-endian host")
        if lbl.lines != lbl.samples:
            raise RuntimeError(f"{dem_name}: not square")
        keep = []

        def mapped(name: str, bits: int):
            path = lola.RAW_DIR / name.lower() / f"{name.lower()}.img"
            want = lola.load_label(name).expected_bytes
            if not path.exists() or path.stat().st_size != want:
                raise FileNotFoundError(f"{path} missing or wrong size; run python pipeline/fetch_terrain.py")
            f = open(path, "rb")
            mm = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
            keep.extend([f, mm])
            return memoryview(mm).cast("h" if bits == 16 else "B")

        dn = mapped(dem_name, 16)
        counts = None
        if count_name:
            clbl = lola.load_label(count_name)
            if (clbl.lines, clbl.samples, clbl.map_scale_m) != (lbl.lines, lbl.samples, lbl.map_scale_m):
                raise RuntimeError(f"{count_name} grid differs from {dem_name}")
            # Labels say LSB_INTEGER 8-bit, but LDEC_75S_60M has MAXIMUM = 159, which
            # only fits an unsigned byte: counts are read as uint8.
            counts = mapped(count_name, 8)
        return cls(name=dem_name, n_full=lbl.samples, scale_m=lbl.map_scale_m, scaling=lbl.scaling,
                   dn=dn, width=lbl.samples, height=lbl.lines, counts=counts, counts_name=count_name,
                   _keep=keep)

    def pixel_of(self, X: float, Y: float) -> tuple[float, float]:
        """Map metres -> fractional 1-based (I, J) in the full product grid."""
        c = self.n_full / 2 + 0.5
        return X / self.scale_m + c, -Y / self.scale_m + c

    def dn_at(self, i: int, j: int) -> int | None:
        c, r = i - self.i_first, j - self.j_first
        if 0 <= c < self.width and 0 <= r < self.height:
            return self.dn[r * self.width + c]
        return None

    def count_at(self, i: int, j: int) -> int | None:
        if self.counts is None:
            return None
        c, r = i - self.i_first, j - self.j_first
        if 0 <= c < self.width and 0 <= r < self.height:
            return self.counts[r * self.width + c]
        return None

    def height_bilinear(self, fi: float, fj: float) -> float | None:
        i0, j0 = math.floor(fi), math.floor(fj)
        q = [self.dn_at(i0, j0), self.dn_at(i0 + 1, j0), self.dn_at(i0, j0 + 1), self.dn_at(i0 + 1, j0 + 1)]
        if any(v is None for v in q):
            return None
        a, b = fi - i0, fj - j0
        return (q[0] * (1 - a) * (1 - b) + q[1] * a * (1 - b) + q[2] * (1 - a) * b + q[3] * a * b) * self.scaling


# ------------------------------------------------------------------ geometry

def unit(lat: float, lon: float) -> tuple[float, float, float]:
    p, l = math.radians(lat), math.radians(lon)
    return (math.cos(p) * math.cos(l), math.cos(p) * math.sin(l), math.sin(p))


def enu(lat: float, lon: float):
    """(east, north, up) unit vectors of the local frame on the sphere."""
    p, l = math.radians(lat), math.radians(lon)
    e = (-math.sin(l), math.cos(l), 0.0)
    n = (-math.sin(p) * math.cos(l), -math.sin(p) * math.sin(l), math.cos(p))
    return e, n, unit(lat, lon)


def stereo_xy(p: tuple[float, float, float]) -> tuple[float, float]:
    """Unit vector -> south polar stereographic (X, Y) metres (same as lola.polar_inverse)."""
    q = 2 * R / (1 - p[2])
    return q * p[1], q * p[0]


def latlon(p) -> tuple[float, float]:
    return math.degrees(math.asin(max(-1.0, min(1.0, p[2])))), math.degrees(math.atan2(p[1], p[0])) % 360.0


def elevation_deg(r_obs: float, r_t: float, theta: float) -> float:
    return math.degrees(math.atan2(r_t * math.cos(theta) - r_obs, r_t * math.sin(theta)))


def sphere_dip_deg(r_obs: float, r_surface: float = R) -> float:
    """Analytic horizon of a smooth sphere seen from r_obs: -arccos(R / r_obs)."""
    return -math.degrees(math.acos(r_surface / r_obs))


def schedule(near_step=NEAR_STEP_M, near_limit=NEAR_LIMIT_M, far_step=FAR_STEP_M,
             d_min=D_MIN_M, d_max=MAX_SEARCH_M) -> list[float]:
    out, d = [], d_min
    while d <= near_limit + 1e-9:
        out.append(d)
        d += near_step
    d = max(d, near_limit + far_step) if out else d_min
    while d <= d_max + 1e-9:
        out.append(d)
        d += far_step
    return out


@dataclass
class Observer:
    lat: float
    lon: float
    r_obs: float

    @property
    def u(self):
        return unit(self.lat, self.lon)


# ------------------------------------------------------------------ ray march

def march(obs: Observer, az_deg: float, rasters: list[Raster], dists: list[float],
          h_max: float, max_dist: float | None = None, limits: list[float] | None = None) -> dict:
    """Maximum apparent terrain elevation along one azimuth.

    Returns {"elevation_deg": float | None, "status": "stopped" | "exited" |
    "capped" | "truncated", ...}. "exited": the ray left every raster before
    the stopping rule was met (elevation None). "capped": the sample schedule
    ended first (None). "truncated": an explicit max_dist was reached (only
    for sensitivity tests; elevation is a lower bound). limits[k] (optional,
    sensitivity tests only): use raster k only up to that ground distance."""
    e_v, n_v, u = enu(obs.lat, obs.lon)
    a = math.radians(az_deg)
    tx = math.cos(a) * n_v[0] + math.sin(a) * e_v[0]
    ty = math.cos(a) * n_v[1] + math.sin(a) * e_v[1]
    tz = math.cos(a) * n_v[2] + math.sin(a) * e_v[2]
    ux, uy, uz = u
    r_o = obs.r_obs
    r_m = R + h_max
    two_r = 2 * R
    # per-raster constants (0-based column/row of the data block)
    rs = []
    for k, ra in enumerate(rasters):
        inv = 1.0 / ra.scale_m
        c = ra.n_full / 2 + 0.5
        lim = math.inf if limits is None or limits[k] is None else limits[k]
        rs.append((inv, c - ra.i_first, c - ra.j_first, ra.width, ra.height, ra.dn, ra.scaling, lim))
    best = -math.inf
    best_k = -1
    best_info = None
    status = "capped"
    end_d = None
    for k, d in enumerate(dists):
        if max_dist is not None and d > max_dist:
            status, end_d = "truncated", d
            break
        th = d / R
        c, s = math.cos(th), math.sin(th)
        # stopping rule: highest possible terrain at this distance is below the running max
        if (r_m * c - r_o) / (r_m * s) < best:
            status, end_d = "stopped", d
            break
        px = c * ux + s * tx
        py = c * uy + s * ty
        pz = c * uz + s * tz
        q = two_r / (1.0 - pz)
        X = q * py
        Y = q * px
        h = None
        for ri, (inv, ci, cj, w, hgt, dn, sc, lim) in enumerate(rs):
            if d > lim:
                continue
            fi = X * inv + ci
            fj = -Y * inv + cj
            if fi < 0.0 or fj < 0.0:
                continue
            i0 = int(fi)
            j0 = int(fj)
            if i0 >= w - 1 or j0 >= hgt - 1:
                continue
            fa = fi - i0
            fb = fj - j0
            base = j0 * w + i0
            h = ((dn[base] * (1.0 - fa) + dn[base + 1] * fa) * (1.0 - fb)
                 + (dn[base + w] * (1.0 - fa) + dn[base + w + 1] * fa) * fb) * sc
            break
        if h is None:
            status, end_d = "exited", d
            break
        rt = R + h
        slope = (rt * c - r_o) / (rt * s)
        if slope > best:
            best, best_k, best_info = slope, k, (ri, fi, fj, h, px, py, pz)
    else:
        end_d = dists[-1] if dists else None

    out = {"azimuth_deg": az_deg, "status": status, "end_distance_m": end_d}
    if status in ("exited", "capped") or best_info is None:
        out["elevation_deg"] = None
        return out
    ri, fi, fj, h, px, py, pz = best_info
    ra = rasters[ri]
    # full-grid 1-based pixel of the setting sample (block col + i_first)
    I, J = fi + ra.i_first, fj + ra.j_first
    i0, j0 = math.floor(I), math.floor(J)
    counts4 = [ra.count_at(i0, j0), ra.count_at(i0 + 1, j0), ra.count_at(i0, j0 + 1), ra.count_at(i0 + 1, j0 + 1)]
    lat, lon = latlon((px, py, pz))
    out.update({
        "elevation_deg": math.degrees(math.atan(best)),
        "distance_m": dists[best_k],
        "height_m": h,
        "lat_deg": lat,
        "lon_deg": lon,
        "product": ra.name,
        "pixel_1based": [I, J],
        "shot_count_nearest": ra.count_at(round(I), round(J)),
        "shot_counts_bilinear_4": counts4,
    })
    return out


# ------------------------------------------------------------------ parallel driver

_W: dict = {}


def _init_worker(products: list[tuple[str, str | None]]) -> None:
    _W["rasters"] = [Raster.from_files(d, c) for d, c in products]


def _run_chunk(args) -> list[dict]:
    obs, azs, sched_kw, h_max, max_dist, limits = args
    dists = schedule(**sched_kw)
    return [march(obs, az, _W["rasters"], dists, h_max, max_dist, limits) for az in azs]


def profile(obs: Observer, azimuths: list[float], products: list[tuple[str, str | None]],
            h_max: float, sched_kw: dict | None = None, max_dist: float | None = None,
            limits: list[float] | None = None, workers: int | None = None) -> list[dict]:
    """Horizon for many azimuths in parallel (each worker memory-maps the files)."""
    sched_kw = sched_kw or {}
    workers = workers or max(1, min(len(azimuths), (os.cpu_count() or 2) - 1))
    chunk = max(1, math.ceil(len(azimuths) / (workers * 4)))
    jobs = [(obs, azimuths[i:i + chunk], sched_kw, h_max, max_dist, limits)
            for i in range(0, len(azimuths), chunk)]
    out: list[dict] = []
    with ProcessPoolExecutor(max_workers=workers, initializer=_init_worker, initargs=(products,)) as ex:
        for res in ex.map(_run_chunk, jobs):
            out.extend(res)
    return out


# ------------------------------------------------------------------ main

def load_site(site_id=None) -> tuple[dict, dict]:
    cfg = json.loads(CONFIG.read_text("utf-8"))
    return cfg, sites.select_sites(cfg, site_id)[0]


def site_observer(site: dict, dlat: float = 0.0, dlon: float = 0.0) -> Observer:
    return Observer(site["latitude_deg"] + dlat, site["longitude_deg_east"] + dlon,
                    R + site["horizons_site_altitude_km"] * 1000.0)


def summarize(rays: list[dict]) -> dict:
    known = [r for r in rays if r["elevation_deg"] is not None]
    el = [r["elevation_deg"] for r in known]
    dist = [r["distance_m"] for r in known]
    ends = [r["end_distance_m"] for r in rays if r["status"] == "stopped"]
    zero = [r for r in known if r["shot_count_nearest"] == 0]
    return {
        "n_azimuths": len(rays),
        "n_unknown": len(rays) - len(known),
        "status_counts": {s: sum(r["status"] == s for r in rays) for s in ("stopped", "exited", "capped", "truncated")},
        "elevation_deg_min_median_max": [min(el), statistics.median(el), max(el)] if el else None,
        "setting_distance_km_min_median_max": [min(dist) / 1e3, statistics.median(dist) / 1e3, max(dist) / 1e3] if dist else None,
        "stop_distance_km_min_median_max": [min(ends) / 1e3, statistics.median(ends) / 1e3, max(ends) / 1e3] if ends else None,
        "setting_points_by_product": {p: sum(r["product"] == p for r in known) for p in sorted({r["product"] for r in known})},
        "setting_points_with_zero_shots_nearest_pixel": len(zero),
        "setting_points_within_200m": sum(d < 200 for d in dist),
    }


def dump_report(report: dict) -> str:
    """Indented JSON, but one ray per line (3600 rays would otherwise be ~1.7 MB)."""
    head = {k: v for k, v in report.items() if k not in ("rays", "sensitivity")}
    text = json.dumps(head, indent=1)[:-2]
    text += ',\n "rays": [\n' + ",\n".join("  " + json.dumps(r, separators=(",", ":")) for r in report["rays"]) + "\n ]"
    if "sensitivity" in report:
        text += ',\n "sensitivity": ' + json.dumps(report["sensitivity"], indent=1).replace("\n", "\n ")
    return text + "\n}\n"


def main() -> int:
    t0 = time.time()
    ap = sites.parser(description=__doc__)
    ap.add_argument("--profile-only", action="store_true", help="skip sensitivity recomputations")
    args = ap.parse_args()
    cfg = json.loads(CONFIG.read_text("utf-8"))
    site = sites.cli_sites(ap, args, cfg)[0]
    out_path = sites.report_path(site["id"], "terrain_horizon")
    t = cfg["terrain"]
    products = [(t["near_field_product"], t["near_field_counts"]), (t["far_field_product"], t["far_field_counts"])]
    obs = site_observer(site)
    h_max = GLOBAL_MAX_HEIGHT_M + H_MAX_MARGIN_M
    azimuths = [round(k * AZ_STEP_DEG, 6) for k in range(round(360 / AZ_STEP_DEG))]

    near = Raster.from_files(*products[0])
    fi, fj = near.pixel_of(*stereo_xy(obs.u))
    foot = near.height_bilinear(fi, fj)
    print(f"observer: lat {obs.lat}, lon {obs.lon}, r_obs {obs.r_obs:.2f} m; "
          f"DEM foot {foot:.3f} m -> eye {obs.r_obs - R - foot:.3f} m above the DEM surface", flush=True)

    rays = profile(obs, azimuths, products, h_max)
    print(f"profile: {len(rays)} azimuths in {time.time() - t0:.0f} s", flush=True)
    summ = summarize(rays)
    print(json.dumps(summ, indent=1), flush=True)

    report = {
        "generated_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "site": {"id": site["id"], "latitude_deg": obs.lat, "longitude_deg_east": obs.lon,
                 "observer_height_above_surface_m": site["observer_height_above_surface_m"],
                 "horizons_site_altitude_km": site["horizons_site_altitude_km"],
                 "observer_radius_m": obs.r_obs,
                 "dem_surface_at_site_m": foot,
                 "eye_above_dem_surface_m": obs.r_obs - R - foot},
        "method": {
            "geometry": ("Exact sphere geometry in the Moon-fixed ME frame: great-circle rays from the site, "
                         "e = atan2(r_t cos(theta) - r_o, r_t sin(theta)); curvature counted once; "
                         "negative elevations kept."),
            "azimuth_step_deg": AZ_STEP_DEG,
            "radial_sampling": {"d_min_m": D_MIN_M, "near_step_m": NEAR_STEP_M, "near_limit_m": NEAR_LIMIT_M,
                                "far_step_m": FAR_STEP_M,
                                "note": ("ray sampling distance, not terrain resolution: the LDEM is bilinearly "
                                         "interpolated at each sample; step <= 1/4 of a 20 m pixel within 2 km and "
                                         "<= 1/2 beyond (1/6 of a 60 m pixel in the far-field product). Terrain "
                                         "detail is limited by the pixel spacing and LOLA track density.")},
            "products_priority": [p[0] for p in products],
            "count_products": [p[1] for p in products],
            "stopping_rule": {"h_max_m": h_max, "basis": "global LOLA maximum 10773 m (LDEM_64 label) + 100 m",
                              "rule": "stop when e(R + h_max, theta) < running maximum"},
            "unknown_rule": "ray leaves every product before the stop rule is met -> elevation null",
            "observer_cell": ("observer foot = bilinear LDEM_80S_20M surface at the site, the same surface sampled "
                              "along the rays; eye = Horizons altitude (surface rounded to 0.1 m + 1 m). Samples "
                              f"start at {D_MIN_M} m. Near-field influence is measured in sensitivity.d_min."),
        },
        "summary": summ,
        "rays": rays,
    }
    if not args.profile_only:
        import terrain_sensitivity  # noqa: E402  (separate module: slower checks)
        report["sensitivity"] = terrain_sensitivity.run_all(obs, products, h_max, rays, cfg, site)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(dump_report(report), "utf-8", newline="\n")
    print(f"wrote {out_path.relative_to(lola.REPO_ROOT)} ({time.time() - t0:.0f} s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(sites.run(main))
