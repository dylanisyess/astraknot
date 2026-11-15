// First-visit introduction and the guided Apollo 17 example.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { App, Workspace, describeScenario } from "./App";
import { checkSites } from "./data";
import { terrainProblem } from "./horizon";
import { DAY_MS, computeMetrics, fmtOutage, fmtPct, parseIntervals, scenarioWindow } from "./mission";
import { EXAMPLE, exampleSearch, isExampleScenario, isExplicitScenario, readOnboarded, resetOnboardedMemory, showWelcomeOnEntry, writeOnboarded } from "./onboarding";
import { strictIntervals } from "./sites";
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
const apollo = DS.sites.find((s) => s.id === EXAMPLE.siteId)!.data;
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
    for (const s of ["Lunar Landing Site Navigator", "Choose your next horizon.", "Explore terrain, sunlight and direct-to-Earth visibility.", "Explore Apollo 17", "Open navigator", "Apollo 17", "A historic site. A new mission.", "Hypothetical planning example", "not a reconstruction of the 1972 mission", "Scientific Visualization Studio"]) expect(t).toContain(s);
    // the long explanation, limitations and sources are in the About disclosure (closed by default)
    expect(root).toMatch(/aria-expanded="false" aria-controls="lp-about"/);
    expect(t).not.toContain("NASA JPL Horizons");
    expect(root).not.toContain('role="dialog"'); // a page, not a modal, on first visit
    const link = renderToStaticMarkup(<App entrySearch="?sites=im2-athena&ds=lvn-2026-12-01-120d" />);
    expect(link).not.toContain("welcome");
    expect(link).toContain("Loading data");
  });
});

describe("the Apollo 17 example", () => {
  const q = exampleSearch();
  const u = parseUrlState(q);
  const iv = parseIntervals(apollo, strictIntervals(apollo, "terrain"));
  const base = { start: Date.parse(EXAMPLE.arrival), end: Date.parse(EXAMPLE.arrival) + EXAMPLE.days * DAY_MS };
  const delayed = scenarioWindow(base.start, EXAMPLE.delay, EXAMPLE.days * DAY_MS);
  it("is an explicit link of the current dataset: Apollo 17 alone, Terrain, 14 days, no delay yet, Explore", () => {
    expect(new URLSearchParams(q).get("ds")).toBe(EXAMPLE.datasetId);
    expect(u).toMatchObject({ sites: ["apollo17-lm"], site: "apollo17-lm", horizon: "terrain", days: 14, delay: 0, view: "explore", mission: "baseline", cam: "overview" });
    expect(u.arrival).toBe(base.start);
    expect(u.t).toBe(base.start);
    expect(isExplicitScenario(q)).toBe(true);
    expect(isExampleScenario(q)).toBe(true);
    expect(isExampleScenario("?sites=im2-athena&ds=lvn-2026-12-01-120d")).toBe(false);
    // inside coverage, with the delay as an existing option that fits
    expect(delayed.end).toBeLessThanOrEqual(Date.parse(DS.manifest.coverage_end_utc));
    expect([1, 3, 7]).toContain(EXAMPLE.delay);
  });
  it("shows a clear change with the slip (checked against the shared metric code, not fixed numbers)", () => {
    const b = computeMetrics(iv, base);
    const d = computeMetrics(iv, delayed);
    expect(b.sunPct.ok && d.sunPct.ok).toBe(true);
    if (!b.sunPct.ok || !d.sunPct.ok || !b.longestDark.ok || !d.longestDark.ok) return;
    expect(b.sunPct.value - d.sunPct.value).toBeGreaterThan(10); // the reason this example was chosen
    expect((d.longestDark.value?.durationMs ?? 0)).toBeGreaterThan(b.longestDark.value?.durationMs ?? 0);
    const lines = delaySummary(b, d, EXAMPLE.delay).join(" ");
    expect(lines).toContain(`${fmtPct(b.sunPct.value)} → ${fmtPct(d.sunPct.value)}`);
    expect(lines).toContain(fmtOutage(d.longestDark.value!.durationMs));
  });
  it("has a Sun horizon crossing inside the baseline mission (step 1)", () => {
    const xs = iv.slice(1).filter((x, k) => x.sun !== iv[k].sun).map((x) => x.start);
    expect(xs.some((t) => t > base.start && t < base.end)).toBe(true);
  });
  it("guide renders the real scenario's numbers in Explore, and says it is hypothetical", () => {
    const guide = { step: 1 as const, setStep: () => {}, exit: () => {}, finish: () => {} };
    const s1 = text(renderToStaticMarkup(<Workspace ds={DS} search={q} guide={guide} />));
    expect(s1).toContain("Guide · 1 of 3");
    expect(s1).toContain("Hypothetical 14-day mission at the historic Apollo 17 landing site");
    expect(s1).toContain("not a replay of the 1972 mission");
    expect(s1).toContain("Track the Sun at its crossing");
    // at the very beginning: the three Conditions items are named and highlighted
    for (const c of ["Solar-power potential", "Direct-to-Earth communication window", "Terrain screening"]) expect(s1).toContain(c);
    expect(renderToStaticMarkup(<Workspace ds={DS} search={q} guide={guide} />)).toContain('data-guide-hint="conditions"');
    const s2h = renderToStaticMarkup(<Workspace ds={DS} search={q} guide={{ ...guide, step: 2 }} />);
    const b = computeMetrics(iv, base);
    const row = s2h.slice(s2h.indexOf('data-row="baseline"'), s2h.indexOf("</tr>", s2h.indexOf('data-row="baseline"')));
    expect(text(row)).toContain(b.sunPct.ok ? fmtPct(b.sunPct.value) : "x");
    expect(s2h).toContain('data-testid="guide-apply-delay"');
    // with the delay applied (same as the delay button), the +3 d row and the derived summary appear
    const s2d = text(renderToStaticMarkup(<Workspace ds={DS} search={q.replace("delay=0", `delay=${EXAMPLE.delay}`).replace("mission=baseline", "mission=delayed")} guide={{ ...guide, step: 2 }} />));
    expect(s2d).toContain(`+${EXAMPLE.delay} d`);
    expect(s2d).toContain("Direct sunlight falls by");
    const s3 = text(renderToStaticMarkup(<Workspace ds={DS} search={q} guide={{ ...guide, step: 3 }} />));
    expect(s3).toContain("Open Find arrival windows");
    expect(s3).toContain("Continue exploring");
    // without a guide, nothing of it is rendered
    expect(renderToStaticMarkup(<Workspace ds={DS} search={q} />)).not.toContain('data-testid="guide"');
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
