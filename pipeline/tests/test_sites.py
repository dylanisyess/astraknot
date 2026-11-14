"""Synthetic multi-site isolation checks; no second real site or network calls."""
import contextlib
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import sites
import horizons as hz
import site_elevation as se
import terrain_sensitivity as sensitivity
import export as exporter

A = dict(id="fixture-a", name="Synthetic A", latitude_deg=-84, longitude_deg_east=30,
         horizons_site_altitude_km=5, observer_height_above_surface_m=1)
# Same coordinates on purpose: checking coordinates alone must not accept B as A.
B = {**A, "id": "fixture-b", "name": "Synthetic B"}
CFG = dict(sites=[A, B], dataset_id="synthetic", sample_step_seconds=600,
           coverage_start_utc="2030-01-01T00:00:00Z", coverage_end_utc="2030-01-01T00:10:00Z")


def data(site):
    return dict(site=site, samples=[{"time_utc": CFG[k]} for k in ("coverage_start_utc", "coverage_end_utc")])


def manifest():
    return {**CFG, "sites": [dict(id=s["id"], name=s["name"], file=s["id"] + ".json") for s in (A, B)]}


class Selection(unittest.TestCase):
    def test_explicit_selection_ignores_config_order(self):
        self.assertEqual(sites.select_sites(CFG, B["id"]), [B])
        self.assertEqual(sites.select_sites({**CFG, "sites": [B, A]}, A["id"]), [A])

    def test_sole_default_batch_default_and_ambiguous_single(self):
        self.assertEqual(sites.select_sites({"sites": [A]}), [A])
        self.assertEqual(sites.select_sites(CFG, batch=True), [A, B])
        with self.assertRaisesRegex(ValueError, "Choose --site"):
            sites.select_sites(CFG)

    def test_bad_unknown_and_duplicate_ids(self):
        for value in ("../x", "UPPER", "a/b", "a\\b", "", "a.json", "a--b", "a_1"):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "Invalid site ID"):
                sites.select_sites(CFG, value)
        with self.assertRaisesRegex(ValueError, "Unknown site ID"):
            sites.select_sites(CFG, "missing")
        for values in ([], [A, A]):
            with self.assertRaisesRegex(ValueError, "unique site IDs"):
                sites.select_sites({"sites": values})

    def test_all_entrypoints_reject_unknown_before_work(self):
        pipeline = Path(__file__).resolve().parent.parent
        for script in ("fetch", "fetch_terrain", "export", "validate", "terrain_check", "site_elevation",
                       "compare_altitude", "crosscheck_metrics", "terrain_horizon", "horizon_crosscheck"):
            with self.subTest(script=script):
                r = subprocess.run([sys.executable, str(pipeline / f"{script}.py"), "--site", "missing"],
                                   capture_output=True, text=True)
                self.assertEqual(r.returncode, 2, r.stderr)
                self.assertIn("Unknown site ID", r.stderr)
                self.assertNotIn("Traceback", r.stderr)


class Files(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.patcher = patch.object(sites, "REPO_ROOT", self.root)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)
        self.out = self.root / "app/public/data"
        self.out.mkdir(parents=True)

    def write(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value), encoding="utf-8")

    def reports(self):
        path = sites.report_path(A["id"], "terrain_horizon")
        cross = sites.report_path(A["id"], "horizon_crosscheck")
        self.write(path, {"site": A, "rays": []})
        self.write(cross, {"site": A, "terrain_report_sha256": sites.sha256(path)})
        return path, cross

    def test_report_and_raw_cache_paths_are_disjoint(self):
        for kind in ("terrain_horizon", "horizon_crosscheck", "lola_coverage_report",
                     "site_elevation_report", "altitude_comparison"):
            self.assertNotEqual(sites.report_path(A["id"], kind), sites.report_path(B["id"], kind))
        self.assertNotEqual(hz.cache_paths(A["id"], "sun", {}), hz.cache_paths(B["id"], "sun", {}))
        self.assertNotEqual(se.rdr_cache_stem(A["id"], "box", {}), se.rdr_cache_stem(B["id"], "box", {}))
        self.assertNotEqual(se.rdr_cache_stem(A["id"], "box", {}), se.rdr_cache_stem(A["id"], "box", {"lat": 1}))

    def test_reports_require_identity_in_both_files(self):
        for which in (0, 1):
            with self.subTest(which=which):
                paths = self.reports()
                d = json.loads(paths[which].read_text())
                d["site"] = B
                self.write(paths[which], d)
                with self.assertRaisesRegex(ValueError, "identity mismatch"):
                    sites.load_terrain_reports(A)

    def test_stale_crosscheck_and_changed_altitude_rejected(self):
        path, cross = self.reports()
        self.assertEqual(sites.load_terrain_reports(A)[0]["site"], A)
        with self.assertRaisesRegex(ValueError, "altitude"):
            sites.load_terrain_reports({**A, "horizons_site_altitude_km": 6})
        path.write_text(path.read_text() + "\n")
        with self.assertRaisesRegex(ValueError, "fingerprint mismatch"):
            sites.load_terrain_reports(A)

    def test_missing_report_does_not_fall_back_to_another_site(self):
        self.reports()
        block, sources, reason = exporter.terrain_block(CFG, B, [])
        self.assertIsNone(block)
        self.assertIn(B["id"], reason)

    def test_sample_reader_and_sensitivity_reject_wrong_site(self):
        self.write(self.out / (A["id"] + ".json"), data(B))
        with self.assertRaisesRegex(ValueError, "identity mismatch"):
            sites.load_site_data(CFG, A)
        with self.assertRaisesRegex(ValueError, "identity mismatch"):
            sensitivity.load_samples(CFG, A)

    def test_manifest_alias_duplicate_and_wrong_coverage_rejected(self):
        self.write(self.out / (A["id"] + ".json"), data(A))
        self.assertEqual(sites.load_site_data(CFG, A, manifest=manifest())["site"], A)
        for change in ("alias", "duplicate", "coverage"):
            m = manifest()
            if change == "alias":
                m["sites"][0]["file"] = B["id"] + ".json"
            elif change == "duplicate":
                m["sites"].append(m["sites"][0])
            else:
                m["coverage_end_utc"] = "2031-01-01T00:00:00Z"
            with self.subTest(change=change), self.assertRaises(ValueError):
                sites.load_site_data(CFG, A, manifest=m)

    def test_scoped_export_preserves_other_site_bytes_and_manifest(self):
        config_path = self.root / "config.json"
        self.write(config_path, CFG)
        for s in (A, B):
            self.write(self.out / (s["id"] + ".json"), data(s))
        self.write(self.out / "manifest.json", manifest())
        other = self.out / (A["id"] + ".json")
        before = other.read_bytes()
        with patch.object(exporter, "CONFIG", config_path), patch.object(exporter, "OUT_DIR", self.out), \
                patch.object(exporter, "export_site", return_value=data(B)) as build, \
                patch.object(exporter, "dump_site", side_effect=json.dumps), \
                patch.object(sys, "argv", ["export.py", "--site", B["id"]]), contextlib.redirect_stdout(io.StringIO()):
            # Only the output summary needs interval counts in this synthetic export.
            build.return_value["visibility_intervals"] = []
            self.assertEqual(exporter.main(), 0)
            self.assertEqual(build.call_args.args[1], B)
        self.assertEqual(other.read_bytes(), before)
        self.assertEqual([e["id"] for e in json.loads((self.out / "manifest.json").read_text())["sites"]],
                         [A["id"], B["id"]])

    def test_scoped_export_refuses_incompatible_retained_data_before_writes(self):
        config_path = self.root / "config.json"
        self.write(config_path, CFG)
        self.write(self.out / (B["id"] + ".json"), data(A))
        self.write(self.out / "manifest.json", manifest())
        before = {p.name: p.read_bytes() for p in self.out.iterdir()}
        with patch.object(exporter, "CONFIG", config_path), patch.object(exporter, "OUT_DIR", self.out), \
                patch.object(exporter, "export_site", return_value=data(A)), \
                patch.object(sys, "argv", ["export.py", "--site", A["id"]]):
            with self.assertRaisesRegex(ValueError, "identity mismatch"):
                exporter.main()
        self.assertEqual({p.name: p.read_bytes() for p in self.out.iterdir()}, before)

    def test_raw_horizons_copied_metadata_rejected_offline(self):
        params = hz.build_params(A, "10", CFG["coverage_start_utc"], CFG["coverage_end_utc"], 600)
        with patch.object(hz, "CACHE_DIR", self.root), patch.object(hz, "_get_with_retry") as network:
            body_path, meta_path = hz.cache_paths(A["id"], "sun", params)
            body_path.write_bytes(b'{"result":"$$SOE\\n$$EOE"}')
            self.write(meta_path, dict(site_id=B["id"], target_key="sun", request_params=params,
                                       response_sha256=sites.sha256(body_path)))
            with self.assertRaisesRegex(hz.HorizonsError, "Cache identity"):
                hz.fetch(A["id"], "sun", params, offline=True)
            network.assert_not_called()

    def test_rdr_copy_rejected_and_correct_cache_read_without_network(self):
        q = dict(query="lolardr", results="v", output="JSON", minlat="-84.000000", maxlat="-83.000000",
                 westernlon="30.000000", easternlon="31.000000")
        name = se.rdr_cache_stem(A["id"], "box", q)
        self.write(self.root / (name + ".query.json"), {})
        self.write(self.root / (name + ".meta.json"), dict(site_id=B["id"], params=q))
        (self.root / (name + "_pts.lbl")).write_text("synthetic")
        (self.root / (name + "_pts.csv")).write_text("Coordinated_Universal_Time,Pt_Longitude,Pt_Latitude,Pt_Radius,Flg\n")
        with patch.object(se, "RDR_DIR", self.root), patch.object(se.lola, "_get") as network:
            with self.assertRaisesRegex(ValueError, "RDR cache query mismatch"):
                se.gds_points("box", -84, -83, 30, 31, site_id=A["id"])
            self.write(self.root / (name + ".meta.json"), dict(site_id=A["id"], params=q))
            self.assertEqual(se.gds_points("box", -84, -83, 30, 31, site_id=A["id"])[0], [])
            network.assert_not_called()
