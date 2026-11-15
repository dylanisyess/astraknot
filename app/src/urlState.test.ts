import { describe, expect, it } from "vitest";
import { parseUrlState, resolveActive, resolveSites, writeUrlState } from "./urlState";

const IDS = ["im2-athena", "connecting-ridge-cr1"];

describe("URL state", () => {
  it("an existing single-site Athena link still parses; it compares all sites with Athena active", () => {
    const s = parseUrlState("?arrival=2026-12-08T03:00Z&days=10&delay=7&t=2026-12-10T00:00:00Z&horizon=smooth");
    expect(s.arrival).toBe(Date.parse("2026-12-08T03:00:00Z"));
    expect(s.days).toBe(10);
    expect(s.delay).toBe(7);
    expect(s.t).toBe(Date.parse("2026-12-10T00:00:00Z"));
    expect(s.horizon).toBe("smooth");
    const sites = resolveSites(s.sites, IDS);
    expect(sites).toEqual({ ids: IDS, unknown: [], duplicates: [], dropped: [] });
    expect(resolveActive(s.site, sites.ids)).toBe("im2-athena");
  });

  it("restores the selected sites (manifest order) and the active site", () => {
    const s = parseUrlState("?sites=connecting-ridge-cr1,im2-athena&site=connecting-ridge-cr1");
    expect(resolveSites(s.sites, IDS).ids).toEqual(IDS);
    expect(resolveActive(s.site, IDS)).toBe("connecting-ridge-cr1");
    const one = parseUrlState("?sites=connecting-ridge-cr1&site=im2-athena");
    const r = resolveSites(one.sites, IDS);
    expect(r.ids).toEqual(["connecting-ridge-cr1"]);
    expect(resolveActive(one.site, r.ids)).toBe("connecting-ridge-cr1"); // active must be compared
  });

  it("reports unknown site IDs and never invents a site", () => {
    const r = resolveSites(["nope", "im2-athena"], IDS);
    expect(r).toEqual({ ids: ["im2-athena"], unknown: ["nope"], duplicates: [], dropped: [] });
    expect(resolveSites(["nope"], IDS)).toEqual({ ids: IDS, unknown: ["nope"], duplicates: [], dropped: [] });
    expect(resolveSites([], IDS).ids).toEqual(IDS);
  });

  it("release 6: duplicates are compared once and reported; more than four sites are capped and reported", () => {
    const six = ["a", "b", "c", "d", "e", "f"];
    expect(resolveSites(["b", "b", "a"], six)).toEqual({ ids: ["a", "b"], unknown: [], duplicates: ["b"], dropped: [] });
    const r = resolveSites(["f", "e", "d", "c", "b", "a"], six);
    expect(r.ids).toEqual(["a", "b", "c", "d"]); // catalog order, at most MAX_SITES
    expect(r.dropped).toEqual(["e", "f"]);
    // no sites named: the first two catalog sites (the whole 60-day release)
    expect(resolveSites(null, six).ids).toEqual(["a", "b"]);
  });

  it("ignores malformed values", () => {
    const s = parseUrlState("?days=abc&delay=&horizon=3d&arrival=yesterday");
    expect(s).toMatchObject({ days: null, delay: null, horizon: null, arrival: null });
  });

  it("round-trips through writeUrlState", () => {
    const u = writeUrlState(new URL("http://x/app/?foo=1"), {
      arrival: Date.parse("2026-12-08T03:00:00Z"), days: 14, delay: 3, t: "2026-12-11T00:00:00Z",
      horizon: "terrain", sites: IDS, site: "connecting-ridge-cr1",
    });
    expect(u.searchParams.get("foo")).toBe("1");
    const s = parseUrlState(u.search);
    expect(s).toEqual({
      arrival: Date.parse("2026-12-08T03:00:00Z"), days: 14, delay: 3, t: Date.parse("2026-12-11T00:00:00Z"),
      horizon: "terrain", sites: IDS, site: "connecting-ridge-cr1", view: null, mission: null, cam: null, layer: null, thr: null,
    });
    const v = writeUrlState(new URL("http://x/"), {
      arrival: Date.parse("2026-12-08T03:00:00Z"), days: 14, delay: 3, t: "2026-12-11T00:00:00Z",
      horizon: "terrain", sites: IDS, site: "im2-athena", view: "analysis",
    });
    expect(parseUrlState(v.search).view).toBe("analysis");
  });

  it("an old link without a view opens the default view (Explore); view is validated", () => {
    expect(parseUrlState("?arrival=2026-12-08T03:00Z&horizon=smooth").view).toBeNull();
    expect(parseUrlState("?view=analysis").view).toBe("analysis");
    expect(parseUrlState("?view=explore").view).toBe("explore");
    expect(parseUrlState("?view=Analysis").view).toBeNull();
  });

  it("restores Explore's active mission and camera mode; malformed values are ignored", () => {
    const u = writeUrlState(new URL("http://x/"), {
      arrival: Date.parse("2026-12-05T00:00:00Z"), days: 14, delay: 3, t: "2026-12-09T00:00:00Z",
      horizon: "terrain", sites: IDS, site: "im2-athena", view: "explore", mission: "baseline", cam: "horizon",
    });
    expect(parseUrlState(u.search)).toMatchObject({ mission: "baseline", cam: "horizon", view: "explore" });
    expect(parseUrlState("?mission=later&cam=eye")).toMatchObject({ mission: null, cam: null });
  });
});
