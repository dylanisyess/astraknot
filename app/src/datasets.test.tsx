import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { Workspace } from "./App";
import { assetMismatch } from "./explore/terrainAsset";
import type { TerrainAssetMeta } from "./explore/terrainAsset";
import { primeSlopeAsset, slopeAssetProblem, type SlopeAsset } from "./explore/slope";
import { describe, expect, it } from "vitest";
import { chooseDataset, datasetSearch, loadIndexedDataset } from "./datasets";
import { checkCatalog, checkSiteFile, manifestTimes } from "./data";
import { DatasetBar } from "./DatasetBar";
import { DAY_MS, computeMetrics, delayOptions, parseIntervals } from "./mission";
import { selectedTimeStatus } from "./status";
import type { Catalog, DatasetIndex, HorizonMode, Manifest, SiteData } from "./types";

const read = <T,>(file: string): T => JSON.parse(readFileSync(new URL(`../public/${file}`, import.meta.url), "utf8"));
const index = read<DatasetIndex>("data/datasets.json");
const legacy = index.legacy_dataset_id;
const expanded = index.default_dataset_id;
const root = `data/${expanded}/`;
const manifest = read<Manifest>(`${root}manifest.json`);
const catalog = read<Catalog>(`${root}catalog.json`);
const times = manifestTimes(manifest);

describe("dataset selection and legacy scenarios", () => {
  it("uses expanded data for a fresh visit and original data for old scenario links", () => {
    expect(chooseDataset(index, "").choice.id).toBe(expanded);
    expect(chooseDataset(index, "?foo=1").choice.id).toBe(expanded);
    for (const q of ["?arrival=2026-12-05T00:00Z", "?sites=im2-athena", "?view=analysis&horizon=terrain"]) {
      expect(chooseDataset(index, q)).toMatchObject({ choice: { id: legacy }, legacyLink: true });
      expect(chooseDataset(index, datasetSearch(q, expanded)).choice.id).toBe(expanded);
    }
  });
  it("rejects unknown/empty IDs and unsafe index folders; never substitutes another release", () => {
    for (const q of ["?ds=missing", "?ds=", "?ds=../data"]) expect(() => chooseDataset(index, q)).toThrow(/Unknown dataset/);
    const bad = structuredClone(index);
    bad.datasets[0].dir = "data/../../";
    expect(() => chooseDataset(bad, "")).toThrow(/Invalid dataset entry/);
  });
  it("switch links preserve all scenario parameters and unrelated parameters", () => {
    const old = "?arrival=2026-12-05T00:00Z&days=14&delay=7&sites=im2-athena&cam=horizon&foo=bar";
    const q = new URLSearchParams(datasetSearch(old, expanded));
    for (const [k, v] of new URLSearchParams(old)) expect(q.get(k)).toBe(v);
    expect(q.get("ds")).toBe(expanded);
  });
  it("shows a visible offer while retaining legacy data", () => {
    const oldManifest = read<Manifest>("data/manifest.json");
    const html = renderToStaticMarkup(<DatasetBar ds={{ manifest: oldManifest, catalog, sites: [], times: [], selection: { index, legacyLink: true } }} search="?delay=7" />);
    expect(html).toContain("Original dataset retained");
    expect(html).toContain("Switch to 120 days / 4 sites");
    expect(html).toContain(`delay=7&amp;ds=${expanded}`);
  });
  it("current dataset: coverage stays visible; the previous dataset is under Details", () => {
    const html = renderToStaticMarkup(<DatasetBar ds={{ manifest, catalog, sites: [], times: [], selection: { index, legacyLink: false } }} search="?delay=7" />);
    const cov = html.slice(0, html.indexOf("<details"));
    expect(cov).toContain("120 days · 4 sites");
    expect(cov).toContain("2026-12-01 to 2027-03-31 UTC · 10-minute samples");
    expect(cov).not.toContain("Open accepted 60-day dataset");
    const details = html.slice(html.indexOf("<details"));
    expect(details).toMatch(/<summary[^>]*>Details<\/summary>/);
    expect(details.indexOf("Previous dataset")).toBeGreaterThan(-1);
    expect(details.indexOf("Open accepted 60-day dataset")).toBeGreaterThan(details.indexOf("Previous dataset"));
    expect(details).toContain(`delay=7&amp;ds=${legacy}`);
  });
  it("loads only the selected version and selected site, including a nested base path", async () => {
    const paths: string[] = [];
    const fetcher = async (input: RequestInfo | URL) => {
      const p = String(input); paths.push(p);
      return new Response(JSON.stringify(read(p.replace("/navigator/", ""))));
    };
    const ds = await loadIndexedDataset("/navigator/", `?ds=${expanded}&sites=apollo17-lm&horizon=smooth`, fetcher);
    expect(ds.manifest.dataset_id).toBe(expanded);
    expect(ds.sites.map((s) => s.id)).toEqual(["apollo17-lm"]);
    expect(paths).toEqual(["/navigator/data/datasets.json", `/navigator/${root}manifest.json`, `/navigator/${root}catalog.json`, `/navigator/${root}apollo17-lm.json`]);
    await expect(loadIndexedDataset("/navigator/", "?ds=missing", fetcher)).rejects.toThrow(/Unknown dataset/);
  });
  it("refuses the wrong version's manifest before loading any site", async () => {
    const fetcher = async (input: RequestInfo | URL) => new Response(JSON.stringify(String(input).endsWith("datasets.json") ? index : { ...manifest, dataset_id: legacy }));
    await expect(loadIndexedDataset("/", `?ds=${expanded}`, fetcher)).rejects.toThrow(/Requested dataset/);
  });
});

describe("real expanded release and protected existing windows", () => {
  it("has four checked sites, 120 days at ten minutes, inclusive final positions", () => {
    checkCatalog(manifest, catalog);
    expect(manifest.sites).toHaveLength(4);
    expect(times).toHaveLength(17281);
    expect(times.at(-1)! - times[0]).toBe(120 * DAY_MS);
    expect(new Date(times.at(-1)!).toISOString()).toBe("2027-03-31T00:00:00.000Z");
    for (const c of catalog.sites) {
      const data = read<SiteData>(`${root}${c.file}`);
      expect(checkSiteFile(manifest, c, data, times).id).toBe(c.id);
      const modes: HorizonMode[] = data.terrain_horizon ? ["smooth", "terrain"] : ["smooth"];
      for (const mode of modes) {
        const status = selectedTimeStatus({ samples: data.samples, times, mode, horizon: mode === "terrain" ? data.terrain_horizon!.horizon : data.horizon, intervals: parseIntervals(data, mode === "terrain" ? data.terrain_horizon!.visibility_intervals : data.visibility_intervals) }, times.at(-1)!);
        expect(status.sun.visible).toBe(null);
        expect(status.earth.visible).toBe(null);
      }
    }
  });
  it("new sites have their own validated terrain, render and slope products", () => {
    for (const id of ["apollo17-lm", "im1-odysseus"]) {
      const c = catalog.sites.find((s) => s.id === id)!;
      expect(c.capabilities.positions.available).toBe(true);
      expect(c.capabilities.smooth_visibility.available).toBe(true);
      expect(c.capabilities.terrain_horizon.available).toBe(true);
      expect(c.capabilities.terrain_3d.available).toBe(true);
      expect(c.capabilities.slope_screening.available).toBe(true);
      const d = read<SiteData>(`${root}${c.file}`);
      expect(d.terrain_horizon).toBeDefined();
      const mesh = read<TerrainAssetMeta>(`render/${id}.terrain.json`);
      const slope = read<SlopeAsset>(`screening/${id}.slope.json`);
      expect(assetMismatch(mesh, d)).toBeNull();
      expect(slopeAssetProblem(slope, d)).toBeNull();
      expect(mesh.source_dem.product).toBe(slope.source_dem.product);
      expect(d.terrain_horizon!.observer!.observer_radius_m).toBe(1737400 + d.site.horizons_site_altitude_km * 1000);
      expect(slope.method.baseline_m).toBeGreaterThan(id === "apollo17-lm" ? 110 : 39);
      expect(mesh.site.id).toBe(id);
      expect(slope.site.id).toBe(id);
    }
  });
  it("renders every new site and all four together in Terrain mode without mixing site assets or source text", () => {
    for (const c of catalog.sites) primeSlopeAsset("/", read<SlopeAsset>(`screening/${c.id}.slope.json`));
    const files = catalog.sites.map((c) => read<SiteData>(`${root}${c.file}`));
    const ds = { manifest, catalog, times, sites: catalog.sites.map((c, k) => checkSiteFile(manifest, c, files[k], times)) };
    for (const id of ["apollo17-lm", "im1-odysseus"]) {
      const html = renderToStaticMarkup(<Workspace ds={ds} search={`?view=analysis&sites=${catalog.sites.map((s) => s.id).join(",")}&site=${id}&horizon=terrain`} />);
      expect(html).toContain(`data-site="${id}"`);
      expect(html).toContain("Laser-shot counts at the skyline points have not been assessed");
      expect(html).not.toContain("no terrain horizon");
      expect(html.includes("120 m")).toBe(true);
      expect(html.includes("Different measurement scales")).toBe(true);
      // the unresolved NAIF source height is disclosed, not silently replaced
      expect(html).toContain("The NAIF kernel lists an altitude of 2.583 km");
    }
  });
  it("keeps every old sample and skyline; old-window metrics match for both models", () => {
    for (const id of ["im2-athena", "connecting-ridge-cr1"]) {
      const a = read<SiteData>(`data/${id}.json`);
      const b = read<SiteData>(`${root}${id}.json`);
      expect(b.samples.slice(0, a.samples.length)).toEqual(a.samples);
      expect(b.terrain_horizon!.horizon).toEqual(a.terrain_horizon!.horizon);
      expect(b.terrain_horizon!.observer).toEqual(a.terrain_horizon!.observer);
      for (const terrain of [false, true]) {
        const ia = parseIntervals(a, terrain ? a.terrain_horizon!.visibility_intervals : a.visibility_intervals);
        const ib = parseIntervals(b, terrain ? b.terrain_horizon!.visibility_intervals : b.visibility_intervals);
        for (const start of [Date.parse("2026-12-05T00:00Z"), Date.parse("2027-01-15T00:00Z")]) {
          for (const delay of [0, 1, 3, 7]) {
            const w = { start: start + delay * DAY_MS, end: Math.min(start + (delay + 7) * DAY_MS, Date.parse("2027-01-30T00:00Z")) };
            const metricA = computeMetrics(ia, w), metricB = computeMetrics(ib, w);
            // Full-run extents can now extend past the OLD coverage end; window totals and censoring must match.
            expect(metricB.sunPct).toEqual(metricA.sunPct);
            expect(metricB.earthPct).toEqual(metricA.earthPct);
            expect(metricB.bothPct).toEqual(metricA.bothPct);
            expect(metricB.longestDark.ok).toBe(metricA.longestDark.ok);
            if (metricB.longestDark.ok && metricA.longestDark.ok) {
              expect(metricB.longestDark.value?.durationMs).toBe(metricA.longestDark.value?.durationMs);
              expect(metricB.longestDark.value?.start).toBe(metricA.longestDark.value?.start);
              expect(metricB.longestDark.value?.end).toBe(metricA.longestDark.value?.end);
              expect(metricB.longestDark.value?.touchesStart).toBe(metricA.longestDark.value?.touchesStart);
              expect(metricB.longestDark.value?.touchesEnd).toBe(metricA.longestDark.value?.touchesEnd);
            }
          }
        }
      }
    }
  });
  it("allows missions ending exactly at the expanded endpoint and blocks slips past it", () => {
    const cov = { start: times[0], end: times.at(-1)! };
    const options = delayOptions(cov.end - 14 * DAY_MS, 14 * DAY_MS, cov);
    expect(options.map((o) => o.enabled)).toEqual([true, false, false, false]);
    expect(delayOptions(cov.end - 21 * DAY_MS, 14 * DAY_MS, cov).every((o) => o.enabled)).toBe(true);
  });
});
