"""Retrieve Sun and Earth AZ/EL from JPL Horizons for every configured site.

The coverage interval is split into chunks (config: horizons_chunk_days).
Requests are made one at a time (never concurrently), each response is cached
byte-for-byte under data/horizons/ keyed by its exact query parameters, and a
re-run only downloads chunks that are missing. Transient service errors are
retried with backoff; persistent failures stop the run and are reported.

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
import sites
import horizons as hz  # noqa: E402

CONFIG = Path(__file__).resolve().parent / "config.json"


def main() -> int:
    ap = sites.parser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--refresh", action="store_true", help="ignore cache and re-download")
    ap.add_argument("--print-urls", action="store_true", help="print query URLs and exit")
    args = ap.parse_args()

    cfg = json.loads(CONFIG.read_text("utf-8"))
    live = 0
    for site in sites.cli_sites(ap, args, cfg, batch=True):
        for tgt in cfg["targets"]:
            for (s, e), params in hz.site_queries(cfg, site, tgt):
                label = f"{site['id']} / {tgt['key']} / {s} .. {e}"
                if args.print_urls:
                    print(f"# {label}\n{hz.build_url(params)}\n")
                    continue
                body_path, meta_path = hz.cache_paths(site["id"], tgt["key"], params)
                cached = body_path.exists() and meta_path.exists() and not args.refresh
                if live and not cached:
                    time.sleep(hz.REQUEST_PAUSE_S)  # sequential + courteous
                try:
                    r = hz.fetch(site["id"], tgt["key"], params, refresh=args.refresh)
                except hz.HorizonsError as err:
                    print(f"FAILED {label}:\n{err}", file=sys.stderr)
                    print("No data was substituted. Re-run to resume; cached chunks are kept.", file=sys.stderr)
                    return 1
                live += not r.from_cache
                rows = hz.parse_azel(r.payload["result"])
                print(f"{label}: {len(rows)} rows ({'cache' if r.from_cache else 'live'})")
                if not r.meta.get("api_version_matches_documented", True):
                    print(f"  note: API signature {r.meta['api_signature'].get('version')} vs documented "
                          f"{hz.EXPECTED_API_VERSION}", file=sys.stderr)
    if not args.print_urls:
        print(f"{live} live request(s) made")
    return 0


if __name__ == "__main__":
    raise SystemExit(sites.run(main))
