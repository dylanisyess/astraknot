"""Download the LOLA terrain products selected in config.json ("terrain") into
the git-ignored data/raw/lola/<product>/ directories.

    python pipeline/fetch_terrain.py            # all four products (~3.4 GB)
    python pipeline/fetch_terrain.py --check    # verify what is on disk, no network

Source: PDS Geosciences Node, LRO-L-LOLA-4-GDR-V1.0, polar products V2.0:
  https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/polar/img/
Each file is checked against its PDS label (LINES x LINE_SAMPLES x bytes per
sample) and its sha256 is recorded in download.meta.json next to it. Requests
are sequential. Equivalent manual command for one product:
  curl -fLo ldem_80s_20m.img <polar_dir>/ldem_80s_20m.img
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lola  # noqa: E402

CONFIG = Path(__file__).resolve().parent / "config.json"


def products(cfg: dict) -> list[str]:
    t = cfg["terrain"]
    return [t["near_field_product"], t["near_field_counts"], t["far_field_product"], t["far_field_counts"]]


def check_on_disk(name: str, rehash: bool) -> tuple[bool, str]:
    lbl = lola.load_label(name)
    d = lola.RAW_DIR / name.lower()
    path, meta_path = d / f"{name.lower()}.img", d / "download.meta.json"
    if not path.exists() or not meta_path.exists():
        return False, "missing"
    meta = json.loads(meta_path.read_text("utf-8"))
    size = path.stat().st_size
    if size != lbl.expected_bytes:
        return False, f"{size} bytes, label implies {lbl.expected_bytes}"
    if rehash:
        h = hashlib.sha256()
        with open(path, "rb") as f:
            while block := f.read(16 << 20):
                h.update(block)
        if h.hexdigest() != meta["sha256"]:
            return False, "sha256 differs from download.meta.json"
    return True, f"{size:,} bytes = label; sha256 {meta['sha256'][:16]}...{' (re-hashed)' if rehash else ''}"


def main() -> int:
    cfg = json.loads(CONFIG.read_text("utf-8"))
    names = products(cfg)
    if "--check" in sys.argv:
        bad = 0
        for n in names:
            ok, msg = check_on_disk(n, rehash="--rehash" in sys.argv)
            bad += not ok
            print(f"{'OK ' if ok else 'BAD'} {n}: {msg}")
        return 1 if bad else 0
    for n in names:
        lbl = lola.load_label(n)
        print(f"{n}: {lbl.url} ({lbl.expected_bytes / 1e6:,.0f} MB)", flush=True)
        path, meta = lola.download_stream(lbl)
        print(f"  -> {path.relative_to(lola.REPO_ROOT)} sha256 {meta['sha256']}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
