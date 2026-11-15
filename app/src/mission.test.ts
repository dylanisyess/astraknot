import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  HOUR_MS,
  type Interval,
  arrivalBounds,
  compare,
  computeMetrics,
  delayOptions,
  intervalAt,
  nextChange,
  parseIntervals,
  scenarioWindow,
} from "./mission";
import type { Manifest, SiteData } from "./types";

const H = HOUR_MS;
const T0 = Date.parse("2030-01-01T00:00:00Z");
/** Synthetic intervals from [hours, sun, earth] segments starting at T0. */
function ivs(...segs: [number, boolean | null, boolean | null][]): Interval[] {
  let t = T0;
  return segs.map(([h, sun, earth]) => {
    const iv = { start: t, end: t + h * H, sun, earth };
    t += h * H;
    return iv;
  });
}
const win = (fromH: number, toH: number) => ({ start: T0 + fromH * H, end: T0 + toH * H });
const val = <T,>(a: { ok: true; value: T } | { ok: false; reason: string }): T => {
  if (!a.ok) throw new Error(`unavailable: ${a.reason}`);
  return a.value;
};

describe("delays are offsets from the baseline and preserve duration", () => {
  const cov = { start: T0, end: T0 + 60 * DAY_MS };
  const D = 14 * DAY_MS;

  it("each delay shifts the baseline window; selecting +1 then +3 is not +4", () => {
    const base = T0 + 2 * DAY_MS;
    const opts = delayOptions(base, D, cov);
    expect(opts.map((o) => (o.window.start - base) / DAY_MS)).toEqual([0, 1, 3, 7]);
    // Delay choice is stateless: +3 computed directly equals +3 after having chosen +1.
    const afterOne = scenarioWindow(base, 1, D);
    expect(scenarioWindow(base, 3, D)).toEqual(opts[2].window);
    expect(scenarioWindow(base, 3, D).start).not.toBe(afterOne.start + 3 * DAY_MS);
    for (const o of opts) expect(o.window.end - o.window.start).toBe(D);
  });

  it("earliest arrival = coverage start; latest arrival = coverage end - duration", () => {
    expect(arrivalBounds(cov, D)).toEqual({ earliest: cov.start, latest: cov.end - D });
    expect(arrivalBounds(cov, 61 * DAY_MS)).toBeNull();
    expect(arrivalBounds(cov, 60 * DAY_MS)).toEqual({ earliest: cov.start, latest: cov.start });
  });

  it("at the earliest arrival all delays fit; at the latest only the baseline fits", () => {
    const { earliest, latest } = arrivalBounds(cov, D)!;
    expect(delayOptions(earliest, D, cov).map((o) => o.enabled)).toEqual([true, true, true, true]);
    const atLatest = delayOptions(latest, D, cov);
    expect(atLatest.map((o) => o.enabled)).toEqual([false, false, false, false].map((_, i) => i === 0));
    expect(atLatest[1].reason).toBe("This mission plus the selected delay exceeds cached coverage.");
  });

  it("a window ending exactly at coverage end is allowed (end is exclusive)", () => {
    const base = cov.end - D - 3 * DAY_MS;
    expect(delayOptions(base, D, cov).map((o) => o.enabled)).toEqual([true, true, true, false]);
    expect(delayOptions(base + 1, D, cov)[2].enabled).toBe(false); // 1 ms later: +3 no longer fits
  });
});

describe("window metrics", () => {
  it("all visible", () => {
    const m = computeMetrics(ivs([24, true, true]), win(0, 24));
    expect([val(m.sunPct), val(m.earthPct), val(m.bothPct)]).toEqual([100, 100, 100]);
    expect(val(m.longestDark)).toBeNull(); // no modeled darkness, not "never"
  });

  it("all dark: darkness spans the window and touches both boundaries", () => {
    const m = computeMetrics(ivs([48, false, true]), win(6, 30));
    expect(val(m.sunPct)).toBe(0);
    expect(val(m.bothPct)).toBe(0);
    const d = val(m.longestDark)!;
    expect(d.durationMs).toBe(24 * H);
    expect([d.touchesStart, d.touchesEnd]).toEqual([true, true]);
    expect([d.fullStart, d.fullEnd]).toEqual([T0, T0 + 48 * H]); // continues outside the window
  });

  it("unknown sun state makes sun % and darkness unavailable, not dark or visible", () => {
    const m = computeMetrics(ivs([10, false, true], [2, null, true], [12, true, true]), win(0, 24));
    expect(m.sunPct.ok).toBe(false);
    expect(m.longestDark.ok).toBe(false);
    expect(val(m.earthPct)).toBe(100); // Earth is still known everywhere
    expect(m.bothPct.ok).toBe(false); // sun unknown + earth true = unknown
  });

  it("both-visible is known false when either body is known false, even if the other is unknown", () => {
    const m = computeMetrics(ivs([12, null, false], [12, true, true]), win(0, 24));
    expect(val(m.bothPct)).toBe(50);
    expect(m.sunPct.ok).toBe(false);
  });

  it("uses elapsed duration, not interval counts", () => {
    // one long visible interval, nine short dark ones -> 90 %, not 10 %
    const segs: [number, boolean, boolean][] = [[9, true, true]];
    for (let i = 0; i < 9; i++) segs.push([1 / 9, false, i % 2 === 0]);
    const m = computeMetrics(ivs(...segs), win(0, 10));
    expect(val(m.sunPct)).toBeCloseTo(90, 9);
    // the nine dark pieces differ in Earth state but form ONE continuous darkness run
    expect(val(m.longestDark)!.durationMs).toBeCloseTo(1 * H, 0);
  });

  it("window boundaries cutting through intervals are clipped by elapsed time", () => {
    const all = ivs([10, true, true], [10, false, true], [10, true, false]);
    const a = computeMetrics(all, win(5, 25));
    expect(val(a.sunPct)).toBe(50); // 5 h + 5 h of 20 h
    expect(val(a.earthPct)).toBe(75); // 15 h of 20 h
    expect(val(a.bothPct)).toBe(25); // 5 h of 20 h
    const da = val(a.longestDark)!;
    expect([da.durationMs, da.touchesStart, da.touchesEnd]).toEqual([10 * H, false, false]);

    const b = computeMetrics(all, win(12, 25));
    const db = val(b.longestDark)!;
    expect([db.durationMs, db.touchesStart, db.touchesEnd]).toEqual([8 * H, true, false]);
    expect(db.fullStart).toBe(T0 + 10 * H); // started 2 h before the window
    expect(val(b.sunPct)).toBeCloseTo((5 / 13) * 100, 9);
  });

  it("a window extending past the data is unavailable", () => {
    const m = computeMetrics(ivs([10, true, true]), win(5, 15));
    expect(m.sunPct.ok || m.earthPct.ok || m.bothPct.ok || m.longestDark.ok).toBe(false);
  });

  it("unknown interrupts darkness runs instead of being merged into them", () => {
    const m = computeMetrics(ivs([5, false, true], [1, null, true], [5, false, true]), win(0, 11));
    expect(m.longestDark.ok).toBe(false);
  });

  it("ties for longest darkness choose the earliest run", () => {
    const m = computeMetrics(ivs([3, false, true], [2, true, true], [3, false, true]), win(0, 8));
    expect(val(m.longestDark)!.start).toBe(T0);
  });

  it("comparison reports percentage points and darkness hours", () => {
    const all = ivs([24, false, true], [24, true, true]);
    const c = compare(computeMetrics(all, win(0, 24)), computeMetrics(all, win(12, 36)));
    expect(c.sunPp).toBe(50);
    expect(c.earthPp).toBe(0);
    expect(c.darkHours).toBe(-12);
  });
});

describe("cursor queries", () => {
  const all = ivs([10, false, true], [10, true, true], [10, true, false]);
  it("intervalAt uses [start, end)", () => {
    expect(intervalAt(all, T0 + 10 * H)!.sun).toBe(true);
    expect(intervalAt(all, T0 + 30 * H)).toBeNull();
  });
  it("nextChange finds the next transition or reports not found within coverage", () => {
    expect(nextChange(all, T0, "sun")).toEqual({ found: true, at: T0 + 10 * H, to: true });
    expect(nextChange(all, T0 + 25 * H, "sun")).toEqual({ found: false, searchedUntil: T0 + 30 * H });
    expect(nextChange(all, T0 + 5 * H, "earth")).toEqual({ found: true, at: T0 + 20 * H, to: false });
  });
});

// ---------------------------------------------------------------- real data
// Expected values come from pipeline/crosscheck_metrics.py, an independent
// Python implementation that re-classifies every 10-minute step from the
// samples (not from the merged intervals used here). The first block was also
// checked by hand against the interval list (see docs/STATUS.md).

describe("real dataset cross-check vs independent Python reference", () => {
  const dir = new URL("../public/data/", import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("manifest.json", dir), "utf-8")) as Manifest;
  const site = JSON.parse(readFileSync(new URL(manifest.sites[0].file, dir), "utf-8")) as SiteData;
  const all = parseIntervals(site);
  const cov = { start: Date.parse(manifest.coverage_start_utc), end: Date.parse(manifest.coverage_end_utc) };
  const D = 14 * DAY_MS;

  const cases: [string, number, number, number, number, number, boolean, boolean][] = [
    // baseline, delay, sun %, earth %, both %, longest dark h, touches start, touches end
    ["2026-12-05T00:00:00Z", 0, 43.3531746031746, 55.654761904761905, 43.3531746031746, 190.33333333333334, true, false],
    ["2026-12-05T00:00:00Z", 7, 93.35317460317461, 100.0, 93.35317460317461, 22.333333333333332, true, false],
    ["2026-12-20T07:00:00Z", 3, 47.817460317460316, 51.14087301587302, 47.817460317460316, 175.33333333333334, false, true],
  ];
  it.each(cases)("baseline %s +%i d", (b, delay, sun, earth, both, darkH, ts, te) => {
    const w = scenarioWindow(Date.parse(b), delay, D);
    const m = computeMetrics(all, w);
    expect(val(m.sunPct)).toBeCloseTo(sun, 9);
    expect(val(m.earthPct)).toBeCloseTo(earth, 9);
    expect(val(m.bothPct)).toBeCloseTo(both, 9);
    const d = val(m.longestDark)!;
    expect(d.durationMs / H).toBeCloseTo(darkH, 9);
    expect([d.touchesStart, d.touchesEnd]).toEqual([ts, te]);
  });

  it("no darkness in 2027-01-13 + 14 d, and +7 d from 2027-01-10 is disabled", () => {
    const m = computeMetrics(all, scenarioWindow(Date.parse("2027-01-10T00:00:00Z"), 3, D));
    expect(val(m.sunPct)).toBe(100);
    expect(val(m.longestDark)).toBeNull();
    expect(val(m.earthPct)).toBeCloseTo(97.4702380952381, 9);
    const opts = delayOptions(Date.parse("2027-01-10T00:00:00Z"), D, cov);
    expect(opts.map((o) => o.enabled)).toEqual([true, true, true, false]);
  });

  it("intervals cover the advertised data range exactly", () => {
    expect(all[0].start).toBe(cov.start);
    expect(all[all.length - 1].end).toBe(cov.end);
    for (let i = 1; i < all.length; i++) expect(all[i].start).toBe(all[i - 1].end);
  });
});
