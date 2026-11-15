"""Two-site Sun/Earth direction consistency check (science review follow-up, 2026-11-14).

Each site's exported Sun azimuth/elevation is turned into a direction in the
Moon-fixed (ME) frame using that site's own latitude, east longitude and local
east-north-up frame (azimuth clockwise from north, elevation above the plane
normal to the radial zenith). The Sun is ~1.5e8 km away and the two sites are
~174 km apart, so the Sun's direction should be the same from both sites to
about 0.00007 deg (parallax). The test tolerance is 0.001 deg.

What it detects: any convention or bookkeeping error that acts DIFFERENTLY at
the two sites, because the two local frames are rotated relative to each other
(about 5 deg apart in latitude and 193 deg apart in longitude):
- a mirrored azimuth (counter-clockwise from north): 26.8 deg here;
- west-positive instead of east-positive longitude: 26.8 deg here;
- a wrong or transposed coordinate for one site, or one site's samples paired
  with the other site's metadata;
- a time offset of one site's series relative to the other (the Sun moves
  about 0.0085 deg per minute in the ME frame, so offsets above ~7 s fail).

What it cannot detect: errors SHARED by both sites, because they cancel in the
comparison. Examples: a common time-scale offset (for example TDB vs UTC), a
rotation of the whole body-fixed frame (ME vs another realization, or a wrong
longitude zero), a common altitude or reference-radius error (Sun parallax is
negligible), and a wrong but common target. The azimuth-convention sanity check
in horizon_crosscheck.py (one direction) and the Earth parallax bounds below
detect only SOME gross shared errors; they do not close these gaps.

Earth is 384 000 km away, so its direction differs between the sites by
0.010-0.017 deg (parallax). That is used as a looser plausibility check: the
approximate Earth-distance scale must lie within broad bounds. This uses
rounded apparent directions, not independent geometric rays, and does not
validate ephemeris accuracy. The original review evaluated distance at just
three timestamps; this script evaluates all samples (SCIENCE_REVIEW.md).

This module deliberately shares no frame code with terrain_horizon.py or
horizon_crosscheck.py (standard library only). Input: the exported files
app/public/data/<site>.json, which are committed; no raw data is needed.
Run: python pipeline/direction_check.py
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA = REPO_ROOT / "app" / "public" / "data"
R_KM = 1737.4

SUN_TOLERANCE_DEG = 0.001
# Lunar distance range (perigee ~356 400 km, apogee ~406 700 km) with margin.
EARTH_DISTANCE_KM_RANGE = (340_000.0, 420_000.0)

Vec = tuple[float, float, float]


def enu(lat_deg: float, lon_east_deg: float) -> tuple[Vec, Vec, Vec]:
    """(east, north, up) unit vectors on the sphere at a planetocentric point."""
    p, lam = math.radians(lat_deg), math.radians(lon_east_deg)
    e = (-math.sin(lam), math.cos(lam), 0.0)
    n = (-math.sin(p) * math.cos(lam), -math.sin(p) * math.sin(lam), math.cos(p))
    u = (math.cos(p) * math.cos(lam), math.cos(p) * math.sin(lam), math.sin(p))
    return e, n, u


def direction(site: dict, az_deg: float, el_deg: float, *, mirror: bool = False, west_lon: bool = False) -> Vec:
    """ME-frame unit vector of a body seen at (az, el) from `site`.
    mirror / west_lon apply deliberately wrong conventions (controls)."""
    lon = site["longitude_deg_east"]
    e, n, u = enu(site["latitude_deg"], -lon if west_lon else lon)
    a, h = math.radians(-az_deg if mirror else az_deg), math.radians(el_deg)
    ch = math.cos(h)
    return tuple(ch * math.cos(a) * n[i] + ch * math.sin(a) * e[i] + math.sin(h) * u[i] for i in range(3))  # type: ignore[return-value]


def angle_deg(v: Vec, w: Vec) -> float:
    """Angle between two unit vectors; atan2 form, accurate for tiny angles."""
    d = sum(x * y for x, y in zip(v, w))
    c = (v[1] * w[2] - v[2] * w[1], v[2] * w[0] - v[0] * w[2], v[0] * w[1] - v[1] * w[0])
    return math.degrees(math.atan2(math.sqrt(sum(x * x for x in c)), d))


def position_km(site: dict) -> Vec:
    r = R_KM + site["horizons_site_altitude_km"]
    return tuple(r * c for c in enu(site["latitude_deg"], site["longitude_deg_east"])[2])  # type: ignore[return-value]


def load(site_id: str, data_dir: Path = DATA) -> dict:
    return json.loads((data_dir / f"{site_id}.json").read_text("utf-8"))


def separations(a: dict, b: dict, body: str, **kw) -> list[float]:
    """Per-sample angle between the body's ME direction from site a and from site b."""
    sa, sb = a["samples"], b["samples"]
    if [x["time_utc"] for x in sa] != [x["time_utc"] for x in sb]:
        raise ValueError("the two sites do not share sample times")
    out = []
    for x, y in zip(sa, sb):
        if None in (x[f"{body}_azimuth_deg"], x[f"{body}_elevation_deg"], y[f"{body}_azimuth_deg"], y[f"{body}_elevation_deg"]):
            continue
        v = direction(a["site"], x[f"{body}_azimuth_deg"], x[f"{body}_elevation_deg"], **kw)
        w = direction(b["site"], y[f"{body}_azimuth_deg"], y[f"{body}_elevation_deg"], **kw)
        out.append(angle_deg(v, w))
    return out


def implied_earth_distances_km(a: dict, b: dict) -> list[float]:
    """Approximate distance scale from apparent directions at every sample:
    perpendicular baseline / small parallax angle (radians). A gross consistency
    diagnostic only, not a validation of ephemeris accuracy or an independent
    center-to-center Earth-Moon distance measurement.
    """
    pa, pb = position_km(a["site"]), position_km(b["site"])
    base = [q - p for p, q in zip(pa, pb)]
    blen2 = sum(c * c for c in base)
    out = []
    for x, y in zip(a["samples"], b["samples"]):
        v = direction(a["site"], x["earth_azimuth_deg"], x["earth_elevation_deg"])
        w = direction(b["site"], y["earth_azimuth_deg"], y["earth_elevation_deg"])
        par = sum(p * q for p, q in zip(base, v))
        perp = math.sqrt(max(0.0, blen2 - par * par))
        out.append(perp / math.radians(angle_deg(v, w)))
    return out


def main() -> int:
    manifest = json.loads((DATA / "manifest.json").read_text("utf-8"))
    ids = [e["id"] for e in manifest["sites"]]
    if len(ids) < 2:
        print("need two exported sites")
        return 1
    a, b = load(ids[0]), load(ids[1])
    chord = math.dist(position_km(a["site"]), position_km(b["site"]))
    print(f"{ids[0]} vs {ids[1]}: chord {chord:.2f} km; expected Sun parallax ~{math.degrees(chord / 1.47e8):.1e} deg")
    ok = True
    for body in ("sun", "earth"):
        for label, kw in (("as implemented", {}), ("mirrored azimuth (control)", {"mirror": True}),
                          ("west-positive lon (control)", {"west_lon": True})):
            d = separations(a, b, body, **kw)
            print(f"  {body:5s} {label:28s} min {min(d):.6f}  max {max(d):.6f}  mean {sum(d) / len(d):.6f} deg  ({len(d)} samples)")
            if body == "sun" and not kw:
                ok &= max(d) <= SUN_TOLERANCE_DEG
    dist = implied_earth_distances_km(a, b)
    print(f"  implied Earth distance from parallax: {min(dist):,.0f} .. {max(dist):,.0f} km")
    ok &= EARTH_DISTANCE_KM_RANGE[0] <= min(dist) and max(dist) <= EARTH_DISTANCE_KM_RANGE[1]
    print("PASS" if ok else "FAIL", f"(Sun tolerance {SUN_TOLERANCE_DEG} deg; Earth distance {EARTH_DISTANCE_KM_RANGE} km)")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
