"""Retrieve Sun and Earth AZ/EL from JPL Horizons for every configured site.

Requests are made one at a time (never concurrently), each response is cached
byte-for-byte under data/horizons/, and a re-run uses the cache.

    python pipeline/fetch.py              # fetch missing responses
    python pipeline/fetch.py --refresh    # re-download everything
    python pipeline/fetch.py --print-urls # print exact query URLs, no network
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import horizons as hz  # noqa: E402

CONFIG = Path(__file__).resolve().parent / "config.json"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--refresh", action="store_true", help="ignore cache and re-download")
    ap.add_argument("--print-urls", action="store_true", help="print query URLs and exit")
    args = ap.parse_args()

    cfg = json.loads(CONFIG.read_text("utf-8"))
    live_requests = 0
    for site in cfg["sites"]:
        for tgt in cfg["targets"]:
            params = hz.build_params(site, tgt["command"], cfg["coverage_start_utc"],
                                     cfg["coverage_end_utc"], cfg["sample_step_seconds"])
            label = f"{site['id']} / {tgt['key']}"
            if args.print_urls:
                print(f"# {label}\n{hz.build_url(params)}\n")
                continue
            body_path, _ = hz.cache_paths(site["id"], tgt["key"], params)
            if live_requests and not (body_path.exists() and not args.refresh):
                time.sleep(hz.REQUEST_PAUSE_S)  # sequential + courteous
            try:
                r = hz.fetch(site["id"], tgt["key"], params, refresh=args.refresh)
            except hz.HorizonsError as e:
                print(f"FAILED {label}:\n{e}", file=sys.stderr)
                return 1
            if not r.from_cache:
                live_requests += 1
            rows = hz.parse_azel(r.payload["result"])
            src = "cache" if r.from_cache else "live"
            print(f"{label}: {len(rows)} rows ({src}) -> {body_path.relative_to(hz.REPO_ROOT)}")
            if not r.meta.get("api_version_matches_documented", True):
                print(f"  WARNING: API version {r.meta['api_signature']} differs from documented "
                      f"{hz.EXPECTED_API_VERSION}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
