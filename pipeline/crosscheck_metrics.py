"""Independent reference for mission-window metrics on the real dataset.

Deliberately does NOT use visibility.classify() or the merged intervals and
shares no code with the frontend. It re-classifies every 10-minute sample pair
from the exported samples (midpoint elevation strictly above the horizon at
the midpoint azimuth), then sums durations inside each window. Window
boundaries need not align with samples: partial steps are clipped by elapsed
time.

Horizons: smooth (0 deg) by default; --terrain uses the exported terrain
profile with its own uniform-grid interpolation (written here, not
visibility.horizon_elevation).

    python pipeline/crosscheck_metrics.py [baseline_iso] [duration_days] [--terrain]
"""
from __future__ import annotations

import sites
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "app" / "public" / "data"
FMT = "%Y-%m-%dT%H:%M:%SZ"


def t(s: str) -> datetime:
    return datetime.strptime(s, FMT).replace(tzinfo=timezone.utc)


def terrain_lookup(h: dict):
    """Horizon elevation at any azimuth for a UNIFORM grid starting at 0 deg."""
    az, el = h["azimuth_deg"], h["elevation_deg"]
    n = len(az)
    step = 360.0 / n
    if any(abs(a - k * step) > 1e-9 for k, a in enumerate(az)):
        raise SystemExit("terrain azimuths are not a uniform grid from 0 deg")

    def f(a: float):
        x = (a % 360.0) / step
        k = int(x) % n
        e0, e1 = el[k], el[(k + 1) % n]
        if e0 is None or e1 is None:
            return None
        frac = x - int(x)
        return e0 if frac == 0 else e0 + (e1 - e0) * frac
    return f


def steps(samples, horizon=lambda a: 0.0):
    """(start, end, sun_visible, earth_visible) for every sample pair."""
    for a, b in zip(samples, samples[1:]):
        def vis(k):
            e0, e1 = a[f"{k}_elevation_deg"], b[f"{k}_elevation_deg"]
            a0, a1 = a[f"{k}_azimuth_deg"], b[f"{k}_azimuth_deg"]
            if None in (e0, e1, a0, a1):
                return None
            d = a1 - a0
            if d > 180:
                d -= 360
            elif d < -180:
                d += 360
            hz = horizon((a0 + d / 2) % 360.0)
            return None if hz is None else (e0 + e1) / 2 > hz
        yield t(a["time_utc"]), t(b["time_utc"]), vis("sun"), vis("earth")


def metrics(samples, ws: datetime, we: datetime, horizon=lambda a: 0.0) -> dict:
    total = (we - ws).total_seconds()
    acc = {"sun": 0.0, "earth": 0.0, "both": 0.0}
    unknown = {"sun": 0.0, "earth": 0.0, "both": 0.0}
    covered = 0.0
    runs, cur = [], None  # darkness runs (start, end) within the window
    for s, e, sv, ev in steps(samples, horizon):
        a, b = max(s, ws), min(e, we)
        if b <= a:
            continue
        d = (b - a).total_seconds()
        covered += d
        bv = True if (sv and ev) else (False if (sv is False or ev is False) else None)
        for k, v in (("sun", sv), ("earth", ev), ("both", bv)):
            if v is None:
                unknown[k] += d
            elif v:
                acc[k] += d
        if sv is False:
            cur = (cur[0], b) if cur and cur[1] == a else (a, b)
            if not runs or runs[-1][0] != cur[0]:
                runs.append(cur)
            else:
                runs[-1] = cur
        else:
            cur = None
    full = abs(covered - total) < 1e-6
    out = {k: (None if unknown[k] or not full else 100 * acc[k] / total) for k in acc}
    if unknown["sun"] or not full:
        out["longest_dark_h"] = None
    elif not runs:
        out["longest_dark_h"] = 0.0
    else:
        best = max(runs, key=lambda r: ((r[1] - r[0]).total_seconds(), -r[0].timestamp()))
        out["longest_dark_h"] = (best[1] - best[0]).total_seconds() / 3600
        out["longest_dark"] = [best[0].strftime(FMT), best[1].strftime(FMT)]
        out["dark_touches_start"] = best[0] == ws
        out["dark_touches_end"] = best[1] == we
    return out


def main() -> int:
    ap = sites.parser(description=__doc__)
    ap.add_argument("baseline_iso", nargs="?", default="2026-12-05T00:00:00Z")
    ap.add_argument("duration_days", nargs="?", type=float, default=14.0)
    ap.add_argument("--terrain", action="store_true")
    args = ap.parse_args()
    cfg = json.loads((Path(__file__).parent / "config.json").read_text("utf-8"))
    selected = sites.cli_sites(ap, args, cfg)[0]
    m = json.loads((DATA / "manifest.json").read_text("utf-8"))
    site = sites.load_site_data(cfg, selected, DATA, m)
    base = t(args.baseline_iso)
    days = args.duration_days
    horizon = lambda a: 0.0  # noqa: E731
    if args.terrain:
        horizon = terrain_lookup(site["terrain_horizon"]["horizon"])
    print("horizon:", "terrain (exported profile)" if args.terrain else "smooth 0 deg")
    cov_end = t(m["coverage_end_utc"])
    for delay in (0, 1, 3, 7):
        ws = base + timedelta(days=delay)
        we = ws + timedelta(days=days)
        if we > cov_end:
            print(f"+{delay} d: window ends {we:%Y-%m-%d %H:%M} after coverage end -> not allowed")
            continue
        r = metrics(site["samples"], ws, we, horizon)
        print(f"+{delay} d  {ws:%Y-%m-%d %H:%M} .. {we:%Y-%m-%d %H:%M} UTC  " + json.dumps(r))
    return 0


if __name__ == "__main__":
    raise SystemExit(sites.run(main))
