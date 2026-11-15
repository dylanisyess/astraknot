// First-visit introduction and the guided south-polar (Odysseus) example.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { App, Workspace, describeScenario } from "./App";
import { checkSites } from "./data";
import { terrainProblem } from "./horizon";
import { DAY_MS, computeMetrics, fmtOutage, fmtPct, parseIntervals, scenarioWindow } from "./mission";
import { EXAMPLE, exampleSearch, isExampleScenario, isExplicitScenario, readOnboarded, recommendedComparison, resetOnboardedMemory, showWelcomeOnEntry, writeOnboarded } from "./onboarding";
import { geometryAt } from "./status";
import { planCrossing, transitions } from "./explore/availability";
import { strictHorizon, strictIntervals } from "./sites";
import type { Catalog, Dataset, Manifest, SiteData } from "./types";
import { parseUrlState } from "./urlState";
import { delaySummary } from "./welcome/Guide";
import { Welcome, moonSrcSet } from "./welcome/Welcome";
import moon from "./welcome/moonImage.json";

const dir = new URL(`../public/data/${EXAMPLE.datasetId}/`, import.meta.url);
const readJson = <T,>(name: string): T => JSON.parse(readFileSync(new URL(name, dir), "utf-8")) as T;
function dataset(): Dataset {
  const manifest = readJson<Manifest>("manifest.json");
  const files = manifest.sites.map((e) => readJson<SiteData>(e.file));
  const times = checkSites(manifest, files);
  return {
    manifest,
    catalog: readJson<Catalog>("catalog.json"),
    times,
    sites: files.map((d, k) => ({ id: manifest.sites[k].id, data: d, terrainProblem: terrainProblem(d) })),
  };
}
const DS = dataset();
const site = DS.sites.find((s) => s.id === EXAMPLE.siteId)!.data;
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&gt;/g, ">").replace(/\s+/g, " ");
const store = (v: string | null, throws = false) => ({
  getItem: () => { if (throws) throw new Error("blocked"); return v; },
  setItem: () => { if (throws) throw new Error("blocked"); },
});

describe("entry intent and the onboarded flag", () => {
  beforeEach(() => resetOnboardedMemory());
  it("a root visit shows the welcome; any scenario or dataset parameter is an explicit link", () => {
    expect(isExplicitScenario("")).toBe(false);
    expect(isExplicitScenario("?utm_source=x")).toBe(false);
    for (const q of ["?sites=im2-athena", "?ds=lvn-2026-12-01-60d", "?arrival=2026-12-05T00:00Z", "?view=analysis", "?t=2026-12-08T00:00:00Z"]) expect(isExplicitScenario(q)).toBe(true);
    expect(showWelcomeOnEntry("", store(null))).toBe(true);
    expect(showWelcomeOnEntry("?sites=im2-athena", store(null))).toBe(false);
    expect(showWelcomeOnEntry("", store("1"))).toBe(false); // returning visitor
  });
  it("unavailable storage never throws; the choice is remembered in memory for the page", () => {
    expect(readOnboarded(store(null, true))).toBe(false);
    expect(() => writeOnboarded(store(null, true))).not.toThrow();
    expect(readOnboarded(store(null, true))).toBe(true);
    expect(() => writeOnboarded(null)).not.toThrow();
  });
  it("App: welcome on a root entry, the navigator (loading) for a scenario link", () => {
    const root = renderToStaticMarkup(<App entrySearch="" />);
    expect(root).toContain('data-testid="welcome-page"');
    const t = text(root);
    for (const s of ["Lunar Landing Site Navigator", "Choose your next horizon.", "Explore terrain, sunlight and direct-to-Earth visibility.", "Watch a south-pole sunrise", "Open navigator", "Odysseus · south pole", "Watch the Sun clear a ridge.", "Hypothetical planning example at the IM-1 Odysseus landing point", "not a replay of the 2024 IM-1 landing", "Scientific Visualization Studio"]) expect(t).toContain(s);
    expect(t).not.toContain("Apollo 17");
    // the long explanation, limitations and sources are in the About disclosure (closed by default)
    expect(root).toMatch(/aria-expanded="false" aria-controls="lp-about"/);
    expect(t).not.toContain("NASA JPL Horizons");
    expect(root).not.toContain('role="dialog"'); // a page, not a modal, on first visit
    const link = renderToStaticMarkup(<App entrySearch="?sites=im2-athena&ds=lvn-2026-12-01-120d" />);
    expect(link).not.toContain("welcome");
    expect(link).toContain("Loading data");
  });
});

describe("the south-polar example (Odysseus)", () => {
  const q = exampleSearch();
  const u = parseUrlState(q);
  const ivT = parseIntervals(site, strictIntervals(site, "terrain"));
  const ivS = parseIntervals(site, strictIntervals(site, "smooth"));
  const base = { start: Date.parse(EXAMPLE.arrival), end: Date.parse(EXAMPLE.arrival) + EXAMPLE.days * DAY_MS };
  const delayed = scenarioWindow(base.start, EXAMPLE.delay, EXAMPLE.days * DAY_MS);
  const times = DS.times;
  it("is an explicit link of the current dataset: Odysseus alone, Terrain, 14 days, no delay yet, Explore", () => {
    expect(new URLSearchParams(q).get("ds")).toBe(EXAMPLE.datasetId);
    expect(u).toMatchObject({ sites: ["im1-odysseus"], site: "im1-odysseus", horizon: "terrain", days: 14, delay: 0, view: "explore", mission: "baseline", cam: "overview" });
    expect(u.arrival).toBe(base.start);
    expect(u.t).toBe(base.start);
    expect(isExplicitScenario(q)).toBe(true);
    expect(isExampleScenario(q)).toBe(true);
    expect(isExampleScenario("?sites=im2-athena&ds=lvn-2026-12-01-120d")).toBe(false);
    // inside coverage, with the delay as an existing option that fits
    expect(delayed.end).toBeLessThanOrEqual(Date.parse(DS.manifest.coverage_end_utc));
    expect([1, 3, 7]).toContain(EXAMPLE.delay);
  });
  it("meets the selection rule: a terrain-ridge Sun crossing, Smooth vs Terrain differ, and the slip changes sunlight (shared metric code)", () => {
    const xs = transitions(ivT, "sun", base);
    const first = xs.find((x) => x.t - base.start >= 3_600_000)!;
    expect(first.to).toBe(true); // sunrise over the ridge
    const g = geometryAt({ samples: site.samples, times, horizon: strictHorizon(site, "terrain") }, "sun", first.t);
    expect(g.elevationDeg!).toBeGreaterThanOrEqual(1); // the Smooth model already counts it as up
    expect(g.horizonDeg!).toBeGreaterThanOrEqual(1); // a ridge, not the flat horizon
    expect(new Date(first.t).toISOString()).toBe("2026-12-18T10:40:00.000Z");
    const bT = computeMetrics(ivT, base);
    const bS = computeMetrics(ivS, base);
    const d = computeMetrics(ivT, delayed);
    if (!bT.sunPct.ok || !bS.sunPct.ok || !d.sunPct.ok || !bT.longestDark.ok || !d.longestDark.ok) throw new Error("metrics unavailable");
    expect(Math.abs(bS.sunPct.value - bT.sunPct.value)).toBeGreaterThanOrEqual(5);
    expect(bT.sunPct.value - d.sunPct.value).toBeGreaterThanOrEqual(10);
    expect(d.longestDark.value!.durationMs).toBeGreaterThan(bT.longestDark.value!.durationMs);
    const lines = delaySummary(bT, d, EXAMPLE.delay).join(" ");
    expect(lines).toContain(`${fmtPct(bT.sunPct.value)} → ${fmtPct(d.sunPct.value)}`);
    expect(lines).toContain(fmtOutage(d.longestDark.value!.durationMs));
  });
  it("the guide starts 3 h before that crossing, with the whole nominal Sun disk still behind the ridge", () => {
    const plan = planCrossing({ intervals: ivT, body: "sun", range: base, selT: base.start, anchor: null, dir: 1, leadMs: EXAMPLE.leadMs, times });
    expect(plan.kind).toBe("event");
    if (plan.kind !== "event") return;
    expect(new Date(plan.targetT).toISOString()).toBe("2026-12-18T07:40:00.000Z");
    const g = geometryAt({ samples: site.samples, times, horizon: strictHorizon(site, "terrain") }, "sun", plan.targetT);
    expect(g.clearanceDeg!).toBeLessThan(-0.53 / 2); // the upper limb too is below the skyline
  });
  it("recommends Athena for comparison: the other south-polar site that is neither provisional nor user-defined", () => {
    expect(recommendedComparison(DS.catalog.sites, EXAMPLE.siteId)).toBe(EXAMPLE.compareSiteId);
    expect(EXAMPLE.compareSiteId).toBe("im2-athena");
    // with five sites in the catalog (incl. the custom demonstration) and a four-site limit
    expect(DS.catalog.sites).toHaveLength(5);
    expect(recommendedComparison(DS.catalog.sites, "im2-athena")).toBe("im1-odysseus");
  });
  it("guide renders the real scenario's numbers in Explore, and says it is hypothetical", () => {
    const guide = { step: 1 as const, setStep: () => {}, exit: () => {}, finish: () => {} };
    const s1 = text(renderToStaticMarkup(<Workspace ds={DS} search={q} guide={guide} />));
    expect(s1).toContain("Guide · 1 of 3");
    expect(s1).toContain("Hypothetical 14-day mission at the IM-1 Odysseus landing point");
    expect(s1).toContain("not a replay of the historical landing");
    expect(s1).toContain("Show the sunrise in Horizon view");
    expect(s1).toContain("Skip guide");
    // step 2: the Add site control is named; Athena can be added with an explicit button
    const s2 = renderToStaticMarkup(<Workspace ds={DS} search={q} guide={{ ...guide, step: 2 }} />);
    expect(text(s2)).toContain("+ Add site (top left, in Mission setup)");
    expect(s2).toContain('data-testid="guide-add-compare"');
    expect(text(s2)).toContain("Add Athena for comparison");
    // with Athena compared: both sites' baseline numbers from the shared metrics, same window and model
    const qa = q.replace("sites=im1-odysseus", "sites=im2-athena,im1-odysseus");
    const s2a = renderToStaticMarkup(<Workspace ds={DS} search={qa} guide={{ ...guide, step: 2 }} />);
    expect(s2a).not.toContain('data-testid="guide-add-compare"');
    const athena = DS.sites.find((x) => x.id === "im2-athena")!.data;
    const bA = computeMetrics(parseIntervals(athena, strictIntervals(athena, "terrain")), base);
    const bO = computeMetrics(ivT, base);
    const rowOf = (h: string, id: string) => text(h.slice(h.indexOf(`data-row="${id}"`), h.indexOf("</tr>", h.indexOf(`data-row="${id}"`))));
    expect(rowOf(s2a, "im2-athena")).toContain(bA.sunPct.ok ? fmtPct(bA.sunPct.value) : "x");
    expect(rowOf(s2a, "im2-athena")).toContain(bA.earthPct.ok ? fmtPct(bA.earthPct.value) : "x");
    expect(rowOf(s2a, "im1-odysseus")).toContain(bO.sunPct.ok ? fmtPct(bO.sunPct.value) : "x");
    // step 3: baseline first; with the delay applied, "baseline → +3 d" per compared site and the summary
    const s3 = renderToStaticMarkup(<Workspace ds={DS} search={qa} guide={{ ...guide, step: 3 }} />);
    expect(s3).toContain('data-testid="guide-apply-delay"');
    expect(text(s3)).toContain("Open Find arrival windows");
    const s3d = renderToStaticMarkup(<Workspace ds={DS} search={qa.replace("delay=0", `delay=${EXAMPLE.delay}`).replace("mission=baseline", "mission=delayed")} guide={{ ...guide, step: 3 }} />);
    const dA = computeMetrics(parseIntervals(athena, strictIntervals(athena, "terrain")), delayed);
    if (!bA.earthPct.ok || !dA.earthPct.ok) throw new Error("metrics unavailable");
    expect(rowOf(s3d, "im2-athena")).toContain(`${fmtPct(bA.earthPct.value)} → ${fmtPct(dA.earthPct.value)}`);
    expect(text(s3d)).toContain("Direct sunlight falls by");
    expect(text(s3d)).toContain("Done");
    // without a guide, nothing of it is rendered
    expect(renderToStaticMarkup(<Workspace ds={DS} search={q} />)).not.toContain('data-testid="guide"');
  });
  it("a full comparison (four sites) is never changed by the guide: it says why Athena cannot be added", () => {
    const guide = { step: 2 as const, setStep: () => {}, exit: () => {}, finish: () => {} };
    const full = q.replace("sites=im1-odysseus", "sites=apollo17-lm,connecting-ridge-cr1,custom-85p5s-315e,im1-odysseus");
    const h = renderToStaticMarkup(<Workspace ds={DS} search={full} guide={guide} />);
    expect(h).not.toContain('data-testid="guide-add-compare"');
    expect(text(h)).toContain("the comparison is full (4 sites)");
  });
  it("the help dialog's replacement note describes the scenario being replaced", () => {
    expect(describeScenario("?sites=im2-athena,connecting-ridge-cr1&arrival=2026-12-05T00:00Z&days=10&delay=1&horizon=terrain", DS)).toBe("Athena, CR1 · arrival 2026-12-05 00:00 UTC · 10 days · delay +1 d · Terrain");
  });
});

describe("welcome image", () => {
  it("responsive AVIF/WebP sources and a JPEG fallback, each file matching its recorded hash", () => {
    expect(moonSrcSet("avif")).toBe(moon.widths.map((w) => `/welcome/moon-${w}.avif ${w}w`).join(", "));
    expect(moonSrcSet("webp")).toContain("moon-1400.webp 1400w");
    for (const [name, f] of Object.entries(moon.files)) {
      const bytes = readFileSync(new URL(`../public/welcome/${name}`, import.meta.url));
      expect(bytes.length).toBe(f.bytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(f.sha256);
    }
    expect(moon.files["moon-960.avif"].bytes).toBeLessThan(150_000); // a typical desktop transfer
  });
  it("is credited NASA imagery, near side, north up, rendered without displacement", () => {
    expect(moon.source.credit).toBe("NASA's Scientific Visualization Studio");
    expect(moon.source.page).toBe("https://svs.gsfc.nasa.gov/4720/");
    expect(moon.source.derived_from).toMatch(/LROC WAC/);
    expect(moon.projection).toMatchObject({ type: "orthographic", center_lat_deg: 0, center_lon_deg_east: 0, north_up: true });
    expect(moon.rendering).toMatch(/no displacement/);
  });
  it("About: a disclosure with the explanation, limitations, sources, image credit and font licenses", () => {
    const h = renderToStaticMarkup(<Welcome mode="page" onExplore={() => {}} onOpen={() => {}} />);
    expect(h).not.toContain('data-testid="welcome-about"');
    expect(h).toContain('data-testid="welcome-about-toggle"');
    // the dialog form keeps the same content and a close control
    const d = renderToStaticMarkup(<Welcome mode="dialog" current="Athena" onExplore={() => {}} onOpen={() => {}} />);
    expect(d).toMatch(/role="dialog" aria-modal="true" aria-labelledby="wl-title"/);
    expect(d).toContain('data-testid="welcome-close"');
    for (const f of ["BarlowCondensed-OFL.txt", "SpaceGrotesk-OFL.txt"]) expect(readFileSync(new URL(`../public/welcome/fonts/${f}`, import.meta.url), "utf8")).toContain("SIL Open Font License");
  });
});
