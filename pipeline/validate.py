"""Validate exported app data against the data contract and the raw Horizons
responses. Prints one line per check; exits non-zero on any failure.

    python pipeline/validate.py
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import horizons as hz  # noqa: E402
import visibility as vis  # noqa: E402

CONFIG = Path(__file__).resolve().parent / "config.json"
DATA = hz.REPO_ROOT / "app" / "public" / "data"

results: list[tuple[bool, str, str]] = []


def check(ok: bool, name: str, detail: str = "") -> None:
    results.append((bool(ok), name, detail))


def validate_raw(cfg: dict, site: dict) -> dict[str, list[hz.AzElRow]]:
    rows_by_key = {}
    n_expected = int((vis.parse_utc(cfg["coverage_end_utc"]) - vis.parse_utc(cfg["coverage_start_utc"]))
                     .total_seconds() // cfg["sample_step_seconds"]) + 1
    for tgt in cfg["targets"]:
        params = hz.build_params(site, tgt["command"], cfg["coverage_start_utc"],
                                 cfg["coverage_end_utc"], cfg["sample_step_seconds"])
        r = hz.fetch(site["id"], tgt["key"], params, offline=True)
        tag = f"raw/{tgt['key']}"
        check(hashlib.sha256(r.body).hexdigest() == r.meta["response_sha256"],
              f"{tag}: cached body sha256 matches metadata")
        check(r.meta["http_status"] == 200, f"{tag}: HTTP 200", str(r.meta["http_status"]))
        check("error" not in r.payload, f"{tag}: no API error field")
        ver = r.payload["signature"].get("version")
        check(True, f"{tag}: API signature version recorded",
              f"{ver} (doc page says {hz.EXPECTED_API_VERSION})")

        h = hz.header_fields(r.payload["result"])
        check(h.get("Center body name", "").startswith("Moon (301)"), f"{tag}: observer body is Moon (301)",
              h.get("Center body name", ""))
        expect_target = {"sun": "Sun (10)", "earth": "Earth (399)"}[tgt["key"]]
        check(h.get("Target body name", "").startswith(expect_target), f"{tag}: target is {expect_target}",
              h.get("Target body name", ""))
        geo = h.get("Center geodetic", "")
        try:
            lon, lat, alt = (float(x) for x in geo.split("{")[0].split(","))
            ok = (abs(lon - site["longitude_deg_east"]) < 1e-9 and abs(lat - site["latitude_deg"]) < 1e-9
                  and abs(alt - site["horizons_site_altitude_km"]) < 1e-9)
        except ValueError:
            ok = False
        check(ok and "{E-lon(deg),Lat(deg),Alt(km)}" in geo,
              f"{tag}: site echoed as E-lon,Lat,Alt = config", geo)
        check("East-longitude positive" in h.get("Center pole/equ", ""),
              f"{tag}: lunar frame is east-longitude positive", h.get("Center pole/equ", ""))
        check(h.get("Center radii", "").startswith("1737.4, 1737.4, 1737.4"),
              f"{tag}: altitude reference is 1737.4 km sphere", h.get("Center radii", ""))
        check(h.get("Atmos refraction", "") == "NO (AIRLESS)", f"{tag}: airless output",
              h.get("Atmos refraction", ""))
        check(h.get("Start time", "").endswith("UT") and h.get("Stop time", "").endswith("UT"),
              f"{tag}: time scale UT (=UTC after 1962)", h.get("Start time", ""))
        check("Airless apparent azimuth and elevation of target center" in r.payload["result"],
              f"{tag}: columns are airless apparent AZ/EL of target center")

        rows = hz.parse_azel(r.payload["result"])
        rows_by_key[tgt["key"]] = rows
        check(len(rows) == n_expected, f"{tag}: row count", f"{len(rows)} (expected {n_expected})")
        missing = sum(x.azimuth_deg is None or x.elevation_deg is None for x in rows)
        check(missing == 0, f"{tag}: no missing values", f"{missing} missing")
    return rows_by_key


def validate_export(cfg: dict, site: dict, raw: dict[str, list[hz.AzElRow]]) -> None:
    manifest = json.loads((DATA / "manifest.json").read_text("utf-8"))
    check(manifest["schema_version"] == "1.0", "manifest: schema_version 1.0")
    check(manifest["is_synthetic"] is False, "manifest: is_synthetic false")
    check(manifest["sample_step_seconds"] == 600, "manifest: sample_step_seconds 600")
    check(manifest["generated_at_utc"].endswith("Z"), "manifest: generated_at_utc ends in Z")
    entry = next((s for s in manifest["sites"] if s["id"] == site["id"]), None)
    check(entry is not None, f"manifest: lists site {site['id']}")
    d = json.loads((DATA / entry["file"]).read_text("utf-8"))
    m = d["site"]
    check(m["is_synthetic"] is False, "site: is_synthetic false")
    check(0 <= m["longitude_deg_east"] < 360, "site: longitude in [0, 360)", str(m["longitude_deg_east"]))
    check(m["horizons_site_altitude_km"] == site["horizons_site_altitude_km"],
          "site: Horizons altitude equals value submitted")

    s = d["samples"]
    times = [x["time_utc"] for x in s]
    check(times == sorted(times) and len(set(times)) == len(times), "samples: sorted, unique timestamps")
    check(vis.step_ok(s, manifest["sample_step_seconds"]), "samples: uniform 600 s spacing")
    check(times[0] == manifest["coverage_start_utc"], "samples: first = coverage_start_utc", times[0])
    check(times[-1] == manifest["coverage_end_utc"], "samples: final sample at coverage_end_utc", times[-1])
    nulls = sum(v is None for x in s for k, v in x.items() if k != "time_utc")
    check(nulls == 0, "samples: no null values", f"{nulls} null")
    els = [x[k] for x in s for k in ("sun_elevation_deg", "earth_elevation_deg") if x[k] is not None]
    azs = [x[k] for x in s for k in ("sun_azimuth_deg", "earth_azimuth_deg") if x[k] is not None]
    check(all(-90 <= v <= 90 for v in els), "samples: elevations in [-90, 90]",
          f"min {min(els):.4f}, max {max(els):.4f}")
    check(all(0 <= v < 360 for v in azs), "samples: azimuths in [0, 360)")

    mism = 0
    for i, x in enumerate(s):
        for key in ("sun", "earth"):
            rr = raw[key][i]
            if (x["time_utc"] != rr.time_utc or x[f"{key}_azimuth_deg"] != vis.norm360(rr.azimuth_deg)
                    or x[f"{key}_elevation_deg"] != rr.elevation_deg):
                mism += 1
    check(mism == 0, "export == raw Horizons rows (exact, every sample)", f"{mism} mismatches of {2 * len(s)}")

    iv = d["visibility_intervals"]
    contiguous = all(a["end_utc"] == b["start_utc"] for a, b in zip(iv, iv[1:]))
    check(iv[0]["start_utc"] == times[0] and iv[-1]["end_utc"] == times[-1] and contiguous,
          "intervals: contiguous and cover the advertised range exactly", f"{len(iv)} interval(s)")
    check(d["horizon"]["model"] == "smooth" and m["horizon_model"] == "smooth",
          "horizon: explicitly labeled smooth model")


def main() -> int:
    cfg = json.loads(CONFIG.read_text("utf-8"))
    for site in cfg["sites"]:
        raw = validate_raw(cfg, site)
        validate_export(cfg, site, raw)
    width = max(len(n) for _, n, _ in results)
    for ok, name, detail in results:
        print(f"{'PASS' if ok else 'FAIL'}  {name.ljust(width)}  {detail}")
    failed = sum(not ok for ok, _, _ in results)
    print(f"\n{len(results) - failed}/{len(results)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
