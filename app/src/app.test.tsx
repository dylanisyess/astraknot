// Server-side render of the real Workspace with the exported data (no DOM library needed).
// Checks per-site content, leakage between sites, URL restoration and model consistency.
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Workspace } from "./App";
import { checkSites } from "./data";
import { terrainProblem } from "./horizon";
import type { Dataset, Manifest, SiteData } from "./types";

const dataDir = new URL("../public/data/", import.meta.url);
const readJson = <T,>(name: string): T => JSON.parse(readFileSync(new URL(name, dataDir), "utf-8")) as T;

function dataset(mutate?: (files: SiteData[]) => void): Dataset {
  const manifest = readJson<Manifest>("manifest.json");
  const files = manifest.sites.map((e) => readJson<SiteData>(e.file));
  mutate?.(files);
  const times = checkSites(manifest, files);
  return {
    manifest,
    times,
    sites: files.map((d, k) => {
      const p = terrainProblem(d);
      if (p) delete d.terrain_horizon;
      return { id: manifest.sites[k].id, data: d, terrainProblem: p };
    }),
  };
}
const DS = dataset();
const render = (search: string, ds = DS) => renderToStaticMarkup(<Workspace ds={ds} search={search} />);

/** Inner HTML of the first element with data-site=id and the given tag (cards are <article>). */
function block(html: string, tag: string, id: string): string {
  const start = html.indexOf(`<${tag} class`, 0);
  let i = html.indexOf(`data-site="${id}"`, start);
  while (i >= 0) {
    const open = html.lastIndexOf(`<${tag}`, i);
    if (open >= 0 && html.slice(open, i).indexOf(">") < 0) {
      const close = html.indexOf(`</${tag}>`, i);
      return html.slice(open, close);
    }
    i = html.indexOf(`data-site="${id}"`, i + 1);
  }
  throw new Error(`no <${tag}> for ${id}`);
}
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");

const ATHENA_ONLY = ["Athena", "LROC", "Mons Mouton", "im2-athena", "0.0034", "2026-12-30"];
const CR1_ONLY = ["CR1", "Connecting", "notional", "ACD-50044", "0.0235", "Provisional", "5 m terrain assessment"];

describe("two-site comparison render (default terrain, baseline 2026-12-05, +3 d)", () => {
  const html = render("?arrival=2026-12-05T00:00Z&days=14&delay=3&horizon=terrain");
  const athena = text(block(html, "article", "im2-athena"));
  const cr1 = text(block(html, "article", "connecting-ridge-cr1"));

  it("shows both cards with their exported reference metrics for identical windows", () => {
    expect(athena).toContain("27.2 %"); // baseline Sun, terrain (pipeline 27.232...)
    expect(athena).toContain("67.3 %"); // baseline Earth
    expect(athena).toContain("244.5 h");
    expect(cr1).toContain("72.1 %");
    expect(cr1).toContain("25.4 %");
    expect(cr1).toContain("62.8 h");
    expect(cr1).toContain("59.9 %"); // +3 d Sun
    expect(cr1).toContain("134.8 h"); // +3 d darkness
    for (const c of [athena, cr1]) {
      expect(c).toContain("Delay +3 d");
      expect(c).toContain("Change: +3 d vs baseline");
    }
    expect(text(html)).toContain("2026-12-05 00:00 UTC → 2026-12-19 00:00 UTC");
    expect(text(html)).toContain("2026-12-08 00:00 UTC → 2026-12-22 00:00 UTC");
  });

  it("labels CR1 as required, marks it provisional next to its metrics and names the 20 m model", () => {
    expect(cr1).toContain("Connecting Ridge CR1 — NASA notional study point");
    expect(cr1).toContain("Provisional: sensitive to terrain model");
    expect(cr1).toContain("20 m LOLA model (LDEM_80S_20M");
    expect(cr1).toContain("5 m terrain assessment (comparison only; not the displayed model)");
    expect(cr1).toContain("non-statistical illustration");
    expect(cr1).toContain("not offered as selectable models");
    expect(cr1.indexOf("Provisional")).toBeLessThan(cr1.indexOf("Sun center visible"));
  });

  it("does not leak site-specific text between cards", () => {
    for (const w of CR1_ONLY) expect(athena).not.toContain(w);
    for (const w of ATHENA_ONLY) expect(cr1).not.toContain(w);
  });

  it("never claims an overall best site", () => {
    expect(text(html)).toMatch(/do not rank the sites/);
    expect(text(html)).not.toMatch(/best (landing )?site(?! overall)/i);
  });

  it("panorama-side content belongs to the active site (Athena by default)", () => {
    expect(block(html, "div", "im2-athena")).toBeTruthy();
    const facts = text(block(html, "details", "im2-athena"));
    expect(facts).toContain("0.0034");
    for (const w of CR1_ONLY) expect(facts).not.toContain(w);
  });
});

describe("switching the active site", () => {
  const html = render("?horizon=terrain&site=connecting-ridge-cr1");
  it("readouts, panorama notes and facts come from CR1 only", () => {
    const facts = text(block(html, "details", "connecting-ridge-cr1"));
    expect(facts).toContain("0.0235");
    expect(facts).toContain("provisional: sensitive to terrain model");
    for (const w of ATHENA_ONLY) expect(facts).not.toContain(w);
    const shift = text(block(html, "div", "connecting-ridge-cr1"));
    for (const w of ATHENA_ONLY) expect(shift).not.toContain(w);
    expect(html).toContain('data-testid="site-shift" data-site="connecting-ridge-cr1"');
    expect(html).not.toContain('data-testid="site-shift" data-site="im2-athena"');
    expect(html).not.toContain("im2-athena_terrain_horizon.json");
  });
  it("panorama axis caption follows each site's centre azimuth", () => {
    expect(text(html)).toContain("azimuth (NW at both edges, SE in the middle)");
    expect(text(render("?horizon=terrain"))).toContain("azimuth (S at both edges, N in the middle)");
  });
  it("keeps the same scenario and cards for both sites", () => {
    const a = render("?arrival=2026-12-08T00:00Z&days=10&delay=1&horizon=terrain&site=im2-athena");
    const b = render("?arrival=2026-12-08T00:00Z&days=10&delay=1&horizon=terrain&site=connecting-ridge-cr1");
    const cards = (h: string) => ["im2-athena", "connecting-ridge-cr1"].map((id) => text(block(h, "article", id)).replace(/Shown in panorama|Show in panorama/g, ""));
    expect(cards(a)).toEqual(cards(b));
  });
});

describe("URL restoration and model consistency", () => {
  it("restores selected sites, active site and scenario", () => {
    const html = text(render("?arrival=2026-12-10T06:00Z&days=10&delay=7&horizon=smooth&sites=connecting-ridge-cr1&site=connecting-ridge-cr1"));
    expect(html).toContain("2026-12-10 06:00 UTC → 2026-12-20 06:00 UTC");
    expect(html).toContain("2026-12-17 06:00 UTC → 2026-12-27 06:00 UTC");
    expect(html).toContain("Smooth 0° horizon (terrain ignored)");
    expect(html).not.toContain("27.2 %");
    expect(render("?sites=connecting-ridge-cr1")).not.toContain('<article class="card site-compare active-site" data-site="im2-athena"');
  });

  it("an old Athena link works and shows Athena in the panorama", () => {
    const html = render("?arrival=2026-12-05T00:00Z&days=14&delay=3&t=2026-12-06T00:00:00Z&horizon=terrain");
    expect(html).toContain('class="card site-compare active-site" data-site="im2-athena"');
    expect(text(html)).toContain("2026-12-06 00:00 UTC");
  });

  it("Provisional label is shown in Terrain mode only", () => {
    expect(text(render("?horizon=smooth"))).not.toContain("Provisional: sensitive to terrain model");
  });

  it("if one site lacks terrain, every site is shown with the smooth model (never mixed)", () => {
    const ds = dataset((f) => {
      delete f[1].terrain_horizon;
    });
    const html = render("?horizon=terrain", ds);
    const t = text(html);
    expect(t).toContain("Terrain horizon requested but not available for connecting-ridge-cr1");
    expect(text(block(html, "article", "im2-athena"))).toContain("Smooth 0° horizon (terrain ignored)");
    expect(text(block(html, "article", "connecting-ridge-cr1"))).toContain("Smooth 0° horizon (terrain ignored)");
    expect(text(block(html, "article", "im2-athena"))).toContain("43.4 %"); // Athena smooth baseline Sun
  });

  it("delays that leave the common coverage are disabled (latest arrival)", () => {
    const t = text(render("?arrival=2027-01-16T00:00Z&days=14&delay=7&horizon=terrain"));
    expect(t).toContain("+7 d no longer fits the data with this arrival; showing the baseline only.");
    expect(t).not.toContain("Change: +7 d vs baseline");
  });
});
