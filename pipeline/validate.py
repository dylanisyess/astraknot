"""Validate exported app data against the data contract and the raw Horizons
responses. Prints one line per check; exits non-zero on any failure.

    python pipeline/validate.py
"""
from __future__ import annotations

import hashlib
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sites
import horizons as hz  # noqa: E402
import visibility as vis  # noqa: E402

CONFIG = Path(__file__).resolve().parent / "config.json"
DATA = hz.REPO_ROOT / "app" / "public" / "data"

results: list[tuple[bool, str, str]] = []


def check(ok: bool, name: str, detail: str = "") -> None:
    results.append((bool(ok), name, detail))


def _header_checks(tag: str, site: dict, tgt: dict, r: hz.CachedResponse, chunk: tuple[str, str],
                   step_s: int) -> tuple[dict[str, tuple[bool, str]], list[hz.AzElRow]]:
    """Per-chunk checks: name -> (ok, detail)."""
    out: dict[str, tuple[bool, str]] = {}
    h = hz.header_fields(r.payload["result"])
    out["cached body sha256 matches metadata"] = (hashlib.sha256(r.body).hexdigest() == r.meta["response_sha256"], "")
    out["HTTP 200, no API error field"] = (r.meta["http_status"] == 200 and "error" not in r.payload,
                                         str(r.meta["http_status"]))
    out["observer body is Moon (301)"] = (h.get("Center body name", "").startswith("Moon (301)"),
                                         h.get("Center body name", ""))
    expect_target = {"sun": "Sun (10)", "earth": "Earth (399)"}[tgt["key"]]
    out[f"target is {expect_target}"] = (h.get("Target body name", "").startswith(expect_target),
                                        h.get("Target body name", ""))
    geo = h.get("Center geodetic", "")
    try:
        lon, lat, alt = (float(x) for x in geo.split("{")[0].split(","))
        ok = (abs(lon - site["longitude_deg_east"]) < 1e-9 and abs(lat - site["latitude_deg"]) < 1e-9
              and abs(alt - site["horizons_site_altitude_km"]) < 1e-9)
    except ValueError:
        ok = False
    out["site echoed as E-lon,Lat,Alt = config"] = (ok and "{E-lon(deg),Lat(deg),Alt(km)}" in geo, geo)
    cyl = h.get("Center cylindric", "")
    try:
        _, dxy, dz = (float(x) for x in cyl.split("{")[0].split(","))
        r_site = math.hypot(dxy, dz)
        # Horizons prints Dxy to 1e-5 km and Dz to 1e-4 km, so |r| from the echo is only
        # good to ~0.05 m; 0.1 m tolerance. This does not show agreement better than that.
        ok = abs(r_site - (1737.4 + site["horizons_site_altitude_km"])) < 1e-4
    except ValueError:
        r_site, ok = float("nan"), False
    out["altitude is height above 1737.4 km sphere (|cylindric| ~ R + alt, within printed precision)"] = (
        ok, f"|r| = {r_site:.7f} km; R + alt - |r| = {(1737.4 + site['horizons_site_altitude_km'] - r_site) * 1e6:.1f} mm")
    out["lunar frame MEAN_ME, east-longitude positive"] = (
        "MEAN_ME" in h.get("Center pole/equ", "") and "East-longitude positive" in h.get("Center pole/equ", ""),
        h.get("Center pole/equ", ""))
    out["reference body radii 1737.4 km sphere"] = (h.get("Center radii", "").startswith("1737.4, 1737.4, 1737.4"),
                                                   h.get("Center radii", ""))
    out["airless output"] = (h.get("Atmos refraction", "") == "NO (AIRLESS)", h.get("Atmos refraction", ""))
    out["time scale UT (=UTC after 1962)"] = (h.get("Start time", "").endswith("UT") and
                                             h.get("Stop time", "").endswith("UT"), "")
    out["columns are airless apparent AZ/EL of target center"] = (
        "Airless apparent azimuth and elevation of target center" in r.payload["result"], "")
    rows = hz.parse_azel(r.payload["result"])
    n_exp = int((vis.parse_utc(chunk[1]) - vis.parse_utc(chunk[0])).total_seconds() // step_s) + 1
    out["chunk row count and endpoints"] = (len(rows) == n_exp and rows[0].time_utc == chunk[0]
                                           and rows[-1].time_utc == chunk[1], f"{len(rows)} (expected {n_exp})")
    missing = sum(x.azimuth_deg is None or x.elevation_deg is None for x in rows)
    out["no missing (n.a.) values"] = (missing == 0, f"{missing} missing")
    return out, rows


def validate_raw(cfg: dict, site: dict) -> dict[str, list[hz.AzElRow]]:
    rows_by_key = {}
    for tgt in cfg["targets"]:
        tag = f"raw/{tgt['key']}"
        per_check: dict[str, list[tuple[bool, str]]] = {}
        chunks, versions = [], set()
        queries = hz.site_queries(cfg, site, tgt)
        for chunk, params in queries:
            r = hz.fetch(site["id"], tgt["key"], params, offline=True)
            versions.add(r.payload["signature"].get("version"))
            res, rows = _header_checks(tag, site, tgt, r, chunk, cfg["sample_step_seconds"])
            chunks.append(rows)
            for k, v in res.items():
                per_check.setdefault(k, []).append(v)
        for k, vals in per_check.items():
            n_ok = sum(ok for ok, _ in vals)
            details = sorted({d for _, d in vals if d})
            check(n_ok == len(vals), f"{tag}: {k}",
                  f"{n_ok}/{len(vals)} chunks" + (f"; {details[0]}" if len(details) == 1 else ""))
        check(True, f"{tag}: API signature version recorded",
              f"{sorted(versions)} (doc page says {hz.EXPECTED_API_VERSION})")
        try:
            merged = hz.merge_chunks(chunks)
            check(True, f"{tag}: chunk boundary samples identical in both chunks", f"{len(chunks) - 1} boundaries")
        except hz.HorizonsError as e:
            check(False, f"{tag}: chunk boundary samples identical in both chunks", str(e))
            merged = [row for c in chunks for row in c]
        n_expected = int((vis.parse_utc(cfg["coverage_end_utc"]) - vis.parse_utc(cfg["coverage_start_utc"]))
                         .total_seconds() // cfg["sample_step_seconds"]) + 1
        check(len(merged) == n_expected, f"{tag}: merged row count", f"{len(merged)} (expected {n_expected})")
        rows_by_key[tgt["key"]] = merged
    return rows_by_key


def validate_export(cfg: dict, site: dict, raw: dict[str, list[hz.AzElRow]]) -> None:
    manifest = json.loads((DATA / "manifest.json").read_text("utf-8"))
    check(manifest["schema_version"] == "1.0", "manifest: schema_version 1.0")
    check(manifest["is_synthetic"] is False, "manifest: is_synthetic false")
    check(manifest["sample_step_seconds"] == 600, "manifest: sample_step_seconds 600")
    check(manifest["generated_at_utc"].endswith("Z"), "manifest: generated_at_utc ends in Z")
    entry = next((s for s in manifest["sites"] if s["id"] == site["id"]), None)
    check(entry is not None, f"manifest: lists site {site['id']}")
    d = sites.load_site_data(cfg, site, DATA, manifest)
    check(True, "site: manifest filename, identity and configured coverage match")
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
    models = m.get("available_horizon_models", ["smooth"])
    check(models[0] == "smooth" and set(models) <= {"smooth", "terrain"}, "site: available_horizon_models",
          str(models))
    if "terrain" in models:
        validate_terrain(d, m, s, times)
    else:
        check("terrain_horizon" not in d, "terrain: no terrain block when not listed as available")


def validate_terrain(d: dict, m: dict, s: list[dict], times: list[str]) -> None:
    t = d.get("terrain_horizon")
    check(t is not None, "terrain: block present")
    if t is None:
        return
    h = t["horizon"]
    az, el = h["azimuth_deg"], h["elevation_deg"]
    check(h["model"] == "terrain" and h["interpolation"] == "linear_periodic", "terrain: model and interpolation")
    check(len(az) == len(el) == 3600 and az == sorted(set(az)) and 0 <= az[0] and az[-1] < 360,
          "terrain: 3600 ascending unique azimuths in [0, 360)", f"{len(az)} azimuths")
    check(all(e is None or -90 <= e <= 90 for e in el), "terrain: elevations in [-90, 90] or null",
          f"{sum(e is None for e in el)} null; min {min(e for e in el if e is not None):.3f}, "
          f"max {max(e for e in el if e is not None):.3f}")
    check(any(e is not None and e < 0 for e in el), "terrain: negative horizons kept (not clamped to 0)",
          f"{sum(e is not None and e < 0 for e in el)} negative")
    check(h["observer_height_above_surface_m"] == m["observer_height_above_surface_m"],
          "terrain: observer height matches site")
    se = h.get("search_extent", {})
    check(se.get("h_max_m") and se.get("stop_distance_km_min_median_max") and
          "Search extent" in h["processing_notes"] and h.get("resolution", {}).get("azimuth_step_deg"),
          "terrain: search extent, stopping rule and resolution recorded")
    sp = t["setting_points"]
    cols = ("distance_km", "height_m", "lat_deg", "lon_deg_east", "product_index", "shot_count")
    check(all(len(sp[c]) == len(az) for c in cols), "terrain: one setting point per azimuth")
    check(all((e is None) == (sp["distance_km"][i] is None) for i, e in enumerate(el)),
          "terrain: unknown elevation <-> no setting point")
    # equals the pipeline report (rounded) and was computed for this site
    rep, xc = sites.load_terrain_reports(m)
    check(True, "terrain: report and cross-check identities + fingerprint match")
    same = [None if r["elevation_deg"] is None else round(r["elevation_deg"], 5) for r in rep["rays"]] == el
    check(same and rep["site"]["horizons_site_altitude_km"] == m["horizons_site_altitude_km"],
          "terrain: export == data/terrain report (rounded 1e-5 deg), same site altitude")
    iv = t["visibility_intervals"]
    contiguous = all(a["end_utc"] == b["start_utc"] for a, b in zip(iv, iv[1:]))
    check(iv[0]["start_utc"] == times[0] and iv[-1]["end_utc"] == times[-1] and contiguous,
          "terrain intervals: contiguous and cover the advertised range exactly", f"{len(iv)} interval(s)")
    check(vis.classify(s, h) == iv, "terrain intervals: re-classified from samples + exported profile (exact)")
    unknown = sum(x["sun_visible"] is None or x["earth_visible"] is None for x in iv)
    check(True, "terrain intervals: unknown states", f"{unknown} interval(s) with an unknown state")
    # product files: label-implied size and recorded sha256 (when the downloads are present)
    srcs = {x["id"] for x in d["sources"]}
    check(all(f"lola-{p['name'].lower().replace('_', '-')}" in srcs for p in t["products"]),
          "terrain: every LOLA product listed in sources")
    n_ok = n_missing = 0
    for p in t["products"]:
        meta_path = hz.REPO_ROOT / "data" / "raw" / "lola" / p["name"].lower() / "download.meta.json"
        img = meta_path.parent / f"{p['name'].lower()}.img"
        if not (meta_path.exists() and img.exists()):
            n_missing += 1
            continue
        meta = json.loads(meta_path.read_text("utf-8"))
        n_ok += (meta["sha256"] == p["sha256"] and img.stat().st_size == meta["bytes"] == meta["label_implied_bytes"])
    check(n_ok + n_missing == len(t["products"]), "terrain: local LOLA files match recorded size and sha256",
          f"{n_ok} match, {n_missing} not downloaded (run pipeline/fetch_terrain.py --check --rehash)")


def main() -> int:
    ap = sites.parser(description=__doc__)
    args = ap.parse_args()
    cfg = json.loads(CONFIG.read_text("utf-8"))
    selected = sites.cli_sites(ap, args, cfg, batch=True)
    results.clear()
    for site in selected:
        start = len(results)
        try:
            raw = validate_raw(cfg, site)
            validate_export(cfg, site, raw)
        except (ValueError, KeyError, OSError, hz.HorizonsError) as e:
            check(False, "site data validation", str(e))
        results[start:] = [(ok, f"{site['id']}: {name}", detail) for ok, name, detail in results[start:]]
    width = max(len(n) for _, n, _ in results)
    for ok, name, detail in results:
        print(f"{'PASS' if ok else 'FAIL'}  {name.ljust(width)}  {detail}")
    failed = sum(not ok for ok, _, _ in results)
    print(f"\n{len(results) - failed}/{len(results)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(sites.run(main))
