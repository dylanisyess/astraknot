"""Sensitivity of the terrain horizon to its numerical choices, measured both
as angles and as visibility outcomes (10-minute steps that change state over
the 60 days, and the demonstration-scenario metrics).

Called by terrain_horizon.py (run_all). Every variant is a full recomputation
with one setting changed; nothing here is used to build the exported horizon.
These checks share the base method's geometry and data, so they measure
numerical sensitivity, not correctness (see horizon_crosscheck.py for an
independent check).
"""
from __future__ import annotations

import json
import math
import statistics
import time
from datetime import datetime, timedelta, timezone

import sites
import lola
import terrain_horizon as th
import visibility as vis

DEMO_BASELINE = "2026-12-05T00:00:00Z"
DEMO_DAYS = 14
DELAYS = (0, 1, 3, 7)


# ------------------------------------------------------------------ visibility helpers

def load_samples(cfg, site) -> list[dict]:
    return sites.load_site_data(cfg, site)["samples"]


def horizon_dict(az: list[float], el: list[float | None], model="terrain") -> dict:
    return {"model": model, "azimuth_deg": az, "elevation_deg": el}


def step_states(samples: list[dict], horizon: dict) -> list[tuple]:
    """(sun, earth) visibility of every 10-minute step (midpoint rule, vis._visible)."""
    out = []
    for a, b in zip(samples, samples[1:]):
        out.append((vis._visible(a["sun_azimuth_deg"], a["sun_elevation_deg"], b["sun_azimuth_deg"],
                                 b["sun_elevation_deg"], horizon),
                    vis._visible(a["earth_azimuth_deg"], a["earth_elevation_deg"], b["earth_azimuth_deg"],
                                 b["earth_elevation_deg"], horizon)))
    return out


def _t(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def window_metrics(samples: list[dict], states: list[tuple], ws: datetime, we: datetime) -> dict:
    """Shares of elapsed time (whole 10-min steps; windows are on whole hours)."""
    t0 = _t(samples[0]["time_utc"])
    k0 = int((ws - t0).total_seconds() // 600)
    k1 = int((we - t0).total_seconds() // 600)
    part = states[k0:k1]
    n = len(part)

    def pct(f):
        v = [f(s) for s in part]
        return None if any(x is None for x in v) else 100.0 * sum(bool(x) for x in v) / n

    both = lambda s: (True if s[0] and s[1] else (False if s[0] is False or s[1] is False else None))  # noqa: E731
    best = cur = 0
    for s in part:
        cur = cur + 1 if s[0] is False else 0
        best = max(best, cur)
    return {"sun_pct": pct(lambda s: s[0]), "earth_pct": pct(lambda s: s[1]), "both_pct": pct(both),
            "longest_dark_h": None if any(s[0] is None for s in part) else best * 600 / 3600}


def demo_metrics(samples: list[dict], states: list[tuple]) -> dict:
    base = _t(DEMO_BASELINE)
    out = {}
    for d in DELAYS:
        ws = base + timedelta(days=d)
        out[f"+{d}d"] = window_metrics(samples, states, ws, ws + timedelta(days=DEMO_DAYS))
    return out


def transitions(samples: list[dict], states: list[tuple]) -> list[dict]:
    """State changes (per body) with the body's azimuth at the boundary sample."""
    out = []
    for k in range(1, len(states)):
        for bi, body in enumerate(("sun", "earth")):
            if states[k][bi] != states[k - 1][bi]:
                s = samples[k]
                out.append({"time_utc": s["time_utc"], "body": body, "to": states[k][bi],
                            "azimuth_deg": s[f"{body}_azimuth_deg"], "elevation_deg": s[f"{body}_elevation_deg"]})
    return out


# ------------------------------------------------------------------ comparisons

def angular_diff(base_az, base_el, az, el) -> dict:
    """Variant profile vs the base profile linearly interpolated at the variant's azimuths."""
    diffs = []
    for a, e in zip(az, el):
        b = vis.horizon_elevation(a, base_az, base_el)
        if b is None or e is None:
            continue
        diffs.append((e - b, a))
    unknown = sum(e is None for e in el)
    if not diffs:
        return {"n_compared": 0, "n_unknown_in_variant": unknown}
    ad = sorted(abs(d) for d, _ in diffs)
    worst = max(diffs, key=lambda x: abs(x[0]))
    return {"n_compared": len(diffs), "n_unknown_in_variant": unknown,
            "max_abs_deg": ad[-1], "at_azimuth_deg": worst[1], "signed_at_max_deg": worst[0],
            "p99_abs_deg": ad[min(len(ad) - 1, int(0.99 * len(ad)))],
            "median_abs_deg": statistics.median(ad),
            "rms_deg": math.sqrt(statistics.fmean(d * d for d, _ in diffs)),
            "n_over_0.01deg": sum(x > 0.01 for x in ad), "n_over_0.05deg": sum(x > 0.05 for x in ad)}


def visibility_diff(samples, base_states, states, base_demo) -> dict:
    sun = sum(a[0] != b[0] for a, b in zip(base_states, states))
    earth = sum(a[1] != b[1] for a, b in zip(base_states, states))
    demo = demo_metrics(samples, states)
    deltas = {}
    for k, m in demo.items():
        deltas[k] = {f: (None if m[f] is None or base_demo[k][f] is None else m[f] - base_demo[k][f])
                     for f in m}
    return {"sun_steps_changed": sun, "earth_steps_changed": earth,
            "sun_hours_changed": sun / 6, "earth_hours_changed": earth / 6,
            "demo_metric_deltas_pp_or_h": deltas}


def max_demo_delta(v: dict) -> dict:
    """Largest |delta| per metric over the four demo windows."""
    out = {}
    for f in ("sun_pct", "earth_pct", "both_pct", "longest_dark_h"):
        vals = [d[f] for d in v["demo_metric_deltas_pp_or_h"].values() if d[f] is not None]
        out[f] = max((abs(x) for x in vals), default=None)
    return out


# ------------------------------------------------------------------ driver

def run_all(obs: th.Observer, products, h_max: float, base_rays: list[dict], cfg: dict, site: dict) -> dict:
    t0 = time.time()
    samples = load_samples(cfg, site)
    base_az = [r["azimuth_deg"] for r in base_rays]
    base_el = [r["elevation_deg"] for r in base_rays]
    base_states = step_states(samples, horizon_dict(base_az, base_el))
    base_demo = demo_metrics(samples, base_states)
    smooth_states = step_states(samples, vis.smooth_horizon(1.0))
    smooth_demo = demo_metrics(samples, smooth_states)
    az01 = base_az

    def evaluate(name: str, desc: str, rays: list[dict]) -> dict:
        az = [r["azimuth_deg"] for r in rays]
        el = [r["elevation_deg"] for r in rays]
        st = step_states(samples, horizon_dict(az, el))
        v = visibility_diff(samples, base_states, st, base_demo)
        res = {"name": name, "description": desc, "angular": angular_diff(base_az, base_el, az, el),
               "visibility": v, "demo_max_abs_delta": max_demo_delta(v)}
        a = res["angular"]
        print(f"  {name:28s} max|d| {a.get('max_abs_deg', float('nan')):.4f} deg  "
              f"steps changed sun {v['sun_steps_changed']}, earth {v['earth_steps_changed']}  "
              f"({time.time() - t0:.0f} s)", flush=True)
        return res

    variants = []
    print("sensitivity:", flush=True)

    # 1. azimuth spacing (full circle)
    for step in (0.05, 0.02):
        azs = [round(k * step, 6) for k in range(round(360 / step))]
        variants.append(evaluate(f"azimuth_step_{step}", f"full circle at {step} deg instead of 0.1 deg",
                                 th.profile(obs, azs, products, h_max)))

    # 2. selected sectors: +/-0.3 deg around every terrain-horizon crossing of the Sun/Earth
    #    path, at 0.005 deg, merged into the 0.1 deg profile
    trans = transitions(samples, base_states)
    centres = sorted({round(t["azimuth_deg"], 3) for t in trans})
    fine_az = sorted({round((c + k * 0.005) % 360, 6) for c in centres for k in range(-60, 61)})
    fine = th.profile(obs, fine_az, products, h_max)
    merged = {a: e for a, e in zip(az01, base_el)}
    merged.update({r["azimuth_deg"]: r["elevation_deg"] for r in fine})
    m_az = sorted(merged)
    ev = evaluate("event_sectors_0.005", f"0.005 deg within +/-0.3 deg of {len(centres)} crossing azimuths, "
                  "merged into the 0.1 deg profile", [{"azimuth_deg": a, "elevation_deg": merged[a]} for a in m_az])
    ev["angular"] = angular_diff(base_az, base_el, [r["azimuth_deg"] for r in fine],
                                 [r["elevation_deg"] for r in fine])
    ev["n_crossings"] = len(trans)
    variants.append(ev)

    # 3. radial sampling
    for near, far in ((2.5, 5.0), (10.0, 20.0), (20.0, 40.0), (20.0, 60.0)):
        variants.append(evaluate(f"radial_{near:g}m_{far:g}m", f"radial step {near} m (<2 km) / {far} m beyond "
                                 f"(base {th.NEAR_STEP_M:g} / {th.FAR_STEP_M:g} m)",
                                 th.profile(obs, az01, products, h_max, {"near_step": near, "far_step": far,
                                                                          "d_min": near})))

    # 4. first-sample distance (observer cell)
    for dmin in (20.0, 50.0, 100.0, 300.0):
        variants.append(evaluate(f"d_min_{dmin:g}m", f"ignore terrain closer than {dmin} m (base {th.D_MIN_M:g} m)",
                                 th.profile(obs, az01, products, h_max, {"d_min": dmin})))

    # 5. search extent: truncation (lower bounds) and a tighter, still rigorous height bound
    for km in (10, 25, 50, 100):
        variants.append(evaluate(f"truncate_{km}km", f"stop every ray at {km} km regardless of the stopping rule",
                                 th.profile(obs, az01, products, h_max, max_dist=km * 1000.0)))
    reg = max(lola._num(lola.load_label(p[0]).fields["DERIVED_MAXIMUM"]) * 0.5 for p in products) + 100.0
    rr = th.profile(obs, az01, products, reg)
    ve = evaluate("h_max_regional", f"stopping-rule height bound = max of the two products' DERIVED_MAXIMUM "
                  f"+ 100 m = {reg:.0f} m (base {h_max:.0f} m)", rr)
    ve["stop_distance_km_min_median_max"] = th.summarize(rr)["stop_distance_km_min_median_max"]
    variants.append(ve)

    # 6. products / resolution / transition
    variants.append(evaluate("far_product_only", f"{products[1][0]} for the whole ray (60 m instead of 20 m)",
                             th.profile(obs, az01, [products[1]], h_max)))
    for km in (5, 25, 100):
        variants.append(evaluate(f"switch_to_far_at_{km}km", f"{products[0][0]} only up to {km} km, then {products[1][0]}",
                                 th.profile(obs, az01, products, h_max, limits=[km * 1000.0, None])))

    # 7. site-position sensitivity SCENARIOS (not a measured coordinate uncertainty): observer moved
    #    100 m due N/E/S/W of the published point (eye kept at the nominal point's height above the DEM,
    #    e.g. 1.02 m for Athena, 0.98 m for CR1); deltas vs the nominal point
    near = th.Raster.from_files(*products[0])
    foot = near.height_bilinear(*near.pixel_of(*th.stereo_xy(obs.u)))
    eye = obs.r_obs - th.R - foot
    e_v, n_v, u = th.enu(obs.lat, obs.lon)
    for name, az in (("N", 0), ("E", 90), ("S", 180), ("W", 270)):
        a = math.radians(az)
        t = [math.cos(a) * n_v[i] + math.sin(a) * e_v[i] for i in range(3)]
        th_ = 100.0 / th.R
        p = [math.cos(th_) * u[i] + math.sin(th_) * t[i] for i in range(3)]
        lat, lon = th.latlon(p)
        f2 = near.height_bilinear(*near.pixel_of(*th.stereo_xy(p)))
        o2 = th.Observer(lat, lon, th.R + f2 + eye)
        v = evaluate(f"site_shift_100m_{name}", f"observer moved 100 m {name} (surface {f2:.1f} m vs {foot:.1f} m)",
                     th.profile(o2, az01, products, h_max))
        variants.append(v)

    # 8. seam between products, along rays that cross the 80S edge before stopping
    seam = seam_check(obs, products, base_rays)

    # 9. smooth vs terrain (the effect this milestone is about)
    smooth_vs = {"sun_steps_differ": sum(a[0] != b[0] for a, b in zip(base_states, smooth_states)),
                 "earth_steps_differ": sum(a[1] != b[1] for a, b in zip(base_states, smooth_states)),
                 "demo_smooth": smooth_demo, "demo_terrain": base_demo}

    return {"note": ("Numerical sensitivity of the base method (same geometry, same data). Not an "
                     "independent validation."),
            "base_demo_metrics": base_demo, "terrain_crossings": trans, "variants": variants,
            "seam": seam, "smooth_vs_terrain": smooth_vs, "runtime_s": round(time.time() - t0)}


def seam_check(obs: th.Observer, products, base_rays: list[dict]) -> dict:
    """Height step between the two products where a ray leaves the near product,
    and how far below the running horizon that seam point lies."""
    near = th.Raster.from_files(*products[0])
    far = th.Raster.from_files(*products[1])
    e_v, n_v, u = th.enu(obs.lat, obs.lon)
    pts = []
    for r in base_rays:
        if r["status"] != "stopped":
            continue
        a = math.radians(r["azimuth_deg"])
        t = [math.cos(a) * n_v[i] + math.sin(a) * e_v[i] for i in range(3)]

        def at(d):
            th_ = d / th.R
            p = [math.cos(th_) * u[i] + math.sin(th_) * t[i] for i in range(3)]
            return th_, th.stereo_xy(p)

        lo, hi = 0.0, r["end_distance_m"]
        _, xy = at(hi)
        if near.height_bilinear(*near.pixel_of(*xy)) is not None:
            continue  # ray never left the near product
        for _ in range(40):  # bisection for the last covered distance
            mid = (lo + hi) / 2
            if near.height_bilinear(*near.pixel_of(*at(mid)[1])) is None:
                hi = mid
            else:
                lo = mid
        th_, xy = at(lo)
        hn = near.height_bilinear(*near.pixel_of(*xy))
        hf = far.height_bilinear(*far.pixel_of(*xy))
        en = th.elevation_deg(obs.r_obs, th.R + hn, th_)
        ef = th.elevation_deg(obs.r_obs, th.R + hf, th_)
        pts.append({"azimuth_deg": r["azimuth_deg"], "distance_km": lo / 1000, "h_near_m": hn, "h_far_m": hf,
                    "dh_m": hn - hf, "d_elev_deg": en - ef, "seam_elev_deg": en,
                    "below_horizon_deg": r["elevation_deg"] - max(en, ef)})
    if not pts:
        return {"n_rays_crossing": 0}
    return {"n_rays_crossing": len(pts),
            "azimuth_range_deg": [min(p["azimuth_deg"] for p in pts), max(p["azimuth_deg"] for p in pts)],
            "dh_m_mean": statistics.fmean(p["dh_m"] for p in pts),
            "dh_m_max_abs": max(abs(p["dh_m"]) for p in pts),
            "d_elev_deg_max_abs": max(abs(p["d_elev_deg"]) for p in pts),
            "min_margin_below_horizon_deg": min(p["below_horizon_deg"] for p in pts),
            "points_every_10th": pts[::10]}
