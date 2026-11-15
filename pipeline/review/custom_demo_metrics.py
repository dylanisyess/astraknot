"""Terrain-versus-smooth check for the custom-coordinate demonstration, from exported data only.

    python pipeline/review/custom_demo_metrics.py

Independent re-implementation (does not import visibility.py): each 10-minute step's state is
the body at the step midpoint (positions interpolated, azimuth across the shortest arc) strictly
above the horizon interpolated linearly and periodically at that azimuth. Metrics are shares of
elapsed time. Two scopes are reported separately and must not be confused:

- full coverage: every step of the dataset (2026-12-01 to 2027-03-31);
- mission window: one 14-day arrival at 00:00 UTC (the finder's candidate grid).

The demo window is chosen by a stated rule (largest smooth-minus-terrain simultaneous share,
earliest on ties) and every share is cross-checked against the exported visibility intervals.
Writes data/release/custom_demo_metrics.json. Nothing here feeds the app's calculations.
"""
from __future__ import annotations
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "app/public/data/lvn-2026-12-01-120d"
SITE = "custom-85p5s-315e"
COMPARE = "im2-athena"  # the existing site used in the demo's Analysis comparison
DAYS = 14

def t(s): return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)

def horizon_at(az, h_az, h_el):
    az %= 360.0
    n = len(h_az)
    for i in range(n):
        a0, a1 = h_az[i], h_az[(i + 1) % n]
        span = (a1 - a0) % 360.0 or 360.0
        off = (az - a0) % 360.0
        if off <= span:
            e0, e1 = h_el[i], h_el[(i + 1) % n]
            return None if e0 is None or e1 is None else e0 + (e1 - e0) * off / span

def steps(d, horizon):
    h_az, h_el = horizon["azimuth_deg"], horizon["elevation_deg"]
    out = []
    for s0, s1 in zip(d["samples"], d["samples"][1:]):
        row = {"start": t(s0["time_utc"])}
        for b in ("sun", "earth"):
            a0, a1, e0, e1 = s0[f"{b}_azimuth_deg"], s1[f"{b}_azimuth_deg"], s0[f"{b}_elevation_deg"], s1[f"{b}_elevation_deg"]
            if None in (a0, a1, e0, e1): row[b] = None; continue
            az = (a0 + 0.5 * (((a1 - a0 + 180) % 360) - 180)) % 360
            h = horizon_at(az, h_az, h_el)
            row[b] = None if h is None else (e0 + 0.5 * (e1 - e0)) > h
        out.append(row)
    return out

def shares(rows, digits=None):
    n = len(rows)
    assert n and all(r["sun"] is not None and r["earth"] is not None for r in rows), "unknown states in window"
    pct = lambda f: (lambda v: v if digits is None else round(v, digits))(100 * sum(1 for r in rows if f(r)) / n)
    return {"sun_pct": pct(lambda r: r["sun"]), "earth_pct": pct(lambda r: r["earth"]),
            "both_pct": pct(lambda r: r["sun"] and r["earth"]), "neither_pct": pct(lambda r: not r["sun"] and not r["earth"]),
            "steps": n}

def interval_shares(intervals, w0, w1):
    tot = (w1 - w0).total_seconds(); acc = {"sun": 0, "earth": 0, "both": 0}
    for iv in intervals:
        a, b = max(t(iv["start_utc"]), w0), min(t(iv["end_utc"]), w1)
        if b <= a: continue
        sec = (b - a).total_seconds()
        acc["sun"] += sec * bool(iv["sun_visible"]); acc["earth"] += sec * bool(iv["earth_visible"])
        acc["both"] += sec * bool(iv["sun_visible"] and iv["earth_visible"])
    return {f"{k}_pct": 100 * v / tot for k, v in acc.items()}

def window(rows, w0, w1): return [r for r in rows if w0 <= r["start"] < w1]

def site_report(sid):
    d = json.loads((DATA / f"{sid}.json").read_text("utf-8"))
    models = {"smooth": (d["horizon"], d["visibility_intervals"]),
              "terrain": (d["terrain_horizon"]["horizon"], d["terrain_horizon"]["visibility_intervals"])}
    rows = {m: steps(d, h) for m, (h, _) in models.items()}
    return d, models, rows

def main():
    manifest = json.loads((DATA / "manifest.json").read_text("utf-8"))
    c0, c1 = t(manifest["coverage_start_utc"]), t(manifest["coverage_end_utc"])
    d, models, rows = site_report(SITE)
    _, cmodels, crows = site_report(COMPARE)
    worst = 0.0
    def checked(rows_m, intervals, w0, w1):
        nonlocal worst
        s = shares(window(rows_m, w0, w1)); iv = interval_shares(intervals, w0, w1)
        worst = max(worst, *(abs(s[k] - iv[k]) for k in iv)); return s
    full = {m: checked(rows[m], models[m][1], c0, c1) for m in models}
    # Every 14-day arrival at 00:00 UTC that fits the coverage (the finder's daily grid).
    arrivals, a = [], c0
    while a + timedelta(days=DAYS) <= c1: arrivals.append(a); a += timedelta(days=1)
    per = []
    for a in arrivals:
        w1 = a + timedelta(days=DAYS)
        per.append({"arrival": a, **{m: checked(rows[m], models[m][1], a, w1) for m in models}})
    best_smooth = lambda m: max(per, key=lambda r: (r[m]["both_pct"], -r["arrival"].timestamp()))
    demo = max(per, key=lambda r: (r["smooth"]["both_pct"] - r["terrain"]["both_pct"], -r["arrival"].timestamp()))
    w0, w1 = demo["arrival"], demo["arrival"] + timedelta(days=DAYS)
    iso = lambda x: x.strftime("%Y-%m-%dT%H:%MZ")
    out = {
        "site": SITE, "dataset_id": manifest["dataset_id"],
        "method": " ".join(__doc__.split(chr(10) * 2)[2].split()),
        "full_coverage": {"window": [iso(c0), iso(c1)], **full},
        "full_coverage_any_simultaneous_terrain_step": any(r["sun"] and r["earth"] for r in rows["terrain"]),
        "mission_windows": {"days": DAYS, "arrival_hour_utc": 0, "candidates": len(per),
                            "terrain_both_pct_max": max(r["terrain"]["both_pct"] for r in per),
                            "smooth_both_pct_max": best_smooth("smooth")["smooth"]["both_pct"],
                            "smooth_both_pct_max_arrival": iso(best_smooth("smooth")["arrival"])},
        "demo_window": {"rule": "largest smooth-minus-terrain simultaneous (Sun + Earth) share among the candidates; earliest on ties",
                        "arrival": iso(w0), "end": iso(w1), "smooth": demo["smooth"], "terrain": demo["terrain"],
                        "comparison_site": {"id": COMPARE, **{m: shares(window(crows[m], w0, w1)) for m in cmodels}},
                        "url": f"/?ds={manifest['dataset_id']}&sites={COMPARE},{SITE}&site={SITE}&arrival={iso(w0)}&days={DAYS}&delay=0&horizon=terrain&view=analysis"},
        "cross_check": {"max_abs_difference_vs_exported_intervals_pp": worst, "note": "independent midpoint rule vs exported visibility intervals"},
    }
    assert worst < 1e-9, f"independent states disagree with exported intervals by {worst} pp"
    def rounded(x):
        if isinstance(x, dict): return {k: rounded(v) for k, v in x.items()}
        return round(x, 4) if isinstance(x, float) else x
    out = rounded(out)
    p = ROOT / "data/release/custom_demo_metrics.json"
    p.write_text(json.dumps(out, indent=1) + "\n", "utf-8", newline="\n")
    print(json.dumps(out, indent=1))

if __name__ == "__main__":
    main()
