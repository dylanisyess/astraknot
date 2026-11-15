// Explore / Analysis shell, server-rendered with the real exported data (no WebGL needed:
// the 3D scene is lazy, so these renders contain the scene's loading fallback).
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Workspace } from "../App";
import { checkSites } from "../data";
import { terrainProblem } from "../horizon";
import { type ReadyScenario, useScenario } from "../scenario";
import type { Catalog, Dataset, Manifest, SiteData } from "../types";
import { parseUrlState, writeUrlState } from "../urlState";
import Explore, { type ExploreProps, MissionSummary, timelineSpan } from "./Explore";

const dataDir = new URL("../../public/data/", import.meta.url);
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
const shell = (search: string) => renderToStaticMarkup(<Workspace ds={DS} search={search} />);
function Harness({ search, ...rest }: { search: string } & Omit<ExploreProps, "sc">) {
  const sc = useScenario(DS, search) as ReadyScenario;
  return <Explore sc={sc} {...rest} />;
}
const explore = (search: string, rest: Omit<ExploreProps, "sc"> = {}) => renderToStaticMarkup(<Harness search={search} {...rest} />);
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").replace(/\s+/g, " ");
/** The status panel's markup (from its opening tag to the end of its section). */
function statusPanel(html: string): string {
  const i = html.indexOf('data-testid="status-panel"');
  const open = html.lastIndexOf("<section", i);
  return html.slice(open, html.indexOf("</section>", i));
}

const DEMO = "?arrival=2026-12-05T00:00Z&days=14&delay=3&horizon=terrain";

describe("Explore is the default view; Analysis stays available", () => {
  it("opens Explore when no view is given (old links included)", () => {
    const h = shell(DEMO + "&t=2026-12-06T00:00:00Z");
    expect(h).toContain('data-view="explore"');
    expect(h).toContain('id="explore"');
    expect(h).toContain('data-view-tab="analysis"');
    expect(h).not.toContain("Shared mission scenario");
  });
  it("opens Analysis with view=analysis, with the full dashboard", () => {
    const h = shell(DEMO + "&view=analysis");
    expect(h).toContain('data-view="analysis"');
    expect(h).toContain("Shared mission scenario");
    expect(h).toContain('class="card site-compare');
    expect(h).toContain('data-view-tab="explore"');
  });
  it("a malformed view falls back to Explore", () => {
    expect(parseUrlState("?view=3d").view).toBeNull();
    expect(shell(DEMO + "&view=3d")).toContain('data-view="explore"');
  });
});

describe("shared scenario state across views and URL restoration", () => {
  const q = "?arrival=2026-12-10T06:00Z&days=10&delay=7&horizon=smooth&sites=im2-athena,connecting-ridge-cr1&site=connecting-ridge-cr1&t=2026-12-18T12:00:00Z";
  const ex = text(shell(q + "&view=explore"));
  const an = text(shell(q + "&view=analysis"));
  it("both views show the same windows, selected time, site and model", () => {
    for (const t of [ex, an]) {
      expect(t).toContain("2026-12-18 12:00 UTC");
      expect(t).toContain("Connecting Ridge CR1");
    }
    // Explore: the active (delayed) mission in the summary, both windows on the timeline
    expect(ex).toContain("Delay +7 d: 2026-12-17 06:00 → 12-27 06:00 UTC");
    expect(ex).toContain("Baseline arrival 12-10 06:00");
    expect(ex).toContain("+7 d arrival 12-17 06:00");
    expect(an).toContain("2026-12-10 06:00 UTC → 2026-12-20 06:00 UTC");
    expect(an).toContain("2026-12-17 06:00 UTC → 2026-12-27 06:00 UTC");
    expect(ex).toContain("Smooth model · 0° horizontal reference, terrain ignored");
    expect(an).toContain("Smooth 0° horizon (terrain ignored)");
  });
  it("status words agree between Explore and the Analysis readouts", () => {
    const exState = [...statusPanel(shell(q)).matchAll(/data-body="(sun|earth)" data-state="(on|off|unknown)"/g)].map((m) => `${m[1]}:${m[2]}`);
    const anHtml = shell(q + "&view=analysis");
    const word = (b: string) => {
      const i = anHtml.indexOf(`class="readout" data-body="${b}"`);
      return anHtml.slice(i, i + 600).match(/data-field="state">([^<]+)</)![1];
    };
    const map: Record<string, string> = { on: "Visible", off: "Not visible", unknown: "Unknown" };
    expect(exState).toHaveLength(2);
    for (const s of exState) {
      const [b, st] = s.split(":");
      expect(word(b)).toBe(map[st]);
    }
  });
  it("the written URL carries the view and restores the same scenario", () => {
    const u = writeUrlState(new URL("http://x/"), {
      arrival: Date.parse("2026-12-10T06:00:00Z"), days: 10, delay: 7, t: "2026-12-18T12:00:00Z",
      horizon: "smooth", sites: ["im2-athena", "connecting-ridge-cr1"], site: "connecting-ridge-cr1", view: "analysis",
    });
    expect(parseUrlState(u.search)).toMatchObject({ view: "analysis", site: "connecting-ridge-cr1", delay: 7, days: 10, horizon: "smooth" });
    expect(text(shell(u.search))).toContain("Shared mission scenario");
  });
});

describe("camera mode never changes scientific status or metrics", () => {
  for (const t of ["2026-12-09T14:00:00Z", "2026-12-16T06:00:00Z"]) {
    it(`identical status panel and metrics in overview and observer view (${t})`, () => {
      const a = explore(`${DEMO}&t=${t}&cam=overview`);
      const b = explore(`${DEMO}&t=${t}&cam=horizon`);
      expect(statusPanel(a)).toBe(statusPanel(b));
      const metrics = (h: string) => h.slice(h.indexOf('data-field="metrics"'), h.indexOf("</section>", h.indexOf('data-field="metrics"')));
      expect(metrics(a)).toBe(metrics(b));
      expect(a).toContain('data-camera="overview"');
      expect(b).toContain('data-camera="eye"');
    });
  }
});

describe("site switching shows one site's data only", () => {
  const ATHENA_ONLY = ["Athena", "84.7906", "im2-athena"];
  const CR1_ONLY = ["CR1", "89.4680", "connecting-ridge-cr1", "Provisional"];
  it("CR1 active: CR1 status, coordinates and provisional badge, nothing from Athena in the status panel", () => {
    const h = shell(DEMO + "&site=connecting-ridge-cr1");
    const sp = statusPanel(h);
    expect(sp).toContain('data-site="connecting-ridge-cr1"');
    for (const w of ATHENA_ONLY) expect(sp).not.toContain(w);
    expect(h).toContain('data-field="provisional"');
    expect(text(h)).toContain("Provisional: sensitive to terrain model");
    expect(h).toContain('<main class="explore" id="explore" data-site="connecting-ridge-cr1"');
  });
  it("Athena active: no CR1 content in the status panel and no provisional badge", () => {
    const h = shell(DEMO + "&site=im2-athena");
    const sp = statusPanel(h);
    expect(sp).toContain('data-site="im2-athena"');
    for (const w of CR1_ONLY) expect(sp).not.toContain(w);
    expect(h).not.toContain('data-field="provisional"');
  });
  it("activating a site that is not compared adds it (the scenario keeps a valid active site)", () => {
    const h = shell(DEMO + "&sites=im2-athena&site=connecting-ridge-cr1");
    expect(statusPanel(h)).toContain('data-site="im2-athena"'); // the URL asked for a non-compared site
  });
});

describe("near-crossing and endpoint behavior in Explore", () => {
  it("keeps the interval state, adds the shared qualifier and the same explanation as Analysis", () => {
    const q = `${DEMO}&t=2026-12-09T14:00:00Z`;
    const sp = text(statusPanel(shell(q)));
    const why =
      "Near estimated crossing: the 10-minute step 2026-12-09 14:00 UTC–14:10 is classified visible at its midpoint (14:05 UTC), " +
      "but at 14:00 UTC the Earth’s center is 0.00012° below the skyline.";
    expect(sp).toContain(why);
    expect(statusPanel(shell(q))).toMatch(/data-body="earth" data-state="on" data-near="true"/);
    expect(text(shell(q + "&view=analysis"))).toContain(why);
  });
  it("an ordinary time has no qualifier", () => {
    const sp = statusPanel(shell(`${DEMO}&t=2026-12-09T15:00:00Z`));
    expect(sp).not.toContain("data-near");
    expect(sp).not.toContain("Near estimated crossing");
  });
  it("the final sample is Unknown with its reason, and playback cannot start there", () => {
    const h = shell("?arrival=2027-01-16T00:00Z&days=14&delay=0&horizon=terrain&t=2027-01-30T00:00:00Z");
    const sp = text(statusPanel(h));
    expect(sp).toContain("Unknown: final sample of the data (no 10-minute step starts here).");
    expect(statusPanel(h)).toMatch(/data-body="sun" data-state="unknown"/);
    expect(h).toMatch(/<button type="button" class="play-btn" disabled="" aria-pressed="false" title="At the end of the data" data-testid="play">/);
    expect(h).toMatch(/data-testid="step-fwd" disabled=""|disabled="" aria-label="Forward 10 minutes"/);
  });
  it("selected time and baseline arrival are shown separately", () => {
    const t = text(shell(`${DEMO}&t=2026-12-11T03:20:00Z`));
    expect(t).toContain("Viewing time 2026-12-11 03:20 UTC");
    expect(t).toContain("Baseline arrival 12-05 00:00");
    expect(t).toContain("+3 d arrival 12-08 00:00");
    // one primary selected-time readout: not repeated in the conditions panel
    expect(text(statusPanel(shell(`${DEMO}&t=2026-12-11T03:20:00Z`)))).not.toContain("2026-12-11 03:20 UTC");
  });
});

describe("loading and renderer failure keep status and Analysis available", () => {
  it("before the renderer loads, status, controls and the Analysis tab are already present", () => {
    const h = shell(DEMO);
    expect(h).toContain("Loading 3D renderer…");
    expect(h).toContain('data-testid="status-panel"');
    expect(h).toContain('data-testid="scrubber"');
    expect(h).toContain('data-view-tab="analysis"');
    expect(h).toContain('data-testid="asset-loading"');
  });
  it("a WebGL failure shows a clear message with a way to Analysis; status still renders", () => {
    const h = explore(DEMO, { initialFatal: "WebGL could not be started (test)." });
    const t = text(h);
    expect(h).toContain('data-testid="scene-fatal"');
    expect(t).toContain("The 3D view is unavailable.");
    expect(t).toContain("WebGL could not be started (test).");
    expect(t).toContain("Open Analysis");
    expect(h).toContain('data-testid="status-panel"');
    expect(h).not.toContain("Loading 3D renderer…");
  });
  it("smooth mode states its 0° assumption on the stage only after terrain is ready (not during loading)", () => {
    // during loading the stage shows the loading toast; the status panel already states the model
    const h = shell("?horizon=smooth");
    expect(text(statusPanel(h))).toContain("Smooth model · 0° horizontal reference, terrain ignored");
  });
});

describe("power and communications framing (milestone 5B)", () => {
  it("names solar-power potential and direct-to-Earth communication, from selectedTimeStatus", () => {
    const sp = text(statusPanel(shell(`${DEMO}&t=2026-12-16T06:00:00Z`)));
    expect(sp).toContain("Solar-power potential");
    expect(sp).toContain("Direct sunlight available");
    expect(sp).toContain("Direct-to-Earth communication");
    expect(sp).toContain("Earth visibility window open");
    expect(sp).not.toMatch(/\bwatts?\b|\bkW\b|battery|state of charge|go\/no-go/i);
  });
  it("keeps the interval state and the near-crossing explanation in the comms group", () => {
    const h = statusPanel(shell(`${DEMO}&t=2026-12-09T14:00:00Z`));
    expect(h).toMatch(/group-comms body-earth" data-body="earth" data-state="on" data-near="true"/);
    expect(text(h)).toContain("Earth visibility window open");
    expect(text(h)).toContain("Direct sunlight blocked");
    expect(text(h)).toContain("Near estimated crossing: the 10-minute step");
  });
  it("CR1 Sun near-crossing: label stays 'available'; disk geometry is described separately", () => {
    const t = text(statusPanel(shell("?arrival=2026-12-20T00:00Z&days=14&delay=0&horizon=terrain&site=connecting-ridge-cr1&t=2026-12-24T00:00:00Z")));
    expect(t).toContain("Direct sunlight available");
    expect(t).toContain("nominal disk straddles the skyline; its center is below it");
  });
  it("final sample: both unknown with the reason", () => {
    const t = text(statusPanel(shell("?arrival=2027-01-16T00:00Z&days=14&delay=0&horizon=terrain&t=2027-01-30T00:00:00Z")));
    expect(t).toContain("Sunlight status unknown");
    expect(t).toContain("Earth visibility unknown");
    expect(t).toContain("Unknown: final sample of the data");
  });
  it("mission comparison: collapsed line for the active (delayed) mission, full table from computeMetrics", () => {
    const h = shell(DEMO); // Athena terrain, 2026-12-05 +3 d
    const ms = h.slice(h.indexOf('class="mission-summary"'), h.indexOf('data-field="windows"', h.indexOf('class="mission-summary"')));
    expect(ms).toContain('data-active="delayed"');
    expect(ms).toMatch(/aria-checked="true" class="seg-b on" data-focus-btn="delayed"/);
    expect(text(ms)).toMatch(/48\.7 % .*88\.7 % Both 48\.7 %/); // the +3 d Analysis card values
    expect(ms).not.toContain("<table"); // collapsed by default
    function Full() {
      const sc = useScenario(DS, DEMO) as ReadyScenario;
      return <MissionSummary sc={sc} focus={sc.mission} setFocus={() => {}} initialOpen />;
    }
    const full = text(renderToStaticMarkup(<Full />));
    expect(full).toMatch(/Direct sunlight 27\.2 % 48\.7 %/); // baseline 27.232..., +3 d
    expect(full).toMatch(/Longest without sunlight 244\.5 h/);
    expect(text(shell(DEMO + "&view=analysis"))).toContain("27.2 %");
  });
  it("the active mission and camera mode are restored from the URL", () => {
    const h = shell(DEMO + "&mission=baseline&cam=horizon");
    expect(h).toContain('data-active="baseline"');
    expect(h).toContain('data-camera="eye"');
    expect(text(h)).toContain("Baseline: 2026-12-05 00:00 → 12-19 00:00 UTC");
    // "delayed" without a delay falls back to the baseline
    expect(shell("?arrival=2026-12-05T00:00Z&days=14&delay=0&mission=delayed")).toContain('data-active="baseline"');
  });
  it("boundary qualification for the longest period without direct sunlight is kept", () => {
    expect(text(shell(DEMO))).toContain("The longest period without direct sunlight touches the window start (Baseline), start (Delay +3 d); it may be longer than shown.");
  });
});

describe("four-state mission timeline in Explore", () => {
  it("renders the band from the intervals, with the active window marked and the rest dimmed", () => {
    const h = shell(DEMO + "&t=2026-12-10T00:00:00Z");
    const band = h.slice(h.indexOf('data-testid="avail-band"'), h.indexOf("</svg>", h.indexOf('data-testid="avail-band"')));
    // this Athena window has Sun + Earth, Earth only and neither periods (no Sun-only period)
    for (const st of ["both", "earth", "neither"]) expect(band).toContain(`data-state="${st}"`);
    // Sun-only periods exist elsewhere (CR1, same scenario)
    expect(shell(DEMO + "&site=connecting-ridge-cr1")).toContain('data-state="sun"');
    expect(band).not.toContain('data-state="unknown"');
    expect(band).toContain('class="av-dim"');
    expect(h).toContain('class="win win-delay active"');
    expect(text(h)).toContain("not a go/no-go");
  });
  it("unknown intervals are drawn as unknown (hatched), never as neither, and metrics become unavailable", () => {
    const ds = dataset((f) => {
      const ivs = f[0].terrain_horizon!.visibility_intervals;
      const k = ivs.findIndex((x) => Date.parse(x.start_utc) >= Date.parse("2026-12-10T00:00:00Z"));
      ivs[k] = { ...ivs[k], earth_visible: null };
    });
    const h = renderToStaticMarkup(<Workspace ds={ds} search={DEMO} />);
    const band = h.slice(h.indexOf('data-testid="avail-band"'), h.indexOf("</svg>", h.indexOf('data-testid="avail-band"')));
    expect(band).toContain('data-state="unknown"');
    expect(band).toMatch(/data-state="unknown"[^>]*class="av-unknown"/); // hatched (CSS fill: url(#hatch-unknown))
    expect(band).toContain('id="hatch-unknown"');
    const line = h.slice(h.indexOf('data-field="ms-line"'), h.indexOf("</p>", h.indexOf('data-field="ms-line"')));
    expect(text(line)).toContain("unavailable");
  });
  it("a selected time outside the active mission says so and offers Jump to mission", () => {
    const h = shell(DEMO + "&t=2026-12-06T00:00:00Z"); // before the +3 d window (starts 12-08)
    expect(h).toContain('data-testid="outside-mission"');
    expect(text(h)).toContain("Outside selected mission");
    expect(h).toContain('data-testid="jump-mission"');
    expect(shell(DEMO + "&t=2026-12-10T00:00:00Z")).not.toContain('data-testid="outside-mission"');
  });
  it("the keyboard-operable scrubber announces time and availability", () => {
    expect(shell(DEMO + "&t=2026-12-16T06:00:00Z")).toMatch(/aria-valuetext="2026-12-16 06:00 UTC, (Sun \+ Earth|Sun only|Earth only|Neither)"/);
  });
  it("crossing controls are present with an explained search range", () => {
    const h = shell(DEMO);
    expect(h).toContain('data-testid="ev-prev"');
    expect(h).toContain('data-testid="ev-next"');
    expect(text(h)).toContain("in selected mission");
    expect(text(h)).toContain("in all cached data");
  });
});

describe("activeWindow", () => {
  it("delayed only when a delay applies", async () => {
    const { activeWindow } = await import("./Explore");
    const sc = { baseW: { start: 1, end: 2 }, actW: { start: 3, end: 4 }, effDelay: 0 };
    expect(activeWindow(sc, "delayed").key).toBe("baseline");
    expect(activeWindow({ ...sc, effDelay: 3 }, "delayed")).toEqual({ key: "delayed", label: "Delay +3 d mission", w: { start: 3, end: 4 } });
  });
});

describe("viewing time independent of the mission windows (5B acceptance)", () => {
  it("a viewing time outside the windows is shown in Explore; Analysis keeps its clamped cursor", () => {
    const q = DEMO + "&t=2026-12-28T12:00:00Z"; // windows: 12-05 .. 12-22
    const ex = text(shell(q));
    expect(ex).toContain("Viewing time 2026-12-28 12:00 UTC");
    expect(ex).toContain("Outside selected mission");
    const an = text(shell(q + "&view=analysis"));
    expect(an).toContain("2026-12-22 00:00 UTC at IM-2 Athena landing point"); // clamped to the shown windows
    // the metrics stay tied to their windows
    expect(an).toContain("27.2 %");
  });
  it("the timeline widens to include an outside viewing time, never shrinks the windows", () => {
    const d = { start: Date.parse("2026-12-05T00:00:00Z"), end: Date.parse("2026-12-22T00:00:00Z") };
    expect(timelineSpan(d, Date.parse("2026-12-10T00:00:00Z"))).toEqual(d);
    const late = timelineSpan(d, Date.parse("2026-12-28T12:00:00Z"));
    expect(late.start).toBe(d.start);
    expect(late.end).toBeGreaterThan(Date.parse("2026-12-28T12:00:00Z"));
    const early = timelineSpan(d, Date.parse("2026-12-02T00:00:00Z"));
    expect(early.end).toBe(d.end);
    expect(early.start).toBeLessThan(Date.parse("2026-12-02T00:00:00Z"));
  });
  it("conditions say 'Simultaneous availability' and keep camera-independent status", () => {
    const t = text(statusPanel(shell(`${DEMO}&t=2026-12-16T06:00:00Z`)));
    expect(t).toMatch(/Simultaneous availability (Yes|No|Unknown)/);
    expect(t).not.toContain("Sun and Earth together");
    expect(t).toContain("Direct-to-Earth communication window");
  });
  it("camera modes are named Site overview and Horizon view", () => {
    const t = text(shell(DEMO));
    expect(t).toContain("Site overview");
    expect(t).toContain("Horizon view");
    expect(t).not.toContain("Observer view");
  });
});

// ---------------------------------------------------------------- 5C: terrain hazard screening and 5B fixes
import { ScreeningRow } from "./TerrainScreening";
import { type SlopeAsset, clearSlopeCache, overlayMode, primeSlopeAsset, screeningView } from "./slope";
import { slopeAssetOf } from "./slope.test";

describe("5C automatic terrain screening (overlays off), overlays and inspection", () => {
  const prime = () => {
    for (const id of ["im2-athena", "connecting-ridge-cr1"]) primeSlopeAsset("/", slopeAssetOf(id));
  };
  prime();
  const base = `${DEMO}&site=connecting-ridge-cr1&t=2026-12-08T00:00:00Z`;
  const metrics = (h: string) => { const i = h.indexOf('data-field="metrics"'); return h.slice(i, h.indexOf("</div>", h.indexOf("ms-window", i))); };
  /** The Sun/Earth groups of the Conditions panel (without the terrain row). */
  const sunEarth = (h: string) => { const i = h.indexOf("status-group group-power"); return h.slice(i, h.indexOf('data-testid="screening-row"', i)); };
  const warning = (h: string) => ["screening", "screening-text", "screening-observer"].map((f) => { const m = h.match(new RegExp(`data-field="${f}"[^>]*>([^<]*)<`)); return m ? m[1] : ""; }).join(" | ") + " | " + (h.match(/class="muted small ts-qual">([^<]*)</)?.[1] ?? "");
  const row = (h: string) => { const i = h.indexOf('data-testid="screening-row"'); return text(h.slice(i, h.indexOf("</div></div>", i))); };

  it("screening appears automatically, also with the overlay hidden, from computed values", () => {
    const cr1 = explore(base + "&layer=hide");
    const t = text(cr1);
    expect(t).toContain("Terrain screening");
    expect(t).toContain("Steep terrain nearby");
    expect(t).toContain("5.3 % of analyzed area exceeds 15° within 500 m.");
    expect(t).toContain("The modeled observer’s own cell: 0.9°, not above 15°.");
    expect(t).toContain("20 m DEM; slope measured over approximately 40 m.");
    expect(t).toContain("Full slope map");
    expect(t).not.toContain("Frame assessed area");
    const ath = text(explore(`${DEMO}&site=im2-athena`));
    expect(ath).toContain("No slopes above 15° detected within 500 m at this DEM scale.");
    expect(ath.toLowerCase()).not.toMatch(/\bsafe\b/);
    expect(explore(`${DEMO}&site=im2-athena`)).toContain('data-kind="none"');
  });
  it("threshold updates the warning; the observer cell is reported separately when it exceeds too", () => {
    expect(row(explore(`${base}&thr=10`))).toContain("17.1 % of analyzed area exceeds 10° within 500 m.");
    expect(row(explore(`${base}&thr=25`))).toContain("No slopes above 25° detected within 500 m at this DEM scale.");
    const low = row(explore(`${DEMO}&site=im2-athena&thr=2`)); // Athena's observer cell is 2.26°
    expect(low).toContain("The modeled observer’s own cell also exceeds 2° (2.3°).");
    expect(row(explore(`${DEMO}&site=im2-athena&thr=0.5`))).toContain("exceeds 1° within 500 m"); // clamped to 1°
  });
  it("is independent of date, horizon model and overlays", () => {
    const r = warning(explore(base));
    expect(r).toContain("Steep terrain nearby | 5.3 % of analyzed area exceeds 15° within 500 m.");
    for (const q of ["&t=2027-01-20T00:00:00Z", "&horizon=smooth", "&layer=exceed", "&layer=slope", "&layer=hide", "&cam=horizon"]) expect(warning(explore(base + q))).toBe(r);
  });
  it("overlays never change Sun/Earth conditions or mission metrics", () => {
    const off = explore(base);
    for (const layer of ["slope", "exceed"]) {
      const h = explore(`${base}&layer=${layer}`);
      expect(sunEarth(h)).toBe(sunEarth(off)); // Sun/Earth conditions
      expect(warning(h)).toBe(warning(off)); // the screening warning (only the overlay key and action differ)
      expect(metrics(h)).toBe(metrics(off));
    }
  });
  it("never shows another site's result or 'no exceedances' before this site's data", () => {
    clearSlopeCache();
    primeSlopeAsset("/", slopeAssetOf("im2-athena"));
    const h = explore(base); // CR1 active, only Athena's asset available
    expect(row(h)).toContain("Loading terrain screening…");
    expect(row(h)).not.toMatch(/No slopes|Steep terrain|exceeds/);
    prime();
    const ath = slopeAssetOf("im2-athena");
    expect(screeningView({ state: "ready", asset: ath }, "connecting-ridge-cr1", 15).kind).toBe("loading");
    expect(screeningView(undefined, "im2-athena", 15).kind).toBe("loading");
    expect(screeningView({ state: "idle" }, "im2-athena", 15).kind).toBe("loading");
    expect(screeningView({ state: "error", message: "HTTP 404" }, "im2-athena", 15)).toEqual({ kind: "error", message: "HTTP 404" });
    expect(screeningView({ state: "ready", asset: ath }, "im2-athena", 15).kind).toBe("none");
  });
  it("loading, error and no-exceedance render distinctly (Retry only on error)", () => {
    const props = { siteShort: "CR1", detailsOpen: false, layer: "exceed" as const, thresholdDeg: 15, onDetails: () => {}, onSlopeMap: () => {}, onSteep: () => {}, onRetry: () => {} };
    const loading = text(renderToStaticMarkup(<ScreeningRow view={{ kind: "loading" }} {...props} />));
    const err = text(renderToStaticMarkup(<ScreeningRow view={{ kind: "error", message: "Failed to fetch" }} {...props} />));
    expect(loading).toContain("Loading terrain screening…");
    expect(loading).not.toMatch(/Retry|No slopes|Full slope map/);
    expect(err).toContain("Terrain screening unavailable (Failed to fetch).");
    expect(err).toContain("Retry");
    expect(err).not.toMatch(/No slopes|Full slope map/);
  });
  it("incomplete coverage is stated prominently", () => {
    const a = JSON.parse(JSON.stringify(slopeAssetOf("im2-athena"))) as SlopeAsset;
    const k = a.grid.state.indexOf(1);
    a.grid.state[k] = 2;
    a.grid.slope_centideg[k] = null;
    const v = screeningView({ state: "ready", asset: a }, "im2-athena", 15);
    expect(v.kind).toBe("none");
    if (v.kind === "none") expect(v.coverage).toMatch(/^Incomplete coverage: 99\.9 %/);
  });
  /** The Conditions panel's terrain row (all terrain screening lives here). */
  const rowHtml = (h: string) => { const i = h.indexOf('data-testid="screening-row"'); return h.slice(h.lastIndexOf("<div", i), h.indexOf('<div class="both-row', i)); };
  const details = (h: string) => { const i = h.indexOf('data-testid="terrain-details"'); return i < 0 ? "" : h.slice(h.lastIndexOf("<div", i), h.indexOf('<div class="both-row', i)); };
  it("one place: no terrain control on the stage; everything is in the Conditions panel", () => {
    for (const q of ["", "&layer=slope", "&layer=hide", "&cam=horizon"]) {
      const h = explore(base + q);
      expect(h).not.toContain('data-testid="terrain-layers"');
      expect(h).not.toContain("overlay-ctl");
      expect(statusPanel(h)).toContain('data-testid="screening-row"');
    }
  });
  it("fresh load (no overlay preference): steep areas highlighted by default, Details closed", () => {
    const h = explore(base); // DEMO has no layer parameter
    const r = rowHtml(h);
    expect(r).toContain('data-layer="exceed"');
    expect(text(r)).toContain("Slope >15° highlighted · ring = 500 m assessed area; outside not assessed"); // the key, from the actual threshold
    expect(text(r)).toContain("Full slope map");
    expect(text(r)).toContain("Terrain details");
    expect(r).not.toContain("Frame assessed area");
    expect(h).not.toContain('data-testid="terrain-details"');
    expect(text(rowHtml(explore(base + "&thr=12.5")))).toContain("Slope >12.5° highlighted");
    const ath = explore(`${DEMO}&site=im2-athena`);
    expect(row(ath)).toContain("No slopes above 15° detected within 500 m at this DEM scale.");
  });
  it("Terrain details holds the overlay choice, the illustrative threshold and the legend, then the statistics", () => {
    const d = details(explore(base, { initialTerrainDetails: true }));
    for (const id of ["exceed", "slope", "surface"]) expect(d).toContain(`data-overlay-btn="${id}"`);
    expect(d).toMatch(/aria-checked="true"[^>]*data-overlay-btn="exceed"/);
    expect(d).toMatch(/class="oc-hide"[^>]*data-overlay-btn="surface"/); // a quieter Hide, not a third mode button
    expect(text(d)).toContain("Steep areas >15°");
    expect(text(d)).toContain("Illustrative screening threshold");
    expect(d).toContain('data-testid="threshold"');
    expect(text(d)).toContain("not a validated lander capability or universal safety limit");
    expect(text(d)).toContain("Slope >15°");
    expect(text(d)).toContain("Outside: not assessed");
    expect(text(d)).toContain("Median");
    expect(text(d)).toContain("Source, method and limits");
    // the overlay choice comes before the secondary information
    expect(d.indexOf("data-overlay-btn")).toBeLessThan(d.indexOf('data-field="median"'));
    expect(d.indexOf('data-testid="threshold"')).toBeLessThan(d.indexOf('data-field="median"'));
  });
  it("full slope map: the row offers one-click return to steep areas and shows the fixed scale", () => {
    const h = explore(base + "&layer=slope");
    expect(h).not.toContain('data-testid="terrain-details"');
    const r = rowHtml(h);
    expect(r).toContain('data-testid="steep-btn"');
    expect(r).not.toContain('data-testid="slope-map-btn"');
    expect(text(r)).toMatch(/0° to 30°\+ · same color scale at every site/);
    const d = details(explore(base + "&layer=slope", { initialTerrainDetails: true }));
    expect(d).toMatch(/aria-checked="true"[^>]*data-overlay-btn="slope"/);
    expect(text(d)).toMatch(/0° 10° 20° 30°\+/);
  });
  it("an explicit Hide stays hidden across reloads, thresholds, time and sites", () => {
    for (const q of ["", "&thr=10", "&t=2027-01-20T00:00:00Z", "&site=im2-athena", "&horizon=smooth"]) {
      const h = explore(`${base}&layer=hide${q}`);
      expect(rowHtml(h)).toContain('data-layer="surface"');
      expect(text(rowHtml(h))).toContain("Overlay hidden · screening stays on");
      expect(details(explore(`${base}&layer=hide${q}`, { initialTerrainDetails: true }))).toMatch(/aria-checked="true"[^>]*data-overlay-btn="surface"/);
    }
    expect(parseUrlState("?layer=hide").layer).toBe("surface");
    expect(parseUrlState("?layer=surface").layer).toBe("surface"); // older 5C links
    expect(parseUrlState("?layer=off").layer).toBe("surface");
    expect(parseUrlState("").layer).toBeNull(); // no preference -> default steep areas
  });
  it("overlay choice changes no camera mode, time, Sun/Earth status, warning or mission metrics", () => {
    const ref = explore(base);
    for (const layer of ["slope", "hide"]) {
      const h = explore(`${base}&layer=${layer}`);
      expect(sunEarth(h)).toBe(sunEarth(ref));
      expect(warning(h)).toBe(warning(ref));
      expect(metrics(h)).toBe(metrics(ref));
      expect(h.match(/data-field="selected-time">[^<]*/)?.[0]).toBe(ref.match(/data-field="selected-time">[^<]*/)?.[0]);
      expect(h.match(/data-camera="[a-z]+"/)?.[0]).toBe(ref.match(/data-camera="[a-z]+"/)?.[0]);
    }
  });
  it("draws only the active site's asset, only in the overview; returning restores the choice", () => {
    expect(overlayMode("exceed", "overview", "connecting-ridge-cr1", "connecting-ridge-cr1")).toBe(2);
    expect(overlayMode("slope", "overview", "connecting-ridge-cr1", "connecting-ridge-cr1")).toBe(1);
    expect(overlayMode("exceed", "overview", "connecting-ridge-cr1", "im2-athena")).toBe(0); // mid-switch: the old site's asset
    expect(overlayMode("exceed", "overview", null, "im2-athena")).toBe(0);
    expect(overlayMode("slope", "eye", "im2-athena", "im2-athena")).toBe(0); // the horizon view stays authoritative
    expect(overlayMode("surface", "overview", "im2-athena", "im2-athena")).toBe(0);
    const eye = details(explore(`${base}&layer=slope&cam=horizon`, { initialTerrainDetails: true }));
    expect(eye).toMatch(/aria-checked="true"[^>]*data-overlay-btn="slope"/);
    expect(text(eye)).toContain("Overlays are drawn in the Site overview");
    const u = writeUrlState(new URL("http://x/"), { arrival: Date.parse("2026-12-05T00:00:00Z"), days: 14, delay: 3, t: "2026-12-08T00:00:00Z", horizon: "terrain", sites: ["im2-athena"], site: "im2-athena", cam: "horizon", layer: "slope", thr: 15 });
    expect(u.searchParams.get("layer")).toBe("slope"); // kept while in Horizon view
  });
  it("an inspection point uses the detail area and never becomes the observer", () => {
    const a = slopeAssetOf("connecting-ridge-cr1");
    const p = a.grid.check_points[4].local_xyz;
    const h = explore(`${base}&layer=slope`, { initialInspection: [p[0] + 120, p[1], p[2] + 40] });
    const plain = explore(`${base}&layer=slope`);
    expect(sunEarth(h)).toBe(sunEarth(plain));
    expect(metrics(h)).toBe(metrics(plain));
    const t = text(h);
    expect(t).toContain("Terrain inspection point");
    expect(t).toMatch(/Slope \d+\.\d° · (above|not above) the 15° threshold/);
    expect(t).toMatch(/\d+ m from the modeled observer/);
    expect(t).toContain("Clear inspection");
    const out = text(explore(`${base}&layer=exceed`, { initialInspection: [2000, -20, -1500] }));
    expect(out).toContain("No slope data at this point");
    expect(out).toContain("outside the analysis area (not assessed)");
  });
  it("Horizon view keeps its presentation; screening stays in Conditions", () => {
    const h = explore(`${base}&layer=exceed&cam=horizon`);
    expect(h).not.toContain('data-testid="terrain-layers"');
    expect(text(h)).toContain("Full slope map"); // one click back to the overview, framed
    expect(text(h)).toContain("Steep terrain nearby");
  });
  it("URL: old layer links map to the new controls; threshold shared and clamped", () => {
    expect(rowHtml(explore(`${base}&layer=exceed`))).toContain('data-layer="exceed"'); // old Above-threshold link
    expect(rowHtml(explore(`${base}&layer=slope`))).toContain('data-layer="slope"'); // old Slope link
    expect(parseUrlState("?layer=bogus").layer).toBeNull();
    const s = parseUrlState("?layer=exceed&thr=12.5");
    expect([s.layer, s.thr]).toEqual(["exceed", 12.5]);
    const u = writeUrlState(new URL("http://x/"), { arrival: Date.parse("2026-12-05T00:00:00Z"), days: 14, delay: 3, t: "2026-12-08T00:00:00Z", horizon: "terrain", sites: ["im2-athena"], site: "im2-athena", layer: "surface", thr: 15 });
    expect(u.searchParams.get("layer")).toBe("hide"); // written explicitly so Hide survives a reload
    expect(u.searchParams.get("thr")).toBe("15");
    expect(row(explore(`${base}&thr=99`))).toContain("No slopes above 45°");
  });
  it("Analysis: matched comparison for both sites with the shared threshold, next to availability", () => {
    const t = text(shell(`${DEMO}&view=analysis&thr=10`));
    expect(t).toContain("Terrain hazard screening: matched 500 m footprint");
    expect(t).toMatch(/Median slope 2\.9° 5\.6°/);
    expect(t).toMatch(/95th-percentile slope 5\.9° 15\.2°/);
    expect(t).toMatch(/Area above 10° 0\.2 % 17\.1 %/);
    expect(t).toMatch(/Valid coverage 100\.0 % \(1,969 cells\) 100\.0 % \(1,964 cells\)/);
    expect(t).toMatch(/Sun center visible · Delay \+3 d/);
    expect(t).toContain("Provisional site terrain");
    expect(t).not.toMatch(/best (landing )?site/i);
  });
});

describe("5B corrections: shared viewing time and disabled delays", () => {
  it("Analysis states when it shows a clamped time; Explore keeps the viewing time", () => {
    const outside = "?arrival=2026-12-05T00:00Z&days=14&delay=3&horizon=terrain&t=2027-01-10T00:00:00Z";
    const a = text(shell(outside + "&view=analysis")).replace(/ ([,.])/g, "$1");
    expect(a).toContain("Explore’s viewing time, 2027-01-10 00:00 UTC, is outside these mission windows.");
    expect(a).toContain("Analysis shows the nearest window edge, 2026-12-22 00:00 UTC.");
    expect(text(shell(outside))).toContain("2027-01-10 00:00 UTC");
    expect(shell(DEMO + "&t=2026-12-10T00:00:00Z&view=analysis")).not.toContain('data-testid="clamped-time"');
  });
  it("explains unavailable delay choices in Explore and Analysis", () => {
    const late = "?arrival=2027-01-14T00:00Z&days=14&delay=0&horizon=terrain";
    const e = text(shell(late));
    expect(e).toContain("+3 d, +7 d unavailable: this mission plus the selected delay exceeds cached coverage");
    expect(shell(late)).toContain('title="This mission plus the selected delay exceeds cached coverage."');
    expect(text(shell(late + "&view=analysis"))).toContain("This mission plus the selected delay exceeds cached coverage");
  });
});

describe("continuous body tracking (release 6, checkpoint 1)", () => {
  const H = DEMO + "&t=2026-12-06T00:00:00Z&cam=horizon";
  it("the toolbar offers Track Sun / Track Earth (no one-time Look toward)", () => {
    const h = explore(H);
    expect(h).toContain('data-track-btn="sun"');
    expect(h).toContain('data-track-btn="earth"');
    expect(text(h)).toContain("Track Sun");
    expect(text(h)).not.toContain("Look toward");
    expect(h).not.toContain('data-testid="track-indicator"');
  });
  it("tracking shows an obvious indicator with Stop tracking and a pressed button", () => {
    const h = explore(H, { initialTrack: "earth" });
    expect(h).toContain('data-testid="track-indicator"');
    expect(h).toContain('data-track="earth"');
    expect(h).toContain('data-testid="stop-tracking"');
    expect(h).toMatch(/data-track-btn="earth"[^>]*>|aria-pressed="true"[^>]*data-track-btn="earth"/);
    expect(text(h)).toContain("Tracking Earth");
    expect(text(h)).toMatch(/10-minute sample/);
  });
  it("indicator words come from the shared status (same state as the Conditions panel)", () => {
    const h = explore(H, { initialTrack: "sun" });
    const st = /data-testid="track-indicator"[^>]*data-state="([a-z]+)"/.exec(h)![1];
    const panelSun = /data-body="sun" data-state="([a-z-]+)"/.exec(statusPanel(h))![1];
    // visible <-> available, hidden <-> blocked
    expect(st === "visible" ? "available" : "blocked").toBe(panelSun === "available" ? "available" : "blocked");
  });
  it("tracking is only shown in the Horizon view (the overview is never auto-tracked)", () => {
    const h = explore(DEMO + "&t=2026-12-06T00:00:00Z&cam=overview", { initialTrack: "sun" });
    expect(h).not.toContain('data-testid="track-indicator"');
  });
  it("smooth mode: the indicator states the 0° assumption", () => {
    const h = explore("?arrival=2026-12-05T00:00Z&days=14&delay=3&horizon=smooth&t=2026-12-06T00:00:00Z&cam=horizon", { initialTrack: "sun" });
    expect(text(h)).toContain("0° reference horizon");
    expect(text(h)).toContain("Smooth model: terrain ignored");
  });
  it("tracking a hidden body explains the occlusion", () => {
    // Earth at CR1 (terrain) is below the skyline at this time in the exported data
    const iso = DS.sites[1].data.terrain_horizon!.visibility_intervals.find((iv) => iv.earth_visible === false)!.start_utc;
    const h = explore(`${DEMO}&sites=im2-athena,connecting-ridge-cr1&site=connecting-ridge-cr1&t=${iso}&cam=horizon`, { initialTrack: "earth" });
    expect(h).toContain('data-state="hidden"');
    expect(text(h)).toMatch(/Hidden by the terrain skyline/);
  });
});

describe("link notices in Explore (dataset switch from the 120-day release)", () => {
  it("states dropped sites and a moved arrival instead of changing them silently", () => {
    const h = text(shell("?view=explore&arrival=2027-02-10T00:00Z&days=14&delay=0&sites=im2-athena,connecting-ridge-cr1,im1-odysseus,apollo17-lm&site=apollo17-lm"));
    expect(h).toContain("Unknown site ID in the link: im1-odysseus, apollo17-lm");
    expect(h).toMatch(/link.{0,6}s arrival 2027-02-10 00:00 UTC is outside this dataset.{0,6}s coverage for a 14-day mission/);
    expect(h).toContain("shown from 2027-01-16 00:00 UTC, the nearest arrival that fits");
  });
  it("shows no notice for a link that fits the dataset", () => {
    expect(shell("?view=explore&arrival=2026-12-05T00:00Z&days=14&sites=im2-athena")).not.toContain('data-testid="link-notice"');
  });
});
