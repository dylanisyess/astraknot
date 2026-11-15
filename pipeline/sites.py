"""Site selection, canonical filenames and identity checks shared by the pipeline.

Only a sole configured site can be selected implicitly. Batch commands retain
their default of processing all configured sites; --site limits them to one.
Raw LOLA rasters/labels are product caches and deliberately remain shared.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
IDENTITY_FIELDS = ("id", "latitude_deg", "longitude_deg_east",
                   "horizons_site_altitude_km", "observer_height_above_surface_m")


def valid_id(site_id: str) -> str:
    if not isinstance(site_id, str) or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", site_id):
        raise ValueError(f"Invalid site ID {site_id!r}: use lowercase letters/digits separated by hyphens")
    return site_id


def select_sites(cfg: dict, site_id: str | None = None, *, batch=False) -> list[dict]:
    sites = cfg["sites"]
    ids = [valid_id(s["id"]) for s in sites]
    if not ids or len(ids) != len(set(ids)):
        raise ValueError("Config must contain nonempty, unique site IDs")
    if site_id is not None:
        valid_id(site_id)
        if site_id not in ids:
            raise ValueError(f"Unknown site ID {site_id!r}; configured: {', '.join(ids)}")
        return [sites[ids.index(site_id)]]
    if batch or len(sites) == 1:
        return sites
    raise ValueError(f"Choose --site explicitly; configured: {', '.join(ids)}")


def parser(**kwargs) -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(**kwargs)
    ap.add_argument("--site", metavar="ID", help="configured site ID (default: sole site; batch commands: all sites)")
    return ap


def cli_sites(ap, args, cfg, *, batch=False):
    try:
        return select_sites(cfg, args.site, batch=batch)
    except ValueError as e:
        ap.error(str(e))


def run(main) -> int:
    """Expected data/config errors should be readable CLI failures."""
    try:
        return main()
    except (ValueError, KeyError, OSError, RuntimeError) as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1


DEFAULT_CONFIG = REPO_ROOT / "pipeline" / "config.json"


def add_config_arg(ap: argparse.ArgumentParser, default: Path = DEFAULT_CONFIG) -> None:
    ap.add_argument("--config", metavar="PATH", default=str(default),
                    help="dataset config (default pipeline/config.json; the accepted 60-day release: pipeline/datasets/lvn-2026-12-01-60d.json)")


def load_config(path: str | Path | None = None) -> dict:
    return json.loads(Path(path or DEFAULT_CONFIG).read_text("utf-8"))


def dataset_dir(cfg: dict) -> Path:
    """Folder of a dataset's manifest and site files (legacy configs: app/public/data)."""
    return REPO_ROOT / cfg.get("dataset_dir", "app/public/data")


def report_path(site_id: str, kind: str) -> Path:
    folder = "horizons" if kind == "altitude_comparison" else "terrain"
    return REPO_ROOT / "data" / folder / f"{valid_id(site_id)}_{kind}.json"


def identity(site: dict) -> dict:
    return {k: site[k] for k in IDENTITY_FIELDS}


def require_identity(actual: dict, expected: dict, label: str) -> None:
    for k in IDENTITY_FIELDS:
        if k not in actual or actual[k] != expected[k]:
            raise ValueError(f"{label}: site identity mismatch for {k} (expected {expected[k]!r}, got {actual.get(k)!r})")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_terrain_reports(site: dict) -> tuple[dict, dict]:
    path = report_path(site["id"], "terrain_horizon")
    cross = report_path(site["id"], "horizon_crosscheck")
    rep, xc = json.loads(path.read_text("utf-8")), json.loads(cross.read_text("utf-8"))
    require_identity(rep.get("site", {}), site, str(path))
    require_identity(xc.get("site", {}), site, str(cross))
    if xc.get("terrain_report_sha256") != sha256(path):
        raise ValueError(f"{cross}: terrain report fingerprint mismatch; rerun horizon_crosscheck.py --site {site['id']}")
    return rep, xc


def load_site_data(cfg: dict, site: dict, data_dir: Path | None = None, manifest: dict | None = None) -> dict:
    data_dir = data_dir or dataset_dir(cfg)
    filename = f"{valid_id(site['id'])}.json"
    if manifest is not None:
        entries = [e for e in manifest["sites"] if e["id"] == site["id"]]
        if len(entries) != 1 or entries[0]["file"] != filename:
            raise ValueError(f"Manifest must map {site['id']} exactly once to {filename}")
        for k in ("dataset_id", "coverage_start_utc", "coverage_end_utc", "sample_step_seconds"):
            if manifest[k] != cfg[k]:
                raise ValueError(f"Manifest {k} differs from config; export all sites again")
    data = json.loads((data_dir / filename).read_text("utf-8"))
    require_identity(data.get("site", {}), site, filename)
    samples = data["samples"]
    if (not samples or samples[0]["time_utc"] != cfg["coverage_start_utc"]
            or samples[-1]["time_utc"] != cfg["coverage_end_utc"]):
        raise ValueError(f"{filename}: samples do not cover configured interval")
    return data
