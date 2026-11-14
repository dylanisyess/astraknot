"""Independent reference for mission-window metrics on the real dataset.

Deliberately does NOT use visibility.classify() or the merged intervals and
shares no code with the frontend. It re-classifies every 10-minute sample pair
from the exported samples (midpoint elevation strictly > 0 deg, the smooth
horizon), then sums durations inside each window. Window boundaries need not
align with samples: partial steps are clipped by elapsed time.

    python pipeline/crosscheck_metrics.py [baseline_iso] [duration_days]
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "app" / "public" / "data"
FMT = "%Y-%m-%dT%H:%M:%SZ"


def t(s: str) -> datetime:
    return datetime.strptime(s, FMT).replace(tzinfo=timezone.utc)


def steps(samples):
    """(start, end, sun_visible, earth_visible) for every sample pair."""
    for a, b in zip(samples, samples[1:]):
        def vis(k):
            e0, e1 = a[f"{k}_elevation_deg"], b[f"{k}_elevation_deg"]
            return None if e0 is None or e1 is None else (e0 + e1) / 2 > 0.0
        yield t(a["time_utc"]), t(b["time_utc"]), vis("sun"), vis("earth")


def metrics(samples, ws: datetime, we: datetime) -> dict:
    total = (we - ws).total_seconds()
    acc = {"sun": 0.0, "earth": 0.0, "both": 0.0}
    unknown = {"sun": 0.0, "earth": 0.0, "both": 0.0}
    covered = 0.0
    runs, cur = [], None  # darkness runs (start, end) within the window
    for s, e, sv, ev in steps(samples):
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
    m = json.loads((DATA / "manifest.json").read_text("utf-8"))
    site = json.loads((DATA / m["sites"][0]["file"]).read_text("utf-8"))
    base = t(sys.argv[1]) if len(sys.argv) > 1 else t("2026-12-05T00:00:00Z")
    days = float(sys.argv[2]) if len(sys.argv) > 2 else 14.0
    cov_end = t(m["coverage_end_utc"])
    for delay in (0, 1, 3, 7):
        ws = base + timedelta(days=delay)
        we = ws + timedelta(days=days)
        if we > cov_end:
            print(f"+{delay} d: window ends {we:%Y-%m-%d %H:%M} after coverage end -> not allowed")
            continue
        r = metrics(site["samples"], ws, we)
        print(f"+{delay} d  {ws:%Y-%m-%d %H:%M} .. {we:%Y-%m-%d %H:%M} UTC  " + json.dumps(r))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
