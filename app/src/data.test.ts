import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DataError, checkSite, checkSites, elevationDomain, fmtDeg, fmtUtc, loadDataset, nearestIndex } from "./data";
import type { Manifest, SiteData } from "./types";

const dataDir = new URL("../public/data/", import.meta.url);
const readJson = <T,>(name: string): T => JSON.parse(readFileSync(new URL(name, dataDir), "utf-8")) as T;

describe("real exported dataset", () => {
  const manifest = readJson<Manifest>("manifest.json");
  const site = readJson<SiteData>(manifest.sites[0].file);

  it("is real, not synthetic", () => {
    expect(manifest.is_synthetic).toBe(false);
    expect(site.site.is_synthetic).toBe(false);
  });

  it("passes the loader's structural checks (order, 600 s spacing, coverage)", () => {
    const times = checkSite(manifest, site);
    const span = Date.parse(manifest.coverage_end_utc) - Date.parse(manifest.coverage_start_utc);
    expect(times).toHaveLength(span / (manifest.sample_step_seconds * 1000) + 1); // incl. final endpoint
    expect(times[times.length - 1] - times[0]).toBe(span);
    expect(span).toBe(60 * 86_400_000);
  });

  it("loads every manifest site through loadDataset with a fetch stub", async () => {
    const stub = (async (u: string) =>
      new Response(readFileSync(new URL(u.replace(/^base\/data\//, ""), dataDir)))) as unknown as typeof fetch;
    const ds = await loadDataset("base/", stub);
    expect(ds.sites.map((s) => s.id)).toEqual(manifest.sites.map((s) => s.id));
    expect(ds.sites.map((s) => s.id)).toEqual(["im2-athena", "connecting-ridge-cr1"]);
    for (const s of ds.sites) {
      expect(s.data.site.id).toBe(s.id);
      expect(s.data.samples[0].time_utc).toBe(manifest.coverage_start_utc);
      expect(s.terrainProblem).toBeNull();
    }
    expect(ds.times).toHaveLength(8641);
  });
});

describe("multi-site identity checks (real files, deliberately mismatched)", () => {
  const manifest = readJson<Manifest>("manifest.json");
  const files = manifest.sites.map((e) => readJson<SiteData>(e.file));
  const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

  it("accepts the exported pair and returns the shared times", () => {
    expect(checkSites(manifest, files)).toHaveLength(8641);
  });
  it("rejects a file whose site ID differs from its manifest entry (swapped files)", () => {
    expect(() => checkSites(manifest, [files[1], files[0]])).toThrow(/contains site connecting-ridge-cr1, not im2-athena/);
  });
  it("rejects a manifest entry pointing at another site's file", () => {
    const m = clone(manifest);
    m.sites[1].file = "im2-athena.json";
    expect(() => checkSites(m, files)).toThrow(/expected connecting-ridge-cr1\.json/);
  });
  it("rejects duplicate IDs and a name that differs from the manifest", () => {
    const m = clone(manifest);
    m.sites[1] = { ...m.sites[0] };
    expect(() => checkSites(m, [files[0], files[0]])).toThrow(/more than once/);
    const n = clone(manifest);
    n.sites[1].name = "Something else";
    expect(() => checkSites(n, files)).toThrow(/name differs/);
  });
  it("rejects sites whose sample times differ", () => {
    const f = clone(files[1]);
    f.samples = f.samples.map((x) => ({ ...x, time_utc: new Date(Date.parse(x.time_utc) + 600_000).toISOString().replace(".000Z", "Z") }));
    const m = clone(manifest);
    m.coverage_start_utc = f.samples[0].time_utc;
    m.coverage_end_utc = f.samples[f.samples.length - 1].time_utc;
    expect(() => checkSites(m, [files[0], f])).toThrow(DataError);
  });
});

describe("loader rejects malformed data (synthetic fixtures)", () => {
  const manifest: Manifest = {
    schema_version: "1.0", dataset_id: "test", generated_at_utc: "2030-01-01T00:00:00Z",
    coverage_start_utc: "2030-01-01T00:00:00Z", coverage_end_utc: "2030-01-01T00:20:00Z",
    sample_step_seconds: 600, sites: [], is_synthetic: true,
  };
  const mk = (ts: string[]) => ({
    schema_version: "1.0",
    samples: ts.map((t) => ({ time_utc: t, sun_azimuth_deg: 1, sun_elevation_deg: 1, earth_azimuth_deg: 1, earth_elevation_deg: 1 })),
  }) as unknown as SiteData;

  it("accepts a well-formed series", () => {
    expect(checkSite(manifest, mk(["2030-01-01T00:00:00Z", "2030-01-01T00:10:00Z", "2030-01-01T00:20:00Z"]))).toHaveLength(3);
  });
  it("rejects unordered timestamps", () => {
    expect(() => checkSite(manifest, mk(["2030-01-01T00:00:00Z", "2030-01-01T00:20:00Z", "2030-01-01T00:10:00Z"]))).toThrow(DataError);
  });
  it("rejects a gap", () => {
    expect(() => checkSite(manifest, mk(["2030-01-01T00:00:00Z", "2030-01-01T00:20:00Z"]))).toThrow(/spacing/);
  });
  it("rejects non-UTC timestamps", () => {
    expect(() => checkSite(manifest, mk(["2030-01-01T00:00:00+01:00", "2030-01-01T00:10:00Z"]))).toThrow(DataError);
  });
});

describe("helpers", () => {
  it("nearestIndex picks the closest sample and clamps", () => {
    const t = [0, 600_000, 1_200_000];
    expect(nearestIndex(t, -5)).toBe(0);
    expect(nearestIndex(t, 299_999)).toBe(0);
    expect(nearestIndex(t, 300_001)).toBe(1);
    expect(nearestIndex(t, 9e9)).toBe(2);
  });
  it("fmtDeg never shows null as zero", () => {
    expect(fmtDeg(null)).toBe("unavailable");
    expect(fmtDeg(-0.240538657)).toBe("−0.241°");
    expect(fmtDeg(-0.0001)).toBe("0.000°");
  });
  it("fmtUtc", () => {
    expect(fmtUtc(Date.parse("2026-12-01T12:00:00Z"))).toBe("2026-12-01 12:00 UTC");
  });
  it("elevationDomain always includes 0", () => {
    expect(elevationDomain([2, 3])).toEqual([-1, 4]);
    expect(elevationDomain([-1.24, 3.2])).toEqual([-2, 4]);
  });
});
