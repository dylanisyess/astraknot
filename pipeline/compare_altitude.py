"""Compare Sun/Earth directions computed by Horizons for the corrected site
altitude against the earlier 0 km (reference-sphere) responses, over the day
both cover (2026-12-01T00:00Z .. 2026-12-02T00:00Z). Reads cached responses only.

    python pipeline/compare_altitude.py
"""
from __future__ import annotations

import json
import math
import statistics
import sys
import sites
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import horizons as hz  # noqa: E402

CONFIG = Path(__file__).resolve().parent / "config.json"
OLD = {"start": "2026-12-01T00:00:00Z", "end": "2026-12-02T00:00:00Z", "alt_km": 0}


def unit(az: float, el: float) -> tuple[float, float, float]:
    a, e = math.radians(az), math.radians(el)
    return (math.cos(e) * math.sin(a), math.cos(e) * math.cos(a), math.sin(e))


def separation_deg(az1, el1, az2, el2) -> float:
    u, v = unit(az1, el1), unit(az2, el2)
    cross = math.sqrt(sum(c * c for c in (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])))
    dot = sum(a * b for a, b in zip(u, v))
    return math.degrees(math.atan2(cross, dot))  # stable for tiny angles


def main() -> int:
    ap = sites.parser(description=__doc__)
    args = ap.parse_args()
    cfg = json.loads(CONFIG.read_text("utf-8"))
    site = sites.cli_sites(ap, args, cfg)[0]
    report_path = sites.report_path(site["id"], "altitude_comparison")
    old_site = {**site, "horizons_site_altitude_km": OLD["alt_km"]}
    out = {"site": sites.identity(site), "old_altitude_km": OLD["alt_km"], "new_altitude_km": site["horizons_site_altitude_km"],
           "interval": [OLD["start"], OLD["end"]], "targets": {}}
    for tgt in cfg["targets"]:
        old_p = hz.build_params(old_site, tgt["command"], OLD["start"], OLD["end"], cfg["sample_step_seconds"])
        old = {r.time_utc: r for r in hz.parse_azel(hz.fetch(site["id"], tgt["key"], old_p, offline=True).payload["result"])}
        new = {}
        for (s, e), p in hz.site_queries(cfg, site, tgt):
            if s <= OLD["end"] and e >= OLD["start"]:
                for r in hz.parse_azel(hz.fetch(site["id"], tgt["key"], p, offline=True).payload["result"]):
                    new[r.time_utc] = r
        common = sorted(set(old) & set(new))
        sep = [separation_deg(old[t].azimuth_deg, old[t].elevation_deg, new[t].azimuth_deg, new[t].elevation_deg) for t in common]
        d_el = [new[t].elevation_deg - old[t].elevation_deg for t in common]
        d_az = [((new[t].azimuth_deg - old[t].azimuth_deg + 180) % 360) - 180 for t in common]
        out["targets"][tgt["key"]] = {
            "samples_compared": len(common),
            "angular_separation_deg": {"min": min(sep), "mean": statistics.fmean(sep), "max": max(sep)},
            "elevation_new_minus_old_deg": {"min": min(d_el), "mean": statistics.fmean(d_el), "max": max(d_el)},
            "azimuth_new_minus_old_deg": {"min": min(d_az), "mean": statistics.fmean(d_az), "max": max(d_az)},
        }
        sd = out["targets"][tgt["key"]]
        print(f"{tgt['key']:5s} n={len(common)}  separation deg: min {min(sep):.3e} mean {statistics.fmean(sep):.3e} "
              f"max {max(sep):.3e} | d_el mean {statistics.fmean(d_el):+.3e} | d_az mean {statistics.fmean(d_az):+.3e}")
    report_path.write_text(json.dumps(out, indent=2) + "\n", "utf-8", newline="\n")
    print(f"wrote {report_path.relative_to(hz.REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(sites.run(main))
