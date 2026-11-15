// Four-state availability timeline, mission-window clipping, transitions (event navigation),
// power/comms wording and the observer-view profile mask.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { horizonAt } from "../horizon";
import { type Interval, DAY_MS, computeMetrics, nextChange, parseIntervals } from "../mission";
import { strictHorizon, strictIntervals } from "../sites";
import { selectedTimeStatus } from "../status";
import type { SiteData } from "../types";
import {
  EVENT_LEAD_MS,
  PURPOSE_NOTE,
  adjacentTransition,
  availabilitySegments,
  availabilityState,
  commsStatus,
  powerStatus,
  segmentAt,
  transitionText,
  transitions,
} from "./availability";
import { MASK_ROWS_DEG, azElFromVector, diskRelation, profileMask } from "./geometry";

const H = 3_600_000;
const T0 = Date.parse("2026-12-01T00:00:00Z");
const iv = (a: number, b: number, sun: boolean | null, earth: boolean | null): Interval => ({ start: T0 + a * H, end: T0 + b * H, sun, earth });
const site = (id: string) => JSON.parse(readFileSync(new URL(`../../public/data/${id}.json`, import.meta.url), "utf-8")) as SiteData;

describe("four availability states", () => {
  it("maps Sun/Earth to both, Sun only, Earth only, neither; any unknown is unknown, never neither", () => {
    expect(availabilityState(true, true)).toBe("both");
    expect(availabilityState(true, false)).toBe("sun");
    expect(availabilityState(false, true)).toBe("earth");
    expect(availabilityState(false, false)).toBe("neither");
    for (const [s, e] of [[null, false], [false, null], [null, null], [true, null], [null, true]] as const) {
      expect(availabilityState(s, e)).toBe("unknown");
    }
  });

  it("clips to the window with [start, end) semantics, merges equal periods, marks gaps as uncovered", () => {
    const all = [iv(0, 2, true, true), iv(2, 3, true, true), iv(3, 5, false, null), iv(6, 8, false, false)];
    const segs = availabilitySegments(all, { start: T0 + 1 * H, end: T0 + 9 * H });
    expect(segs.map((s) => [(s.start - T0) / H, (s.end - T0) / H, s.state])).toEqual([
      [1, 3, "both"], // clipped at the window start and merged across the 2 h boundary
      [3, 5, "unknown"], // Earth unknown: not "neither"
      [5, 6, "uncovered"], // gap between intervals
      [6, 8, "neither"],
      [8, 9, "uncovered"], // past the last interval
    ]);
    const total = segs.reduce((a, s) => a + s.end - s.start, 0);
    expect(total).toBe(8 * H);
    expect(segmentAt(segs, T0 + 3 * H)?.state).toBe("unknown"); // boundary belongs to the later period
    expect(segmentAt(segs, T0 + 9 * H)).toBeNull(); // end is exclusive
  });

  it("on real data, segment durations reproduce computeMetrics for the same window (both sites, both models)", () => {
    for (const id of ["im2-athena", "connecting-ridge-cr1"]) {
      const d = site(id);
      for (const mode of ["smooth", "terrain"] as const) {
        const all = parseIntervals(d, strictIntervals(d, mode));
        for (const start of [Date.parse("2026-12-05T00:00:00Z"), Date.parse("2026-12-08T06:00:00Z")]) {
          const w = { start, end: start + 14 * DAY_MS };
          const segs = availabilitySegments(all, w);
          const m = computeMetrics(all, w);
          const dur = (pred: (s: string) => boolean) => segs.filter((s) => pred(s.state)).reduce((a, s) => a + s.end - s.start, 0);
          const pct = (x: number) => (100 * x) / (w.end - w.start);
          expect(m.sunPct.ok && m.earthPct.ok && m.bothPct.ok).toBe(true);
          if (m.sunPct.ok) expect(pct(dur((s) => s === "both" || s === "sun"))).toBeCloseTo(m.sunPct.value, 9);
          if (m.earthPct.ok) expect(pct(dur((s) => s === "both" || s === "earth"))).toBeCloseTo(m.earthPct.value, 9);
          if (m.bothPct.ok) expect(pct(dur((s) => s === "both"))).toBeCloseTo(m.bothPct.value, 9);
          expect(segs.some((s) => s.state === "unknown" || s.state === "uncovered")).toBe(false);
        }
      }
    }
  });
});

describe("transitions for guided horizon crossings", () => {
  const all = [iv(0, 2, true, false), iv(2, 4, false, false), iv(4, 5, false, null), iv(5, 7, true, true), iv(8, 9, false, true)];
  const R = { start: T0, end: T0 + 9 * H };
  it("uses interval boundaries where the known state flips; skips unknown sides and gaps", () => {
    // Sun: true -> false at 2 h, false (4-5 h, Earth unknown but Sun known) -> true at 5 h; 7-8 h is a gap
    expect(transitions(all, "sun", R).map((x) => [(x.t - T0) / H, x.to])).toEqual([[2, false], [5, true]]);
  });
  it("reports the flip after an unknown Earth period only when both sides are known", () => {
    const sun = transitions([iv(0, 2, true, false), iv(2, 4, false, false), iv(4, 6, true, false)], "sun", R);
    expect(sun.map((x) => (x.t - T0) / H)).toEqual([2, 4]);
    // Earth 4-5 unknown, 5-7 true: the change at 5 is from unknown, so it is not a transition
    expect(transitions(all, "earth", R)).toEqual([]);
  });
  it("a gap (7-8) is not a transition, and the end of the data is never one", () => {
    const sun = transitions(all, "sun", R).map((x) => (x.t - T0) / H);
    expect(sun).not.toContain(8);
    expect(sun).not.toContain(9);
  });
  it("only boundaries strictly inside the search range count", () => {
    const seq = [iv(0, 2, true, false), iv(2, 4, false, false), iv(4, 6, true, false)];
    expect(transitions(seq, "sun", { start: T0 + 2 * H, end: T0 + 4 * H })).toEqual([]);
    expect(transitions(seq, "sun", { start: T0 + 1 * H, end: T0 + 5 * H })).toHaveLength(2);
  });
  it("previous / next relative to a reference time; null when there is none", () => {
    const list = transitions([iv(0, 2, true, false), iv(2, 4, false, false), iv(4, 6, true, false)], "sun", R);
    expect((adjacentTransition(list, T0, 1)!.t - T0) / H).toBe(2);
    expect((adjacentTransition(list, T0 + 2 * H, 1)!.t - T0) / H).toBe(4); // strictly after
    expect((adjacentTransition(list, T0 + 4 * H, -1)!.t - T0) / H).toBe(2); // strictly before
    expect(adjacentTransition(list, T0 + 4 * H, 1)).toBeNull();
    expect(adjacentTransition(list, T0 + 2 * H, -1)).toBeNull();
  });
  it("real data: each transition is where nextChange (the readouts' rule) finds the next change; none at coverage end", () => {
    for (const id of ["im2-athena", "connecting-ridge-cr1"]) {
      const d = site(id);
      const all = parseIntervals(d, strictIntervals(d, "terrain"));
      const cov = { start: all[0].start, end: all[all.length - 1].end };
      for (const body of ["sun", "earth"] as const) {
        const list = transitions(all, body, cov);
        expect(list.length).toBeGreaterThan(0);
        for (const x of list) {
          const c = nextChange(all, x.t - 1, body);
          expect(c.found && c.at === x.t && c.to === x.to).toBe(true);
          expect(x.t).toBeLessThan(cov.end);
          expect((x.t - cov.start) % 600_000).toBe(0); // on the 10-minute grid
        }
      }
    }
  });
  it("event text names the body, the horizon model and a UTC time; leads land on samples", () => {
    const x = { t: Date.parse("2026-12-16T09:10:00Z"), body: "sun" as const, to: false };
    expect(transitionText(x, "terrain")).toBe("Sun center crosses the modeled skyline near 2026-12-16 09:10 UTC (direct sunlight ends).");
    expect(transitionText({ ...x, body: "earth", to: true }, "smooth")).toBe("Earth center crosses the 0° reference horizon near 2026-12-16 09:10 UTC (Earth window opens).");
    expect(EVENT_LEAD_MS.sun % 600_000).toBe(0);
    expect(EVENT_LEAD_MS.earth % 600_000).toBe(0);
  });
});

describe("power / communications wording from selectedTimeStatus", () => {
  const status = (id: string, mode: "smooth" | "terrain", t: string) => {
    const d = site(id);
    const times = d.samples.map((s) => Date.parse(s.time_utc));
    return selectedTimeStatus({ samples: d.samples, times, horizon: strictHorizon(d, mode), intervals: parseIntervals(d, strictIntervals(d, mode)), mode }, Date.parse(t));
  };
  it("labels follow the interval state, including near a crossing", () => {
    const s = status("im2-athena", "terrain", "2026-12-09T14:00:00Z"); // Earth: step visible, center 0.00012° below
    expect(s.earth.nearCrossing).toBe(true);
    expect(commsStatus(s.earth)).toEqual({ label: "Earth visibility window open", tone: "on" });
    expect(powerStatus(s.sun)).toEqual({ label: "Direct sunlight blocked", tone: "off" });
    const c = status("connecting-ridge-cr1", "terrain", "2026-12-24T00:00:00Z"); // Sun: step visible, center below
    expect(c.sun.nearCrossing).toBe(true);
    expect(powerStatus(c.sun).label).toBe("Direct sunlight available");
  });
  it("the final sample is unknown for both, never blocked or closed", () => {
    const s = status("connecting-ridge-cr1", "terrain", "2027-01-30T00:00:00Z");
    expect(s.sun.unknownReason).toBe("end-of-data");
    expect(powerStatus(s.sun)).toEqual({ label: "Sunlight status unknown", tone: "unknown" });
    expect(commsStatus(s.earth)).toEqual({ label: "Earth visibility unknown", tone: "unknown" });
  });
  it("states the purpose and what is not modeled", () => {
    expect(PURPOSE_NOTE).toBe(
      "Sun visibility indicates potential for direct solar generation. Earth visibility indicates a geometric direct-to-Earth communication window. Electrical output, battery endurance and radio-link performance are not modeled.",
    );
  });
});

describe("observer-view profile mask (the profile alone decides occlusion)", () => {
  for (const id of ["im2-athena", "connecting-ridge-cr1"]) {
    it(`${id}: the mask's top edge is the exported profile; rows reach nadir`, () => {
      const h = site(id).terrain_horizon!.horizon;
      const m = profileMask(h.azimuth_deg, h.elevation_deg, 80_000);
      const n = h.azimuth_deg.length;
      expect(m.index.length).toBe(n * MASK_ROWS_DEG.length * 6); // every column present (no unknown azimuths)
      for (let k = 0; k < n; k += 37) {
        const p = m.positions.slice(3 * k * m.rows, 3 * k * m.rows + 3);
        expect(Math.hypot(p[0], p[1], p[2])).toBeCloseTo(80_000, 0);
        const { az, el } = azElFromVector([p[0], p[1], p[2]]);
        expect(Math.abs(el - h.elevation_deg[k]!)).toBeLessThan(1e-5);
        expect(Math.abs(((az - h.azimuth_deg[k] + 540) % 360) - 180)).toBeLessThan(1e-5);
        // on the exact profile azimuth the mask edge equals the status rule's horizon
        expect(Math.abs(el - horizonAt(h, h.azimuth_deg[k])!)).toBeLessThan(1e-5);
        const bottom = m.positions.slice(3 * (k * m.rows + m.rows - 1), 3 * (k * m.rows + m.rows));
        expect(azElFromVector([bottom[0], bottom[1], bottom[2]]).el).toBeLessThan(-89);
      }
    });
  }
  it("omits a column whose profile value is unknown (no invented horizon)", () => {
    const m = profileMask([0, 120, 240], [1, null, 2], 1000);
    // columns 0-1 and 1-2 touch the unknown value; only 2-0 (wrap) remains
    expect(m.index.length).toBe(MASK_ROWS_DEG.length * 6);
    expect(m.top).toHaveLength(3); // known values 0 and 2, plus the repeated first point that closes the skyline loop
  });
  it("disk relation from the center clearance and nominal radius", () => {
    expect(diskRelation(0.5, 0.265)).toBe("clear");
    expect(diskRelation(0.1, 0.265)).toBe("straddles");
    expect(diskRelation(-0.0015, 0.265)).toBe("straddles");
    expect(diskRelation(-0.3, 0.265)).toBe("hidden");
    expect(diskRelation(null, 0.95)).toBeNull();
  });
});
