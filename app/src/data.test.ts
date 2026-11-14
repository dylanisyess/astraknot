import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DataError, checkSite, elevationDomain, fmtDeg, fmtUtc, loadDataset, nearestIndex } from "./data";
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
    expect(times).toHaveLength(145);
    expect(times[times.length - 1] - times[0]).toBe(24 * 3600 * 1000);
  });

  it("loads through loadDataset with a fetch stub", async () => {
    const stub = (async (u: string) =>
      new Response(readFileSync(new URL(u.replace(/^base\/data\//, ""), dataDir)))) as unknown as typeof fetch;
    const ds = await loadDataset("base/", stub);
    expect(ds.site.samples[0].time_utc).toBe(manifest.coverage_start_utc);
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
