"""Write a dataset's site catalog (catalog.json) next to its manifest.

The catalog lets the app list sites, their location type and their data capabilities
WITHOUT loading every site's time series. Every capability is measured from files that
exist and match the site's identity; nothing is asserted from configuration except the
descriptive location type, short name and provisional note (config.json "catalog").

    python pipeline/catalog.py                      # the current dataset (app/public/data)
    python pipeline/catalog.py --dataset-dir app/public/data/lvn-2026-12-01-120d

Capabilities:
- positions: cached Horizons samples covering the manifest coverage at its step;
- smooth_visibility: smooth-horizon intervals covering that coverage exactly;
- terrain_horizon: a terrain block with its products, near-field pixel size and unknown azimuths;
- terrain_3d: a render asset (app/public/render) whose site identity and observer match;
- slope_screening: a screening asset (app/public/screening) whose site identity and observer match,
  with its DEM pixel size and slope baseline (measurement scale);
- provisional: the configured provisional-result note, or null.
A missing or mismatching file gives {"available": false, "reason": ...}, never a silent yes.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import sites

ROOT = sites.REPO_ROOT
CONFIG = ROOT / "pipeline" / "config.json"
PUBLIC = ROOT / "app" / "public"
CATALOG_VERSION = "1"
LOCATION_TYPES = ("actual_landing_point", "intended_landing_target", "study_location", "user_defined_study_point")


def _lf(path: Path) -> bytes:
    """File bytes with LF line endings (as committed; a Windows checkout may hold CRLF)."""
    return path.read_bytes().replace(bytes([13, 10]), bytes([10]))


def _covers(intervals: list[dict], start: str, end: str) -> bool:
    if not intervals or intervals[0]["start_utc"] != start or intervals[-1]["end_utc"] != end:
        return False
    return all(a["end_utc"] == b["start_utc"] for a, b in zip(intervals, intervals[1:]))


def _render(site: dict, observer_radius: float | None) -> dict:
    p = PUBLIC / "render" / f"{site['id']}.terrain.json"
    if not p.exists():
        return {"available": False, "reason": "no 3D terrain asset for this site"}
    m = json.loads(p.read_text("utf-8"))
    s = m.get("site", {})
    if s.get("id") != site["id"] or s.get("latitude_deg") != site["latitude_deg"] or s.get("longitude_deg_east") != site["longitude_deg_east"]:
        return {"available": False, "reason": "3D terrain asset identity differs from the site file"}
    obs = m.get("observer", {}).get("observer_radius_m")
    if observer_radius is not None and obs is not None and abs(obs - observer_radius) > 1e-6:
        return {"available": False, "reason": "3D terrain asset observer differs from the site file"}
    bin_path = p.with_suffix("").with_suffix(".terrain.bin")
    if not bin_path.exists() or bin_path.stat().st_size != m["counts"]["bin_bytes"]:
        return {"available": False, "reason": "3D terrain binary missing or of the wrong size"}
    return {
        "available": True,
        "source_product": m["source_dem"]["product"],
        "bytes": m["counts"]["bin_bytes"] + len(_lf(p)),  # LF bytes, like every other catalog size
        "near_spacing_m": m["levels"][0]["spacing_m"],
    }


def _slope(site: dict, observer_radius: float | None) -> dict:
    p = PUBLIC / "screening" / f"{site['id']}.slope.json"
    if not p.exists():
        return {"available": False, "reason": "no slope screening asset for this site"}
    a = json.loads(p.read_text("utf-8"))
    s = a.get("site", {})
    if s.get("id") != site["id"] or s.get("latitude_deg") != site["latitude_deg"] or s.get("longitude_deg_east") != site["longitude_deg_east"] \
            or s.get("horizons_site_altitude_km") != site["horizons_site_altitude_km"]:
        return {"available": False, "reason": "slope screening asset identity differs from the site file"}
    obs = a.get("observer", {}).get("observer_radius_m")
    if observer_radius is not None and obs is not None and abs(obs - observer_radius) > 1e-6:
        return {"available": False, "reason": "slope screening asset observer differs from the site file"}
    return {
        "available": True,
        "source_product": a["source_dem"]["product"],
        "dem_pixel_m": a["source_dem"]["map_scale_m"],
        "baseline_m": a["method"]["baseline_m"],
        "radius_m": a["footprint"]["radius_m"],
    }


def build(dataset_dir: Path, cfg: dict) -> dict:
    manifest = json.loads((dataset_dir / "manifest.json").read_text("utf-8"))
    by_id = {s["id"]: s for s in cfg["sites"]}
    out_sites = []
    for e in manifest["sites"]:
        sid = sites.valid_id(e["id"])
        if sid not in by_id:
            raise ValueError(f"manifest site {sid} is not configured")
        c = by_id[sid].get("catalog")
        if not c or c.get("location_type") not in LOCATION_TYPES or not c.get("short_name") or not c.get("location_label"):
            raise ValueError(f"{sid}: config 'catalog' needs short_name, location_label and a location_type in {LOCATION_TYPES}")
        path = dataset_dir / e["file"]
        d = json.loads(path.read_text("utf-8"))
        meta = d["site"]
        if meta["id"] != sid or meta["name"] != e["name"]:
            raise ValueError(f"{e['file']}: identity differs from the manifest")
        sites.require_identity(meta, by_id[sid], f"{e['file']}")
        smp = d["samples"]
        positions_ok = (smp[0]["time_utc"] == manifest["coverage_start_utc"] and smp[-1]["time_utc"] == manifest["coverage_end_utc"])
        th = d.get("terrain_horizon")
        if th and th.get("checks", {}).get("preparation"):
            import prepared_export
            folder, verified = prepared_export.load(by_id[sid])
            if verified["fingerprint"] != th["checks"]["preparation"]["fingerprint"]:
                raise ValueError(f"{sid}: exported horizon differs from the validated preparation")
            # A complete bundle alone is insufficient: the served render/slope files must match it.
            for suffix, subdir in (("terrain.json", "render"), ("terrain.bin", "render"), ("slope.json", "screening")):
                filename = f"{sid}.{suffix}"
                public_path = PUBLIC / subdir / filename
                if not public_path.exists():
                    raise ValueError(f"{sid}: public asset missing: {filename}; catalog not promoted")
                served = public_path.read_bytes()
                prepared = (folder / filename).read_bytes()
                if suffix.endswith("json"):
                    served, prepared = served.replace(b"\r\n", b"\n"), prepared.replace(b"\r\n", b"\n")
                if served != prepared:
                    raise ValueError(f"{sid}: public asset differs from validated bundle: {filename}")
        observer_radius = th["observer"]["observer_radius_m"] if th and th.get("observer") else None
        if th:
            pix = th["horizon"]["resolution"]["dem_pixel_m"]
            terrain = {
                "available": True,
                "products": list(pix.keys()),
                "near_pixel_m": list(pix.values())[0],
                "unknown_azimuths": th["horizon"]["search_extent"]["unknown_azimuths"],
                "covers_positions": _covers(th["visibility_intervals"], manifest["coverage_start_utc"], manifest["coverage_end_utc"]),
            }
        else:
            terrain = {"available": False, "reason": "no terrain horizon in the site file (smooth model only)"}
        out_sites.append({
            "id": sid,
            "name": e["name"],
            "short_name": c["short_name"],
            "latitude_deg": meta["latitude_deg"],
            "longitude_deg_east": meta["longitude_deg_east"],
            "location_type": c["location_type"],
            "location_label": c["location_label"],
            "file": e["file"],
            "file_sha256_lf": hashlib.sha256(_lf(path)).hexdigest(),
            "file_bytes_lf": len(_lf(path)),
            "capabilities": {
                "positions": {
                    "available": positions_ok,
                    "coverage_start_utc": smp[0]["time_utc"],
                    "coverage_end_utc": smp[-1]["time_utc"],
                    "sample_step_seconds": manifest["sample_step_seconds"],
                    "samples": len(smp),
                },
                "smooth_visibility": {"available": _covers(d["visibility_intervals"], manifest["coverage_start_utc"], manifest["coverage_end_utc"])},
                "terrain_horizon": terrain,
                "terrain_3d": _render(meta, observer_radius),
                "slope_screening": _slope(meta, observer_radius),
                "provisional": c.get("provisional_note"),
            },
        })
    return {
        "catalog_version": CATALOG_VERSION,
        "dataset_id": manifest["dataset_id"],
        "manifest_sha256_lf": hashlib.sha256(_lf(dataset_dir / "manifest.json")).hexdigest(),
        "note": "Site list and data capabilities for the app's catalog; derived from the dataset's files and assets. Not visibility data. Hashes and sizes are of the files with LF line endings.",
        "sites": out_sites,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dataset-dir", default=str(PUBLIC / "data"), help="folder holding manifest.json and the site files")
    args = ap.parse_args()
    cfg = json.loads(CONFIG.read_text("utf-8"))
    ddir = Path(args.dataset_dir).resolve()
    cat = build(ddir, cfg)
    (ddir / "catalog.json").write_text(json.dumps(cat, indent=2, ensure_ascii=False) + "\n", "utf-8")
    for s in cat["sites"]:
        caps = s["capabilities"]
        flags = ", ".join(k for k in ("positions", "smooth_visibility", "terrain_horizon", "terrain_3d", "slope_screening") if caps[k]["available"])
        print(f"{s['id']}: {s['location_type']}; available: {flags}" + (f"; {caps['provisional']}" if caps["provisional"] else ""))
    print(f"wrote {(ddir / 'catalog.json').relative_to(ROOT).as_posix()}")
    return 0


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    raise SystemExit(sites.run(main))
