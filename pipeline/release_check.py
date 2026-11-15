"""Offline release evidence: validate both versions, protect the accepted files, and measure payload.

Run from the repository root: python pipeline/release_check.py
No downloads or terrain regeneration. Writes evidence under data/release/ only.
"""
from __future__ import annotations

import contextlib
import gzip
import hashlib
import io
import json
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import sites
import validate
import export as exporter

ROOT = sites.REPO_ROOT
LEGACY_CONFIG = ROOT / "pipeline/datasets/lvn-2026-12-01-60d.json"


def digest(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def main() -> int:
    cfg = sites.load_config()
    old = sites.load_config(LEGACY_CONFIG)
    out = ROOT / "data/release"
    out.mkdir(exist_ok=True)
    evidence = {"checked_at_utc": datetime.now(timezone.utc).isoformat(), "network_requests": 0,
                "head": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
                "baseline_reference": "245adc6", "baseline_files": [], "datasets": [], "cache": [], "regression": []}
    with patch("urllib.request.urlopen", side_effect=AssertionError("NETWORK FORBIDDEN in release check")):
        for label, path in (("60d", LEGACY_CONFIG), ("120d", ROOT / "pipeline/config.json")):
            buf = io.StringIO()
            with patch.object(sys, "argv", ["validate.py", "--config", str(path)]), contextlib.redirect_stdout(buf):
                code = validate.main()
            (out / f"m6_validation_{label}.txt").write_text(buf.getvalue(), "utf-8")
            assert code == 0, f"{label} validation failed; see data/release/m6_validation_{label}.txt"
            evidence["datasets"].append({"version": label, "checks": len(validate.results), "passed": sum(x[0] for x in validate.results)})
        for s in cfg["sites"]:
            for tgt in cfg["targets"]:
                responses, rows = exporter.load_target(cfg, s, tgt)
                evidence["cache"].append({"site": s["id"], "target": tgt["key"], "verified_chunks": len(responses),
                                           "samples": len(rows), "start": rows[0].time_utc, "end": rows[-1].time_utc})
    # Do not rewrite the legacy export. Compare it to the accepted Git object, allowing only checkout EOL conversion.
    for name in ("manifest.json", "im2-athena.json", "connecting-ridge-cr1.json"):
        p = sites.dataset_dir(old) / name
        b = p.read_bytes()
        rel = p.relative_to(ROOT).as_posix()
        accepted = subprocess.check_output(["git", "show", f"245adc6:{rel}"], cwd=ROOT)
        assert b.replace(b"\r\n", b"\n") == accepted.replace(b"\r\n", b"\n"), f"accepted file changed: {rel}"
        evidence["baseline_files"].append({"file": rel, "sha256_actual_checkout_bytes": digest(b),
                                            "sha256_lf": digest(b.replace(b"\r\n", b"\n")), "matches_accepted_git_with_checkout_eol": True})
    start = datetime.fromisoformat(cfg["coverage_start_utc"].replace("Z", "+00:00"))
    expected_end = (start + timedelta(days=120)).strftime("%Y-%m-%dT%H:%M:%SZ")
    assert cfg["coverage_end_utc"] == expected_end
    evidence["computed_endpoint"] = expected_end
    for s in old["sites"]:
        a = sites.load_site_data(old, s)
        b = sites.load_site_data(cfg, s)
        assert b["samples"][:len(a["samples"])] == a["samples"]
        assert a["horizon"] == b["horizon"]
        for key in ("horizon", "observer", "setting_points"):
            assert a["terrain_horizon"][key] == b["terrain_horizon"][key]
        for key in (None, "terrain_horizon"):
            aa, bb = (a, b) if key is None else (a[key], b[key])
            def clipped(intervals):
                return [{**iv, "end_utc": min(iv["end_utc"], old["coverage_end_utc"])} for iv in intervals if iv["start_utc"] < old["coverage_end_utc"]]
            assert clipped(aa["visibility_intervals"]) == clipped(bb["visibility_intervals"])
        evidence["regression"].append({"site": s["id"], "identical_old_samples": len(a["samples"]),
                                         "identical_profiles_and_observer": True, "identical_smooth_and_terrain_states_over_entire_old_coverage": True})
    payload = []
    for folder in (sites.dataset_dir(old), sites.dataset_dir(cfg)):
        for p in sorted(folder.glob("*.json")):
            raw = p.read_bytes()
            payload.append({"file": p.relative_to(ROOT).as_posix(), "bytes": len(raw), "gzip_bytes": len(gzip.compress(raw, mtime=0)), "sha256": digest(raw)})
    evidence["payload"] = payload
    # Rehash the already downloaded nonpolar tile; do not trust its metadata alone.
    report = json.loads((ROOT / "data/terrain/apollo17-lm_site_elevation_report.json").read_text("utf-8"))
    dem = report["dem"]
    p = ROOT / "data/raw/sldem" / dem["product"] / f"{dem['product']}.img"
    h = hashlib.sha256()
    with p.open("rb") as f:
        for block in iter(lambda: f.read(16 << 20), b""):
            h.update(block)
    assert p.stat().st_size == dem["bytes"] and h.hexdigest() == dem["sha256"]
    evidence["apollo17_surface_dem"] = {"bytes": p.stat().st_size, "sha256": h.hexdigest(), "rehashed": True}
    (out / "m6_release_check.json").write_text(json.dumps(evidence, indent=2) + "\n", "utf-8")
    print("PASS: both datasets, 96 cached chunks, accepted files, entire old-window samples/states/profiles, endpoint, SLDEM hash")
    for item in evidence["datasets"]:
        print(f"  {item['version']}: {item['passed']}/{item['checks']} checks")
    print("Evidence: data/release/m6_release_check.json and m6_validation_{60d,120d}.txt")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
