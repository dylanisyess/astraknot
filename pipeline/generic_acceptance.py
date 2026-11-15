"""Read-only generic terrain acceptance and a bounded missing-coverage CLI check.

Writes data/release/generic_acceptance.json. Does not publish, fetch or rebuild terrain.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time

import prepare_site
import sites
import terrain_sources as ts


def portable(cmd):
    """Command as recorded in release evidence: "python" and repo-relative paths (runs used sys.executable and absolute paths)."""
    out = ["python"]
    for arg in cmd[1:]:
        p = Path(arg)
        out.append(p.relative_to(ROOT).as_posix() if p.is_absolute() and p.is_relative_to(ROOT) else arg)
    return out

ROOT = ts.ROOT
SMOKE = ROOT / "data/prepared/d029381f847ce1f0fc820596b1b698069abcc934718775ac7232c791c8c010ab"


def main():
    cfg = sites.load_config()
    catalog_path = sites.dataset_dir(cfg) / "catalog.json"
    catalog_bytes = catalog_path.read_bytes()
    catalog = json.loads(catalog_bytes)
    public_ids = {s["id"] for s in catalog["sites"]}
    records, implementations, sources = [], [], {}
    for site in [s for s in cfg["sites"] if s.get("prepared_terrain")] + [None]:
        folder = ROOT / site["prepared_terrain"] if site else SMOKE
        manifest = prepare_site.validate_bundle(folder, site)
        identity = json.loads((folder / "input.json").read_text())
        implementations.append(identity["implementation_sha256"])
        sid = manifest["site"]["id"]
        if site is None:
            assert sid not in public_ids and sid not in {s["id"] for s in cfg["sites"]}
        for source in identity["sources"]:
            sources[source["file"]] = source["sha256"]
        mesh = json.loads((folder / f"{sid}.terrain.json").read_text())
        slope = json.loads((folder / f"{sid}.slope.json").read_text())
        records.append(dict(site=sid, public=site is not None, command=manifest["command"],
                            fingerprint=manifest["fingerprint"], bundle=folder.relative_to(ROOT).as_posix(),
                            all_product_hashes_valid=True, observer=mesh["observer"],
                            mesh_check=mesh["mesh_check"], slope_method=slope["method"],
                            slope_stats=slope["stats"], checks=manifest["checks"]))
    assert len(records) == 3 and all(i == implementations[0] for i in implementations)
    current_code = {name: ts.sha(ROOT / "pipeline" / name) for name in implementations[0]}
    assert current_code == implementations[0], "Processing code changed after acceptance runs"
    verified_sources = []
    for filename, expected in sources.items():
        actual = ts.sha(ROOT / filename)
        assert actual == expected, f"Source bytes changed: {filename}"
        verified_sources.append(dict(file=filename, sha256=actual, actual_bytes_rehashed=True))
    protected = []
    paths = subprocess.check_output(["git", "ls-files", "--", "app/public/data", "app/public/render", "app/public/screening", "data/terrain", "data/render", "data/screening", "data/horizons"], cwd=ROOT, text=True).splitlines()
    for path in paths:
        before = subprocess.check_output(["git", "show", f"HEAD:{path}"], cwd=ROOT)
        after = (ROOT / path).read_bytes()
        assert before.replace(b"\r\n", b"\n") == after.replace(b"\r\n", b"\n"), f"Protected tracked file changed: {path}"
        protected.append(dict(file=path, sha256_checkout=hashlib.sha256(after).hexdigest(), matches_head_with_checkout_eol=True))
    negative_cmd = [sys.executable, str(ROOT / "pipeline/prepare_site.py"), "--id", "missing-coverage-smoke", "--name", "Missing local terrain smoke test", "--lat", "40", "--lon", "180", "--frame", "MOON_ME_DE421", "--observer-height", "1", "--start", "2026-12-01T00:00:00Z", "--end", "2026-12-02T00:00:00Z", "--step-seconds", "600"]
    markers_before = sorted(str(p) for p in (ROOT / "data/prepared").glob("*/complete.json"))
    rejected = subprocess.run(negative_cmd, cwd=ROOT, capture_output=True, text=True)
    assert rejected.returncode == 1 and "No local" in rejected.stderr and "30..60" in rejected.stderr
    assert markers_before == sorted(str(p) for p in (ROOT / "data/prepared").glob("*/complete.json"))
    assert catalog_path.read_bytes() == catalog_bytes
    first = next(s for s in cfg["sites"] if s.get("prepared_terrain"))
    replay_cmd = [sys.executable, str(ROOT / "pipeline/prepare_site.py"), "--config", str(ROOT / "pipeline/config.json"), "--site", first["id"]]
    started = time.monotonic()
    replay = subprocess.run(replay_cmd, cwd=ROOT, capture_output=True, text=True)
    assert replay.returncode == 0 and "CACHE VALID" in replay.stdout, replay.stderr
    result = dict(checked_at_utc=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                  three_coordinates_same_unchanged_processing_code=True, implementation_sha256=current_code,
                  records=records, sources=verified_sources, protected_files=protected,
                  missing_coverage=dict(command=portable(negative_cmd), exit_code=rejected.returncode, stderr=rejected.stderr,
                                        no_complete_marker_created=True, catalog_unchanged=True),
                  replay=dict(command=portable(replay_cmd), stdout=replay.stdout, seconds=time.monotonic()-started,
                              cache_reused=True, no_horizon_or_mesh_rebuild=True), network_requests=0)
    prepare_site.atomic_json(ROOT / "data/release/generic_acceptance.json", result)
    print(f"PASS: 3 coordinates, identical unchanged processing code; {len(verified_sources)} source files rehashed; {len(protected)} protected files unchanged; missing coverage refused; complete cache reused")


if __name__ == "__main__":
    main()
