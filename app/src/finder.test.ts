import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type FinderRow,
  type Limits,
  type ScenarioCore,
  CSV_COLUMNS,
  NO_LIMITS,
  applyResult,
  arrivalLimits,
  bestPerSite,
  candidateArrivals,
  checkInputs,
  commonCoverage,
  delayPreview,
  evaluate,
  finderCsv,
  limitOutcomes,
  metricValue,
  rank,
  resultView,
  searchKey,
  siteProblems,
  verdict,
} from "./finder";
import { DAY_MS, HOUR_MS, type Interval, computeMetrics, fmtOutage, fmtPct, parseIntervals } from "./mission";
import type { Manifest, SiteData } from "./types";

const H = HOUR_MS;
const T0 = Date.parse("2030-01-01T00:00:00Z");
const at = (h: number) => T0 + h * H;
function ivs(...segs: [number, boolean | null, boolean | null][]): Interval[] {
  let t = T0;
  return segs.map(([h, sun, earth]) => {
    const iv = { start: t, end: t + h * H, sun, earth };
    t += h * H;
    return iv;
  });
}

// Six days of synthetic intervals (hours from T0):
//   [0,30) Sun+Earth   [30,40) Earth only   [40,60) Sun only   [60,100) Sun+Earth   [100,144) neither
const SITE = ivs([30, true, true], [10, false, true], [20, true, false], [40, true, true], [44, false, false]);
const COV = { start: T0, end: at(144) };
const BASE = { siteIds: ["a-site"], days: 2, fromDate: "2030-01-01", toDate: "2030-01-04", hour: 6 };

// Independently calculated (by hand) for 48 h missions arriving at 06:00 UTC:
//   A 01-01 06:00 [6,54):   Sun 38 h, Earth 34 h, both 24 h, Sun blockage 10 h, Earth blockage 14 h (touches end)
//   B 01-02 06:00 [30,78):  Sun 38 h, Earth 28 h, both 18 h, Sun blockage 10 h (touches start), Earth 20 h
//   C 01-03 06:00 [54,102): Sun 46 h, Earth 40 h, both 40 h, Sun blockage 2 h (touches end), Earth 6 h (touches start)
//   D 01-04 06:00 [78,126): Sun 22 h, Earth 22 h, both 22 h, Sun and Earth blockage 26 h (touch end)
const pct = (h: number) => (100 * h) / 48;
const EXPECT = {
  A: { sun: pct(38), earth: pct(34), both: pct(24), sunBlock: 10, earthBlock: 14 },
  B: { sun: pct(38), earth: pct(28), both: pct(18), sunBlock: 10, earthBlock: 20 },
  C: { sun: pct(46), earth: pct(40), both: pct(40), sunBlock: 2, earthBlock: 6 },
  D: { sun: pct(22), earth: pct(22), both: pct(22), sunBlock: 26, earthBlock: 26 },
};
const LETTER: Record<number, keyof typeof EXPECT> = { [at(6)]: "A", [at(30)]: "B", [at(54)]: "C", [at(78)]: "D" };
const letters = (rows: FinderRow[]) => rows.map((r) => LETTER[r.arrival]);

function rowsFor(sites: { id: string; intervals: Interval[] }[], inp = BASE) {
  const c = checkInputs({ ...inp, siteIds: sites.map((s) => s.id) }, commonCoverage(sites)!);
  if (!c.ok) throw new Error(c.problems.join(" "));
  return evaluate(sites, c.arrivals, c.durationMs);
}

describe("candidate grid: once per UTC day at the selected hour, full duration only", () => {
  it("generates daily arrivals at the hour, inclusive of both dates", () => {
    expect(candidateArrivals("2030-01-01", "2030-01-04", 6)).toEqual([at(6), at(30), at(54), at(78)]);
    expect(candidateArrivals("2030-01-03", "2030-01-03", 23)).toEqual([at(71)]);
    for (const t of candidateArrivals("2026-12-30", "2027-01-02", 5)) expect(new Date(t).getUTCHours()).toBe(5);
  });

  it("valid limits keep the complete mission inside [coverage start, coverage end)", () => {
    // latest start = 144 - 48 = 96 h (01-05 00:00); at 06:00 the last fitting day is 01-04
    expect(arrivalLimits(COV, 48 * H, 6)).toMatchObject({ earliestDate: "2030-01-01", latestDate: "2030-01-04", earliest: at(6), latest: at(78) });
    // exact dataset endpoint: at 00:00 the mission arriving 01-05 ends exactly at coverage end and is allowed
    const l0 = arrivalLimits(COV, 48 * H, 0)!;
    expect(l0.latest).toBe(at(96));
    expect(l0.latest + 48 * H).toBe(COV.end);
    // coverage that starts mid-day: an earlier hour on that day is not offered
    expect(arrivalLimits({ start: at(12), end: COV.end }, 48 * H, 6)!.earliest).toBe(at(30));
    expect(arrivalLimits(COV, 7 * DAY_MS, 0)).toBeNull();
  });

  it("explains invalid ranges with the valid limits and never clamps", () => {
    const late = checkInputs({ ...BASE, toDate: "2030-01-05" }, COV);
    expect(late.ok).toBe(false);
    if (!late.ok) {
      expect(late.problems.join(" ")).toContain("would end after the data ends");
      expect(late.problems.join(" ")).toContain("2030-01-01 to 2030-01-04");
    }
    const early = checkInputs({ ...BASE, fromDate: "2029-12-31" }, COV);
    expect(!early.ok && early.problems.join(" ")).toContain("before the data begins");
    const reversed = checkInputs({ ...BASE, fromDate: "2030-01-04", toDate: "2030-01-02" }, COV);
    expect(!reversed.ok && reversed.problems.join(" ")).toContain("after the latest");
    expect(checkInputs({ ...BASE, days: 7 }, COV).ok).toBe(false);
    expect(checkInputs({ ...BASE, days: 1.5 }, COV).ok).toBe(false);
    expect(checkInputs({ ...BASE, fromDate: "2030-02-30" }, COV).ok).toBe(false);
    expect(checkInputs({ ...BASE, siteIds: [] }, COV).ok).toBe(false);
    // the exact endpoint is accepted at 00:00
    const edge = checkInputs({ ...BASE, hour: 0, toDate: "2030-01-05" }, COV);
    expect(edge.ok && edge.arrivals.at(-1)! + edge.durationMs).toBe(COV.end);
  });

  it("uses the common coverage of all searched sites", () => {
    const short = ivs([30, true, true], [10, false, true], [20, true, false], [40, true, true]); // ends at 100 h
    expect(commonCoverage([{ intervals: SITE }, { intervals: short }])).toEqual({ start: T0, end: at(100) });
    const c = checkInputs({ ...BASE, siteIds: ["a", "b"] }, commonCoverage([{ intervals: SITE }, { intervals: short }])!);
    expect(!c.ok && c.problems.join(" ")).toContain("2030-01-01 to 2030-01-02");
  });
});

describe("metrics equal hand-calculated values (shared computeMetrics)", () => {
  const rows = rowsFor([{ id: "a-site", intervals: SITE }]);
  it("evaluates every candidate over the full duration", () => {
    expect(rows.map((r) => r.end - r.arrival)).toEqual([48, 48, 48, 48].map((h) => h * H));
    for (const r of rows) {
      const e = EXPECT[LETTER[r.arrival]];
      expect(metricValue(r, "sun")).toBeCloseTo(e.sun, 10);
      expect(metricValue(r, "earth")).toBeCloseTo(e.earth, 10);
      expect(metricValue(r, "both")).toBeCloseTo(e.both, 10);
      expect(metricValue(r, "sunBlock")).toBeCloseTo(e.sunBlock, 10);
      expect(metricValue(r, "earthBlock")).toBeCloseTo(e.earthBlock, 10);
      // identical to the scenario's own metric for the same window
      expect(r.m).toEqual(computeMetrics(SITE, { start: r.arrival, end: r.end }));
    }
  });

  it("simultaneous visibility counts only time when both are visible", () => {
    const a = rows.find((r) => r.arrival === at(6))!;
    expect(metricValue(a, "both")).toBeLessThan(Math.min(metricValue(a, "sun")!, metricValue(a, "earth")!));
  });

  it("keeps the boundary flags of clipped blockages", () => {
    const by = (l: string) => rows.find((r) => LETTER[r.arrival] === l)!;
    const ea = by("A").m.longestEarthBlock;
    expect(ea.ok && ea.value!.touchesEnd).toBe(true);
    expect(ea.ok && ea.value!.fullEnd).toBe(at(60)); // the full run continues to 60 h, outside the mission
    const sb = by("B").m.longestDark;
    expect(sb.ok && sb.value!.touchesStart).toBe(true);
    const sd = by("D").m.longestDark;
    expect(sd.ok && sd.value!.touchesEnd && sd.value!.fullEndAtCoverageEdge).toBe(true);
  });
});

describe("ranking: deterministic, one criterion at a time", () => {
  const rows = rowsFor([{ id: "a-site", intervals: SITE }]);
  it("orders by each criterion; ties go to the earlier arrival", () => {
    expect(letters(rank(rows, "both").ranked)).toEqual(["C", "A", "D", "B"]);
    expect(letters(rank(rows, "sun").ranked)).toEqual(["C", "A", "B", "D"]); // A and B tie at 38 h: earlier first
    expect(letters(rank(rows, "earth").ranked)).toEqual(["C", "A", "B", "D"]);
    expect(letters(rank(rows, "sunBlock").ranked)).toEqual(["C", "A", "B", "D"]); // A and B tie at 10 h
    expect(letters(rank(rows, "earthBlock").ranked)).toEqual(["C", "A", "B", "D"]);
  });

  it("ties at the same arrival go to the site ID; input order does not matter", () => {
    const two = rowsFor([{ id: "z-site", intervals: SITE }, { id: "b-site", intervals: SITE }]);
    const r = rank(two, "both").ranked;
    expect(r.slice(0, 2).map((x) => x.siteId)).toEqual(["b-site", "z-site"]);
    expect(rank([...two].reverse(), "both").ranked).toEqual(r);
  });
});

describe("unknown data is never favorable", () => {
  // Earth unknown for 2 h inside the first candidate only
  const unk = ivs([20, true, true], [2, true, null], [8, true, true], [10, false, true], [20, true, false], [40, true, true], [44, false, false]);
  const rows = rowsFor([{ id: "u-site", intervals: unk }]);
  it("is not ranked by an unavailable metric and is reported separately", () => {
    const both = rank(rows, "both");
    expect(both.unevaluable.map((r) => r.arrival)).toEqual([at(6)]);
    expect(both.ranked.map((r) => r.arrival)).not.toContain(at(6));
    // the Sun metric is still known for that candidate
    expect(rank(rows, "sun").ranked.map((r) => r.arrival)).toContain(at(6));
  });

  it("cannot pass a limit", () => {
    const first = rows.find((r) => r.arrival === at(6))!;
    const o = limitOutcomes(first, { ...NO_LIMITS, minEarthPct: 0 });
    expect(o[0].state).toBe("unknown");
    expect(verdict(o)).toBe("unknown");
    const v = resultView(rows, "sun", { ...NO_LIMITS, minEarthPct: 0 });
    expect(v.meeting.map((r) => r.arrival)).not.toContain(at(6));
    expect(v.limitUnknown.map((r) => r.arrival)).toEqual([at(6)]);
  });
});

describe("optional limits", () => {
  const rows = rowsFor([{ id: "a-site", intervals: SITE }]);
  const L = (l: Partial<Limits>) => ({ ...NO_LIMITS, ...l });
  it("are off by default: every ranked row is shown", () => {
    const v = resultView(rows, "both", NO_LIMITS);
    expect(v.meeting.length).toBe(4);
    expect(verdict(limitOutcomes(rows[0], NO_LIMITS))).toBe("none");
  });

  it("filter on inclusive thresholds, within-mission blockage", () => {
    // Sun >= 38/48 h keeps A, B, C; Earth blockage <= 14 h keeps A (14 h, clipped) and C
    expect(letters(resultView(rows, "both", L({ minSunPct: pct(38) })).meeting)).toEqual(["C", "A", "B"]);
    expect(letters(resultView(rows, "both", L({ maxEarthBlockH: 14 })).meeting)).toEqual(["C", "A"]);
    expect(letters(resultView(rows, "both", L({ minSunPct: 50, maxSunBlockH: 5 })).meeting)).toEqual(["C"]);
    expect(letters(resultView(rows, "both", L({ minEarthPct: 60 })).meeting)).toEqual(["C", "A"]);
  });

  it("no match: nothing is relaxed; failing rows remain available with their failed limits", () => {
    const v = resultView(rows, "both", L({ minSunPct: 99 }));
    expect(v.meeting).toEqual([]);
    expect(letters(v.failing)).toEqual(["C", "A", "D", "B"]);
    const o = limitOutcomes(v.failing[0], L({ minSunPct: 99 }));
    expect(o).toEqual([{ key: "minSunPct", limit: 99, value: pct(46), state: "fail" }]);
  });
});

describe("sites and the horizon model", () => {
  const opts = [
    { id: "a", short: "A", state: "ready" as const, reason: null },
    { id: "b", short: "B", state: "no-model" as const, reason: "no terrain horizon" },
  ];
  it("requires an explicit compatible selection; never mixes models", () => {
    expect(siteProblems(["a"], opts, "terrain")).toEqual([]);
    const p = siteProblems(["a", "b"], opts, "terrain");
    expect(p.length).toBe(1);
    expect(p[0]).toContain("never mixed");
  });
  it("results depend on dataset, model, sites and every search input", () => {
    const k = searchKey("ds", "terrain", BASE);
    expect(searchKey("ds", "terrain", { ...BASE })).toBe(k);
    for (const changed of [
      searchKey("ds2", "terrain", BASE),
      searchKey("ds", "smooth", BASE),
      searchKey("ds", "terrain", { ...BASE, siteIds: ["a-site", "b"] }),
      searchKey("ds", "terrain", { ...BASE, days: 3 }),
      searchKey("ds", "terrain", { ...BASE, fromDate: "2030-01-02" }),
      searchKey("ds", "terrain", { ...BASE, toDate: "2030-01-03" }),
      searchKey("ds", "terrain", { ...BASE, hour: 7 }),
    ]) expect(changed).not.toBe(k);
  });
});

describe("search and apply", () => {
  const cur: ScenarioCore = {
    selIds: ["a-site", "b-site"], active: "b-site", arrival: at(0), days: 3, delay: 3, mission: "delayed", t: at(80),
    mode: "terrain", view: "explore", cam: "horizon", layer: "slope", thr: 20, playing: true,
  };
  it("searching does not touch the scenario", () => {
    const snapshot = structuredClone(cur);
    const sites = [{ id: "a-site", intervals: SITE }];
    rank(rowsFor(sites), "both");
    expect(cur).toEqual(snapshot);
  });
  it("applying changes only site, arrival, duration, delay, mission, viewing time and playback", () => {
    const next = applyResult(cur, { siteId: "a-site", arrival: at(54), days: 2 });
    expect(next).toEqual({ ...cur, active: "a-site", arrival: at(54), days: 2, delay: 0, mission: "baseline", t: at(54), playing: false });
    expect(next.mode).toBe("terrain");
    expect(next.cam).toBe("horizon");
    expect(next.layer).toBe("slope");
    expect(() => applyResult(cur, { siteId: "x", arrival: at(54), days: 2 })).toThrow();
  });
});

// ------------------------------------------------------------ CSV

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let f = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { f += '"'; i++; }
      else if (ch === '"') q = false;
      else f += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(f); f = ""; }
    else if (ch === "\r") continue;
    else if (ch === "\n") { row.push(f); rows.push(row); row = []; f = ""; }
    else f += ch;
  }
  return rows;
}

describe("CSV export", () => {
  const unk = ivs([20, true, true], [2, true, null], [8, true, true], [10, false, true], [20, true, false], [40, true, true], [44, false, false]);
  const rows = [...rowsFor([{ id: "a-site", intervals: SITE }]), ...rowsFor([{ id: "u-site", intervals: unk }])];
  const limits = { ...NO_LIMITS, minSunPct: 50, maxEarthBlockH: 14 };
  const csv = finderCsv(rows, {
    datasetId: "test-ds", mode: "terrain", inputs: { ...BASE, siteIds: ["a-site", "u-site"] }, sampleStepSeconds: 600,
    visibilityMethod: "10-minute midpoint classification", criterion: "both", limits,
    sites: [
      { id: "a-site", name: "Site A, \"quoted\"", latitude_deg: -85, longitude_deg_east: 30, observer_height_above_surface_m: 1, provisional: null },
      { id: "u-site", name: "Site U", latitude_deg: -89, longitude_deg_east: 222, observer_height_above_surface_m: 1, provisional: "Provisional: sensitive to terrain model" },
    ],
  });
  const table = parseCsv(csv);
  const head = table[0];
  const col = (r: string[], k: string) => r[head.indexOf(k)];

  it("has readable columns with units and one row per evaluated candidate", () => {
    expect(head).toEqual([...CSV_COLUMNS]);
    expect(table.length).toBe(1 + rows.length);
    expect(col(table[1], "dataset_id")).toBe("test-ds");
    expect(col(table[1], "search_earliest_arrival_utc")).toBe("2030-01-01T06:00:00Z");
    expect(col(table[1], "search_latest_arrival_utc")).toBe("2030-01-04T06:00:00Z");
    expect(col(table[1], "candidate_spacing_days")).toBe("1");
    expect(col(table[1], "candidate_arrival_hour_utc")).toBe("06:00");
    expect(col(table[1], "horizon_model")).toBe("Terrain horizon");
    expect(col(table[1], "temporal_sampling")).toContain("600 s");
    expect(table.find((r) => col(r, "site_id") === "a-site")![head.indexOf("site_name")]).toBe('Site A, "quoted"');
  });

  it("uses the same values and order as the interface", () => {
    const { ranked, unevaluable } = rank(rows, "both");
    [...ranked, ...unevaluable].forEach((r, i) => {
      const line = table[i + 1];
      expect(col(line, "rank")).toBe(i < ranked.length ? String(i + 1) : "");
      expect(col(line, "site_id")).toBe(r.siteId);
      expect(Date.parse(col(line, "arrival_utc"))).toBe(r.arrival);
      expect(Date.parse(col(line, "mission_end_utc"))).toBe(r.end);
      expect(col(line, "mission_duration_days")).toBe("2");
      for (const [k, c] of [["sun_visible_pct", "sun"], ["earth_visible_pct", "earth"], ["sun_and_earth_visible_pct", "both"], ["longest_sun_blockage_within_mission_h", "sunBlock"], ["longest_earth_blockage_within_mission_h", "earthBlock"]] as const) {
        const v = metricValue(r, c);
        if (v === null) expect(col(line, k)).toBe("");
        else expect(Number(col(line, k))).toBeCloseTo(v, 4);
      }
    });
  });

  it("records limits, outcomes, boundary and coverage flags", () => {
    const a = table.find((r) => col(r, "site_id") === "a-site" && col(r, "arrival_utc") === "2030-01-01T06:00:00Z")!;
    expect(col(a, "limit_min_sun_visible_pct")).toBe("50");
    expect(col(a, "limit_min_sun_visible_pct_outcome")).toBe("pass");
    expect(col(a, "limit_max_earth_blockage_within_mission_h_outcome")).toBe("pass");
    expect(col(a, "limit_min_earth_visible_pct_outcome")).toBe("not set");
    expect(col(a, "earth_blockage_touches_mission_end")).toBe("yes");
    expect(col(a, "meets_selected_limits")).toBe("meets selected limits");
    expect(col(a, "data_coverage")).toBe("complete");
    const u = table.find((r) => col(r, "site_id") === "u-site" && col(r, "arrival_utc") === "2030-01-01T06:00:00Z")!;
    expect(col(u, "rank")).toBe("");
    expect(col(u, "data_coverage")).toContain("incomplete");
    expect(col(u, "earth_visible_pct")).toBe("");
    expect(col(u, "provisional_designation")).toContain("Provisional");
  });
});

// ------------------------------------------------------------ real 120-day dataset

describe("real 120-day dataset (four sites)", () => {
  const dir = new URL("../public/data/lvn-2026-12-01-120d/", import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("manifest.json", dir), "utf-8")) as Manifest;
  const files = manifest.sites.map((s) => JSON.parse(readFileSync(new URL(s.file, dir), "utf-8")) as SiteData);
  const sites = files.map((d) => ({ id: d.site.id, intervals: parseIntervals(d, d.terrain_horizon!.visibility_intervals) }));
  const cov = commonCoverage(sites)!;

  it("common coverage is the manifest coverage; 14-day missions at 00:00 arrive 2026-12-01 to 2027-03-17", () => {
    expect(cov).toEqual({ start: Date.parse(manifest.coverage_start_utc), end: Date.parse(manifest.coverage_end_utc) });
    expect(arrivalLimits(cov, 14 * DAY_MS, 0)).toMatchObject({ earliestDate: "2026-12-01", latestDate: "2027-03-17" });
    expect(arrivalLimits(cov, 14 * DAY_MS, 12)).toMatchObject({ earliestDate: "2026-12-01", latestDate: "2027-03-16" });
  });

  it("evaluates 4 x 107 candidates with complete data, quickly", () => {
    const t0 = performance.now();
    const c = checkInputs({ siteIds: sites.map((s) => s.id), days: 14, fromDate: "2026-12-01", toDate: "2027-03-17", hour: 0 }, cov);
    if (!c.ok) throw new Error(c.problems.join(" "));
    const rows = evaluate(sites, c.arrivals, c.durationMs);
    const v = resultView(rows, "both", NO_LIMITS);
    const ms = performance.now() - t0;
    expect(rows.length).toBe(4 * 107);
    expect(v.ranking.unevaluable).toEqual([]);
    expect(rows.every((r) => r.end <= cov.end)).toBe(true);
    expect(ms).toBeLessThan(1000);
  });
});

// ------------------------------------------------------------ polish: formatting, per-site best, delay preview, apply scope

describe("percentage and outage formatting", () => {
  it("reserves 100.0 % and 0.0 % for exact values; bounds what rounding would hide", () => {
    expect(fmtPct(100)).toBe("100.0 %");
    expect(fmtPct(0)).toBe("0.0 %");
    expect(fmtPct(99.95)).toBe(">99.9 %");
    expect(fmtPct(99.9999)).toBe(">99.9 %");
    expect(fmtPct(100 * (20150 / 20160))).toBe(">99.9 %"); // 10 min short of 14 d
    expect(fmtPct(99.94)).toBe("99.9 %");
    expect(fmtPct(0.04)).toBe("<0.1 %");
    expect(fmtPct(100 * (10 / 20160))).toBe("<0.1 %"); // 10 min in 14 d
    expect(fmtPct(0.06)).toBe("0.1 %");
    expect(fmtPct(54.25)).toBe(Number(54.25).toFixed(1) + " %");
  });
  it("shows short outages in minutes and longer ones in hours", () => {
    expect(fmtOutage(10 * 60_000)).toBe("10 min");
    expect(fmtOutage(50 * 60_000)).toBe("50 min");
    expect(fmtOutage(60 * 60_000)).toBe("1.0 h");
    expect(fmtOutage(62.8 * H)).toBe("62.8 h");
  });
  it("ranking uses unrounded values: 10 min of blockage ranks below none", () => {
    // 14-day missions: 10 minutes without sunlight is 99.95 %, which one decimal would show as 100.0 %
    const short = ivs([10 / 60, false, true], [15 * 24 - 10 / 60, true, true]);
    const full = ivs([15 * 24, true, true]);
    const rows = [
      ...evaluate([{ id: "a-short", intervals: short }], [T0], 14 * DAY_MS),
      ...evaluate([{ id: "b-full", intervals: full }], [T0], 14 * DAY_MS),
    ];
    expect(rank(rows, "sun").ranked.map((r) => r.siteId)).toEqual(["b-full", "a-short"]);
    expect(fmtPct(metricValue(rows[0], "sun")!)).toBe(">99.9 %");
  });
});

describe("best matching arrival per site", () => {
  const unk = ivs([144, null, null]);
  const shortCov = ivs([20, true, true]); // ends long before any 48 h candidate does
  const rows = [
    ...evaluate([{ id: "a-site", intervals: SITE }, { id: "b-site", intervals: SITE }], [at(6), at(30), at(54), at(78)], 48 * H),
    ...evaluate([{ id: "u-site", intervals: unk }], [at(6), at(30)], 48 * H),
    ...evaluate([{ id: "c-site", intervals: shortCov }], [at(6), at(30)], 48 * H),
  ];
  const ids = ["a-site", "b-site", "u-site", "c-site"];
  it("gives each site its best candidate with the global rank; ties are deterministic", () => {
    const b = bestPerSite(rows, "both", NO_LIMITS, ids, [{ id: "x-site", reason: "no terrain horizon" }]);
    expect(b.map((x) => [x.siteId, x.state])).toEqual([["a-site", "match"], ["b-site", "match"], ["u-site", "unknown-data"], ["c-site", "coverage"], ["x-site", "unsupported"]]);
    expect(LETTER[b[0].row!.arrival]).toBe("C");
    expect(b[0].rank).toBe(1); // a-site before b-site at the same value and arrival
    expect(b[1].rank).toBe(2);
    expect(b[4].detail).toBe("no terrain horizon");
    expect(b[2].detail).toContain("never counts as favorable");
    expect(b[3].detail).toContain("never shortened");
  });
  it("respects the selected limits and never calls a failing candidate a match", () => {
    const l = { ...NO_LIMITS, maxEarthBlockH: 10 };
    const b = bestPerSite(rows, "both", l, ["a-site"]);
    expect(b[0].state).toBe("match");
    expect(LETTER[b[0].row!.arrival]).toBe("C"); // 6 h Earth blockage
    const none = bestPerSite(rows, "both", { ...NO_LIMITS, minSunPct: 99 }, ["a-site", "u-site"]);
    expect(none[0]).toMatchObject({ state: "no-match", row: null });
    expect(none[0].detail).toContain("Limits were not relaxed");
    expect(none[1].state).toBe("unknown-data");
  });
  it("limits that cannot be checked are reported as unknown data, not as no match", () => {
    const earthUnknown = ivs([144, true, null]);
    const r = evaluate([{ id: "e-site", intervals: earthUnknown }], [at(6)], 48 * H);
    const b = bestPerSite(r, "sun", { ...NO_LIMITS, minEarthPct: 10 }, ["e-site"]);
    expect(b[0].state).toBe("unknown-data");
    expect(b[0].detail).toContain("cannot be checked");
  });
});

describe("arrival-delay preview", () => {
  // 6-day coverage, 2-day missions: from 01-02 06:00 (30 h) +1 d fits (ends 102 h), +3 d would end 150 h > 144 h
  const p = delayPreview(SITE, at(30), 48 * H, COV, { ...NO_LIMITS, maxEarthBlockH: 14 }, "a-site");
  it("evaluates the chosen arrival and +1/+3/+7 d as complete missions with the shared metrics", () => {
    expect(p.map((x) => x.days)).toEqual([0, 1, 3, 7]);
    expect(p[0].m).toEqual(computeMetrics(SITE, { start: at(30), end: at(78) }));
    expect(p[1].m).toEqual(computeMetrics(SITE, { start: at(54), end: at(102) }));
    for (const x of p) expect(x.window.end - x.window.start).toBe(48 * H);
  });
  it("marks offsets beyond coverage unavailable; never shortens them", () => {
    expect(p.map((x) => x.enabled)).toEqual([true, true, false, false]);
    expect(p[2]).toMatchObject({ m: null, verdict: "none" });
    expect(p[2].reason).toContain("exceeds cached coverage");
    // exactly at the end of coverage is allowed
    const edge = delayPreview(SITE, at(72), 48 * H, COV, NO_LIMITS); // +1 d: 96..144 h, ends exactly at coverage end
    expect(edge.map((x) => x.enabled)).toEqual([true, true, false, false]);
    expect(edge[1].window.end).toBe(COV.end);
  });
  it("checks the selected limits and keeps boundary flags", () => {
    expect(p[0].verdict).toBe("fails"); // B: 20 h Earth blockage
    expect(p[1].verdict).toBe("meets"); // C: 6 h
    const sb = p[0].m!.longestDark;
    expect(sb.ok && sb.value!.touchesStart).toBe(true);
  });
});

describe("apply scope: a site outside the comparison", () => {
  const base: ScenarioCore = {
    selIds: ["a"], active: "a", arrival: at(0), days: 3, delay: 1, mission: "delayed", t: at(5),
    mode: "smooth", view: "analysis", cam: "overview", layer: "exceed", thr: 15, playing: false,
  };
  it("adds it in catalog order and makes it active; nothing else about the sites changes", () => {
    const next = applyResult(base, { siteId: "c", arrival: at(30), days: 2 }, ["a", "b", "c", "d", "e"]);
    expect(next.selIds).toEqual(["a", "c"]);
    expect(next).toMatchObject({ active: "c", arrival: at(30), days: 2, delay: 0, mission: "baseline", t: at(30), mode: "smooth", view: "analysis" });
  });
  it("refuses when the comparison is full or the site is not in the dataset", () => {
    const full = { ...base, selIds: ["a", "b", "c", "d"] };
    expect(() => applyResult(full, { siteId: "e", arrival: at(30), days: 2 }, ["a", "b", "c", "d", "e"])).toThrow(/full/);
    expect(() => applyResult(base, { siteId: "z", arrival: at(30), days: 2 }, ["a", "b"])).toThrow(/not in this dataset/);
  });
  it("search, ranking, per-site summary and preview leave the scenario untouched", () => {
    const snap = structuredClone(base);
    const rows = rowsFor([{ id: "a-site", intervals: SITE }]);
    resultView(rows, "sun", { ...NO_LIMITS, minSunPct: 50 });
    bestPerSite(rows, "both", NO_LIMITS, ["a-site"]);
    delayPreview(SITE, at(30), 48 * H, COV, NO_LIMITS);
    expect(base).toEqual(snap);
  });
});
