"""Effect of the observer-altitude rounding convention on a site's terrain horizon.

The Horizons altitude is formed from the LOLA surface rounded to 0.1 m plus the nominal
observer height (site_elevation.py), so the submitted eye is not exactly the nominal height
above the bilinear DEM surface. This recomputes the 0.1-degree profile with the eye at exactly
the nominal height and compares skyline, 10-minute visibility steps and demo-window metrics
with the terrain report. Diagnostic only: nothing here is exported to the app.

    python pipeline/observer_rounding_check.py --site ID
Writes data/terrain/<site_id>_observer_rounding_check.json. Requires the terrain report,
the exported site samples and the downloaded LOLA products.
"""
from __future__ import annotations

import json
import statistics
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sites  # noqa: E402
import terrain_horizon as th  # noqa: E402
import terrain_sensitivity as ts  # noqa: E402


def main() -> int:
    ap = sites.parser(description=__doc__)
    args = ap.parse_args()
    cfg = json.loads(th.CONFIG.read_text("utf-8"))
    site = sites.cli_sites(ap, args, cfg)[0]
    rep_path = sites.report_path(site["id"], "terrain_horizon")
    rep = json.loads(rep_path.read_text("utf-8"))
    sites.require_identity(rep.get("site", {}), site, str(rep_path))
    t = cfg["terrain"]
    products = [(t["near_field_product"], t["near_field_counts"]), (t["far_field_product"], t["far_field_counts"])]
    foot = rep["site"]["dem_surface_at_site_m"]
    nominal = site["observer_height_above_surface_m"]
    obs = th.Observer(site["latitude_deg"], site["longitude_deg_east"], th.R + foot + nominal)
    az = [r["azimuth_deg"] for r in rep["rays"]]
    base_el = [r["elevation_deg"] for r in rep["rays"]]
    rays = th.profile(obs, az, products, rep["method"]["stopping_rule"]["h_max_m"])
    el = [r["elevation_deg"] for r in rays]
    d = [(b - a, x, r["distance_m"]) for a, b, x, r in zip(base_el, el, az, rays)
         if a is not None and b is not None]
    worst = max(d, key=lambda q: abs(q[0]))
    samples = ts.load_samples(cfg, site)
    s0 = ts.step_states(samples, ts.horizon_dict(az, base_el))
    s1 = ts.step_states(samples, ts.horizon_dict(az, el))
    changed = [{"step_start_utc": samples[k]["time_utc"], "body": b, "submitted": s0[k][i], "exact": s1[k][i]}
               for k in range(len(s0)) for i, b in enumerate(("sun", "earth")) if s0[k][i] != s1[k][i]]
    demo0, demo1 = ts.demo_metrics(samples, s0), ts.demo_metrics(samples, s1)
    out = {
        "generated_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "site": sites.identity(site),
        "terrain_report_sha256": sites.sha256(rep_path),
        "eye_above_dem_submitted_m": rep["site"]["eye_above_dem_surface_m"],
        "eye_above_dem_exact_m": nominal,
        "note": ("Exact-eye profile minus the exported (submitted-altitude) profile. Sun/Earth directions are "
                 "not recomputed (their altitude parallax at this scale is ~1e-9 deg). Demo windows: 14 days "
                 f"from {ts.DEMO_BASELINE} + 0/1/3/7 d, terrain mode."),
        "skyline_change_deg": {"max_abs": abs(worst[0]), "signed_at_max": worst[0], "at_azimuth_deg": worst[1],
                               "setting_distance_m_at_max": worst[2],
                               "mean_abs": statistics.fmean(abs(q[0]) for q in d)},
        "unknown_azimuths_submitted_exact": [sum(e is None for e in base_el), sum(e is None for e in el)],
        "steps_changed": {"sun": sum(c["body"] == "sun" for c in changed),
                          "earth": sum(c["body"] == "earth" for c in changed), "rows": changed},
        "demo_metric_change_exact_minus_submitted": {
            w: {f: (None if demo0[w][f] is None or demo1[w][f] is None else demo1[w][f] - demo0[w][f])
                for f in demo0[w]} for w in demo0},
    }
    path = sites.report_path(site["id"], "observer_rounding_check")
    path.write_text(json.dumps(out, indent=1) + "\n", "utf-8", newline="\n")
    sc = out["skyline_change_deg"]
    print(f"{site['id']}: eye {out['eye_above_dem_submitted_m']:.6f} m -> {nominal} m: skyline max |change| "
          f"{sc['max_abs']:.4f} deg (az {sc['at_azimuth_deg']}, {sc['setting_distance_m_at_max']:.0f} m), "
          f"mean {sc['mean_abs']:.4f}; steps changed sun {out['steps_changed']['sun']}, "
          f"earth {out['steps_changed']['earth']}")
    print(f"wrote {path.relative_to(sites.REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(sites.run(main))
