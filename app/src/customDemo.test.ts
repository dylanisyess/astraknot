// Custom-coordinate demonstration: source-aware wording, default selection, and agreement of the
// app's own metrics with the independent Python check (data/release/custom_demo_metrics.json).
// Expected values are read from that record, never typed in here.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DAY_MS, computeMetrics, parseIntervals } from "./mission";
import { CUSTOM_CAPABILITY_NOTE, coordinateBasis, isUserDefined, linkableUrl, profileFor, strictIntervals } from "./sites";
import { modelNotes } from "./SiteCatalog";
import { userDefinedFacts } from "./UserDefinedPoint";
import { MAX_SITES, resolveSites } from "./urlState";
import type { Catalog, HorizonMode, SiteData } from "./types";

const dir = new URL("../public/data/lvn-2026-12-01-120d/", import.meta.url);
const read = <T,>(f: string) => JSON.parse(readFileSync(new URL(f, dir), "utf-8")) as T;
const catalog = read<Catalog>("catalog.json");
const ID = "custom-85p5s-315e";
const cat = catalog.sites.find((s) => s.id === ID)!;
const data = read<SiteData>(`${ID}.json`);
const record = JSON.parse(readFileSync(new URL("../../data/release/custom_demo_metrics.json", import.meta.url), "utf-8"));

describe("source-aware wording", () => {
  it("never calls a user-defined point published", () => {
    expect(coordinateBasis([{ pointSource: "published" }, { pointSource: "published" }])).toBe("published coordinates");
    expect(coordinateBasis([{ pointSource: "user-defined" }])).toBe("a user-defined study point (an entered coordinate)");
    expect(coordinateBasis([{ pointSource: "published" }, { pointSource: "user-defined" }])).toBe("published coordinates and a user-defined study point (an entered coordinate)");
  });
  it("links only http(s) sources", () => {
    expect(linkableUrl("https://lroc.im-ldi.com/images/1408")).toBe("https://lroc.im-ldi.com/images/1408");
    expect(linkableUrl("urn:astraknots:user-defined-study-point")).toBeNull();
    expect(linkableUrl(undefined)).toBeNull();
  });
  it("curated sites keep their wording; the custom point is labelled from its catalog location type", () => {
    for (const c of catalog.sites.filter((s) => s.id !== ID)) {
      expect(isUserDefined(c)).toBe(false);
      expect(profileFor(null, c).pointSource).toBe("published");
    }
    expect(cat.location_type).toBe("user_defined_study_point");
    const p = profileFor(data, cat);
    expect(p.pointSource).toBe("user-defined");
    expect(p.label).toMatch(/^Custom-coordinate demonstration/);
    expect(p.kind).toMatch(/not a documented landing site or an approved landing target/);
    expect(p.realityNote).not.toMatch(/published/);
    expect(modelNotes(cat).site).toContain(CUSTOM_CAPABILITY_NOTE);
    const coord = data.sources.find((x) => x.id === "site-coordinates")!;
    expect(linkableUrl(coord.url)).toBeNull();
  });
  it("shows entered coordinates, terrain sources, observer and sampling from the site file", () => {
    const f = userDefinedFacts(data);
    expect(f.entered).toBe("85.5000° S, 315.0000° E");
    expect(f.terrain).toMatch(/^LDEM_80S_20M \(20\.0 m pixels\); 0 unknown skyline directions$/);
    expect(f.observer).toMatch(/^1 m nominal .*\(eye 1\.014 m .* Horizons altitude -3\.8654 km relative to the 1737\.4 km sphere/);
    expect(f.sampling).toBe("17,281 samples, 2026-12-01 00:00 UTC – 2027-03-31 00:00 UTC, every 10 minutes (JPL Horizons)");
    expect(f.processing).toMatch(/^Offline Python pipeline \(coordinate-terrain-1\), bundle [0-9a-f]{12}…$/);
  });
});

describe("dataset integration", () => {
  it("is an optional fifth site: default selection and the four-site limit are unchanged", () => {
    const ids = catalog.sites.map((s) => s.id);
    expect(ids).toHaveLength(5);
    expect(resolveSites(null, ids).ids).toEqual(["apollo17-lm"]);
    expect(MAX_SITES).toBe(4);
    expect(resolveSites(ids, ids).dropped).toEqual([ID]);
  });
});

describe("terrain versus smooth: app metrics agree with the independent check", () => {
  const cov = { start: Date.parse(record.full_coverage.window[0].replace("Z", ":00Z")), end: Date.parse(record.full_coverage.window[1].replace("Z", ":00Z")) };
  const demo = { start: Date.parse(record.demo_window.arrival.replace("Z", ":00Z")), end: Date.parse(record.demo_window.end.replace("Z", ":00Z")) };
  const metric = (mode: HorizonMode, w: { start: number; end: number }) => computeMetrics(parseIntervals(data, strictIntervals(data, mode)), w);
  const val = (a: { ok: boolean; value?: number }) => (a.ok ? a.value! : NaN);
  for (const [scope, w, ref] of [["full coverage", cov, record.full_coverage], ["14-day mission window", demo, record.demo_window]] as const) {
    it(`${scope}: Sun, Earth and simultaneous shares in both models`, () => {
      expect(w.end - w.start).toBe(scope === "full coverage" ? 120 * DAY_MS : 14 * DAY_MS);
      for (const mode of ["smooth", "terrain"] as const) {
        const m = metric(mode, w);
        expect(val(m.sunPct)).toBeCloseTo(ref[mode].sun_pct, 3);
        expect(val(m.earthPct)).toBeCloseTo(ref[mode].earth_pct, 3);
        expect(val(m.bothPct)).toBeCloseTo(ref[mode].both_pct, 3);
      }
    });
  }
});
