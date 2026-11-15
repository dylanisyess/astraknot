// Playback speeds: 3 h/s by default, options up to 12 h/s, and no step past the playback endpoint.
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Workspace } from "../App";
import { checkSites } from "../data";
import { playAdvance, playbackEnd } from "../scenario";
import type { Catalog, Dataset, Manifest, SiteData } from "../types";
import { DEFAULT_SPEED, GUIDE_SPEED, SPEEDS } from "./Explore";

describe("playback speeds", () => {
  it("default is 3 h/s; options are 10 min, 1 h, 3 h, 6 h and 12 h per second", () => {
    expect(DEFAULT_SPEED.id).toBe("3h");
    expect(GUIDE_SPEED.id).toBe("3h");
    expect(SPEEDS.map((s) => s.label)).toEqual(["10 min/s", "1 h/s", "3 h/s", "6 h/s", "12 h/s"]);
    // viewing time per real second = stepsPerSec x 10 minutes
    expect(SPEEDS.map((s) => (s.stepsPerSec * 10) / 60)).toEqual([1 / 6, 1, 3, 6, 12]);
  });
  it("12 h/s ticks no faster than 6 h/s (two samples per tick)", () => {
    const tickMs = (id: string) => {
      const s = SPEEDS.find((x) => x.id === id)!;
      return (1000 * s.perTick) / s.stepsPerSec;
    };
    expect(tickMs("12h")).toBeCloseTo(tickMs("6h"), 9);
    expect(SPEEDS.find((x) => x.id === "12h")!.perTick).toBe(2);
  });
});

describe("playback stops at the end of the mission windows", () => {
  const i1 = 101; // end of the shown windows
  const last = 300; // last sample of the data
  /** A whole run as the scenario plays it: the stop is fixed when Play is pressed. */
  const run = (start: number, n: number) => {
    const stop = playbackEnd(start, i1, last);
    let c = start;
    let ticks = 0;
    while (c < stop && ticks++ < 10_000) c = playAdvance(c, n, stop, last);
    return c;
  };
  it("a run started inside the windows stops exactly at their end, at 1 or 2 samples per tick", () => {
    expect(run(90, 1)).toBe(i1);
    expect(run(90, 2)).toBe(i1); // 100 -> 101, not 102
    expect(run(0, 2)).toBe(i1); // started before the windows
  });
  it("reaching the end does not extend the run (the old recomputed rule would continue to the data end)", () => {
    // what the recomputed rule did at the window end: the stop flipped to the data end
    expect(playbackEnd(i1, i1, last)).toBe(last);
    // with the stop fixed at start, a run from 90 never goes beyond 101
    expect(playAdvance(i1, 2, playbackEnd(90, i1, last), last)).toBe(i1);
  });
  it("a run started at or after the window end continues to the end of the data", () => {
    expect(run(i1, 2)).toBe(last);
    expect(run(150, 1)).toBe(last);
    expect(playAdvance(299, 2, last, last)).toBe(last);
  });
});

describe("Explore shows the speeds with 3 h/s selected", () => {
  const dataDir = new URL("../../public/data/", import.meta.url);
  const readJson = <T,>(name: string): T => JSON.parse(readFileSync(new URL(name, dataDir), "utf-8")) as T;
  const manifest = readJson<Manifest>("manifest.json");
  const files = manifest.sites.map((e) => readJson<SiteData>(e.file));
  const ds: Dataset = { manifest, catalog: readJson<Catalog>("catalog.json"), times: checkSites(manifest, files), sites: files.map((d, k) => ({ id: manifest.sites[k].id, data: d, terrainProblem: null })) };
  it("renders the speed select", () => {
    const html = renderToStaticMarkup(<Workspace ds={ds} search="?arrival=2026-12-05T00:00Z&days=14&delay=3&horizon=terrain&view=explore" />);
    const sel = html.slice(html.indexOf('data-testid="speed"'), html.indexOf("</select>", html.indexOf('data-testid="speed"')));
    expect(sel).toContain('<option value="3h" selected="">3 h/s</option>');
    expect(sel).toContain('<option value="6h">6 h/s</option>');
    expect(sel).toContain('<option value="12h">12 h/s</option>');
  });
});
