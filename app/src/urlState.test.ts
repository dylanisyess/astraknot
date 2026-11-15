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
    expect(sites).toEqual({ ids: IDS, unknown: [] });
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
    expect(r).toEqual({ ids: ["im2-athena"], unknown: ["nope"] });
    expect(resolveSites(["nope"], IDS)).toEqual({ ids: IDS, unknown: ["nope"] });
    expect(resolveSites([], IDS).ids).toEqual(IDS);
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
      horizon: "terrain", sites: IDS, site: "connecting-ridge-cr1",
    });
  });
});
