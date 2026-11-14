"""Horizon interpolation and 10-minute midpoint visibility classification
(DATA_CONTRACT.md, "Horizon" and "Visibility intervals")."""
from __future__ import annotations

from bisect import bisect_right
from datetime import datetime, timedelta, timezone

METHOD = "10-minute midpoint classification"


def parse_utc(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def fmt_utc(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def norm360(a: float) -> float:
    a = a % 360.0
    return 0.0 if a >= 360.0 else a


def interp_azimuth(a0: float, a1: float, f: float) -> float:
    """Interpolate along the shortest circular path (359 -> 1 passes through 0)."""
    d = ((a1 - a0 + 180.0) % 360.0) - 180.0
    return norm360(a0 + f * d)


def horizon_elevation(az: float, h_az: list[float], h_el: list[float | None]) -> float | None:
    """Linear periodic interpolation of a horizon profile (ascending azimuths in
    [0, 360)). None = unknown sector: if either bracketing value is None the
    result is None, never a guess; exactly on a profile azimuth the sample's
    own value is returned. Binary search; same result as the linear reference
    below except on exact profile azimuths next to an unknown sample (tested)."""
    n = len(h_az)
    if n == 0:
        return None
    if n == 1:
        return h_el[0]
    az = norm360(az)
    i = bisect_right(h_az, az) - 1  # h_az[i] <= az < h_az[i+1]; -1 = before the first
    if i < 0:
        i = n - 1  # wraps: between the last azimuth and the first + 360
    a0, a1 = h_az[i], h_az[(i + 1) % n]
    span = (a1 - a0) % 360.0 or 360.0
    off = (az - a0) % 360.0
    e0, e1 = h_el[i], h_el[(i + 1) % n]
    if off == 0.0:
        return e0  # exactly on a profile sample: its own value (None if unknown)
    if e0 is None or e1 is None:
        return None
    return e0 + (e1 - e0) * (off / span)


def _horizon_elevation_linear(az: float, h_az: list[float], h_el: list[float | None]) -> float | None:
    """Reference implementation (linear scan), kept for tests."""
    n = len(h_az)
    if n == 0:
        return None
    if n == 1:
        return h_el[0]
    az = norm360(az)
    for i in range(n):
        a0, a1 = h_az[i], h_az[(i + 1) % n]
        span = (a1 - a0) % 360.0 or 360.0
        off = (az - a0) % 360.0
        if off <= span:
            e0, e1 = h_el[i], h_el[(i + 1) % n]
            if e0 is None or e1 is None:
                return None
            return e0 + (e1 - e0) * (off / span)
    return None  # unreachable for a valid profile


def _visible(az0, el0, az1, el1, horizon) -> bool | None:
    if None in (az0, el0, az1, el1):
        return None
    el = el0 + 0.5 * (el1 - el0)
    az = interp_azimuth(az0, az1, 0.5)
    h = horizon_elevation(az, horizon["azimuth_deg"], horizon["elevation_deg"])
    if h is None:
        return None
    return el > h  # strictly above the modeled horizon


def classify(samples: list[dict], horizon: dict) -> list[dict]:
    """One interval per consecutive sample pair, then merge equal neighbours.
    None (unknown) only merges with None, never with known darkness."""
    raw = []
    for s0, s1 in zip(samples, samples[1:]):
        raw.append({
            "start_utc": s0["time_utc"],
            "end_utc": s1["time_utc"],
            "sun_visible": _visible(s0["sun_azimuth_deg"], s0["sun_elevation_deg"],
                                    s1["sun_azimuth_deg"], s1["sun_elevation_deg"], horizon),
            "earth_visible": _visible(s0["earth_azimuth_deg"], s0["earth_elevation_deg"],
                                      s1["earth_azimuth_deg"], s1["earth_elevation_deg"], horizon),
        })
    merged: list[dict] = []
    for iv in raw:
        if merged and merged[-1]["sun_visible"] is iv["sun_visible"] \
                and merged[-1]["earth_visible"] is iv["earth_visible"]:
            merged[-1]["end_utc"] = iv["end_utc"]
        else:
            merged.append(dict(iv))
    return merged


def smooth_horizon(observer_height_m: float) -> dict:
    return {
        "model": "smooth",
        "azimuth_deg": [0.0, 90.0, 180.0, 270.0],
        "elevation_deg": [0.0, 0.0, 0.0, 0.0],
        "observer_height_above_surface_m": observer_height_m,
        "interpolation": "linear_periodic",
        "processing_notes": (
            "Smooth-horizon approximation (Stage 1): 0 deg at every azimuth, i.e. the "
            "local horizontal plane of the reference-sphere observer. Terrain is NOT "
            "modeled; real local horizons near the lunar south pole can be several "
            "degrees high and would block low Sun/Earth directions."
        ),
    }


def step_ok(samples: list[dict], step_s: int) -> bool:
    ts = [parse_utc(s["time_utc"]) for s in samples]
    return all(b - a == timedelta(seconds=step_s) for a, b in zip(ts, ts[1:]))
