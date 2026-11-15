// Arrival Window Finder in the app: entry points, initial inputs from the scenario, and agreement
// of an applied result with the Analysis cards on the real 120-day, four-site dataset.
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Workspace } from "./App";
import { ArrivalFinder } from "./ArrivalFinder";
import { checkCatalog, checkSiteFile, manifestTimes } from "./data";
import { NO_LIMITS, checkInputs, commonCoverage, delayPreview, evaluate, limitOutcomes, metricValue, resultView } from "./finder";
import { DAY_MS, HOUR_MS, computeMetrics, fmtOutage, fmtPct, parseIntervals } from "./mission";
import { useScenario } from "./scenario";
import type { Catalog, Dataset, Manifest, SiteData } from "./types";

const read = <T,>(file: string): T => JSON.parse(readFileSync(new URL(`../public/${file}`, import.meta.url), "utf8"));
const root = "data/lvn-2026-12-01-120d/";
const manifest = read<Manifest>(`${root}manifest.json`);
const catalog = read<Catalog>(`${root}catalog.json`);
checkCatalog(manifest, catalog);
const times = manifestTimes(manifest);
const files = manifest.sites.map((s) => read<SiteData>(`${root}${s.file}`));
const DS: Dataset = {
  manifest,
  catalog,
  times,
  sites: files.map((d, k) => checkSiteFile(manifest, catalog.sites.find((c) => c.id === manifest.sites[k].id)!, d, times)),
};
const ALL = manifest.sites.map((s) => s.id).join(",");
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&gt;/g, ">").replace(/\s+/g, " ");

function FinderHarness({ search }: { search: string }) {
  const sc = useScenario(DS, search);
  return <ArrivalFinder sc={sc} open onClose={() => {}} />;
}

describe("entry points", () => {
  it("both views offer Find arrival windows near mission setup; the drawer is not rendered until opened", () => {
    for (const view of ["analysis", "explore"]) {
      const html = renderToStaticMarkup(<Workspace ds={DS} search={`?ds=${manifest.dataset_id}&sites=${ALL}&view=${view}`} />);
      expect(html).toContain('data-testid="find-windows"');
      expect(html).toContain("Find arrival windows");
      expect(html).not.toContain('data-testid="arrival-finder"');
    }
  });
});

describe("third-party notices", () => {
  it("Analysis links the shipped notices file (relative, works under any base path)", () => {
    const html = renderToStaticMarkup(<Workspace ds={DS} search={`?ds=${manifest.dataset_id}&sites=${ALL}&view=analysis`} />);
    expect(html).toContain('href="THIRD_PARTY_LICENSES.md"');
    expect(text(html)).toContain("Third-party software notices");
  });
});

describe("drawer inputs start from the scenario but are separate from it", () => {
  const html = renderToStaticMarkup(<FinderHarness search={`?arrival=2026-12-20T05:00Z&days=10&delay=3&sites=${ALL}&site=apollo17-lm&horizon=terrain`} />);
  const t = text(html);
  it("duration and hour come from the scenario; dates span every valid arrival", () => {
    expect(html).toMatch(/data-testid="finder-days"[^>]*value="10"|value="10"[^>]*data-testid="finder-days"/);
    expect(t).toContain("Checks arrivals daily at 05:00 UTC. Results are the best among the evaluated dates, not a continuous-time optimum.");
    expect(t).toContain("Candidate spacing: 1 day.");
    expect(html).toContain('value="2026-12-01"');
    expect(html).toContain('value="2027-03-20"'); // 10 d from 03-20 05:00 ends 03-30 05:00; 03-21 05:00 would end after 03-31 00:00
    expect(t).toContain("Most simultaneous Sun + Earth availability (default)");
    expect(t).toContain("Only the active site (Apollo 17)");
    expect(t).toContain("Model: Terrain for every site");
    expect(t).toContain("Screening limits (optional): off");
    expect(html).not.toContain('data-testid="finder-results"');
  });
  it("offers every site of the dataset, marking which are compared, without changing the comparison", () => {
    const two = renderToStaticMarkup(<FinderHarness search={`?ds=${manifest.dataset_id}&sites=im2-athena,apollo17-lm&site=im2-athena&horizon=terrain`} />);
    const tt = text(two);
    for (const id of manifest.sites.map((x) => x.id)) expect(two).toContain(`data-finder-site="${id}"`);
    expect(tt).toContain("Athena · compared");
    expect(tt).toContain("CR1 · not compared");
    expect(tt).toContain("Odysseus · not compared");
    expect(tt).toContain("searching does not add it to the comparison");
  });
});

// ------------------------------------------------------------ formatting reproduction (Athena 2027-01-14, 14 d, Terrain)

describe("rounding never hides a nonzero difference (reported case)", () => {
  const athena = files.find((d) => d.site.id === "im2-athena")!;
  const iv = parseIntervals(athena, athena.terrain_horizon!.visibility_intervals);
  const a = Date.parse("2027-01-14T00:00:00Z");
  const m = computeMetrics(iv, { start: a, end: a + 14 * DAY_MS });
  it("the finder values are unrounded: Sun < 100 % with a short blockage", () => {
    expect(m.sunPct.ok && m.sunPct.value).toBeLessThan(100);
    expect(m.sunPct.ok && m.sunPct.value).toBeGreaterThan(99.9);
    expect(m.longestDark.ok && m.longestDark.value!.durationMs).toBeLessThan(HOUR_MS);
    expect(fmtPct((m.sunPct as { value: number }).value)).toBe(">99.9 %");
    expect(fmtOutage(m.longestDark.ok ? m.longestDark.value!.durationMs : 0)).toMatch(/^\d+ min$/);
    // a limit of 100 % fails on the unrounded value; 99.9 % passes
    const row = { siteId: "im2-athena", arrival: a, end: a + 14 * DAY_MS, m };
    expect(limitOutcomes(row, { ...NO_LIMITS, minSunPct: 100 })[0].state).toBe("fail");
    expect(limitOutcomes(row, { ...NO_LIMITS, minSunPct: 99.9 })[0].state).toBe("pass");
  });
  it("Analysis shows the same bounded and minute formats", () => {
    const html = renderToStaticMarkup(<Workspace ds={DS} search={`?ds=${manifest.dataset_id}&arrival=2027-01-14T00:00Z&days=14&delay=0&horizon=terrain&sites=${ALL}&site=im2-athena&view=analysis`} />);
    const card = html.slice(html.indexOf('<article class="card site-compare active-site" data-site="im2-athena"'));
    const row = (f: string) => text(card.slice(card.indexOf(`data-field="${f}"`), card.indexOf("</tr>", card.indexOf(`data-field="${f}"`))));
    expect(row("sun")).toContain(">99.9 %");
    expect(row("sun")).not.toContain("100.0 %");
    expect(row("dark")).toContain(fmtOutage(m.longestDark.ok ? m.longestDark.value!.durationMs : 0));
  });
});

// ------------------------------------------------------------ delay preview equals Analysis (Athena, 14 d, 2026-12-16 00:00)

describe("delay preview equals Analysis for the same scenario", () => {
  const athena = files.find((d) => d.site.id === "im2-athena")!;
  const iv = parseIntervals(athena, athena.terrain_horizon!.visibility_intervals);
  const a = Date.parse("2026-12-16T00:00:00Z");
  const cov = { start: Date.parse(manifest.coverage_start_utc), end: Date.parse(manifest.coverage_end_utc) };
  const preview = delayPreview(iv, a, 14 * DAY_MS, cov, NO_LIMITS, "im2-athena");
  it("covers the chosen arrival and +1/+3/+7 d, all within coverage here", () => {
    expect(preview.map((p) => [p.days, p.enabled])).toEqual([[0, true], [1, true], [3, true], [7, true]]);
  });
  for (const d of [1, 3, 7]) {
    it(`+${d} d matches the Analysis delayed column`, () => {
      const p = preview.find((x) => x.days === d)!;
      const base = preview[0];
      const html = renderToStaticMarkup(<Workspace ds={DS} search={`?ds=${manifest.dataset_id}&arrival=2026-12-16T00:00Z&days=14&delay=${d}&horizon=terrain&sites=${ALL}&site=im2-athena&view=analysis`} />);
      const card = html.slice(html.indexOf('<article class="card site-compare active-site" data-site="im2-athena"'));
      const cells = (f: string) => {
        const i = card.indexOf(`<tr data-field="${f}"`);
        const tr = card.slice(i, card.indexOf("</tr>", i));
        return [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => text(x[1]).trim());
      };
      const pct = (a: { ok: boolean; value?: number }) => fmtPct(a.value!);
      const blk = (r: { ok: boolean; value?: { durationMs: number; touchesStart: boolean; touchesEnd: boolean } | null }) =>
        r.value ? `${fmtOutage(r.value.durationMs)}${r.value.touchesStart || r.value.touchesEnd ? " ⚠" : ""}` : "None in window";
      for (const [f, k] of [["sun", "sunPct"], ["earth", "earthPct"], ["both", "bothPct"]] as const) {
        expect(cells(f)[0]).toBe(pct(base.m![k]));
        expect(cells(f)[1]).toBe(pct(p.m![k]));
      }
      expect(cells("dark")[0]).toBe(blk(base.m!.longestDark));
      expect(cells("dark")[1]).toBe(blk(p.m!.longestDark));
      expect(cells("earth-block")[1]).toBe(blk(p.m!.longestEarthBlock));
    });
  }
});

describe("an applied result matches Analysis for the same window", () => {
  const sites = files.map((d) => ({ id: d.site.id, intervals: parseIntervals(d, d.terrain_horizon!.visibility_intervals) }));
  const c = checkInputs({ siteIds: sites.map((s) => s.id), days: 14, fromDate: "2026-12-01", toDate: "2027-03-17", hour: 0 }, commonCoverage(sites)!);
  if (!c.ok) throw new Error(c.problems.join(" "));
  const v = resultView(evaluate(sites, c.arrivals, c.durationMs), "both", NO_LIMITS);
  const top = v.ranking.ranked[0];
  const second = v.ranking.ranked.find((r) => r.siteId !== top.siteId)!;

  for (const r of [top, second]) {
    it(`${r.siteId} at ${new Date(r.arrival).toISOString()}`, () => {
      // the URL state written by applyArrival: delay 0 (baseline), the site active, same sites/model
      const q = `?ds=${manifest.dataset_id}&arrival=${new Date(r.arrival).toISOString()}&days=14&delay=0&mission=baseline&t=${new Date(r.arrival).toISOString()}&horizon=terrain&sites=${ALL}&site=${r.siteId}&view=analysis`;
      const html = renderToStaticMarkup(<Workspace ds={DS} search={q} />);
      const card = html.slice(html.indexOf(`<article class="card site-compare active-site" data-site="${r.siteId}"`));
      const cell = (field: string) => text(card.slice(card.indexOf(`data-field="${field}"`), card.indexOf("</tr>", card.indexOf(`data-field="${field}"`))));
      expect(cell("sun")).toContain(fmtPct(metricValue(r, "sun")!));
      expect(cell("earth")).toContain(fmtPct(metricValue(r, "earth")!));
      expect(cell("both")).toContain(fmtPct(metricValue(r, "both")!));
      const hrs = (x: number) => (x === 0 ? "None in window" : fmtOutage(x * HOUR_MS));
      expect(cell("dark")).toContain(hrs(metricValue(r, "sunBlock")!));
      expect(cell("earth-block")).toContain(hrs(metricValue(r, "earthBlock")!));
    });
  }
});
