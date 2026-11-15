// Release 6, checkpoint 2: site catalog, lazy checked site loading and the comparison shortlist.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DataError, checkCatalog, checkSiteFile, loadDataset, manifestTimes } from "./data";
import { capabilityRows } from "./SiteCatalog";
import { isSouthPolar, lon180, placeLabels } from "./Locator";
import { modeAvailability, profileFor } from "./sites";
import type { Catalog, Manifest, SiteData } from "./types";
import { MAX_SITES, addBlockedReason, resolveSites, withSite, withoutSite } from "./urlState";

const dataDir = new URL("../public/data/", import.meta.url);
const raw = (name: string) => readFileSync(new URL(name, dataDir), "utf-8");
const readJson = <T,>(name: string): T => JSON.parse(raw(name)) as T;
const manifest = () => readJson<Manifest>("manifest.json");
const catalog = () => readJson<Catalog>("catalog.json");
const site = (id: string) => readJson<SiteData>(`${id}.json`);

describe("catalog.json describes exactly the manifest's sites", () => {
  it("same IDs, names, files, order, dataset and common coverage", () => {
    expect(() => checkCatalog(manifest(), catalog())).not.toThrow();
    expect(catalog().sites.map((s) => s.id)).toEqual(manifest().sites.map((s) => s.id));
  });
  it("capabilities match the site files they describe (terrain, coverage, sample count)", () => {
    const times = manifestTimes(manifest());
    for (const c of catalog().sites) {
      const d = site(c.id);
      expect(c.capabilities.terrain_horizon.available).toBe(!!d.terrain_horizon);
      expect(c.capabilities.positions.samples).toBe(d.samples.length);
      expect(c.capabilities.positions.samples).toBe(times.length);
      expect(c.latitude_deg).toBe(d.site.latitude_deg);
      expect(profileFor(d, c).short).toBe(c.short_name); // app profile and catalog agree
    }
  });
  it("rejects a catalog for another dataset, a reordered list or a changed coverage", () => {
    const m = manifest();
    expect(() => checkCatalog(m, { ...catalog(), dataset_id: "other" })).toThrow(DataError);
    const rev = catalog();
    rev.sites.reverse();
    expect(() => checkCatalog(m, rev)).toThrow(/differ from the manifest/);
    const cov = catalog();
    cov.sites[0].capabilities.positions.coverage_end_utc = "2027-03-31T00:00:00Z";
    expect(() => checkCatalog(m, cov)).toThrow(/common coverage/);
    const typ = catalog();
    (typ.sites[0] as { location_type: string }).location_type = "best_site";
    expect(() => checkCatalog(m, typ)).toThrow(/location type/);
  });
});

describe("checkSiteFile refuses a site file that disagrees (never patched)", () => {
  const m = manifest();
  const times = manifestTimes(m);
  const c = catalog().sites[0];
  it("accepts the real file", () => {
    expect(checkSiteFile(m, c, site(c.id), times).id).toBe(c.id);
  });
  it("another site's file, moved coordinates, a missing or unexpected terrain block, shifted times", () => {
    expect(() => checkSiteFile(m, c, site("connecting-ridge-cr1"), times)).toThrow(/contains site connecting-ridge-cr1/);
    const moved = site(c.id);
    moved.site.latitude_deg += 0.001;
    expect(() => checkSiteFile(m, c, moved, times)).toThrow(/coordinates differ/);
    const noTerrain = site(c.id);
    delete noTerrain.terrain_horizon;
    expect(() => checkSiteFile(m, c, noTerrain, times)).toThrow(/terrain horizon missing/);
    expect(() => checkSiteFile(m, c, site(c.id), times.map((t) => t + 600_000))).toThrow(/sample times differ/);
  });
});

describe("lazy loading: only the requested sites are fetched", () => {
  it("manifest + catalog + the preloaded site only; others load on demand with the same checks", async () => {
    const fetched: string[] = [];
    const stub = (async (url: string) => {
      fetched.push(url.replace("BASE/", ""));
      const name = url.replace("BASE/data/", "");
      return { ok: true, status: 200, json: async () => JSON.parse(raw(name)) } as Response;
    }) as unknown as typeof fetch;
    const ds = await loadDataset("BASE/", stub, { preload: ["connecting-ridge-cr1"] });
    expect(fetched).toEqual(["data/manifest.json", "data/catalog.json", "data/connecting-ridge-cr1.json"]);
    expect(ds.sites.map((s) => s.id)).toEqual(["connecting-ridge-cr1"]);
    expect(ds.times.length).toBe(8641);
    const athena = await ds.loadSite!("im2-athena");
    expect(athena.id).toBe("im2-athena");
    expect(fetched[fetched.length - 1]).toBe("data/im2-athena.json");
    await expect(ds.loadSite!("nowhere")).rejects.toThrow(/unknown site/);
  });
  it("a failed site file is an error for that site only", async () => {
    const stub = (async (url: string) => {
      if (url.endsWith("im2-athena.json")) return { ok: false, status: 404, json: async () => ({}) } as Response;
      return { ok: true, status: 200, json: async () => JSON.parse(raw(url.replace("BASE/data/", ""))) } as Response;
    }) as unknown as typeof fetch;
    const ds = await loadDataset("BASE/", stub, { preload: [] });
    await expect(ds.loadSite!("im2-athena")).rejects.toThrow(/HTTP 404/);
    expect((await ds.loadSite!("connecting-ridge-cr1")).id).toBe("connecting-ridge-cr1");
  });
});

describe("explicit capabilities", () => {
  it("six rows in a fixed order, from the catalog only", () => {
    const rows = capabilityRows(catalog().sites[1]);
    expect(rows.map((r) => r.label)).toEqual([
      "Cached position coverage", "Smooth visibility", "Terrain horizon", "3D terrain", "Slope screening", "Provisional limitations",
    ]);
    expect(rows[0].text).toMatch(/2026-12-01 00:00 UTC – 2027-01-30 00:00 UTC \(60 days, 10-minute samples\)/);
    expect(rows[2].text).toMatch(/LDEM_80S_20M \+ LDEM_75S_60M \(20 m pixels/);
    expect(rows[4].text).toMatch(/20 m pixels, slope over ≈40 m, within 500 m/);
    expect(rows[5]).toMatchObject({ caution: true, text: "Provisional: sensitive to terrain model" });
    expect(capabilityRows(catalog().sites[0])[5]).toMatchObject({ ok: true, text: "None recorded" });
  });
  it("a missing capability states its reason; Terrain availability uses the catalog for sites not yet loaded", () => {
    const c = catalog().sites[0];
    const smoothOnly = { ...c, capabilities: { ...c.capabilities, terrain_horizon: { available: false as const, reason: "no measured terrain for this point" } } };
    expect(capabilityRows(smoothOnly)[2]).toMatchObject({ ok: false, text: "no measured terrain for this point" });
    const a = modeAvailability([], [smoothOnly]);
    expect(a.terrain).toBe(false);
    expect(a.missing).toEqual([{ id: c.id, reason: "no measured terrain for this point" }]);
    expect(modeAvailability([], [c]).terrain).toBe(true);
  });
});

describe("comparison shortlist rules", () => {
  const ALL = ["a", "b", "c", "d", "e"];
  it(`no duplicates, at most ${MAX_SITES}, catalog order`, () => {
    expect(withSite(["a"], "c", ALL)).toEqual(["a", "c"]);
    expect(withSite(["c"], "a", ALL)).toEqual(["a", "c"]);
    expect(withSite(["a", "c"], "c", ALL)).toEqual(["a", "c"]);
    expect(addBlockedReason(["a", "c"], "c", ALL)).toMatch(/already/);
    const full = ["a", "b", "c", "d"];
    expect(withSite(full, "e", ALL)).toEqual(full);
    expect(addBlockedReason(full, "e", ALL)).toMatch(/full \(4 sites\)/);
    expect(addBlockedReason(["a"], "zz", ALL)).toMatch(/not in this dataset/);
  });
  it("the last site is never removed; removing the active site activates the first remaining", () => {
    expect(withoutSite(["a"], "a", "a")).toEqual({ sel: ["a"], active: "a" });
    expect(withoutSite(["a", "b", "c"], "a", "a")).toEqual({ sel: ["b", "c"], active: "b" });
    expect(withoutSite(["a", "b", "c"], "c", "a")).toEqual({ sel: ["a", "b"], active: "a" });
  });
  it("existing two-site links keep their selection", () => {
    expect(resolveSites(["im2-athena", "connecting-ridge-cr1"], ["im2-athena", "connecting-ridge-cr1", "x", "y"]).ids).toEqual(["im2-athena", "connecting-ridge-cr1"]);
    expect(resolveSites(["connecting-ridge-cr1"], ["im2-athena", "connecting-ridge-cr1", "x", "y"]).ids).toEqual(["connecting-ridge-cr1"]);
  });
});

describe("generalized location display", () => {
  it("south-polar test and near-side-centred longitude", () => {
    expect(isSouthPolar(-84.79)).toBe(true);
    expect(isSouthPolar(20.19)).toBe(false);
    expect(lon180(222.6)).toBeCloseTo(-137.4, 9);
    expect(lon180(30.77)).toBeCloseTo(30.77, 9);
    expect(lon180(360)).toBe(0);
  });
});

describe("whole-Moon locator labels (four-site release)", () => {
  it("labels Athena and Odysseus without overlap and keeps every label in four-site use", () => {
    const c = readJson<Catalog>("lvn-2026-12-01-120d/catalog.json");
    const W = 320, pad = 14, H = 160;
    const pts = c.sites.map((s, k) => ({
      id: s.id, short: s.short_name, active: k === 2, selected: true,
      px: pad + ((lon180(s.longitude_deg_east) + 180) / 360) * (W - 2 * pad),
      py: pad + ((90 - s.latitude_deg) / 180) * (H - 2 * pad),
    }));
    const placed = placeLabels(pts, W);
    expect([...placed.keys()].sort()).toEqual(c.sites.map((s) => s.id).sort());
    const box = (id: string) => {
      const l = placed.get(id)!; const w = pts.find((p) => p.id === id)!.short.length * 6.4 + 2;
      return { x0: l.anchor === "start" ? l.x : l.x - w, x1: l.anchor === "start" ? l.x + w : l.x, y0: l.y - 9, y1: l.y + 2 };
    };
    const a = box("im2-athena"), o = box("im1-odysseus");
    expect(a.x0 < o.x1 && o.x0 < a.x1 && a.y0 < o.y1 && o.y0 < a.y1).toBe(false);
  });
});
