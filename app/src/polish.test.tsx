// Mentor-feedback polish: Analysis takeaway and "Method & limits", chart recovery, display
// precision, wording, the Horizon view's opening direction and its edge hints.
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { VizBoundary, Workspace } from "./App";
import { checkSites } from "./data";
import { terrainProblem } from "./horizon";
import { DAY_MS, computeMetrics, fmtOutage, fmtPct, parseIntervals, scenarioWindow } from "./mission";
import { strictIntervals, terrainFacts } from "./sites";
import { offscreenHint, usefulEyePose } from "./explore/tracking";
import type { BodyStatus } from "./status";
import type { Catalog, Dataset, Manifest, SiteData } from "./types";

const dir = new URL("../public/data/lvn-2026-12-01-120d/", import.meta.url);
const readJson = <T,>(name: string): T => JSON.parse(readFileSync(new URL(name, dir), "utf-8")) as T;
function dataset(): Dataset {
  const manifest = readJson<Manifest>("manifest.json");
  const files = manifest.sites.map((e) => readJson<SiteData>(e.file));
  const times = checkSites(manifest, files);
  return { manifest, catalog: readJson<Catalog>("catalog.json"), times, sites: files.map((d, k) => ({ id: manifest.sites[k].id, data: d, terrainProblem: terrainProblem(d) })) };
}
const DS = dataset();
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&gt;/g, ">").replace(/\s+/g, " ");
const Q = "?ds=lvn-2026-12-01-120d&arrival=2026-12-18T00:00Z&days=14&horizon=terrain&view=analysis";

describe("Analysis leads with a scenario-specific takeaway", () => {
  const h = renderToStaticMarkup(<Workspace ds={DS} search={`${Q}&delay=3&sites=im2-athena,im1-odysseus&site=im1-odysseus`} />);
  const t = text(h);
  it("states direct sunlight and the longest period without it per site, from the shared metrics, with context", () => {
    const base = { start: Date.parse("2026-12-18T00:00:00Z"), end: Date.parse("2026-12-18T00:00:00Z") + 14 * DAY_MS };
    const del = scenarioWindow(base.start, 3, 14 * DAY_MS);
    const s = DS.sites.find((x) => x.id === "im1-odysseus")!.data;
    const iv = parseIntervals(s, strictIntervals(s, "terrain"));
    const b = computeMetrics(iv, base);
    const d = computeMetrics(iv, del);
    if (!b.sunPct.ok || !d.sunPct.ok || !b.longestDark.ok || !d.longestDark.ok) throw new Error("metrics");
    const tk = text(h.slice(h.indexOf('data-testid="takeaway"'), h.indexOf("</section>", h.indexOf('data-testid="takeaway"'))));
    expect(tk).toContain(`Odysseus : Direct sunlight: ${fmtPct(b.sunPct.value)} → ${fmtPct(d.sunPct.value)} with +3 d.`);
    expect(tk).toContain(`Longest period without sunlight: ${fmtOutage(b.longestDark.value!.durationMs)} ⚠ → ${fmtOutage(d.longestDark.value!.durationMs)} ⚠ with +3 d`);
    expect(tk).toContain("touches a mission-window edge, so it may be longer");
    expect(tk).toContain("2026-12-18 00:00 UTC → 2027-01-01 00:00 UTC (14 days)");
    expect(tk).toContain("Terrain horizon · 2 sites, same window and model");
    expect(tk).toContain("Direct sunlight is not electrical power; Earth visible is not a working radio link.");
    expect(h.indexOf('data-testid="takeaway"')).toBeLessThan(h.indexOf('data-testid="aligned-metrics"'));
  });
  it("keeps the long method in one closed 'Method & limits' disclosure; warnings stay outside it", () => {
    expect(h).toMatch(/<details class="card sources-card method-limits" id="method-limits" data-testid="method-limits"/);
    expect(h).not.toMatch(/data-testid="method-limits"[^>]*open/);
    const m = h.slice(h.indexOf('data-testid="method-limits"'));
    expect(text(m)).toContain("10 minutes is the sampling and reporting resolution");
    expect(text(m)).toContain("Observer-to-Sun and observer-to-Earth distances are not part of this dataset");
    // result-specific warnings stay outside it
    const before = h.slice(0, h.indexOf('data-testid="method-limits"'));
    expect(text(before)).toContain("so it may be longer");
    expect(before).toContain("Terrain horizon for every site shown.");
  });
  it("a provisional site keeps its badge in the takeaway (Terrain)", () => {
    const p = text(renderToStaticMarkup(<Workspace ds={DS} search={`${Q}&delay=0&sites=connecting-ridge-cr1&site=connecting-ridge-cr1`} />));
    expect(p).toContain("CR1 ⚠ provisional :");
    expect(p).toContain("one site");
    expect(p).toContain("· 1 site");
  });
  it("Smooth keeps its terrain-ignored warning visible", () => {
    const sm = text(renderToStaticMarkup(<Workspace ds={DS} search={`${Q.replace("horizon=terrain", "horizon=smooth")}&sites=im1-odysseus`} />));
    expect(sm).toContain("Smooth horizon for every site shown: terrain ignored");
    expect(sm).toContain("Smooth 0° horizon (terrain ignored)");
  });
  it("human-readable pixel sizes; calculation values untouched", () => {
    const a = renderToStaticMarkup(<Workspace ds={DS} search={`${Q}&sites=apollo17-lm&site=apollo17-lm`} />);
    expect(a).not.toMatch(/59\.22529/);
    expect(text(a)).toContain("59.2 m");
    const ap = DS.sites.find((x) => x.id === "apollo17-lm")!.data;
    expect(Object.values(ap.terrain_horizon!.horizon.resolution.dem_pixel_m)[0]).toBeCloseTo(59.225293797166955, 12);
  });
  it("grammar: one site is 'this site', never 'both site'", () => {
    const one = text(renderToStaticMarkup(<Workspace ds={DS} search={`${Q}&sites=im1-odysseus`} />));
    expect(one).not.toMatch(/both site\b/);
    expect(one).toContain("threshold at this site");
    expect(t).toContain("threshold at both sites");
  });
});

describe("chart recovery", () => {
  function Boom(): never { throw new Error("draw failed"); }
  it("a failing chart shows what failed and a redraw action, not an empty page", () => {
    // server rendering has no error boundaries; the fallback is checked directly
    const b = new VizBoundary({ name: "elevation chart", fallbackHint: "Use the slider.", children: <Boom /> });
    b.state = { ...VizBoundary.getDerivedStateFromError(new Error("draw failed")), n: 0 };
    const h = renderToStaticMarkup(<>{b.render()}</>);
    expect(text(h)).toContain("The elevation chart could not be drawn. draw failed");
    expect(h).toContain('data-testid="viz-retry"');
    expect(text(h)).toContain("Redraw elevation chart");
  });
});

describe("terrain facts are computed once per site file", () => {
  it("returns the same object on repeated calls (no per-render scan of every sample)", () => {
    const s = DS.sites.find((x) => x.id === "im1-odysseus")!.data;
    expect(terrainFacts(s)).toBe(terrainFacts(s));
    expect(terrainFacts(s)!.sunElevationRange[0]).toBeLessThan(terrainFacts(s)!.sunElevationRange[1]);
  });
});

const geom = (az: number | null, el: number | null): BodyStatus["geometry"] => ({ azimuthDeg: az, elevationDeg: el, horizonDeg: 0, clearanceDeg: el, side: el === null ? null : el > 0 ? "above" : "below" });
const st = (sun: BodyStatus["geometry"], earth: BodyStatus["geometry"]) => ({ sun: { geometry: sun } as BodyStatus, earth: { geometry: earth } as BodyStatus });

describe("Horizon view opening direction", () => {
  it("faces the Sun when its direction is known and it is near or above the horizon", () => {
    const p = usefulEyePose(st(geom(66.7, 5.2), geom(350, 14)), 0);
    expect(p.body).toBe("sun");
    expect(p.yaw).toBeCloseTo(66.7, 6);
    expect(p.pitch).toBeGreaterThanOrEqual(1);
    expect(p.pitch).toBeLessThan(5.2); // the Sun sits above the centre, the skyline below stays in frame
  });
  it("faces Earth when the Sun is well below the horizon; the site default when neither is usable", () => {
    expect(usefulEyePose(st(geom(120, -10), geom(350, 3)), 0).body).toBe("earth");
    const none = usefulEyePose(st(geom(null, null), geom(200, -20)), 135);
    expect(none).toMatchObject({ body: null, yaw: 135 });
  });
  it("normalizes azimuth and keeps the field of view it is given", () => {
    const p = usefulEyePose(st(geom(-10, 1), geom(null, null)), 0, 12);
    expect(p.yaw).toBeCloseTo(350, 6);
    expect(p.fov).toBe(12);
  });
});

describe("edge hints name a camera turn, not an azimuth", () => {
  it("left/right turns with the turn size, and an accessible label that says it is a turn", () => {
    const r = offscreenHint("Earth", 118.4, false, 0);
    expect(r.text).toBe("Turn 118° right toward Earth ▶");
    expect(r.side).toBe("right");
    expect(r.aria).toContain("a camera turn, not an azimuth");
    expect(offscreenHint("Sun", -35, false, 0).text).toBe("◀ Turn 35° left toward Sun");
  });
  it("behind the camera: the shorter way round (|turn| ≤ 180°)", () => {
    expect(offscreenHint("Earth", 179.6, false, 0).text).toBe("Turn 180° right toward Earth ▶");
    expect(offscreenHint("Earth", -179.6, false, 0).text).toBe("◀ Turn 180° left toward Earth");
  });
  it("a body within the horizontal field but above or below the frame says look up / down", () => {
    expect(offscreenHint("Sun", 3, true, 40.2)).toMatchObject({ text: "▲ Look up 40° toward Sun", side: "top" });
    expect(offscreenHint("Earth", -2, true, -25)).toMatchObject({ text: "▼ Look down 25° toward Earth", side: "bottom" });
  });
  it("Explore's legend calls the lines direction rays whose drawn length is not distance", () => {
    const src = readFileSync(new URL("./explore/Explore.tsx", import.meta.url), "utf-8");
    expect(src).toContain("Direction rays start at the fixed modeled observer");
    expect(src).toContain("their drawn length does not represent distance");
    expect(src.toLowerCase()).not.toContain("trajector");
  });
});
