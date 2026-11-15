// Server-side render of the real Workspace with the exported data (no DOM library needed).
// Checks per-site content, leakage between sites, URL restoration and model consistency.
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Workspace } from "./App";
import { checkSites } from "./data";
import { terrainProblem } from "./horizon";
import type { Catalog, Dataset, Manifest, SiteData } from "./types";

const dataDir = new URL("../public/data/", import.meta.url);
const readJson = <T,>(name: string): T => JSON.parse(readFileSync(new URL(name, dataDir), "utf-8")) as T;

function dataset(mutate?: (files: SiteData[]) => void): Dataset {
  const manifest = readJson<Manifest>("manifest.json");
  const files = manifest.sites.map((e) => readJson<SiteData>(e.file));
  mutate?.(files);
  const times = checkSites(manifest, files);
  return {
    manifest,
    catalog: readJson<Catalog>("catalog.json"),
    times,
    sites: files.map((d, k) => {
      const p = terrainProblem(d);
      if (p) delete d.terrain_horizon;
      return { id: manifest.sites[k].id, data: d, terrainProblem: p };
    }),
  };
}
const DS = dataset();
// These tests cover the Analysis dashboard. Explore is the default view since milestone 5A,
// so the dashboard is requested explicitly; the scenario parameters are unchanged.
const render = (search: string, ds = DS) =>
  renderToStaticMarkup(<Workspace ds={ds} search={`${search || "?"}${search.includes("?") && search.length > 1 ? "&" : ""}view=analysis`} />);

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

  it("if one site lacks terrain, Terrain is never mixed: it shows no results and a common Smooth comparison is offered", () => {
    const ds = dataset((f) => {
      delete f[1].terrain_horizon;
    });
    const html = render("?horizon=terrain", ds);
    const t = text(html);
    // explicit explanation naming the site, and an explicit Smooth offer (no automatic fallback)
    expect(html).toContain('data-testid="mixed-terrain"');
    expect(t).toMatch(/Terrain comparison is unavailable for this set: CR1 has no terrain horizon/);
    expect(t).toContain("Compare all 2 sites with the Smooth model");
    // Athena keeps its terrain result; CR1 shows no metrics at all (never smooth values in Terrain mode)
    expect(text(block(html, "article", "im2-athena"))).toContain("Terrain: 20 m LOLA model");
    expect(text(block(html, "article", "im2-athena"))).toContain("27.2 %"); // Athena terrain baseline Sun
    expect(text(block(html, "article", "im2-athena"))).not.toContain("43.4 %"); // ...not its smooth value
    const cr1 = text(block(html, "article", "connecting-ridge-cr1"));
    expect(cr1).toContain("CR1: no terrain horizon");
    expect(cr1).not.toMatch(/\d+\.\d %/);
    // the explicit common Smooth comparison shows every site with the smooth model
    const sm = render("?horizon=smooth", ds);
    expect(text(block(sm, "article", "im2-athena"))).toContain("Smooth 0° horizon (terrain ignored)");
    expect(text(block(sm, "article", "connecting-ridge-cr1"))).toContain("Smooth 0° horizon (terrain ignored)");
    expect(text(block(sm, "article", "im2-athena"))).toContain("43.4 %");
    expect(sm).not.toContain('data-testid="mixed-terrain"');
  });

  it("the active site lacking terrain in Terrain mode: an explanation, no other site's data", () => {
    const ds = dataset((f) => {
      delete f[1].terrain_horizon;
    });
    const html = render("?horizon=terrain&site=connecting-ridge-cr1&view=explore", ds);
    expect(html).toContain('data-testid="active-pending"');
    expect(html).toContain('data-state="no-terrain"');
    expect(html).not.toContain('id="explore"'); // no 3D view of another site in its place
    expect(text(html)).not.toContain("Athena landing point"); // only the chip's short name
  });

  it("delays that leave the common coverage are disabled (latest arrival)", () => {
    const t = text(render("?arrival=2027-01-16T00:00Z&days=14&delay=7&horizon=terrain"));
    expect(t).toContain("+7 d no longer fits the data with this arrival; showing the baseline only.");
    expect(t).not.toContain("Change: +7 d vs baseline");
  });
});

describe("selected-time status is consistent across cards, readouts and panorama", () => {
  // Athena terrain, Earth at 2026-12-09 14:00 UTC: the step is visible at its midpoint while the
  // center is 0.00012 deg below the skyline at 14:00 itself (science review disagreement case).
  const html = render("?arrival=2026-12-05T00:00Z&days=14&delay=3&horizon=terrain&t=2026-12-09T14:00:00Z");
  const t = text(html);

  it("the card keeps the interval state and adds the shared qualifier", () => {
    const card = text(block(html, "article", "im2-athena"));
    expect(card).toMatch(/At 2026-12-09 14:00 UTC: Sun Not visible , Earth Visible \(near estimated crossing\)/);
    expect(text(block(html, "article", "connecting-ridge-cr1"))).not.toContain("near estimated crossing");
  });

  it("readouts and panorama show the same explanation, with the true clearance", () => {
    const why =
      "Near estimated crossing: the 10-minute step 2026-12-09 14:00 UTC–14:10 is classified visible at its midpoint (14:05 UTC), " +
      "but at 14:00 UTC the Earth’s center is 0.00012° below the skyline.";
    expect(t.split(why).length - 1).toBe(2); // once in the readouts, once in the panorama summary
    expect(html).toContain('data-field="clearance">−0.00012°');
    expect(html).toContain("visible · near estimated crossing · −0.00012° vs skyline");
    expect(html).toContain("marker-near-ring");
    expect(html).toMatch(/data-body="earth" data-state="below" data-visible="true" data-near="true"/);
  });

  it("an ordinary time has no qualifier anywhere", () => {
    const plain = render("?arrival=2026-12-05T00:00Z&days=14&delay=3&horizon=terrain&t=2026-12-09T15:00:00Z");
    // (the method text and panorama caption explain the term; no status element uses it)
    expect(plain).not.toContain("marker-near-ring");
    expect(plain).not.toContain("data-near=");
    expect(plain).not.toContain("state-near");
    expect(plain).not.toContain("(near estimated crossing)");
    expect(plain).not.toContain("Near estimated crossing: the 10-minute step");
  });

  it("CR1 Sun and smooth-mode cases use the same wording", () => {
    const cr1 = render("?arrival=2026-12-20T00:00Z&days=14&delay=0&horizon=terrain&site=connecting-ridge-cr1&t=2026-12-24T00:00:00Z");
    expect(text(block(cr1, "article", "connecting-ridge-cr1"))).toContain("Sun Visible (near estimated crossing)");
    expect(text(cr1)).toContain("but at 00:00 UTC the Sun’s center is 0.0015° below the skyline");
    const smooth = render("?arrival=2026-12-05T00:00Z&days=14&delay=3&horizon=smooth&t=2026-12-11T05:00:00Z");
    expect(text(smooth)).toContain("but at 05:00 UTC the Earth’s center is 0.00005° below the 0° horizon");
  });

  it("the final sample of the data is Unknown everywhere, with the reason", () => {
    const end = text(render("?arrival=2027-01-16T00:00Z&days=14&delay=0&horizon=terrain&t=2027-01-30T00:00:00Z"));
    expect(end).toContain("At 2027-01-30 00:00 UTC: Sun Unknown , Earth Unknown");
    expect(end).toContain("Unknown: final sample of the data (no 10-minute step starts here).");
    expect(end).toMatch(/Earth: final sample of the data \(no 10-minute step starts here\); center [\d.]+° (above|below) the skyline/);
  });
});

describe("scientific wording", () => {
  const t = text(render("?horizon=terrain"));
  it("states that visibility uses the centers of both the Sun and Earth", () => {
    expect(t).toContain("Visibility uses the center of both the Sun and Earth. Part of either disk may remain visible when its center is hidden");
    expect(t).toContain("This applies to both the Sun and Earth: part of either disk can still be above the skyline when its center is hidden.");
    expect(t).not.toContain("no partial-disk Sun");
  });
  it("describes 10 minutes as sampling and reporting resolution, not guaranteed accuracy", () => {
    expect(t).toContain("10 minutes is the sampling and reporting resolution, not a guaranteed accuracy of event times.");
    expect(t).not.toContain("10-minute resolution)");
  });
  it("keeps CR1 provisional and the coordinate-frame limitation", () => {
    expect(t).toContain("Provisional: sensitive to terrain model");
    expect(t).toContain("the lunar ME/DE421 frame is assumed");
  });
  it("shows a site-neutral dataset identifier", () => {
    expect(t).toMatch(/Dataset lvn-2026-12-01-60d/);
    expect(t).not.toContain("m2-athena-2026");
  });
});

describe("panorama cardinal directions", () => {
  // Azimuth increases to the right (E right of N, as when facing north); ticks run edge to edge.
  const ticks = (h: string) => [...h.matchAll(/class="tick(?: tick-major)?" x="[\d.]+" y="[\d.]+" text-anchor="middle">([A-Z]+)</g)].map((m) => m[1]);
  it("Athena (north centred): S, SW, W, NW, N, NE, E, SE, S", () => {
    expect(ticks(render("?horizon=terrain"))).toEqual(["S", "SW", "W", "NW", "N", "NE", "E", "SE", "S"]);
  });
  it("CR1 (south-east centred): NW, N, NE, E, SE, S, SW, W, NW", () => {
    expect(ticks(render("?horizon=terrain&site=connecting-ridge-cr1"))).toEqual(["NW", "N", "NE", "E", "SE", "S", "SW", "W", "NW"]);
  });
});
