"""JPL Horizons API helpers: query construction, sequential cached retrieval,
and parsing of observer AZ-EL tables.

Standard library only. Documentation consulted:
  API:    https://ssd-api.jpl.nasa.gov/doc/horizons.html  (API doc v1.3)
  Manual: https://ssd.jpl.nasa.gov/horizons/manual.html
"""
from __future__ import annotations

import hashlib
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

API_URL = "https://ssd.jpl.nasa.gov/api/horizons.api"
# The doc page (checked 2026-11-14) describes v1.3, but the live API signature
# returned "1.2". Output format was inspected manually and matches what this
# parser expects; a mismatch is reported as a warning, not silently ignored.
EXPECTED_API_VERSION = "1.3"
REPO_ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = REPO_ROOT / "data" / "horizons"
USER_AGENT = "lunar-visibility-pipeline/0.1 (python urllib)"
REQUEST_PAUSE_S = 2.0  # courtesy pause between sequential live requests


class HorizonsError(RuntimeError):
    pass


def iso_to_horizons(ts: str) -> str:
    """'2026-12-01T00:00:00Z' -> '2026-12-01 00:00:00' (UT input)."""
    dt = datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ")
    return dt.strftime("%Y-%m-%d %H:%M:%S")


def build_params(site: dict, target_command: str, start_utc: str, end_utc: str,
                 step_seconds: int) -> dict[str, str]:
    """Observer-table query for apparent airless AZ/EL of a target body center
    seen from a geodetic site on the Moon (body 301).

    Values are wrapped in single quotes as in the API documentation examples.
    """
    if step_seconds % 60:
        raise ValueError("step must be a whole number of minutes")
    lon = site["longitude_deg_east"]
    lat = site["latitude_deg"]
    alt = site["horizons_site_altitude_km"]

    def q(v: str) -> str:
        return f"'{v}'"

    return {
        "format": "json",
        "COMMAND": q(target_command),
        "OBJ_DATA": q("YES"),
        "MAKE_EPHEM": q("YES"),
        "EPHEM_TYPE": q("OBSERVER"),
        # coord@301: user-specified topocentric site on the Moon.
        "CENTER": q("coord@301"),
        "COORD_TYPE": q("GEODETIC"),
        # GEODETIC order is E-longitude (deg), latitude (deg), altitude (km).
        # For the Moon, positive longitude is east (manual: Earth/Moon/Sun exception).
        "SITE_COORD": q(f"{lon},{lat},{alt}"),
        "START_TIME": q(iso_to_horizons(start_utc)),
        "STOP_TIME": q(iso_to_horizons(end_utc)),
        "STEP_SIZE": q(f"{step_seconds // 60} min"),
        # Quantity 4 = apparent AZ & EL (topocentric only), azimuth clockwise from north.
        "QUANTITIES": q("4"),
        # AIRLESS: no refraction (refraction is Earth-only anyway).
        "APPARENT": q("AIRLESS"),
        # UT for observer tables; after 1962 UT means UTC.
        "TIME_TYPE": q("UT"),
        "TIME_DIGITS": q("SECONDS"),
        "CAL_FORMAT": q("CAL"),
        "ANG_FORMAT": q("DEG"),
        "EXTRA_PREC": q("YES"),
        "CSV_FORMAT": q("YES"),
        "REF_SYSTEM": q("ICRF"),
        "ELEV_CUT": q("-90"),
        "SKIP_DAYLT": q("NO"),
    }


def build_url(params: dict[str, str]) -> str:
    return API_URL + "?" + urllib.parse.urlencode(params, quote_via=urllib.parse.quote)


def cache_key(params: dict[str, str]) -> str:
    canon = json.dumps(params, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canon.encode()).hexdigest()[:12]


@dataclass
class CachedResponse:
    meta: dict
    body: bytes
    payload: dict
    from_cache: bool


def cache_paths(site_id: str, target_key: str, params: dict[str, str]) -> tuple[Path, Path]:
    stem = f"{site_id}__{target_key}__{cache_key(params)}"
    return CACHE_DIR / f"{stem}.response.json", CACHE_DIR / f"{stem}.meta.json"


def _check_payload(payload: dict) -> None:
    if "error" in payload:
        raise HorizonsError(f"Horizons reported an error: {payload['error']}")
    if "result" not in payload:
        raise HorizonsError("response JSON has no 'result' field")
    if "$$SOE" not in payload["result"] or "$$EOE" not in payload["result"]:
        raise HorizonsError("result text has no $$SOE/$$EOE ephemeris table")


def fetch(site_id: str, target_key: str, params: dict[str, str], *,
          refresh: bool = False, offline: bool = False) -> CachedResponse:
    """Return the cached response for these exact params, or perform ONE live
    request and cache the raw body byte-for-byte plus request/response metadata.
    Failed responses are never cached as data and never replaced by synthetic data.
    """
    body_path, meta_path = cache_paths(site_id, target_key, params)
    if body_path.exists() and meta_path.exists() and not refresh:
        body = body_path.read_bytes()
        payload = json.loads(body)
        _check_payload(payload)
        return CachedResponse(json.loads(meta_path.read_text("utf-8")), body, payload, True)
    if offline:
        raise HorizonsError(f"not cached and offline mode is set: {body_path.name}\n"
                            f"Reproduce with: curl -sS \"{build_url(params)}\"")

    url = build_url(params)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    retrieved_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            status = resp.status
            headers = dict(resp.headers.items())
            body = resp.read()
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:2000]
        raise HorizonsError(f"HTTP {e.code} from Horizons: {detail}\n"
                            f"Reproduce with: curl -sS \"{url}\"") from e
    except urllib.error.URLError as e:
        raise HorizonsError(f"network error contacting Horizons: {e.reason}\n"
                            f"Reproduce with: curl -sS \"{url}\"") from e

    payload = json.loads(body)
    try:
        _check_payload(payload)
    except HorizonsError as e:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        fail = body_path.with_suffix(".FAILED.json")
        fail.write_bytes(body)
        raise HorizonsError(f"{e}\nRaw failed response saved to {fail}\n"
                            f"Reproduce with: curl -sS \"{url}\"") from e

    version = payload.get("signature", {}).get("version")
    meta = {
        "site_id": site_id,
        "target_key": target_key,
        "request_url": url,
        "request_params": params,
        "retrieved_at_utc": retrieved_at,
        "http_status": status,
        "response_headers": headers,
        "api_signature": payload.get("signature"),
        "api_version_matches_documented": version == EXPECTED_API_VERSION,
        "response_sha256": hashlib.sha256(body).hexdigest(),
        "response_file": body_path.name,
    }
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    body_path.write_bytes(body)
    meta_path.write_text(json.dumps(meta, indent=2) + "\n", "utf-8")
    return CachedResponse(meta, body, payload, False)


# ---------------------------------------------------------------- parsing

MONTHS = {m: i for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], 1)}


@dataclass
class AzElRow:
    time_utc: str
    azimuth_deg: float | None
    elevation_deg: float | None
    raw_line: str


def parse_cal_time(s: str) -> str:
    """'2026-Dec-01 00:10:00' (or with .fff) -> '2026-12-01T00:10:00Z'."""
    s = s.strip()
    date, clock = s.split()
    y, mon, d = date.split("-")
    if "." in clock:
        clock, frac = clock.split(".")
        if frac.strip("0"):
            raise ValueError(f"unexpected sub-second time: {s}")
    hh, mm, ss = clock.split(":")
    dt = datetime(int(y), MONTHS[mon], int(d), int(hh), int(mm), int(ss))
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _num(s: str) -> float | None:
    s = s.strip()
    if s in ("", "n.a.", "n.a"):
        return None
    return float(s)


def parse_azel(result_text: str) -> list[AzElRow]:
    """Parse a CSV observer table containing quantity 4 (Azi_(a-app), Elev_(a-app))."""
    lines = result_text.splitlines()
    try:
        soe = lines.index("$$SOE")
        eoe = lines.index("$$EOE")
    except ValueError as e:
        raise HorizonsError("missing $$SOE/$$EOE markers") from e

    # Column header: last non-separator line before $$SOE.
    header = None
    for line in reversed(lines[:soe]):
        if line.strip() and not set(line.strip()) <= {"*"}:
            header = [c.strip() for c in line.split(",")]
            break
    if header is None:
        raise HorizonsError("no column header found")
    if not header[0].startswith("Date__(UT)"):
        raise HorizonsError(f"time column is not UT: {header[0]!r}")
    # The live API labels the columns "Azimuth_(a-app)"/"Elevation_(a-app)"; the
    # manual abbreviates them "Azi (a-app) Elev". "(a-app)" = airless apparent;
    # "(r-app)" (refracted) must never be accepted here.
    def col(*names: str) -> int:
        for n in names:
            if n in header:
                return header.index(n)
        raise HorizonsError(f"airless apparent column {names} not found in header {header}")

    i_az = col("Azimuth_(a-app)", "Azi_(a-app)")
    i_el = col("Elevation_(a-app)", "Elev_(a-app)")

    rows = []
    for line in lines[soe + 1:eoe]:
        if not line.strip():
            continue
        cols = line.split(",")
        rows.append(AzElRow(parse_cal_time(cols[0]), _num(cols[i_az]), _num(cols[i_el]), line))
    return rows


HEADER_KEYS = (
    "Target body name", "Center body name", "Center-site name", "Center geodetic",
    "Center cylindric", "Center pole/equ", "Center radii", "Target radii",
    "Target pole/equ", "Start time", "Stop  time", "Step-size", "Output units",
    "Atmos refraction", "RA format", "Time format", "EOP file", "EOP coverage",
    "Reference frame", "Table cut-offs 1",
)


def header_fields(result_text: str) -> dict[str, str]:
    """Extract 'Key : value' header lines that document the run's conventions."""
    out: dict[str, str] = {}
    head = result_text.split("$$SOE")[0]
    for line in head.splitlines():
        for key in HEADER_KEYS:
            if line.startswith(key) and ":" in line:
                out.setdefault(key.replace("  ", " "), line.split(":", 1)[1].strip())
    return out
